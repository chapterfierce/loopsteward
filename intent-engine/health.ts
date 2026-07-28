/**
 * Claw Task Service — Health Check Endpoint (Phase 3 M3)
 *
 * Provides HTTP health check handler returning service status, uptime,
 * version, and runtime statistics.
 *
 * Endpoint:
 *   GET /health → {
 *     status: 'healthy' | 'degraded' | 'unhealthy',
 *     uptime: number (seconds),
 *     version: string,
 *     timestamp: string,
 *     stats: {
 *       intentEngine: { ... },
 *       cache: { ... },
 *       errors: { ... },
 *       queueLength: number,
 *     }
 *   }
 *
 * Designed to work with Node.js http.Server or Express.
 * No external dependencies — pure Node.js built-in.
 *
 * Based on: Phase 3 M3 task spec (2026-07-16)
 */

import { IncomingMessage, ServerResponse } from 'node:http';
import { metrics, MetricsSnapshot } from './metrics.js';
import { getCacheStats } from './pipeline.js';
import { getRegexPoolStats } from './regex-pool.js';
import { logger } from './logger.js';

// ─── Types ─────────────────────────────────────────────────────────

/** Service health status */
export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

/** Intent engine sub-status */
export interface IntentEngineStatus {
  /** Whether the intent engine is operational */
  operational: boolean;
  /** Total classifications processed */
  totalClassifications: number;
  /** Average confidence (0-1) */
  averageConfidence: number;
  /** Average latency in ms */
  averageLatencyMs: number;
  /** Number of distinct categories seen */
  categoriesTracked: number;
  /** Whether the LRU cache is enabled */
  cacheEnabled: boolean;
  /** Regex pool statistics */
  regexPool: {
    compiledPatterns: number;
    poolSize: number;
  };
}

/** Cache sub-status for health check */
export interface CacheHealthStatus {
  /** Current cache size (entries) */
  size: number;
  /** Maximum cache capacity */
  capacity: number;
  /** Cache hit rate (0-1) */
  hitRate: number;
  /** Total hits */
  hits: number;
  /** Total misses */
  misses: number;
  /** Total evictions */
  evictions: number;
  /** Total expirations */
  expirations: number;
}

/** Error sub-status for health check */
export interface ErrorHealthStatus {
  /** Total errors recorded */
  total: number;
  /** Classification errors */
  classificationErrors: number;
  /** Parse errors */
  parseErrors: number;
  /** Timeouts */
  timeouts: number;
  /** Cache errors */
  cacheErrors: number;
  /** Most recent error timestamp (if any) */
  lastErrorAt?: string;
}

/** Full health response body */
export interface HealthResponse {
  /** Service health status */
  status: HealthStatus;
  /** Service uptime in seconds */
  uptime: number;
  /** Service version */
  version: string;
  /** ISO timestamp of the health check */
  timestamp: string;
  /** Detailed statistics */
  stats: {
    intentEngine: IntentEngineStatus;
    cache: CacheHealthStatus;
    errors: ErrorHealthStatus;
    /** Approximate event loop queue length */
    queueLength: number;
  };
}

// ─── Health Check Configuration ────────────────────────────────────

/** Service version (synced with package.json) */
const SERVICE_VERSION = '3.3.0';

/** Service start time for uptime calculation */
const startTime = Date.now();

/** Track the last error timestamp for health checks */
let lastErrorTimestamp: string | undefined = undefined;

/**
 * Set the last error timestamp.
 * Called when an error is recorded by the metrics system.
 */
export function setLastErrorTimestamp(timestamp: string): void {
  lastErrorTimestamp = timestamp;
}

// ─── Health Status Computation ─────────────────────────────────────

/**
 * Compute the overall health status based on metrics.
 *
 * Rules:
 *   - 'unhealthy' if error rate > 50% of total classifications
 *   - 'degraded' if error rate > 10% OR cache hit rate < 0.3 (when cache is active)
 *   - 'healthy' otherwise
 */
function computeHealthStatus(
  metricsSnapshot: MetricsSnapshot,
  cacheStats: ReturnType<typeof getCacheStats>,
): HealthStatus {
  const total = metricsSnapshot.totalClassifications;
  const errors = metricsSnapshot.errors.total;

  // If no classifications yet, we're healthy
  if (total === 0) return 'healthy';

  const errorRate = errors / total;

  // Unhealthy: more than 50% errors
  if (errorRate > 0.5) return 'unhealthy';

  // Degraded: more than 10% errors
  if (errorRate > 0.1) return 'degraded';

  // Degraded: cache hit rate below 30% when there's been sufficient traffic
  const totalCacheAccesses = cacheStats.hits + cacheStats.misses;
  if (totalCacheAccesses > 50 && cacheStats.hitRate < 0.3) {
    return 'degraded';
  }

  return 'healthy';
}

/**
 * Build the intent engine status from metrics.
 */
function buildIntentEngineStatus(
  metricsSnapshot: MetricsSnapshot,
): IntentEngineStatus {
  const regexPoolStats = getRegexPoolStats();
  return {
    operational: true,
    totalClassifications: metricsSnapshot.totalClassifications,
    averageConfidence: metricsSnapshot.averageConfidence,
    averageLatencyMs: metricsSnapshot.averageLatencyMs,
    categoriesTracked: Object.keys(metricsSnapshot.categories).length,
    cacheEnabled: true,
    regexPool: {
      // Sum of all compiled pattern groups (was `compiledCount`, a field that
      // never existed on the stats object and silently reported undefined).
      compiledPatterns:
        regexPoolStats.rulesCompiled +
        regexPoolStats.priorityKeywordsCompiled +
        regexPoolStats.duePatternsCompiled +
        regexPoolStats.assigneePatternsCompiled,
      poolSize: regexPoolStats.poolSize,
    },
  };
}

/**
 * Build the cache health status from cache stats.
 */
function buildCacheStatus(
  cacheStats: ReturnType<typeof getCacheStats>,
): CacheHealthStatus {
  return {
    size: cacheStats.size,
    capacity: cacheStats.capacity,
    hitRate: cacheStats.hitRate,
    hits: cacheStats.hits,
    misses: cacheStats.misses,
    evictions: cacheStats.evictions,
    expirations: cacheStats.expirations,
  };
}

/**
 * Build the error health status from metrics.
 */
function buildErrorStatus(
  metricsSnapshot: MetricsSnapshot,
): ErrorHealthStatus {
  return {
    total: metricsSnapshot.errors.total,
    classificationErrors: metricsSnapshot.errors.classificationErrors,
    parseErrors: metricsSnapshot.errors.parseErrors,
    timeouts: metricsSnapshot.errors.timeouts,
    cacheErrors: metricsSnapshot.errors.cacheErrors,
    lastErrorAt: lastErrorTimestamp,
  };
}

/**
 * Estimate the event loop queue length.
 * Uses process._getActiveHandles() count as a rough proxy.
 */
function getQueueLength(): number {
  try {
    // @ts-expect-error: Internal Node.js API
    const handles = process._getActiveHandles?.() ?? [];
    return handles.length;
  } catch {
    return 0;
  }
}

// ─── Health Check Handler ──────────────────────────────────────────

/**
 * Build the full health response object.
 */
export function buildHealthResponse(): HealthResponse {
  const metricsSnapshot = metrics.getMetrics();
  const cacheStats = getCacheStats();

  return {
    status: computeHealthStatus(metricsSnapshot, cacheStats),
    uptime: Math.round((Date.now() - startTime) / 1000),
    version: SERVICE_VERSION,
    timestamp: new Date().toISOString(),
    stats: {
      intentEngine: buildIntentEngineStatus(metricsSnapshot),
      cache: buildCacheStatus(cacheStats),
      errors: buildErrorStatus(metricsSnapshot),
      queueLength: getQueueLength(),
    },
  };
}

/**
 * HTTP handler for GET /health.
 *
 * Compatible with both Node.js http.Server and Express.
 *
 * @param req - Incoming HTTP request
 * @param res - HTTP response
 */
export function healthHandler(req: IncomingMessage, res: ServerResponse): void {
  try {
    const response = buildHealthResponse();

    // Set appropriate HTTP status code
    const statusCode = response.status === 'healthy'
      ? 200
      : response.status === 'degraded'
        ? 200 // Degraded is still operational
        : 503; // Unhealthy returns 503 Service Unavailable

    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    });
    res.end(JSON.stringify(response, null, 2));

    // Log the health check at DEBUG level
    logger.debug('Health check served', {
      status: response.status,
      uptime: response.uptime,
    });
  } catch (err) {
    // If health check itself fails, return 500
    logger.error('Health check failed', {
      error: err instanceof Error ? err.message : String(err),
    });

    res.writeHead(500, {
      'Content-Type': 'application/json; charset=utf-8',
    });
    res.end(JSON.stringify({
      status: 'unhealthy',
      error: 'Health check internal error',
      timestamp: new Date().toISOString(),
    }));
  }
}

// ─── Express-Compatible Handler ────────────────────────────────────

/**
 * Express-compatible health check handler.
 *
 * Usage with Express:
 *   import { healthHandlerExpress } from './health.js';
 *   app.get('/health', healthHandlerExpress);
 *
 * @param req - Express request (typed as any for zero-dependency)
 * @param res - Express response (typed as any for zero-dependency)
 */
export function healthHandlerExpress(req: any, res: any): void {
  try {
    const response = buildHealthResponse();

    const statusCode = response.status === 'healthy'
      ? 200
      : response.status === 'degraded'
        ? 200
        : 503;

    res.status(statusCode).json(response);
  } catch (err) {
    logger.error('Health check failed', {
      error: err instanceof Error ? err.message : String(err),
    });

    res.status(500).json({
      status: 'unhealthy',
      error: 'Health check internal error',
      timestamp: new Date().toISOString(),
    });
  }
}

// ─── Utility: Get Service Info ─────────────────────────────────────

/**
 * Get basic service information (without full health check).
 * Useful for lightweight status pings.
 */
export function getServiceInfo(): {
  status: HealthStatus;
  version: string;
  uptime: number;
} {
  const metricsSnapshot = metrics.getMetrics();
  const cacheStats = getCacheStats();
  return {
    status: computeHealthStatus(metricsSnapshot, cacheStats),
    version: SERVICE_VERSION,
    uptime: Math.round((Date.now() - startTime) / 1000),
  };
}
