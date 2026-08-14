/**
 * Claw Task Service — Request Logging Middleware (M10)
 *
 * Structured per-request access log. Emits exactly one log line per
 * completed HTTP request containing:
 *   - method   (HTTP method, e.g. GET)
 *   - path     (raw request path, e.g. /api/tasks/task-xxx-0001)
 *   - route    (normalized pattern, e.g. /api/tasks/:id)
 *   - statusCode
 *   - latencyMs (request duration)
 *   - requestId / traceId (from request context)
 *
 * Usage:
 *   import { requestLoggingMiddleware } from './request-logging.js';
 *   app.use(requestLoggingMiddleware);
 *
 * Must be registered after the request-context middleware so the
 * RequestContext (requestId/traceId/method/path) is populated.
 */

import { serviceLogger } from './service-logger.js';
import { extractRequestContext, type RequestContext } from './request-context.js';
import { normalizeRoute } from './metrics-middleware.js';

/**
 * Express middleware that logs one structured line per request with
 * method, path, status code and duration.
 *
 * Mounted in src/index.ts right after the observability bundle so it
 * sits before all route handlers.
 */
export function requestLoggingMiddleware(req: any, res: any, next: any): void {
  const ctx: RequestContext = extractRequestContext(req);
  const startedAt = ctx.startTimeMs;

  const originalEnd = res.end.bind(res);
  res.end = function (this: any, ...args: any[]): any {
    const latencyMs = Date.now() - startedAt;
    const statusCode = res.statusCode;

    serviceLogger.request('HTTP request completed', ctx, statusCode, latencyMs, {
      route: normalizeRoute(ctx.path),
      contentLength: res.getHeader('content-length') as number | undefined,
    });

    return originalEnd(...args);
  };

  next();
}

export { serviceLogger };
