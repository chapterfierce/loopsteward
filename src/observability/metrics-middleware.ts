/**
 * Claw Task Service — Metrics Middleware (M3)
 *
 * Express-compatible middleware that records HTTP metrics for each
 * request: count, latency, error rate per route.
 *
 * Usage:
 *   import { metricsMiddleware } from './metrics-middleware.js';
 *   app.use(metricsMiddleware);
 */

import { httpMetrics } from './http-metrics.js';
import { extractRequestContext, type RequestContext } from './request-context.js';

/**
 * Normalize a URL path to a route pattern.
 * e.g. /api/tasks/task-abc-123 → /api/tasks/:id
 *
 * Exported so the request-logging middleware can attach the same
 * normalized route label to access-log entries.
 */
export function normalizeRoute(path: string): string {
  // Replace UUID-like segments with :id
  let normalized = path.replace(/\/[a-f0-9-]{8,}\/?$/i, '/:id');
  // Replace numeric segments with :id
  normalized = normalized.replace(/\/\d+\/?$/g, '/:id');
  // Replace task-xxx segments
  normalized = normalized.replace(/\/task-[a-z0-9-]+\/?$/i, '/:id');
  return normalized || '/';
}

/**
 * Express middleware that records HTTP metrics.
 *
 * Must be placed before route handlers but after any body-parsing middleware.
 */
export function metricsMiddleware(req: any, res: any, next: any): void {
  const ctx: RequestContext = extractRequestContext(req);
  req.requestContext = ctx;

  httpMetrics.recordRequestStart();

  // Hook into response finish
  const originalEnd = res.end.bind(res);
  res.end = function (this: any, ...args: any[]): any {
    const latencyMs = Date.now() - ctx.startTimeMs;
    const route = normalizeRoute(ctx.path);
    httpMetrics.recordRequestEnd(ctx.method, route, res.statusCode, latencyMs);
    originalEnd(...args);
  };

  next();
}

export { httpMetrics };
