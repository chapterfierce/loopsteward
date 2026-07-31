/**
 * Claw Task Service — Request Context (M3)
 *
 * Provides per-request context with request_id and trace_id
 * propagation using Node.js AsyncLocalStorage.
 *
 * Each incoming HTTP request gets a unique request_id (UUID-like)
 * and an optional trace_id (from W3C traceparent header or generated).
 * This context is available throughout the request lifecycle without
 * explicit passing, via asyncLocalStorage.
 *
 * Usage:
 *   import { runWithRequestContext, getRequestContext } from './request-context.js';
 *
 *   // In middleware:
 *   runWithRequestContext(req, () => {
 *     // Any code inside can access context:
 *     const ctx = getRequestContext();
 *     logger.info('Processing', { requestId: ctx.requestId });
 *   });
 */

import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage } from 'node:http';

// ─── Types ─────────────────────────────────────────────────────────

export interface RequestContext {
  /** Unique request identifier (UUID format) */
  requestId: string;
  /** Trace identifier (16 hex chars, from traceparent or generated) */
  traceId: string;
  /** Span identifier (8 hex chars) */
  spanId: string;
  /** HTTP method */
  method: string;
  /** Request URL path */
  path: string;
  /** Request start time (epoch ms) */
  startTimeMs: number;
  /** Remote client IP (best effort) */
  remoteIp?: string;
  /** User agent */
  userAgent?: string;
}

// ─── AsyncLocalStorage ─────────────────────────────────────────────

const asyncLocalStorage = new AsyncLocalStorage<RequestContext>();

// ─── W3C Traceparent Parsing ───────────────────────────────────────

/**
 * Parse a W3C traceparent header.
 * Format: 00-{traceId(32 hex)}-{spanId(16 hex)}-{flags(2 hex)}
 *
 * Returns { traceId, spanId } or undefined if invalid.
 */
export function parseTraceparent(header: string | undefined): { traceId: string; spanId: string } | undefined {
  if (!header) return undefined;
  const parts = header.trim().split('-');
  if (parts.length < 4) return undefined;

  const traceId = parts[1];
  const spanId = parts[2];

  // Validate: traceId is 32 hex chars, spanId is 16 hex chars
  if (!/^[0-9a-f]{32}$/.test(traceId)) return undefined;
  if (!/^[0-9a-f]{16}$/.test(spanId)) return undefined;

  return { traceId, spanId };
}

/**
 * Build a W3C traceparent header from trace context.
 */
export function buildTraceparent(traceId: string, spanId: string, flags: string = '01'): string {
  return `00-${traceId}-${spanId}-${flags}`;
}

// ─── ID Generation ─────────────────────────────────────────────────

/**
 * Generate a request ID (UUID v4 format).
 */
export function generateRequestId(): string {
  return randomUUID();
}

/**
 * Generate a trace ID (32 hex chars, W3C compatible).
 */
export function generateTraceId(): string {
  const bytes = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes.toString('hex');
}

/**
 * Generate a span ID (16 hex chars, W3C compatible).
 */
export function generateSpanId(): string {
  const bytes = Buffer.alloc(8);
  for (let i = 0; i < 8; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes.toString('hex');
}

// ─── Context Management ────────────────────────────────────────────

/**
 * Extract request context from an HTTP request.
 * Reads traceparent header for distributed tracing, generates IDs if missing.
 */
export function extractRequestContext(req: IncomingMessage): RequestContext {
  // Try to parse incoming traceparent header
  const traceparent = req.headers['traceparent'] as string | undefined;
  const parsed = parseTraceparent(traceparent);

  return {
    requestId: generateRequestId(),
    traceId: parsed?.traceId ?? generateTraceId(),
    spanId: parsed?.spanId ?? generateSpanId(),
    method: req.method ?? 'GET',
    path: req.url?.split('?')[0] ?? '/',
    startTimeMs: Date.now(),
    remoteIp: (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
      ?? req.socket?.remoteAddress,
    userAgent: req.headers['user-agent'],
  };
}

/**
 * Run a function within a request context.
 * The context is available via getRequestContext() inside the function.
 */
export function runWithRequestContext<T>(
  ctx: RequestContext,
  fn: () => T,
): T {
  return asyncLocalStorage.run(ctx, fn);
}

/**
 * Get the current request context, if any.
 * Returns undefined if called outside a request context.
 */
export function getRequestContext(): RequestContext | undefined {
  return asyncLocalStorage.getStore();
}

/**
 * Get the current request ID, or 'no-request' if outside a context.
 */
export function getRequestId(): string {
  return asyncLocalStorage.getStore()?.requestId ?? 'no-request';
}

/**
 * Get the current trace ID, or 'no-trace' if outside a context.
 */
export function getTraceId(): string {
  return asyncLocalStorage.getStore()?.traceId ?? 'no-trace';
}
