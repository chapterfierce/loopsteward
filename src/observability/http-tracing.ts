/**
 * Claw Task Service — HTTP Tracing Middleware (M3)
 *
 * OpenTelemetry-compatible span management for HTTP requests.
 * Creates a span per request, propagates trace context via W3C
 * traceparent headers, and records span attributes.
 *
 * Uses the existing intent-engine Tracer for span storage,
 * extended with HTTP-specific semantics.
 */

import { tracer, type Trace, type Span } from '../../intent-engine/tracer.js';
import {
  extractRequestContext,
  buildTraceparent,
  type RequestContext,
} from './request-context.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ─── Types ─────────────────────────────────────────────────────────

export interface HttpSpanContext {
  trace: Trace;
  rootSpan: Span;
  requestContext: RequestContext;
}

export interface SpanAttribute {
  key: string;
  value: string | number | boolean;
}

// ─── HTTP Span Creation ────────────────────────────────────────────

/**
 * Create an HTTP request span.
 * This wraps the request in a trace span with HTTP semantics.
 */
export function startHttpSpan(
  req: IncomingMessage,
  requestContext: RequestContext,
): HttpSpanContext {
  const trace = tracer.startTrace(`HTTP ${requestContext.method} ${requestContext.path}`, {
    'http.method': requestContext.method,
    'http.target': requestContext.path,
    'http.request_id': requestContext.requestId,
    'http.user_agent': requestContext.userAgent ?? '',
    'http.remote_ip': requestContext.remoteIp ?? '',
    'traceId': requestContext.traceId,
  });

  const rootSpan = trace.spans.get(trace.rootSpanId)!;

  return {
    trace,
    rootSpan,
    requestContext,
  };
}

/**
 * End an HTTP request span with the response status.
 */
export function endHttpSpan(
  spanCtx: HttpSpanContext,
  statusCode: number,
  responseSize?: number,
): void {
  tracer.setSpanAttribute(
    spanCtx.rootSpan.spanId,
    spanCtx.trace.traceId,
    'http.status_code',
    statusCode,
  );

  if (responseSize !== undefined) {
    tracer.setSpanAttribute(
      spanCtx.rootSpan.spanId,
      spanCtx.trace.traceId,
      'http.response_size',
      responseSize,
    );
  }

  // Mark as error if 5xx
  const status = statusCode >= 500 ? 'error' : 'completed';
  tracer.endSpan(spanCtx.rootSpan, spanCtx.trace.traceId, status);
  tracer.endTrace(spanCtx.trace, status);
}

/**
 * Start a child span within an HTTP request trace.
 * Useful for instrumenting specific operations within a request handler.
 */
export function startChildSpan(
  parentCtx: HttpSpanContext,
  name: string,
  attributes?: Record<string, string | number | boolean>,
): Span | undefined {
  return tracer.startSpan(
    name,
    parentCtx.trace.traceId,
    parentCtx.rootSpan.spanId,
    attributes,
  );
}

/**
 * End a child span.
 */
export function endChildSpan(
  parentCtx: HttpSpanContext,
  span: Span,
  status: 'completed' | 'error' = 'completed',
): void {
  tracer.endSpan(span, parentCtx.trace.traceId, status);
}

// ─── Response Trace Header Injection ───────────────────────────────

/**
 * Inject trace context into the HTTP response.
 * Sets the `traceparent` response header so clients can correlate.
 */
export function injectTraceHeaders(
  res: ServerResponse,
  ctx: RequestContext,
): void {
  const traceparent = buildTraceparent(ctx.traceId, ctx.spanId);
  res.setHeader('traceparent', traceparent);
  res.setHeader('x-request-id', ctx.requestId);
}

// ─── Express-Compatible Middleware ─────────────────────────────────

/**
 * Express middleware that creates a trace span for each request.
 *
 * Usage:
 *   import { tracingMiddleware } from './http-tracing.js';
 *   app.use(tracingMiddleware);
 *
 * Note: Must be used after request-context middleware.
 */
export function tracingMiddleware(req: any, res: any, next: any): void {
  const ctx = extractRequestContext(req) as RequestContext;
  const spanCtx = startHttpSpan(req, ctx);

  // Store on request for later access
  req.spanContext = spanCtx;
  req.requestContext = ctx;

  // Inject trace headers into response
  injectTraceHeaders(res, ctx);

  // Hook into response finish to end the span
  const originalEnd = res.end.bind(res);
  res.end = function (this: any, ...args: any[]): any {
    const latencyMs = Date.now() - ctx.startTimeMs;
    const statusCode = res.statusCode;
    endHttpSpan(spanCtx, statusCode);
    originalEnd(...args);
  };

  next();
}
