/**
 * Claw Task Service — Request Tracer (Phase 3 M3)
 *
 * Provides lightweight distributed tracing for intent classification requests.
 *
 * Features:
 *   - Generate trace_id + span_id (W3C-compatible short format)
 *   - Span lifecycle: start → end with duration tracking
 *   - Span attributes (key-value pairs attached to spans)
 *   - Per-trace span collection (in-memory, bounded)
 *   - Trace context propagation via headers (W3C traceparent-like)
 *   - Integration with structured logger (spans logged at DEBUG)
 *
 * Design:
 *   - Zero external dependencies
 *   - In-memory span storage (ring buffer, max 500 traces / 2000 spans)
 *   - Thread-safe in Node's single-threaded event loop
 *
 * Usage:
 *   import { tracer } from './tracer.js';
 *
 *   // Start a new trace for an incoming request
 *   const trace = tracer.startTrace('intent.classify', { input: text });
 *
 *   // Start child spans for pipeline stages
 *   const span = tracer.startSpan('preprocess', trace.traceId);
 *   // ... do work ...
 *   tracer.endSpan(span);
 *
 *   // End the trace
 *   tracer.endTrace(trace);
 *
 *   // Get trace summary
 *   const summary = tracer.getTraceSummary(trace.traceId);
 *
 * Based on: Phase 3 M3 task spec (2026-07-31)
 */

import { logger } from './logger.js';
import { randomFillSync } from 'node:crypto';

// ─── Types ─────────────────────────────────────────────────────────

/** A single span within a trace */
export interface Span {
  /** Unique span identifier (8 hex chars) */
  spanId: string;
  /** Parent trace identifier (16 hex chars) */
  traceId: string;
  /** Parent span ID (undefined for root span) */
  parentSpanId?: string;
  /** Operation name (e.g. 'preprocess', 'classify', 'cache_lookup') */
  name: string;
  /** Start time in epoch milliseconds */
  startTimeMs: number;
  /** End time in epoch milliseconds (set when span ends) */
  endTimeMs?: number;
  /** Duration in milliseconds (set when span ends) */
  durationMs?: number;
  /** Span status */
  status: SpanStatus;
  /** Span attributes (key-value pairs) */
  attributes: Record<string, string | number | boolean>;
  /** Events recorded during the span */
  events: SpanEvent[];
}

/** Span status */
export type SpanStatus = 'active' | 'completed' | 'error';

/** An event recorded during a span */
export interface SpanEvent {
  /** Event name */
  name: string;
  /** Epoch milliseconds when the event occurred */
  timestampMs: number;
  /** Event attributes */
  attributes?: Record<string, string | number | boolean>;
}

/** A trace containing multiple spans */
export interface Trace {
  /** Unique trace identifier (16 hex chars) */
  traceId: string;
  /** Root span of this trace */
  rootSpanId: string;
  /** All spans in this trace */
  spans: Map<string, Span>;
  /** Trace start time in epoch milliseconds */
  startTimeMs: number;
  /** Trace end time in epoch milliseconds (set when trace ends) */
  endTimeMs?: number;
  /** Total trace duration in milliseconds (set when trace ends) */
  durationMs?: number;
  /** Trace status */
  status: 'active' | 'completed' | 'error';
}

/** Trace summary for reporting */
export interface TraceSummary {
  traceId: string;
  rootSpan: string;
  status: 'active' | 'completed' | 'error';
  spanCount: number;
  totalDurationMs: number;
  /** Breakdown of span durations, sorted by start time */
  spans: SpanSummary[];
}

/** Individual span summary within a trace */
export interface SpanSummary {
  name: string;
  spanId: string;
  parentSpanId?: string;
  durationMs: number;
  status: SpanStatus;
  attributeCount: number;
  eventCount: number;
}

/** Trace context for propagation across service boundaries */
export interface TraceContext {
  traceId: string;
  spanId: string;
}

// ─── Constants ─────────────────────────────────────────────────────

/** Maximum traces kept in memory */
const MAX_TRACES = 500;

/** Maximum total spans across all traces in memory */
const MAX_TOTAL_SPANS = 2000;

// ─── ID Generation ─────────────────────────────────────────────────

/**
 * Generate a random hex ID of the specified length.
 * Uses crypto.randomBytes for cryptographic-quality randomness.
 */
function generateHexId(length: number): string {
  const byteLength = Math.ceil(length / 2);
  const bytes = Buffer.alloc(byteLength);
  randomFillSync(bytes);
  return bytes.toString('hex').slice(0, length);
}

/**
 * Generate a trace ID (16 hex characters).
 */
export function generateTraceId(): string {
  return generateHexId(16);
}

/**
 * Generate a span ID (8 hex characters).
 */
export function generateSpanId(): string {
  return generateHexId(8);
}

// ─── Tracer Class ──────────────────────────────────────────────────

/**
 * Lightweight in-memory request tracer.
 *
 * Maintains a bounded map of active and completed traces.
 * Spans are stored per-trace in insertion order.
 */
class Tracer {
  private traces: Map<string, Trace> = new Map();
  private traceOrder: string[] = []; // For LRU eviction
  private totalSpans: number = 0;

  // ─── Trace Lifecycle ───────────────────────────────────────────

  /**
   * Start a new trace with a root span.
   *
   * @param rootSpanName - Name of the root span (e.g. 'intent.classify')
   * @param attributes - Optional initial attributes for the root span
   * @returns The created Trace object
   */
  startTrace(rootSpanName: string, attributes?: Record<string, string | number | boolean>): Trace {
    const traceId = generateTraceId();
    const spanId = generateSpanId();
    const now = Date.now();

    const rootSpan: Span = {
      spanId,
      traceId,
      name: rootSpanName,
      startTimeMs: now,
      status: 'active',
      attributes: { ...attributes },
      events: [],
    };

    const trace: Trace = {
      traceId,
      rootSpanId: spanId,
      spans: new Map([[spanId, rootSpan]]),
      startTimeMs: now,
      status: 'active',
    };

    this.traces.set(traceId, trace);
    this.traceOrder.push(traceId);
    this.totalSpans++;

    // Evict oldest traces if over capacity
    this.evictIfNeeded();

    logger.debug('Trace started', {
      traceId,
      rootSpan: rootSpanName,
    });

    return trace;
  }

  /**
   * End a trace by setting its root span end time and status.
   *
   * @param trace - The trace to end (or traceId string)
   * @param status - Final status (default: 'completed')
   */
  endTrace(trace: Trace | string, status: 'completed' | 'error' = 'completed'): void {
    const traceId = typeof trace === 'string' ? trace : trace.traceId;
    const t = this.traces.get(traceId);
    if (!t) return;

    const now = Date.now();
    t.endTimeMs = now;
    t.durationMs = now - t.startTimeMs;
    t.status = status;

    // End the root span if still active
    const rootSpan = t.spans.get(t.rootSpanId);
    if (rootSpan && rootSpan.status === 'active') {
      rootSpan.endTimeMs = now;
      rootSpan.durationMs = now - rootSpan.startTimeMs;
      rootSpan.status = status === 'error' ? 'error' : 'completed';
    }

    logger.debug('Trace ended', {
      traceId,
      durationMs: t.durationMs,
      spanCount: t.spans.size,
      status,
    });
  }

  // ─── Span Lifecycle ────────────────────────────────────────────

  /**
   * Start a new span within an existing trace.
   *
   * @param name - Span operation name
   * @param traceId - Parent trace ID
   * @param parentSpanId - Optional parent span ID (defaults to root span)
   * @param attributes - Optional initial attributes
   * @returns The created Span, or undefined if trace not found
   */
  startSpan(
    name: string,
    traceId: string,
    parentSpanId?: string,
    attributes?: Record<string, string | number | boolean>,
  ): Span | undefined {
    const trace = this.traces.get(traceId);
    if (!trace) {
      logger.warn('Span start failed: trace not found', { traceId, spanName: name });
      return undefined;
    }

    const spanId = generateSpanId();
    const span: Span = {
      spanId,
      traceId,
      parentSpanId: parentSpanId ?? trace.rootSpanId,
      name,
      startTimeMs: Date.now(),
      status: 'active',
      attributes: { ...attributes },
      events: [],
    };

    trace.spans.set(spanId, span);
    this.totalSpans++;

    this.evictIfNeeded();

    return span;
  }

  /**
   * End a span.
   *
   * @param span - The span to end (or spanId)
   * @param traceId - Required if span is a string
   * @param status - Span final status (default: 'completed')
   */
  endSpan(
    span: Span | string,
    traceId?: string,
    status: 'completed' | 'error' = 'completed',
  ): void {
    let spanId: string;
    let tid: string | undefined;

    if (typeof span === 'string') {
      spanId = span;
      tid = traceId;
    } else {
      spanId = span.spanId;
      tid = span.traceId;
    }

    if (!tid) return;

    const trace = this.traces.get(tid);
    if (!trace) return;

    const s = trace.spans.get(spanId);
    if (!s || s.status !== 'active') return;

    const now = Date.now();
    s.endTimeMs = now;
    s.durationMs = now - s.startTimeMs;
    s.status = status;

    logger.debug('Span ended', {
      traceId: tid,
      spanId,
      spanName: s.name,
      durationMs: s.durationMs,
      status,
    });
  }

  /**
   * Add an attribute to a span.
   */
  setSpanAttribute(
    spanId: string,
    traceId: string,
    key: string,
    value: string | number | boolean,
  ): void {
    const trace = this.traces.get(traceId);
    if (!trace) return;

    const span = trace.spans.get(spanId);
    if (span) {
      span.attributes[key] = value;
    }
  }

  /**
   * Record an event on a span.
   */
  recordEvent(
    spanId: string,
    traceId: string,
    name: string,
    attributes?: Record<string, string | number | boolean>,
  ): void {
    const trace = this.traces.get(traceId);
    if (!trace) return;

    const span = trace.spans.get(spanId);
    if (span) {
      span.events.push({
        name,
        timestampMs: Date.now(),
        attributes,
      });
    }
  }

  // ─── Query ─────────────────────────────────────────────────────

  /**
   * Get a trace by ID.
   */
  getTrace(traceId: string): Trace | undefined {
    return this.traces.get(traceId);
  }

  /**
   * Get a span by ID within a trace.
   */
  getSpan(traceId: string, spanId: string): Span | undefined {
    const trace = this.traces.get(traceId);
    if (!trace) return undefined;
    return trace.spans.get(spanId);
  }

  /**
   * Get a summary of a trace, including all spans sorted by start time.
   */
  getTraceSummary(traceId: string): TraceSummary | undefined {
    const trace = this.traces.get(traceId);
    if (!trace) return undefined;

    const spans: SpanSummary[] = [];
    for (const span of trace.spans.values()) {
      spans.push({
        name: span.name,
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        durationMs: span.durationMs ?? 0,
        status: span.status,
        attributeCount: Object.keys(span.attributes).length,
        eventCount: span.events.length,
      });
    }

    // Sort by start time (root span first, then children by start time)
    spans.sort((a, b) => {
      const spanA = trace.spans.get(a.spanId);
      const spanB = trace.spans.get(b.spanId);
      return (spanA?.startTimeMs ?? 0) - (spanB?.startTimeMs ?? 0);
    });

    return {
      traceId,
      rootSpan: trace.spans.get(trace.rootSpanId)?.name ?? 'unknown',
      status: trace.status,
      spanCount: trace.spans.size,
      totalDurationMs: trace.durationMs ?? (Date.now() - trace.startTimeMs),
      spans,
    };
  }

  /**
   * Get the current number of active traces.
   */
  getActiveTraceCount(): number {
    let count = 0;
    for (const trace of this.traces.values()) {
      if (trace.status === 'active') count++;
    }
    return count;
  }

  /**
   * Get total trace count (active + completed).
   */
  getTotalTraceCount(): number {
    return this.traces.size;
  }

  /**
   * Get total span count across all traces.
   */
  getTotalSpanCount(): number {
    return this.totalSpans;
  }

  // ─── Context Propagation ───────────────────────────────────────

  /**
   * Extract trace context from a W3C traceparent-like header.
   *
   * Format: 00-{traceId}-{spanId}-01
   *
   * @param header - The traceparent header value
   * @returns Parsed TraceContext or undefined if invalid
   */
  parseTraceParent(header: string): TraceContext | undefined {
    const parts = header.split('-');
    if (parts.length < 4) return undefined;

    const traceId = parts[1];
    const spanId = parts[2];

    // Validate hex IDs
    if (!/^[0-9a-f]{16}$/.test(traceId)) return undefined;
    if (!/^[0-9a-f]{8}$/.test(spanId)) return undefined;

    return { traceId, spanId };
  }

  /**
   * Build a W3C traceparent-like header from a TraceContext.
   *
   * @param ctx - The trace context
   * @returns Header string in format "00-{traceId}-{spanId}-01"
   */
  buildTraceParent(ctx: TraceContext): string {
    return `00-${ctx.traceId}-${ctx.spanId}-01`;
  }

  // ─── Maintenance ────────────────────────────────────────────────

  /**
   * Clear all traces and reset counters.
   */
  reset(): void {
    this.traces.clear();
    this.traceOrder = [];
    this.totalSpans = 0;
  }

  /**
   * Evict oldest traces if over capacity.
   * Called internally after adding new spans.
   */
  private evictIfNeeded(): void {
    // Evict by trace count
    while (this.traceOrder.length > MAX_TRACES) {
      const oldestTraceId = this.traceOrder.shift();
      if (oldestTraceId) {
        const trace = this.traces.get(oldestTraceId);
        if (trace) {
          this.totalSpans -= trace.spans.size;
          this.traces.delete(oldestTraceId);
        }
      }
    }

    // Evict by total span count (remove oldest traces first)
    while (this.totalSpans > MAX_TOTAL_SPANS && this.traceOrder.length > 1) {
      const oldestTraceId = this.traceOrder.shift();
      if (oldestTraceId) {
        const trace = this.traces.get(oldestTraceId);
        if (trace) {
          this.totalSpans -= trace.spans.size;
          this.traces.delete(oldestTraceId);
        }
      }
    }
  }
}

// ─── Convenience: Tracked Span ─────────────────────────────────────

/**
 * A convenience wrapper that automatically ends the span when disposed.
 *
 * Usage:
 *   using tracked = tracer.track('preprocess', traceId);
 *   // ... do work ...
 *   // span automatically ended when 'tracked' goes out of scope
 *
 * Note: Requires the using/Disposable pattern (TS 5.2+).
 */
export class TrackedSpan implements Disposable {
  private span: Span;
  private traceId: string;
  private tracer: Tracer;

  constructor(span: Span, tracer: Tracer) {
    this.span = span;
    this.traceId = span.traceId;
    this.tracer = tracer;
  }

  get spanId(): string {
    return this.span.spanId;
  }

  get name(): string {
    return this.span.name;
  }

  /** Set an attribute on the tracked span */
  setAttribute(key: string, value: string | number | boolean): this {
    this.tracer.setSpanAttribute(this.span.spanId, this.traceId, key, value);
    return this;
  }

  /** Record an event on the tracked span */
  event(name: string, attributes?: Record<string, string | number | boolean>): this {
    this.tracer.recordEvent(this.span.spanId, this.traceId, name, attributes);
    return this;
  }

  /** Mark the span as error */
  markError(): this {
    this.span.status = 'error';
    return this;
  }

  [Symbol.dispose](): void {
    this.tracer.endSpan(this.span, this.traceId, this.span.status === 'error' ? 'error' : 'completed');
  }
}

// ─── Singleton Export ──────────────────────────────────────────────

/**
 * Global singleton tracer instance.
 *
 * Usage:
 *   import { tracer } from './tracer.js';
 *   const trace = tracer.startTrace('intent.classify');
 */
export const tracer = new Tracer();

/**
 * Get the singleton Tracer instance.
 */
export function getTracer(): Tracer {
  return tracer;
}

// ─── Export the class for testing ──────────────────────────────────

export { Tracer };
