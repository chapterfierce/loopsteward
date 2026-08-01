/**
 * Claw Task Service — Intent Pipeline (Phase 2.5)
 *
 * Integration pipeline that connects the intent engine to the task service.
 * Provides a unified entry point for classifying user messages and routing
 * them to the appropriate task service handlers.
 *
 * Pipeline flow:
 *   User Input → Preprocess → Classify → Entity Extract → Disambiguate → Route
 *
 * Usage:
 *   import { IntentPipeline, classifyIntent } from './intent-engine/pipeline.js';
 *   const result = classifyIntent('创建登录页重构任务');
 */

import {
  TaskIntentCategory,
  TaskSubCategory,
  TaskEntity,
  IntentRequest,
  IntentResult,
  IntentContext,
  AlternativeIntent,
  ConfidenceAction,
  getConfidenceAction,
} from './types.js';
import { classify, classifyText, classifyBatch } from './classifier.js';
import { preprocess } from './preprocessor.js';
import { extractEntities } from './entity-extractor.js';
import { IntentLRUCache, CacheStats } from './lru-cache.js';
import { metrics } from './metrics.js';
import { LLMFallbackClassifier, fallbackToRegex } from './llm-fallback.js';
import { tracer, type Trace, type Span } from './tracer.js';
import { logger } from './logger.js';

// ─── Pipeline Configuration ─────────────────────────────────────────

export interface PipelineConfig {
  /** Enable entity extraction in pipeline output */
  enableEntityExtraction: boolean;
  /** Enable disambiguation logging */
  enableDisambiguationLog: boolean;
  /** Minimum confidence for direct execution */
  directExecutionThreshold: number;
  /** Enable context-aware classification */
  enableContext: boolean;
  /** Maximum alternatives to return */
  maxAlternatives: number;
  /** Enable LRU cache for intent classification (Phase 3 M1) */
  enableCache: boolean;
  /** Cache capacity (default 1000) */
  cacheCapacity: number;
  /** Cache TTL in milliseconds (default 300000 = 5min) */
  cacheTtlMs: number;
  /** Enable LLM Fallback when regex confidence is below threshold (Phase 3 M6) */
  enableLLMFallback: boolean;
  /** LLM Fallback confidence threshold — below this, trigger LLM (default 0.5) */
  llmFallbackThreshold: number;
}

const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  enableEntityExtraction: true,
  enableDisambiguationLog: false,
  directExecutionThreshold: 0.70,
  enableContext: true,
  maxAlternatives: 3,
  enableCache: true,
  cacheCapacity: 1000,
  cacheTtlMs: 300_000,
  enableLLMFallback: false,
  llmFallbackThreshold: 0.5,
};

// ─── Pipeline Result ────────────────────────────────────────────────

/**
 * Extended IntentResult with pipeline-specific metadata.
 */
export interface PipelineResult extends IntentResult {
  /** Recommended action based on confidence */
  recommendedAction: ConfidenceAction;
  /** Route handler name for this intent */
  routeHandler: string;
  /** Whether the pipeline used context */
  contextInfluenced: boolean;
  /** Pipeline version */
  pipelineVersion: string;
  /** Whether this result came from the LRU cache (Phase 3 M1) */
  cacheHit: boolean;
  /** Whether this result was produced by LLM Fallback (Phase 3 M6) */
  llmFallbackUsed: boolean;
}

// ─── Route Mapping ──────────────────────────────────────────────────

/**
 * Maps intent categories to route handler names.
 * The task service uses these to dispatch to the correct handler.
 */
const ROUTE_MAP: Record<TaskIntentCategory, string> = {
  create_task: 'task.create',
  query_status: 'task.query',
  modify_task: 'task.modify',
  delete_task: 'task.delete',
  schedule: 'schedule.manage',
  debug: 'dev.debug',
  development: 'dev.execute',
  research: 'dev.research',
  review: 'dev.review',
  planning: 'plan.manage',
  other: 'fallback.help',
};

/**
 * Get the route handler for an intent category.
 */
export function getRouteHandler(category: TaskIntentCategory): string {
  return ROUTE_MAP[category] ?? 'fallback.help';
}

// ─── Intent Pipeline ────────────────────────────────────────────────

/** Global LRU cache instance for intent classification (Phase 3 M1) */
const globalCache = new IntentLRUCache(1000, 300_000);

/** Global LLM Fallback classifier instance (Phase 3 M6) */
const globalLLMFallback = new LLMFallbackClassifier();

/**
 * Run the full intent classification pipeline on a user message.
 *
 * Pipeline stages:
 *   Stage 0: Check LRU cache — if hit, return immediately
 *   Stage 1: Preprocess — normalize text, tokenize
 *   Stage 2: Classify — evaluate all rules
 *   Stage 3: Entity Extract — extract entities
 *   Stage 4: Disambiguate — resolve conflicts
 *   Stage 5: Confidence — assign final score
 *   Stage 6: Write result to LRU cache
 *
 * @param text - User's raw input text
 * @param context - Optional context for disambiguation
 * @param config - Optional pipeline configuration override
 * @returns Pipeline result with routing and action recommendations
 */
export function classifyIntent(
  text: string,
  context?: IntentContext,
  config?: Partial<PipelineConfig>,
): PipelineResult {
  const cfg = { ...DEFAULT_PIPELINE_CONFIG, ...config };

  // ═══ Start Trace ══════════════════════════════════════════════
  const trace: Trace = tracer.startTrace('intent.classify', {
    inputLength: text.length,
    cacheEnabled: cfg.enableCache ? 'true' : 'false',
  });

  // ═══ Stage 0: Check LRU Cache ═════════════════════════════════
  if (cfg.enableCache) {
    const cacheSpan = tracer.startSpan('cache_lookup', trace.traceId)!;
    const cached = globalCache.get(text);
    if (cached) {
      // Cache hit — build PipelineResult from cached IntentResult
      tracer.endSpan(cacheSpan, trace.traceId);
      tracer.setSpanAttribute(cacheSpan.spanId, trace.traceId, 'result', 'hit');

      metrics.recordCacheHit();
      metrics.recordClassification(cached, true);

      logger.classification('Cache hit — returning cached result', {
        category: cached.category,
        subCategory: cached.subCategory,
        latencyMs: cached.meta.processingTimeMs,
        cacheHit: true,
        confidence: cached.confidence,
      });

      const recommendedAction = getConfidenceAction(cached.confidence);
      const routeHandler = getRouteHandler(cached.category);

      tracer.endTrace(trace);
      return {
        ...cached,
        recommendedAction,
        routeHandler,
        contextInfluenced: cached.meta.contextUsed,
        pipelineVersion: '3.0.0',
        cacheHit: true,
        llmFallbackUsed: cached.meta.source === 'llm',
      };
    }
    // Cache miss
    tracer.endSpan(cacheSpan, trace.traceId);
    tracer.setSpanAttribute(cacheSpan.spanId, trace.traceId, 'result', 'miss');
    metrics.recordCacheMiss();
  }

  // Build the classification request
  const request: IntentRequest = {
    text,
    context: cfg.enableContext ? context : undefined,
  };

  // ═══ Stage 1: Preprocess ══════════════════════════════════════
  const preprocessSpan = tracer.startSpan('preprocess', trace.traceId)!;

  // ═══ Stages 2-5: Full classification pipeline ═════════════════
  const result = classify(request);

  tracer.endSpan(preprocessSpan, trace.traceId);
  tracer.setSpanAttribute(preprocessSpan.spanId, trace.traceId, 'rulesEvaluated', result.meta.rulesEvaluated);
  tracer.setSpanAttribute(preprocessSpan.spanId, trace.traceId, 'rulesMatched', result.meta.rulesMatched);

  // Determine recommended action
  const recommendedAction = getConfidenceAction(result.confidence);

  // Get route handler
  const routeHandler = getRouteHandler(result.category);

  // Check if context influenced the result
  const contextInfluenced = result.meta.contextUsed;

  // Build pipeline result
  const pipelineResult: PipelineResult = {
    ...result,
    recommendedAction,
    routeHandler,
    contextInfluenced,
    pipelineVersion: '3.0.0',
    cacheHit: false,
    llmFallbackUsed: false,
  };

  // ═══ Stage 6: Write to LRU Cache ══════════════════════════════
  if (cfg.enableCache) {
    const cacheWriteSpan = tracer.startSpan('cache_write', trace.traceId)!;
    globalCache.set(text, result);
    tracer.endSpan(cacheWriteSpan, trace.traceId);
  }

  // Record metrics for non-cached classification
  metrics.recordClassification(result, false);

  logger.classification('Classification complete', {
    category: result.category,
    subCategory: result.subCategory,
    latencyMs: result.meta.processingTimeMs,
    cacheHit: false,
    confidence: result.confidence,
  });

  // End trace
  tracer.endTrace(trace);
  tracer.setSpanAttribute(trace.rootSpanId, trace.traceId, 'category', result.category);
  tracer.setSpanAttribute(trace.rootSpanId, trace.traceId, 'confidence', result.confidence);

  return pipelineResult;
}

/**
 * 异步分类管道 — 支持 LLM Fallback (Phase 3 M6)。
 *
 * 当 enableLLMFallback 为 true 且正则分类器置信度低于
 * directExecutionThreshold 时，触发 LLM Fallback 进行二次分类。
 *
 * @param text - 用户原始输入文本
 * @param context - 可选的上下文信息
 * @param config - 可选的管道配置覆盖
 * @returns 管道分类结果
 */
export async function classifyIntentAsync(
  text: string,
  context?: IntentContext,
  config?: Partial<PipelineConfig>,
): Promise<PipelineResult> {
  const cfg = { ...DEFAULT_PIPELINE_CONFIG, ...config };

  // Stage 0: 先走同步管道（含缓存）
  const pipelineResult = classifyIntent(text, context, config);

  // 如果正则分类器置信度已经足够高，直接返回
  if (pipelineResult.confidence >= cfg.directExecutionThreshold) {
    return pipelineResult;
  }

  // 如果未启用 LLM Fallback，直接返回正则结果
  if (!cfg.enableLLMFallback) {
    return pipelineResult;
  }

  // ═══ LLM Fallback 触发 ═══════════════════════════════════════
  // 置信度低于 llmFallbackThreshold 且启用了 LLM Fallback
  if (pipelineResult.confidence < cfg.llmFallbackThreshold) {
    const llmTrace = tracer.startTrace('intent.llm_fallback', {
      inputLength: text.length,
      regexConfidence: pipelineResult.confidence,
    });

    const llmSpan = tracer.startSpan('llm_classify', llmTrace.traceId)!;

    const request: IntentRequest = {
      text,
      context: cfg.enableContext ? context : undefined,
    };

    // 调用 LLM Fallback 分类器
    const llmResult = await globalLLMFallback.classify(request);

    tracer.endSpan(llmSpan, llmTrace.traceId);

    if (llmResult) {
      tracer.setSpanAttribute(llmSpan.spanId, llmTrace.traceId, 'llmSuccess', 'true');
      tracer.setSpanAttribute(llmSpan.spanId, llmTrace.traceId, 'llmCategory', llmResult.category);

      // LLM 分类成功 — 用 LLM 结果构建 PipelineResult
      const recommendedAction = getConfidenceAction(llmResult.confidence);
      const routeHandler = getRouteHandler(llmResult.category);

      const llmPipelineResult: PipelineResult = {
        ...llmResult,
        recommendedAction,
        routeHandler,
        contextInfluenced: false,
        pipelineVersion: '3.0.0',
        cacheHit: false,
        llmFallbackUsed: true,
      };

      // 将 LLM 结果写入缓存
      if (cfg.enableCache) {
        globalCache.set(text, llmResult);
      }

      // 记录指标
      metrics.recordClassification(llmResult, false);

      logger.classification('LLM Fallback result', {
        category: llmResult.category,
        subCategory: llmResult.subCategory,
        latencyMs: llmResult.meta.processingTimeMs,
        cacheHit: false,
        confidence: llmResult.confidence,
        extra: { llmFallback: true },
      });

      tracer.endTrace(llmTrace);
      return llmPipelineResult;
    }

    // LLM 不可用 — 降级到正则分类器结果
    tracer.setSpanAttribute(llmSpan.spanId, llmTrace.traceId, 'llmSuccess', 'false');
    tracer.endTrace(llmTrace, 'error');

    logger.warn('LLM Fallback unavailable, degrading to regex result', {
      regexConfidence: pipelineResult.confidence,
    });

    const fallbackResult = fallbackToRegex(
      pipelineResult,
      'LLM Fallback 不可用或超时',
    );
    return {
      ...pipelineResult,
      ...fallbackResult,
      llmFallbackUsed: false,
    };
  }

  return pipelineResult;
}

/**
 * Pipeline convenience: classify and get route in one call.
 */
export function classifyAndRoute(
  text: string,
  context?: IntentContext,
): { result: PipelineResult; handler: string; action: ConfidenceAction } {
  const result = classifyIntent(text, context);
  return {
    result,
    handler: result.routeHandler,
    action: result.recommendedAction,
  };
}

/**
 * Batch pipeline classification.
 */
export function classifyIntentBatch(
  texts: string[],
  context?: IntentContext,
  config?: Partial<PipelineConfig>,
): PipelineResult[] {
  return texts.map(text => classifyIntent(text, context, config));
}

// ─── Pipeline Statistics ────────────────────────────────────────────

export interface PipelineStats {
  totalClassified: number;
  byCategory: Record<string, number>;
  byAction: Record<string, number>;
  averageConfidence: number;
  averageProcessingTimeMs: number;
  ambiguousCount: number;
}

/**
 * Collect statistics from a batch of pipeline results.
 */
export function collectStats(results: PipelineResult[]): PipelineStats {
  const stats: PipelineStats = {
    totalClassified: results.length,
    byCategory: {},
    byAction: {},
    averageConfidence: 0,
    averageProcessingTimeMs: 0,
    ambiguousCount: 0,
  };

  let totalConf = 0;
  let totalTime = 0;

  for (const r of results) {
    stats.byCategory[r.category] = (stats.byCategory[r.category] || 0) + 1;
    stats.byAction[r.recommendedAction] = (stats.byAction[r.recommendedAction] || 0) + 1;
    totalConf += r.confidence;
    totalTime += r.meta.processingTimeMs;
    if (r.ambiguous) stats.ambiguousCount++;
  }

  stats.averageConfidence = results.length > 0 ? totalConf / results.length : 0;
  stats.averageProcessingTimeMs = results.length > 0 ? totalTime / results.length : 0;

  return stats;
}

// ─── Cache Management API (Phase 3 M1) ─────────────────────────────

/**
 * Get LRU cache statistics.
 * Returns hit rate, size, eviction count, etc.
 */
export function getCacheStats(): CacheStats {
  return globalCache.getStats();
}

/**
 * Clear all entries from the LRU cache.
 */
export function clearCache(): void {
  globalCache.clear();
}

/**
 * Reset cache statistics counters (does not clear entries).
 */
export function resetCacheStats(): void {
  globalCache.resetStats();
}

// ─── Pipeline Debug ─────────────────────────────────────────────────

/**
 * Debug a classification through the pipeline.
 * Returns detailed information about each stage.
 */
export function debugPipeline(text: string, context?: IntentContext): {
  input: string;
  preprocessed: ReturnType<typeof preprocess>;
  classification: PipelineResult;
  routeHandler: string;
  entities: TaskEntity[];
  llmFallbackUsed: boolean;
} {
  const preprocessed = preprocess(text);
  const classification = classifyIntent(text, context);

  return {
    input: text,
    preprocessed,
    classification,
    routeHandler: classification.routeHandler,
    entities: classification.entities,
    llmFallbackUsed: classification.llmFallbackUsed,
  };
}

// ─── Exports ────────────────────────────────────────────────────────

export {
  classify,
  classifyText,
  classifyBatch,
  debugClassify,
} from './classifier.js';
export { preprocess } from './preprocessor.js';
export { extractEntities } from './entity-extractor.js';
export {
  disambiguate,
  isAmbiguous,
  applyContextBoost,
} from './disambiguation.js';
export { RULES, getRulesByPriority, getRuleStats } from './patterns.js';
export { LLMFallbackClassifier, fallbackToRegex, classifyWithLLM, llmFallback } from './llm-fallback.js';
export type { LLMFallbackConfig } from './llm-fallback.js';
export { tracer, Tracer, type Trace, type Span, type TraceSummary, type TraceContext } from './tracer.js';
export { logger, Logger, type LogLevel, type LogEntry } from './logger.js';
export { metrics, MetricsCollector, type MetricsSnapshot } from './metrics.js';
export * from './types.js';

// ─── M2: Custom Intent Extension API ─────────────────────────────────
// Re-export the extension API so it is accessible from pipeline.js directly.
// Consumers can also import from custom-intent-extension.js directly.
export {
  extension,
  type CustomIntentExtension,
  type CustomRuleDefinition,
  IntentPriority,
  registerIntent,
  unregisterIntent,
  getCustomRules,
  getMergedRules,
  loadRulesFromConfig,
  CustomIntentRegistry,
} from './custom-intent-extension.js';
export type {
  CustomIntentRule,
  ValidationFunction,
  RegistrationResult,
  RegistryStats,
  CustomIntentConfig,
  CustomIntentConfigRule,
} from './custom-intent-extension.js';
export { toClassificationRule } from './custom-intent-types.js';
