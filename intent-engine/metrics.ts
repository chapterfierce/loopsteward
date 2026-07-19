/**
 * Claw Task Service — Metrics Collector (Phase 3 M3)
 *
 * Provides comprehensive metrics collection for intent classification:
 *   - Per-category statistics: call count, hit rate, latency
 *   - Cache metrics: hit/miss/eviction/expiration/hitRate
 *   - Error statistics: classification errors, parse errors, timeouts
 *   - Timeline: in-memory ring buffer of recent classification records
 *
 * Interfaces:
 *   - recordClassification(result: IntentResult): void
 *   - recordCacheHit() / recordCacheMiss() / recordCacheEviction() / recordCacheExpiration()
 *   - recordError(type: ErrorType, category?: TaskIntentCategory): void
 *   - getMetrics(): MetricsSnapshot
 *   - getTimeline(limit?: number): TimelineEntry[]
 *   - resetMetrics(): void
 *
 * No external dependencies — pure Node.js built-in.
 *
 * Based on: Phase 3 M3 task spec (2026-07-16)
 */

import { IntentResult, TaskIntentCategory } from './types';

// ─── Types ─────────────────────────────────────────────────────────

/** Error types tracked by the metrics collector */
export type ErrorType =
  | 'classification_error'
  | 'parse_error'
  | 'timeout'
  | 'cache_error';

/** Per-category statistics */
export interface CategoryStats {
  /** Total classifications for this category */
  count: number;
  /** Number of high-confidence results (>= 0.85) */
  highConfidenceCount: number;
  /** Number of low-confidence results (< 0.50) */
  lowConfidenceCount: number;
  /** Sum of confidence values (for computing average) */
  totalConfidence: number;
  /** Sum of processing time in ms (for computing average) */
  totalLatencyMs: number;
  /** Minimum latency observed */
  minLatencyMs: number;
  /** Maximum latency observed */
  maxLatencyMs: number;
  /** Number of times this category was a cache hit */
  cacheHits: number;
  /** Number of times this category was a cache miss */
  cacheMisses: number;
}

/** Cache metrics snapshot */
export interface CacheMetrics {
  hits: number;
  misses: number;
  evictions: number;
  expirations: number;
  /** Hit rate (0-1). Returns 0 if no accesses. */
  hitRate: number;
}

/** Error metrics snapshot */
export interface ErrorMetrics {
  classificationErrors: number;
  parseErrors: number;
  timeouts: number;
  cacheErrors: number;
  /** Total errors across all types */
  total: number;
  /** Errors by category (if applicable) */
  byCategory: Partial<Record<TaskIntentCategory, number>>;
}

/** A single timeline entry recording one classification event */
export interface TimelineEntry {
  /** ISO timestamp of the event */
  timestamp: string;
  /** Epoch milliseconds */
  epochMs: number;
  /** Classified category */
  category: TaskIntentCategory;
  /** Sub-category */
  subCategory: string;
  /** Confidence score [0, 1] */
  confidence: number;
  /** Processing time in ms */
  latencyMs: number;
  /** Whether this was a cache hit */
  cacheHit: boolean;
  /** Whether the result was ambiguous */
  ambiguous: boolean;
  /** Input text length */
  inputLength: number;
}

/** Full metrics snapshot returned by getMetrics() */
export interface MetricsSnapshot {
  /** ISO timestamp of the snapshot */
  timestamp: string;
  /** Total classifications recorded */
  totalClassifications: number;
  /** Per-category statistics */
  categories: Record<string, CategoryStats>;
  /** Cache metrics */
  cache: CacheMetrics;
  /** Error metrics */
  errors: ErrorMetrics;
  /** Average confidence across all classifications */
  averageConfidence: number;
  /** Average latency across all classifications */
  averageLatencyMs: number;
  /** Number of ambiguous results */
  ambiguousCount: number;
  /** Timeline entries currently in the ring buffer */
  timelineSize: number;
  /** Maximum timeline entries (ring buffer capacity) */
  timelineCapacity: number;
}

// ─── Metrics Collector ─────────────────────────────────────────────

/** Maximum timeline entries kept in memory (ring buffer) */
const MAX_TIMELINE_ENTRIES = 1000;

/**
 * Central metrics collector for intent classification.
 *
 * Maintains:
 *   - Per-category stats in a Map
 *   - Cache hit/miss/eviction/expiration counters
 *   - Error counters by type
 *   - A ring buffer of recent TimelineEntry records (up to 1000)
 *
 * All methods are synchronous and thread-safe in Node's single-threaded model.
 */
class MetricsCollector {
  private categoryStats: Map<string, CategoryStats> = new Map();
  private totalClassifications: number = 0;
  private totalConfidence: number = 0;
  private totalLatencyMs: number = 0;
  private ambiguousCount: number = 0;

  // Cache metrics
  private cacheHits: number = 0;
  private cacheMisses: number = 0;
  private cacheEvictions: number = 0;
  private cacheExpirations: number = 0;

  // Error metrics
  private classificationErrors: number = 0;
  private parseErrors: number = 0;
  private timeouts: number = 0;
  private cacheErrors: number = 0;
  private errorsByCategory: Map<string, number> = new Map();

  // Timeline ring buffer
  private timeline: TimelineEntry[] = [];
  private timelineHead: number = 0;

  // ─── Classification Recording ──────────────────────────────────

  /**
   * Record a classification result.
   * Updates per-category stats, aggregate stats, and timeline.
   *
   * @param result - The IntentResult from classification
   * @param cacheHit - Whether this result came from the cache
   */
  recordClassification(result: IntentResult, cacheHit: boolean = false): void {
    this.totalClassifications++;
    this.totalConfidence += result.confidence;
    this.totalLatencyMs += result.meta.processingTimeMs;

    if (result.ambiguous) {
      this.ambiguousCount++;
    }

    // Update per-category stats
    const catKey = result.category as string;
    let stats = this.categoryStats.get(catKey);
    if (!stats) {
      stats = {
        count: 0,
        highConfidenceCount: 0,
        lowConfidenceCount: 0,
        totalConfidence: 0,
        totalLatencyMs: 0,
        minLatencyMs: Infinity,
        maxLatencyMs: 0,
        cacheHits: 0,
        cacheMisses: 0,
      };
      this.categoryStats.set(catKey, stats);
    }

    stats.count++;
    stats.totalConfidence += result.confidence;
    stats.totalLatencyMs += result.meta.processingTimeMs;

    if (result.confidence >= 0.85) {
      stats.highConfidenceCount++;
    }
    if (result.confidence < 0.50) {
      stats.lowConfidenceCount++;
    }

    const latency = result.meta.processingTimeMs;
    if (latency < stats.minLatencyMs) stats.minLatencyMs = latency;
    if (latency > stats.maxLatencyMs) stats.maxLatencyMs = latency;

    if (cacheHit) {
      stats.cacheHits++;
    } else {
      stats.cacheMisses++;
    }

    // Add to timeline
    this.pushTimelineEntry({
      timestamp: new Date().toISOString(),
      epochMs: Date.now(),
      category: result.category,
      subCategory: result.subCategory,
      confidence: result.confidence,
      latencyMs: result.meta.processingTimeMs,
      cacheHit,
      ambiguous: result.ambiguous,
      inputLength: result.meta.inputLength,
    });
  }

  // ─── Cache Metrics ─────────────────────────────────────────────

  /** Record a cache hit */
  recordCacheHit(): void {
    this.cacheHits++;
  }

  /** Record a cache miss */
  recordCacheMiss(): void {
    this.cacheMisses++;
  }

  /** Record a cache eviction */
  recordCacheEviction(): void {
    this.cacheEvictions++;
  }

  /** Record a cache expiration */
  recordCacheExpiration(): void {
    this.cacheExpirations++;
  }

  // ─── Error Metrics ─────────────────────────────────────────────

  /**
   * Record an error event.
   * @param type - The error type
   * @param category - Optional category context where the error occurred
   */
  recordError(type: ErrorType, category?: TaskIntentCategory): void {
    switch (type) {
      case 'classification_error':
        this.classificationErrors++;
        break;
      case 'parse_error':
        this.parseErrors++;
        break;
      case 'timeout':
        this.timeouts++;
        break;
      case 'cache_error':
        this.cacheErrors++;
        break;
    }

    if (category) {
      const key = category as string;
      this.errorsByCategory.set(key, (this.errorsByCategory.get(key) || 0) + 1);
    }
  }

  // ─── Snapshot ──────────────────────────────────────────────────

  /**
   * Get a full metrics snapshot.
   * Returns a serializable object suitable for JSON responses.
   */
  getMetrics(): MetricsSnapshot {
    const totalCacheAccesses = this.cacheHits + this.cacheMisses;
    const totalErrors =
      this.classificationErrors +
      this.parseErrors +
      this.timeouts +
      this.cacheErrors;

    // Build categories record
    const categories: Record<string, CategoryStats> = {};
    for (const [key, stats] of this.categoryStats) {
      categories[key] = { ...stats };
      // Normalize Infinity minLatencyMs to 0 if no data
      if (categories[key].minLatencyMs === Infinity) {
        categories[key].minLatencyMs = 0;
      }
    }

    // Build errors by category
    const byCategory: Partial<Record<TaskIntentCategory, number>> = {};
    for (const [key, val] of this.errorsByCategory) {
      byCategory[key as TaskIntentCategory] = val;
    }

    return {
      timestamp: new Date().toISOString(),
      totalClassifications: this.totalClassifications,
      categories,
      cache: {
        hits: this.cacheHits,
        misses: this.cacheMisses,
        evictions: this.cacheEvictions,
        expirations: this.cacheExpirations,
        hitRate: totalCacheAccesses === 0 ? 0 : this.cacheHits / totalCacheAccesses,
      },
      errors: {
        classificationErrors: this.classificationErrors,
        parseErrors: this.parseErrors,
        timeouts: this.timeouts,
        cacheErrors: this.cacheErrors,
        total: totalErrors,
        byCategory,
      },
      averageConfidence: this.totalClassifications === 0
        ? 0
        : this.totalConfidence / this.totalClassifications,
      averageLatencyMs: this.totalClassifications === 0
        ? 0
        : this.totalLatencyMs / this.totalClassifications,
      ambiguousCount: this.ambiguousCount,
      timelineSize: this.timeline.length,
      timelineCapacity: MAX_TIMELINE_ENTRIES,
    };
  }

  // ─── Timeline ──────────────────────────────────────────────────

  /**
   * Get recent timeline entries.
   * @param limit - Maximum number of entries to return (default 100)
   * @returns Array of timeline entries, most recent first
   */
  getTimeline(limit: number = 100): TimelineEntry[] {
    const effectiveLimit = Math.min(limit, this.timeline.length);
    if (effectiveLimit === 0) return [];

    // Collect entries in reverse chronological order
    const result: TimelineEntry[] = [];
    const count = this.timeline.length;
    for (let i = 0; i < effectiveLimit; i++) {
      // Start from the most recently inserted entry
      const idx = (this.timelineHead - 1 - i + count) % count;
      result.push(this.timeline[idx]);
    }
    return result;
  }

  // ─── Reset ─────────────────────────────────────────────────────

  /**
   * Reset all metrics to zero and clear the timeline.
   */
  resetMetrics(): void {
    this.categoryStats.clear();
    this.totalClassifications = 0;
    this.totalConfidence = 0;
    this.totalLatencyMs = 0;
    this.ambiguousCount = 0;

    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.cacheEvictions = 0;
    this.cacheExpirations = 0;

    this.classificationErrors = 0;
    this.parseErrors = 0;
    this.timeouts = 0;
    this.cacheErrors = 0;
    this.errorsByCategory.clear();

    this.timeline = [];
    this.timelineHead = 0;
  }

  // ─── Internal: Ring Buffer ─────────────────────────────────────

  /**
   * Push a timeline entry into the ring buffer.
   * If the buffer is full, overwrites the oldest entry.
   */
  private pushTimelineEntry(entry: TimelineEntry): void {
    if (this.timeline.length < MAX_TIMELINE_ENTRIES) {
      // Buffer not yet full — simply append
      this.timeline.push(entry);
      this.timelineHead = this.timeline.length; // Next write position
    } else {
      // Buffer full — overwrite oldest entry (ring buffer)
      this.timeline[this.timelineHead] = entry;
      this.timelineHead = (this.timelineHead + 1) % MAX_TIMELINE_ENTRIES;
    }
  }
}

// ─── Singleton Export ──────────────────────────────────────────────

/**
 * Global singleton metrics collector instance.
 *
 * Usage:
 *   import { metrics } from './metrics';
 *   metrics.recordClassification(result, pipelineResult.cacheHit);
 *   const snapshot = metrics.getMetrics();
 */
export const metrics = new MetricsCollector();

/**
 * Get the singleton MetricsCollector instance.
 * Convenience function for explicit access.
 */
export function getMetricsCollector(): MetricsCollector {
  return metrics;
}

// ─── Export the class for testing/custom instances ─────────────────

export { MetricsCollector };
