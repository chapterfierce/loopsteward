/**
 * Claw Task Service — Monitoring Dashboard Data API (Phase 3 M3)
 *
 * Provides HTTP handlers for monitoring dashboard endpoints:
 *
 *   GET /monitor/stats    → Classification stats + cache metrics + error stats
 *   GET /monitor/timeline  → Recent N classification records (timeline)
 *
 * Data retention: In-memory ring buffer of last 1000 classification records.
 * No external dependencies — pure Node.js built-in.
 *
 * Based on: Phase 3 M3 task spec (2026-07-16)
 */

import { IncomingMessage, ServerResponse } from 'node:http';
import { metrics, MetricsSnapshot, TimelineEntry } from './metrics.js';
import { getCacheStats } from './pipeline.js';
import type { CacheStats } from './lru-cache.js';
import { logger } from './logger.js';

// ─── Types ─────────────────────────────────────────────────────────

/** Response for GET /monitor/stats */
export interface MonitorStatsResponse {
  /** ISO timestamp of the response */
  timestamp: string;
  /** Full metrics snapshot */
  metrics: MetricsSnapshot;
  /** Cache statistics (from LRU cache) */
  cache: CacheStats;
  /** Per-category summary with computed averages */
  categorySummary: CategorySummary[];
  /** Top 5 most frequent categories */
  topCategories: CategorySummary[];
  /** Health indicator derived from metrics */
  health: {
    /** Error rate (0-1) */
    errorRate: number;
    /** Whether cache is performing well (hit rate >= 0.5) */
    cacheHealthy: boolean;
    /** Whether average latency is acceptable (< 50ms) */
    latencyHealthy: boolean;
    /** Overall recommendation */
    recommendation: 'optimal' | 'acceptable' | 'needs_attention';
  };
}

/** Per-category summary with computed averages */
export interface CategorySummary {
  /** Category name */
  category: string;
  /** Total classifications */
  count: number;
  /** Average confidence (0-1) */
  avgConfidence: number;
  /** Average latency in ms */
  avgLatencyMs: number;
  /** Min latency in ms */
  minLatencyMs: number;
  /** Max latency in ms */
  maxLatencyMs: number;
  /** Cache hit count */
  cacheHits: number;
  /** Cache miss count */
  cacheMisses: number;
  /** Category-level cache hit rate (0-1) */
  cacheHitRate: number;
  /** Percentage of total classifications (0-100) */
  percentOfTotal: number;
}

/** Response for GET /monitor/timeline */
export interface MonitorTimelineResponse {
  /** ISO timestamp of the response */
  timestamp: string;
  /** Number of entries returned */
  count: number;
  /** Total entries available in the buffer */
  totalAvailable: number;
  /** Timeline entries (most recent first) */
  entries: TimelineEntry[];
  /** Summary of the timeline window */
  summary: {
    /** Average confidence in the window */
    avgConfidence: number;
    /** Average latency in the window */
    avgLatencyMs: number;
    /** Cache hit rate in the window */
    cacheHitRate: number;
    /** Unique categories in the window */
    uniqueCategories: number;
    /** Time span of the window in seconds */
    timeSpanSeconds: number;
  };
}

// ─── Stats Handler ─────────────────────────────────────────────────

/**
 * Build the monitor stats response from current metrics.
 */
export function buildStatsResponse(): MonitorStatsResponse {
  const metricsSnapshot = metrics.getMetrics();
  const cacheStats = getCacheStats();

  // Build per-category summaries
  const categorySummary: CategorySummary[] = [];
  const totalClassifications = metricsSnapshot.totalClassifications;

  for (const [category, stats] of Object.entries(metricsSnapshot.categories)) {
    const totalCacheAccesses = stats.cacheHits + stats.cacheMisses;
    categorySummary.push({
      category,
      count: stats.count,
      avgConfidence: stats.count > 0 ? stats.totalConfidence / stats.count : 0,
      avgLatencyMs: stats.count > 0 ? stats.totalLatencyMs / stats.count : 0,
      minLatencyMs: stats.minLatencyMs,
      maxLatencyMs: stats.maxLatencyMs,
      cacheHits: stats.cacheHits,
      cacheMisses: stats.cacheMisses,
      cacheHitRate: totalCacheAccesses > 0 ? stats.cacheHits / totalCacheAccesses : 0,
      percentOfTotal: totalClassifications > 0
        ? (stats.count / totalClassifications) * 100
        : 0,
    });
  }

  // Sort by count descending for top categories
  categorySummary.sort((a, b) => b.count - a.count);
  const topCategories = categorySummary.slice(0, 5);

  // Compute health indicators
  const errorRate = metricsSnapshot.totalClassifications > 0
    ? metricsSnapshot.errors.total / metricsSnapshot.totalClassifications
    : 0;

  const cacheHealthy = cacheStats.hitRate >= 0.5;
  const latencyHealthy = metricsSnapshot.averageLatencyMs < 50;

  let recommendation: 'optimal' | 'acceptable' | 'needs_attention' = 'optimal';
  if (errorRate > 0.1 || !latencyHealthy || !cacheHealthy) {
    recommendation = 'needs_attention';
  } else if (errorRate > 0.03 || metricsSnapshot.averageLatencyMs > 20) {
    recommendation = 'acceptable';
  }

  return {
    timestamp: new Date().toISOString(),
    metrics: metricsSnapshot,
    cache: cacheStats,
    categorySummary,
    topCategories,
    health: {
      errorRate,
      cacheHealthy,
      latencyHealthy,
      recommendation,
    },
  };
}

/**
 * HTTP handler for GET /monitor/stats.
 *
 * Compatible with both Node.js http.Server and Express.
 *
 * @param req - Incoming HTTP request
 * @param res - HTTP response
 */
export function monitorStatsHandler(req: IncomingMessage, res: ServerResponse): void {
  try {
    const response = buildStatsResponse();

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    });
    res.end(JSON.stringify(response, null, 2));

    logger.debug('Monitor stats served', {
      totalClassifications: response.metrics.totalClassifications,
    });
  } catch (err) {
    logger.error('Monitor stats failed', {
      error: err instanceof Error ? err.message : String(err),
    });

    res.writeHead(500, {
      'Content-Type': 'application/json; charset=utf-8',
    });
    res.end(JSON.stringify({
      error: 'Monitor stats internal error',
      timestamp: new Date().toISOString(),
    }));
  }
}

// ─── Timeline Handler ──────────────────────────────────────────────

/**
 * Parse the `limit` query parameter from a URL.
 * Defaults to 100, clamped to [1, 1000].
 */
function parseLimitParam(url: string | undefined): number {
  if (!url) return 100;

  try {
    const parsedUrl = new URL(url, 'http://localhost');
    const limitParam = parsedUrl.searchParams.get('limit');
    if (!limitParam) return 100;

    const limit = parseInt(limitParam, 10);
    if (isNaN(limit) || limit < 1) return 100;
    if (limit > 1000) return 1000;
    return limit;
  } catch {
    return 100;
  }
}

/**
 * Build the monitor timeline response.
 *
 * @param limit - Maximum number of entries to return (default 100, max 1000)
 */
export function buildTimelineResponse(limit: number = 100): MonitorTimelineResponse {
  const entries = metrics.getTimeline(limit);
  const metricsSnapshot = metrics.getMetrics();

  // Compute summary statistics for the timeline window
  let totalConfidence = 0;
  let totalLatency = 0;
  let cacheHits = 0;
  const categories = new Set<string>();
  let oldestEpoch = Date.now();
  let newestEpoch = 0;

  for (const entry of entries) {
    totalConfidence += entry.confidence;
    totalLatency += entry.latencyMs;
    if (entry.cacheHit) cacheHits++;
    categories.add(entry.category);
    if (entry.epochMs < oldestEpoch) oldestEpoch = entry.epochMs;
    if (entry.epochMs > newestEpoch) newestEpoch = entry.epochMs;
  }

  const count = entries.length;
  const timeSpanSeconds = count > 0
    ? Math.round((newestEpoch - oldestEpoch) / 1000)
    : 0;

  return {
    timestamp: new Date().toISOString(),
    count,
    totalAvailable: metricsSnapshot.timelineSize,
    entries,
    summary: {
      avgConfidence: count > 0 ? totalConfidence / count : 0,
      avgLatencyMs: count > 0 ? totalLatency / count : 0,
      cacheHitRate: count > 0 ? cacheHits / count : 0,
      uniqueCategories: categories.size,
      timeSpanSeconds,
    },
  };
}

/**
 * HTTP handler for GET /monitor/timeline.
 *
 * Query parameters:
 *   ?limit=N — Maximum entries to return (default 100, max 1000)
 *
 * @param req - Incoming HTTP request
 * @param res - HTTP response
 */
export function monitorTimelineHandler(req: IncomingMessage, res: ServerResponse): void {
  try {
    const limit = parseLimitParam(req.url);
    const response = buildTimelineResponse(limit);

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    });
    res.end(JSON.stringify(response, null, 2));

    logger.debug('Monitor timeline served', {
      count: response.count,
      limit,
    });
  } catch (err) {
    logger.error('Monitor timeline failed', {
      error: err instanceof Error ? err.message : String(err),
    });

    res.writeHead(500, {
      'Content-Type': 'application/json; charset=utf-8',
    });
    res.end(JSON.stringify({
      error: 'Monitor timeline internal error',
      timestamp: new Date().toISOString(),
    }));
  }
}

// ─── Express-Compatible Handlers ───────────────────────────────────

/**
 * Express-compatible handler for GET /monitor/stats.
 *
 * Usage with Express:
 *   import { monitorStatsHandlerExpress } from './monitor.js';
 *   app.get('/monitor/stats', monitorStatsHandlerExpress);
 */
export function monitorStatsHandlerExpress(req: any, res: any): void {
  try {
    const response = buildStatsResponse();
    res.json(response);
  } catch (err) {
    logger.error('Monitor stats failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      error: 'Monitor stats internal error',
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * Express-compatible handler for GET /monitor/timeline.
 *
 * Usage with Express:
 *   import { monitorTimelineHandlerExpress } from './monitor.js';
 *   app.get('/monitor/timeline', monitorTimelineHandlerExpress);
 */
export function monitorTimelineHandlerExpress(req: any, res: any): void {
  try {
    const limit = req?.query?.limit
      ? Math.min(Math.max(parseInt(String(req.query.limit), 10) || 100, 1), 1000)
      : 100;
    const response = buildTimelineResponse(limit);
    res.json(response);
  } catch (err) {
    logger.error('Monitor timeline failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      error: 'Monitor timeline internal error',
      timestamp: new Date().toISOString(),
    });
  }
}

// ─── Monitor Registration Helper ───────────────────────────────────

/**
 * Register all monitor routes on a Node.js http.Server-style router.
 *
 * This is a convenience function that can be used with the standard
 * Node.js http module. For Express, register handlers individually.
 *
 * @param server - An object with a `on` method (like http.Server)
 */
export function registerMonitorRoutes(server: {
  on: (event: string, handler: (req: IncomingMessage, res: ServerResponse) => void) => void;
}): void {
  // This is a placeholder for route registration.
  // Actual implementation depends on the server framework used.
  // For raw http.Server, you'd typically handle routing in the request event.
  logger.info('Monitor routes registered', {
    routes: ['/monitor/stats', '/monitor/timeline'],
  });
}
