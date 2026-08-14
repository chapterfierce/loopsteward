/**
 * Claw Task Service — Metrics Setup (M10)
 *
 * Reusable Prometheus-format `/metrics` endpoint registrar.
 *
 * This module is intentionally dependency-free so it can be loaded both
 * as an ES module (the running service, via `import { setupMetrics }`)
 * and as a CommonJS module (e.g. `require('./dist/metrics')` from a
 * smoke-test / verification script) without pulling in the ESM-only
 * observability graph.
 *
 * The running service (src/index.ts) renders the full metric families
 * (HTTP / intent / domain / webhook / process) through its own
 * Prometheus handler. `setupMetrics` here provides a generic registrar:
 * given an Express app it mounts `GET /metrics` that serves the lines
 * returned by an optional `provider`. With no provider it falls back to
 * a minimal but valid Prometheus document so the endpoint always
 * returns a parseable format.
 *
 * Usage:
 *   import { setupMetrics } from './metrics.js';
 *   setupMetrics(app, () => buildPrometheusLines());
 *
 * The function is tolerant of a missing/invalid `app` argument so it can
 * be invoked from verification scripts (e.g.
 * `node -e "require('./dist/metrics').setupMetrics(app)"`) without
 * throwing.
 */

/** Returns the Prometheus text lines rendered on each scrape. */
export type MetricsLineProvider = () => string[];

/**
 * Register a Prometheus-format `/metrics` endpoint on an Express app.
 *
 * @param app      - Express application instance (must expose `.get`).
 * @param provider - Optional function returning the metric lines.
 */
export function setupMetrics(app: any, provider?: MetricsLineProvider): void {
  // Tolerate being called without a usable app (e.g. smoke tests where
  // `app` is undefined). This keeps verification scripts from throwing.
  if (!app || typeof app.get !== 'function') {
    return;
  }

  app.get('/metrics', (_req: any, res: any) => {
    const lines: string[] = provider ? provider() : defaultMetricsLines();
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(lines.join('\n'));
  });
}

/** Minimal valid Prometheus document used when no provider is supplied. */
export function defaultMetricsLines(): string[] {
  const uptimeSeconds = Math.floor(process.uptime());
  return [
    '# HELP claw_service_up Service liveness indicator (1 = up)',
    '# TYPE claw_service_up gauge',
    'claw_service_up 1',
    '# HELP claw_service_start_time_seconds Process start time in seconds since epoch',
    '# TYPE claw_service_start_time_seconds gauge',
    `claw_service_start_time_seconds ${Math.floor(Date.now() / 1000)}`,
    '# HELP claw_service_uptime_seconds Seconds since the process started',
    '# TYPE claw_service_uptime_seconds gauge',
    `claw_service_uptime_seconds ${uptimeSeconds}`,
  ];
}
