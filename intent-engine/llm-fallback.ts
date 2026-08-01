/**
 * Claw Task Service — LLM Fallback Classifier (Phase 3 M6 → M11 Enhancement)
 *
 * 当正则分类器置信度低于阈值（默认 0.5）时，调用 LLM API 进行意图分类。
 * 支持 OpenClaw Gateway 的 OpenAI 兼容接口。
 *
 * M11 增强功能：
 *   - 指数退避重试（3次重试，1s/2s/4s）
 *   - 多模型 fallback 链（主→备→备）
 *   - 熔断器（连续5次失败则暂停 LLM fallback 60s）
 *   - 结果缓存（相同输入60s内返回缓存结果，复用 LRU cache）
 *
 * 基于: Phase 3 M6 任务规格 (2026-07-24) + M11 增强 (2026-08-01)
 */

import {
  TaskIntentCategory,
  TaskSubCategory,
  TaskEntity,
  IntentResult,
  IntentRequest,
} from './types.js';
import { logger } from './logger.js';
import { LRUCache, fnv1aHash } from './lru-cache.js';

// ─── 配置 ─────────────────────────────────────────────────────────

/** 单个 LLM endpoint 配置 */
export interface LLMEndpointConfig {
  /** LLM API 端点 URL */
  endpoint: string;
  /** 模型名称 */
  model: string;
  /** 请求超时时间（毫秒），默认 10000 */
  timeoutMs: number;
}

/** LLM Fallback 配置选项 */
export interface LLMFallbackConfig {
  /** LLM API 端点 URL（向后兼容，单 endpoint 模式） */
  endpoint: string;
  /** 置信度阈值，低于此值触发 LLM Fallback */
  confidenceThreshold: number;
  /** 请求超时时间（毫秒），默认 10000 */
  timeoutMs: number;
  /** 请求重试次数，默认 3（M11: 从 0 提升到 3） */
  maxRetries: number;
  /** 模型名称 */
  model: string;
  /** M11: 多模型 fallback 链（优先级从高到低） */
  fallbackChain?: LLMEndpointConfig[];
  /** M11: 熔断器阈值 — 连续失败次数，默认 5 */
  circuitBreakerThreshold: number;
  /** M11: 熔断器恢复时间（毫秒），默认 60000 */
  circuitBreakerResetMs: number;
  /** M11: 结果缓存 TTL（毫秒），默认 60000 */
  resultCacheTtlMs: number;
  /** M11: 结果缓存容量，默认 500 */
  resultCacheCapacity: number;
}

/** 默认配置 */
const DEFAULT_CONFIG: LLMFallbackConfig = {
  endpoint: 'http://localhost:28789/v1/chat/completions',
  confidenceThreshold: 0.5,
  timeoutMs: 10_000,
  maxRetries: 3,
  model: 'default',
  circuitBreakerThreshold: 5,
  circuitBreakerResetMs: 60_000,
  resultCacheTtlMs: 60_000,
  resultCacheCapacity: 500,
};

// ─── LLM 请求/响应类型 ────────────────────────────────────────────

/** OpenAI 兼容的 chat completion 请求体 */
interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  max_tokens: number;
}

/** 聊天消息 */
interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** OpenAI 兼容的 chat completion 响应体 */
interface ChatCompletionResponse {
  id?: string;
  choices?: Array<{
    index: number;
    message: ChatMessage;
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ─── System Prompt ─────────────────────────────────────────────────

/**
 * 系统提示词 — 定义意图分类任务。
 * 要求 LLM 以 JSON 格式输出 intent、confidence、entities。
 */
const SYSTEM_PROMPT = `你是一个意图分类器。将用户输入分类为以下意图类别之一。

意图类别（intent）：
- create_task: 创建任务
- query_status: 查询状态
- modify_task: 修改任务
- delete_task: 删除任务
- schedule: 日程管理
- debug: 调试
- development: 开发
- research: 调研
- review: 评审
- planning: 计划
- other: 其他

子类别（subCategory）根据意图选择最合适的子分类。

你必须以 JSON 格式输出，不要输出其他内容。JSON 格式如下：
{
  "intent": "create_task",
  "subCategory": "general",
  "confidence": 0.85,
  "entities": [
    { "type": "task_name", "value": "登录页面重构" },
    { "type": "deadline", "value": "下周五" }
  ],
  "rationale": "检测到任务创建关键词"
}

confidence 范围: 0.0-1.0，表示你对分类结果的确信程度。
entities 是从输入中提取的关键实体，type 可选: task_name, deadline, priority, assignee, status, category。`;

// ─── M11: Circuit Breaker ──────────────────────────────────────────

/**
 * 熔断器状态。
 *
 * 状态流转：
 *   CLOSED → 连续失败达到 threshold → OPEN
 *   OPEN → 经过 resetMs → HALF_OPEN
 *   HALF_OPEN → 成功 → CLOSED
 *   HALF_OPEN → 失败 → OPEN
 */
type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

class CircuitBreaker {
  private state: CircuitBreakerState = 'CLOSED';
  private consecutiveFailures: number = 0;
  private openedAt: number = 0;
  private readonly threshold: number;
  private readonly resetMs: number;

  constructor(threshold: number = 5, resetMs: number = 60_000) {
    this.threshold = threshold;
    this.resetMs = resetMs;
  }

  /** 检查熔断器是否允许请求通过 */
  canRequest(): boolean {
    switch (this.state) {
      case 'CLOSED':
        return true;
      case 'OPEN':
        // 检查是否已经过了恢复时间
        if (Date.now() - this.openedAt >= this.resetMs) {
          this.state = 'HALF_OPEN';
          logger.info('CircuitBreaker: OPEN → HALF_OPEN, allowing probe request', {
            threshold: this.threshold,
            resetMs: this.resetMs,
          });
          return true;
        }
        return false;
      case 'HALF_OPEN':
        // 半开状态允许一个探测请求
        return true;
    }
  }

  /** 记录成功 */
  recordSuccess(): void {
    const prevState = this.state;
    this.consecutiveFailures = 0;
    this.state = 'CLOSED';
    if (prevState === 'HALF_OPEN') {
      logger.info('CircuitBreaker: HALF_OPEN → CLOSED, probe succeeded', {});
    }
  }

  /** 记录失败 */
  recordFailure(): void {
    this.consecutiveFailures++;
    if (this.state === 'HALF_OPEN') {
      // 半开状态失败，重新打开
      this.state = 'OPEN';
      this.openedAt = Date.now();
      logger.warn('CircuitBreaker: HALF_OPEN → OPEN, probe failed', {
        threshold: this.threshold,
        resetMs: this.resetMs,
      });
      return;
    }
    if (this.consecutiveFailures >= this.threshold) {
      this.state = 'OPEN';
      this.openedAt = Date.now();
      logger.warn('CircuitBreaker: CLOSED → OPEN, consecutive failures reached threshold', {
        failures: this.consecutiveFailures,
        threshold: this.threshold,
        resetMs: this.resetMs,
      });
    }
  }

  /** 获取当前状态 */
  getState(): CircuitBreakerState {
    return this.state;
  }

  /** 获取连续失败次数 */
  getFailureCount(): number {
    return this.consecutiveFailures;
  }

  /** 重置熔断器 */
  reset(): void {
    this.state = 'CLOSED';
    this.consecutiveFailures = 0;
    this.openedAt = 0;
  }
}

// ─── M11: Exponential Backoff Helper ───────────────────────────────

/**
 * 计算指数退避延迟时间。
 *
 * @param attempt - 当前重试次数（0-indexed）
 * @param baseMs - 基础延迟（默认 1000ms）
 * @param maxMs - 最大延迟（默认 30000ms）
 * @returns 延迟时间（毫秒）
 */
function calculateBackoff(attempt: number, baseMs: number = 1000, maxMs: number = 30_000): number {
  // 2^attempt * baseMs: 1s, 2s, 4s, 8s, ...
  const delay = Math.pow(2, attempt) * baseMs;
  return Math.min(delay, maxMs);
}

/**
 * 异步 sleep。
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── LLM Fallback 分类器 (M11 Enhanced) ──────────────────────────

/**
 * LLM Fallback 分类器（M11 增强版）。
 *
 * 增强功能：
 *   1. 指数退避重试：3次重试，延迟 1s/2s/4s
 *   2. 多模型 fallback 链：主 endpoint 失败后尝试备 endpoint
 *   3. 熔断器：连续5次失败暂停 60s
 *   4. 结果缓存：相同输入 60s 内返回缓存结果
 */
export class LLMFallbackClassifier {
  private config: LLMFallbackConfig;
  private circuitBreaker: CircuitBreaker;
  private resultCache: LRUCache<string, IntentResult>;

  constructor(config?: Partial<LLMFallbackConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.circuitBreaker = new CircuitBreaker(
      this.config.circuitBreakerThreshold,
      this.config.circuitBreakerResetMs,
    );
    this.resultCache = new LRUCache<string, IntentResult>(
      this.config.resultCacheCapacity,
      this.config.resultCacheTtlMs,
    );
  }

  /**
   * 调用 LLM API 进行意图分类。
   *
   * M11 增强流程：
   *   1. 检查结果缓存
   *   2. 检查熔断器状态
   *   3. 构建 fallback chain（多 endpoint）
   *   4. 对每个 endpoint 执行指数退避重试
   *   5. 成功则更新熔断器+缓存
   *
   * @param request - 原始分类请求
   * @returns LLM 分类结果，失败时返回 null
   */
  async classify(request: IntentRequest): Promise<IntentResult | null> {
    const startTime = Date.now();

    // ═══ M11: Stage 0 — 结果缓存检查 ═══════════════════════════
    const cacheKey = fnv1aHash(request.text);
    const cached = this.resultCache.get(cacheKey);
    if (cached) {
      logger.info('LLM Fallback: 缓存命中', {
        category: cached.category,
        confidence: cached.confidence,
      });
      return cached;
    }

    // ═══ M11: Stage 1 — 熔断器检查 ═════════════════════════════
    if (!this.circuitBreaker.canRequest()) {
      logger.warn('LLM Fallback: 熔断器开启，跳过 LLM 请求', {
        state: this.circuitBreaker.getState(),
        failures: this.circuitBreaker.getFailureCount(),
      });
      return null;
    }

    // ═══ M11: Stage 2 — 构建 fallback chain ═════════════════════
    const endpoints = this.getFallbackChain();

    // ═══ M11: Stage 3 — 逐个 endpoint 尝试，每个带指数退避重试 ═══
    for (let i = 0; i < endpoints.length; i++) {
      const ep = endpoints[i];
      const isLastEndpoint = i === endpoints.length - 1;

      const result = await this.tryClassifyWithRetry(ep, request, startTime);

      if (result) {
        // 成功 — 更新熔断器 + 缓存
        this.circuitBreaker.recordSuccess();
        this.resultCache.set(cacheKey, result);

        logger.info('LLM Fallback: 分类成功', {
          category: result.category,
          confidence: result.confidence,
          latencyMs: result.meta.processingTimeMs,
          endpointIndex: i,
          endpoint: ep.endpoint,
        });

        return result;
      }

      // 当前 endpoint 失败，尝试下一个
      if (!isLastEndpoint) {
        logger.warn('LLM Fallback: endpoint 失败，尝试下一个', {
          failedEndpoint: ep.endpoint,
          nextIndex: i + 1,
        });
      }
    }

    // ═══ M11: 所有 endpoint 均失败 ═════════════════════════════
    this.circuitBreaker.recordFailure();

    logger.error('LLM Fallback: 所有 endpoint 均失败', {
      endpointCount: endpoints.length,
      circuitBreakerState: this.circuitBreaker.getState(),
      consecutiveFailures: this.circuitBreaker.getFailureCount(),
    });

    return null;
  }

  /**
   * 对单个 endpoint 执行指数退避重试。
   *
   * 重试策略：
   *   - maxRetries=3 → 最多 4 次尝试（1 + 3 重试）
   *   - 退避延迟：1s, 2s, 4s
   *
   * @param ep - endpoint 配置
   * @param request - 分类请求
   * @param startTime - 开始时间
   * @returns 分类结果或 null
   */
  private async tryClassifyWithRetry(
    ep: LLMEndpointConfig,
    request: IntentRequest,
    startTime: number,
  ): Promise<IntentResult | null> {
    const maxAttempts = this.config.maxRetries + 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        // 构建请求体
        const requestBody: ChatCompletionRequest = {
          model: ep.model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: request.text },
          ],
          temperature: 0.1,
          max_tokens: 512,
        };

        // 发送请求（带超时）
        const response = await this.sendRequest(requestBody, ep);

        if (!response) {
          if (attempt < maxAttempts - 1) {
            const backoff = calculateBackoff(attempt);
            logger.warn('LLM Fallback: 请求失败，指数退避重试', {
              attempt: attempt + 1,
              maxAttempts,
              backoffMs: backoff,
              endpoint: ep.endpoint,
            });
            await sleep(backoff);
            continue;
          }
          continue;
        }

        // 解析 LLM 输出
        const result = this.parseLLMResponse(response, request, Date.now() - startTime);

        if (result) {
          return result;
        }

        // 解析失败 — 不值得重试（LLM 返回了响应但格式不对）
        logger.warn('LLM Fallback: 解析 LLM 响应失败', {
          endpoint: ep.endpoint,
          attempt: attempt + 1,
        });

        // 解析失败也重试（可能是 LLM 输出不稳定）
        if (attempt < maxAttempts - 1) {
          const backoff = calculateBackoff(attempt);
          await sleep(backoff);
          continue;
        }
      } catch (err) {
        logger.warn('LLM Fallback: 异常', {
          error: err instanceof Error ? err.message : String(err),
          endpoint: ep.endpoint,
          attempt: attempt + 1,
        });

        if (attempt < maxAttempts - 1) {
          const backoff = calculateBackoff(attempt);
          logger.warn('LLM Fallback: 指数退避重试', {
            attempt: attempt + 1,
            maxAttempts,
            backoffMs: backoff,
          });
          await sleep(backoff);
          continue;
        }
      }
    }

    return null;
  }

  /**
   * 获取 fallback chain — 多模型 endpoint 列表。
   *
   * 如果配置了 fallbackChain，使用它；否则用单 endpoint 构建。
   */
  private getFallbackChain(): LLMEndpointConfig[] {
    if (this.config.fallbackChain && this.config.fallbackChain.length > 0) {
      return this.config.fallbackChain;
    }

    // 单 endpoint 模式（向后兼容）
    return [{
      endpoint: this.config.endpoint,
      model: this.config.model,
      timeoutMs: this.config.timeoutMs,
    }];
  }

  /**
   * 发送 HTTP 请求到 LLM API，带超时处理。
   *
   * M11: 简化为单次请求（重试逻辑在外层处理）。
   */
  private async sendRequest(
    body: ChatCompletionRequest,
    ep: LLMEndpointConfig,
  ): Promise<ChatCompletionResponse | null> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        ep.timeoutMs,
      );

      const response = await fetch(ep.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        logger.warn('LLM Fallback: HTTP 错误', {
          status: response.status,
          statusText: response.statusText,
          endpoint: ep.endpoint,
        });
        return null;
      }

      const data = (await response.json()) as ChatCompletionResponse;
      return data;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        logger.warn('LLM Fallback: 请求超时', {
          timeoutMs: ep.timeoutMs,
          endpoint: ep.endpoint,
        });
      } else {
        logger.warn('LLM Fallback: 请求异常', {
          error: err instanceof Error ? err.message : String(err),
          endpoint: ep.endpoint,
        });
      }
      return null;
    }
  }

  /**
   * 从 LLM 响应中解析意图分类结果。
   *
   * 支持以下格式：
   *   1. 纯 JSON（理想情况）
   *   2. JSON 嵌套在 markdown code block 中
   *   3. JSON 前后有多余文本
   */
  private parseLLMResponse(
    response: ChatCompletionResponse,
    request: IntentRequest,
    processingTimeMs: number,
  ): IntentResult | null {
    // 提取 LLM 输出文本
    const content = response.choices?.[0]?.message?.content;
    if (!content) {
      logger.warn('LLM Fallback: 响应无 content 字段');
      return null;
    }

    // 尝试从输出中提取 JSON
    const jsonStr = this.extractJSON(content);
    if (!jsonStr) {
      logger.warn('LLM Fallback: 无法从输出中提取 JSON', { content: content.substring(0, 200) });
      return null;
    }

    let parsed: LLMClassificationResult;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      logger.warn('LLM Fallback: JSON 解析失败', { jsonStr: jsonStr.substring(0, 200) });
      return null;
    }

    // 验证并构建 IntentResult
    const validCategories: TaskIntentCategory[] = [
      'create_task', 'query_status', 'modify_task', 'delete_task',
      'schedule', 'debug', 'development', 'research', 'review',
      'planning', 'other',
    ];

    const category = validCategories.includes(parsed.intent as TaskIntentCategory)
      ? parsed.intent as TaskIntentCategory
      : 'other';

    const confidence = typeof parsed.confidence === 'number'
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0.5;

    const entities: TaskEntity[] = Array.isArray(parsed.entities)
      ? parsed.entities
          .filter(
            (e: any) =>
              e &&
              typeof e.type === 'string' &&
              e.type.trim() !== '' &&
              typeof e.value === 'string' &&
              e.value.trim() !== '',
          )
          .map((e: any) => ({
            type: e.type as TaskEntity['type'],
            value: String(e.value),
            position: typeof e.position === 'number' ? e.position : 0,
            confidence: typeof e.confidence === 'number' ? e.confidence : 0.7,
          }))
      : [];

    const subCategory = typeof parsed.subCategory === 'string'
      ? parsed.subCategory as TaskSubCategory
      : 'fallback';

    const rationale = typeof parsed.rationale === 'string'
      ? parsed.rationale
      : `LLM 分类: ${category}`;

    return {
      category,
      subCategory,
      confidence,
      entities,
      alternatives: [],
      rationale,
      ambiguous: false,
      meta: {
        processingTimeMs,
        inputLength: request.text.length,
        rulesEvaluated: 0,
        rulesMatched: 0,
        disambiguationTriggered: false,
        contextUsed: false,
        source: 'llm',
      },
    };
  }

  /**
   * 从 LLM 输出文本中提取 JSON 字符串。
   * 处理 markdown code block、纯 JSON、以及混合文本。
   */
  private extractJSON(text: string): string | null {
    // 1. 尝试提取 markdown code block 中的 JSON
    const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (codeBlockMatch) {
      const jsonStr = codeBlockMatch[1].trim();
      if (this.isValidJSON(jsonStr)) return jsonStr;
    }

    // 2. 尝试提取第一个完整的 JSON 对象
    const jsonObjMatch = text.match(/\{[\s\S]*\}/);
    if (jsonObjMatch) {
      const jsonStr = jsonObjMatch[0].trim();
      if (this.isValidJSON(jsonStr)) return jsonStr;
    }

    // 3. 直接尝试整段文本
    const trimmed = text.trim();
    if (this.isValidJSON(trimmed)) return trimmed;

    return null;
  }

  /**
   * 快速检查字符串是否是有效的 JSON。
   */
  private isValidJSON(str: string): boolean {
    try {
      JSON.parse(str);
      return true;
    } catch {
      return false;
    }
  }

  // ─── M11: 公开 API ─────────────────────────────────────────────

  /**
   * 获取当前配置。
   */
  getConfig(): LLMFallbackConfig {
    return { ...this.config };
  }

  /**
   * 更新配置。
   * 注意：更新配置会重置熔断器和缓存。
   */
  updateConfig(updates: Partial<LLMFallbackConfig>): void {
    this.config = { ...this.config, ...updates };
    // 如果熔断器参数变了，重建熔断器
    this.circuitBreaker = new CircuitBreaker(
      this.config.circuitBreakerThreshold,
      this.config.circuitBreakerResetMs,
    );
    // 如果缓存参数变了，重建缓存
    this.resultCache = new LRUCache<string, IntentResult>(
      this.config.resultCacheCapacity,
      this.config.resultCacheTtlMs,
    );
  }

  /**
   * M11: 获取熔断器状态。
   */
  getCircuitBreakerState(): { state: string; failures: number } {
    return {
      state: this.circuitBreaker.getState(),
      failures: this.circuitBreaker.getFailureCount(),
    };
  }

  /**
   * M11: 手动重置熔断器。
   */
  resetCircuitBreaker(): void {
    this.circuitBreaker.reset();
  }

  /**
   * M11: 清空结果缓存。
   */
  clearResultCache(): void {
    this.resultCache.clear();
  }

  /**
   * M11: 获取结果缓存大小。
   */
  getResultCacheSize(): number {
    return this.resultCache.size;
  }
}

// ─── LLM 分类结果解析类型 ─────────────────────────────────────────

/** LLM 输出的分类结果结构 */
interface LLMClassificationResult {
  intent: string;
  subCategory?: string;
  confidence?: number;
  entities?: Array<{
    type: string;
    value: string;
    position?: number;
    confidence?: number;
  }>;
  rationale?: string;
}

// ─── 降级策略 ─────────────────────────────────────────────────────

/**
 * 降级策略：LLM 不可用时回退到正则分类器结果。
 *
 * 记录错误指标并返回原始正则分类结果，标记 source 为 rule_engine。
 *
 * @param regexResult - 原始正则分类器结果
 * @param error - LLM 调用失败原因
 * @returns 降级后的 IntentResult（即原始正则结果）
 */
export function fallbackToRegex(regexResult: IntentResult, error?: string): IntentResult {
  logger.warn('LLM Fallback: 降级到正则分类器', {
    error,
    originalCategory: regexResult.category,
    originalConfidence: regexResult.confidence,
  });

  // 返回原始正则结果，不修改
  return regexResult;
}

// ─── 单例导出 ──────────────────────────────────────────────────────

/**
 * 全局 LLM Fallback 分类器单例。
 *
 * 使用方式：
 *   import { llmFallback } from './llm-fallback.js';
 *   const result = await llmFallback.classify(request);
 */
export const llmFallback = new LLMFallbackClassifier();

/**
 * 获取全局 LLM Fallback 分类器实例。
 */
export function getLLMFallbackClassifier(): LLMFallbackClassifier {
  return llmFallback;
}

// ─── 便捷 API ─────────────────────────────────────────────────────

/**
 * 快速调用 LLM Fallback 分类。
 *
 * @param text - 待分类文本
 * @param config - 可选配置覆盖
 * @returns LLM 分类结果，失败时返回 null
 */
export async function classifyWithLLM(
  text: string,
  config?: Partial<LLMFallbackConfig>,
): Promise<IntentResult | null> {
  const classifier = config
    ? new LLMFallbackClassifier(config)
    : llmFallback;
  return classifier.classify({ text });
}

// ─── M11: 导出工具函数和类型 ──────────────────────────────────────

export { CircuitBreaker, calculateBackoff };
export type { CircuitBreakerState };

export { DEFAULT_CONFIG as DEFAULT_LLM_FALLBACK_CONFIG };
