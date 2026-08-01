/**
 * Claw Task Service — Observability Middleware Bundle (M3)
 *
 * Convenience module that bundles all observability middleware into
 * a single registration function for Express apps.
 *
 * Usage:
 *   import { setupObservability } from './observability/index.js';
 *   const app = express();
 *   setupObservability(app);
 *
 * This registers:
 *   1. Request context middleware (request_id + trace_id)
 *   2. Metrics middleware (HTTP request tracking)
 *   3. Tracing middleware (span creation per request)
 *   4. /health endpoint
 *   5. /health/live endpoint (liveness)
 *   6. /health/ready endpoint (readiness)
 *   7. /metrics endpoint (Prometheus-style JSON metrics)
 */

import { contextMiddleware } from './context-middleware.js';
import { metricsMiddleware } from './metrics-middleware.js';
import { tracingMiddleware } from './http-tracing.js';
import {
  healthCheckHandler,
  livenessHandler,
  readinessHandler,
} from './health-check.js';
import { httpMetrics } from './http-metrics.js';
import { serviceLogger } from './service-logger.js';

/**
 * Set up all observability middleware on an Express app.
 *
 * @param app - Express application instance
 * @param options - Optional configuration
 */
export function setupObservability(
  app: any,
  options?: {
    healthPath?: string;
    metricsPath?: string;
    enableTracing?: boolean;
    skipMetricsEndpoint?: boolean;
  },
): void {
  const opts = {
    healthPath: options?.healthPath ?? '/health',
    metricsPath: options?.metricsPath ?? '/metrics',
    enableTracing: options?.enableTracing ?? true,
    skipMetricsEndpoint: options?.skipMetricsEndpoint ?? false,
  };

  // Order matters: context first, then metrics, then tracing
  app.use(contextMiddleware);
  app.use(metricsMiddleware);
  if (opts.enableTracing) {
    app.use(tracingMiddleware);
  }

  // Health endpoints
  app.get(opts.healthPath, healthCheckHandler);
  app.get(`${opts.healthPath}/live`, livenessHandler);
  app.get(`${opts.healthPath}/ready`, readinessHandler);

  // Metrics endpoint (JSON format; can be overridden by caller for Prometheus format)
  if (!opts.skipMetricsEndpoint) {
    app.get(opts.metricsPath, (req: any, res: any) => {
      const snapshot = httpMetrics.getMetrics();
      res.json({
        timestamp: snapshot.timestamp,
        http: snapshot,
      });
    });
  }

  serviceLogger.info('Observability middleware registered', {
    healthPath: opts.healthPath,
    metricsPath: opts.metricsPath,
    tracing: opts.enableTracing,
  });
}

// ─── Re-exports ────────────────────────────────────────────────────

export { contextMiddleware } from './context-middleware.js';
export { metricsMiddleware } from './metrics-middleware.js';
export { tracingMiddleware } from './http-tracing.js';
export { healthCheckHandler, livenessHandler, readinessHandler } from './health-check.js';
export { httpMetrics } from './http-metrics.js';
export { serviceLogger, ServiceLogger, type StructuredLogEntry, type LogLevel } from './service-logger.js';
export {
  extractRequestContext,
  runWithRequestContext,
  getRequestContext,
  getRequestId,
  getTraceId,
  type RequestContext,
} from './request-context.js';
export {
  startHttpSpan,
  endHttpSpan,
  startChildSpan,
  endChildSpan,
  injectTraceHeaders,
} from './http-tracing.js';
export {
  buildHealthResponse,
  type ServiceHealthResponse,
  type DependencyCheck,
  type HealthStatus,
} from './health-check.js';
export {
  type HttpMetricsSnapshot,
  type RouteMetrics,
  type LatencyBucket,
} from './http-metrics.js';
