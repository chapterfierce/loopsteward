/**
 * Claw Task Service — Request Context Middleware (M3)
 *
 * Express-compatible middleware that establishes a request context
 * with request_id and trace_id using AsyncLocalStorage.
 *
 * This middleware must be registered FIRST, before any other middleware,
 * so that all subsequent middleware and route handlers can access
 * the request context via getRequestContext().
 *
 * Usage:
 *   import { contextMiddleware } from './context-middleware.js';
 *   app.use(contextMiddleware);
 */

import {
  extractRequestContext,
  runWithRequestContext,
} from './request-context.js';

/**
 * Express middleware that establishes request context.
 *
 * Wraps the entire request handling chain in an AsyncLocalStorage
 * context so that request_id and trace_id are available everywhere.
 */
export function contextMiddleware(req: any, res: any, next: any): void {
  const ctx = extractRequestContext(req);

  // Set response headers for client-side correlation
  res.setHeader('x-request-id', ctx.requestId);

  // Run the rest of the middleware chain within the context
  runWithRequestContext(ctx, () => {
    next();
  });
}
