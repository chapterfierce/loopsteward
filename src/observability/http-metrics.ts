/**
 * Claw Task Service — HTTP Metrics Collector (M3)
 *
 * Service-level HTTP request metrics:
 *   - Request count per method/route/status
 *   - Latency histogram (bucketed)
 *   - Error rate tracking
 *   - Active in-flight request gauge
 *
 * Designed to be used as Express middleware or directly instrumented.
 * Zero external dependencies.
 */

// ─── Types ─────────────────────────────────────────────────────────

export interface RouteMetrics {
  method: string;
  route: string;
  count: number;
  errorCount: number;
  totalLatencyMs: number;
  minLatencyMs: number;
  maxLatencyMs: number;
  statusBreakdown: Record<number, number>;
}

export interface LatencyBucket {
  /** Upper bound of the bucket in ms (inclusive) */
  upperBoundMs: number;
  /** Number of requests in this bucket */
  count: number;
}

export interface HttpMetricsSnapshot {
  timestamp: string;
  totalRequests: number;
  totalErrors: number;
  errorRate: number;
  inFlightRequests: number;
  routes: RouteMetrics[];
  latencyHistogram: LatencyBucket[];
  averageLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
}

// ─── Latency Histogram Buckets ─────────────────────────────────────

const DEFAULT_BUCKETS = [
  1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000,
];

// ─── HTTP Metrics Collector ────────────────────────────────────────

class HttpMetricsCollector {
  private routeMetrics: Map<string, RouteMetrics> = new Map();
  private totalRequests: number = 0;
  private totalErrors: number = 0;
  private totalLatencyMs: number = 0;
  private inFlightRequests: number = 0;
  private latencyValues: number[] = [];
  private latencyBuckets: LatencyBucket[];
  private maxLatencySamples: number = 10000;

  constructor(buckets: number[] = DEFAULT_BUCKETS) {
    this.latencyBuckets = buckets.map(upperBoundMs => ({
      upperBoundMs,
      count: 0,
    }));
  }

  // ─── Recording ─────────────────────────────────────────────────

  /** Record the start of a request (increments in-flight gauge). */
  recordRequestStart(): void {
    this.inFlightRequests++;
  }

  /** Record the completion of a request. */
  recordRequestEnd(
    method: string,
    route: string,
    statusCode: number,
    latencyMs: number,
  ): void {
    this.inFlightRequests = Math.max(0, this.inFlightRequests - 1);
    this.totalRequests++;
    this.totalLatencyMs += latencyMs;

    // Track errors (4xx and 5xx)
    if (statusCode >= 400) {
      this.totalErrors++;
    }

    // Per-route metrics
    const key = `${method} ${route}`;
    let routeMetrics = this.routeMetrics.get(key);
    if (!routeMetrics) {
      routeMetrics = {
        method,
        route,
        count: 0,
        errorCount: 0,
        totalLatencyMs: 0,
        minLatencyMs: Infinity,
        maxLatencyMs: 0,
        statusBreakdown: {},
      };
      this.routeMetrics.set(key, routeMetrics);
    }

    routeMetrics.count++;
    routeMetrics.totalLatencyMs += latencyMs;
    if (latencyMs < routeMetrics.minLatencyMs) routeMetrics.minLatencyMs = latencyMs;
    if (latencyMs > routeMetrics.maxLatencyMs) routeMetrics.maxLatencyMs = latencyMs;
    routeMetrics.statusBreakdown[statusCode] = (routeMetrics.statusBreakdown[statusCode] || 0) + 1;

    if (statusCode >= 400) {
      routeMetrics.errorCount++;
    }

    // Latency histogram
    for (const bucket of this.latencyBuckets) {
      if (latencyMs <= bucket.upperBoundMs) {
        bucket.count++;
        break;
      }
    }

    // Store latency samples for percentile calculation
    this.latencyValues.push(latencyMs);
    if (this.latencyValues.length > this.maxLatencySamples) {
      // Drop oldest 50% to prevent unbounded growth
      this.latencyValues = this.latencyValues.slice(Math.floor(this.maxLatencySamples / 2));
    }
  }

  // ─── Snapshot ──────────────────────────────────────────────────

  getMetrics(): HttpMetricsSnapshot {
    const routes = [...this.routeMetrics.values()].sort((a, b) => b.count - a.count);

    return {
      timestamp: new Date().toISOString(),
      totalRequests: this.totalRequests,
      totalErrors: this.totalErrors,
      errorRate: this.totalRequests === 0 ? 0 : this.totalErrors / this.totalRequests,
      inFlightRequests: this.inFlightRequests,
      routes,
      latencyHistogram: [...this.latencyBuckets],
      averageLatencyMs: this.totalRequests === 0 ? 0 : this.totalLatencyMs / this.totalRequests,
      p50LatencyMs: this.percentile(50),
      p95LatencyMs: this.percentile(95),
      p99LatencyMs: this.percentile(99),
    };
  }

  // ─── Percentile Calculation ────────────────────────────────────

  private percentile(p: number): number {
    if (this.latencyValues.length === 0) return 0;
    const sorted = [...this.latencyValues].sort((a, b) => a - b);
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
  }

  // ─── Reset ─────────────────────────────────────────────────────

  reset(): void {
    this.routeMetrics.clear();
    this.totalRequests = 0;
    this.totalErrors = 0;
    this.totalLatencyMs = 0;
    this.inFlightRequests = 0;
    this.latencyValues = [];
    this.latencyBuckets = this.latencyBuckets.map(b => ({ ...b, count: 0 }));
  }
}

// ─── Singleton ─────────────────────────────────────────────────────

export const httpMetrics = new HttpMetricsCollector();

export { HttpMetricsCollector };
