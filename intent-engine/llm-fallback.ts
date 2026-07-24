/**
 * Claw Task Service — LLM Fallback Classifier (Phase 3 M6)
 *
 * 当正则分类器置信度低于阈值（默认 0.5）时，调用 LLM API 进行意图分类。
 * 支持 OpenClaw Gateway 的 OpenAI 兼容接口。
 *
 * 功能：
 *   - 调用 LLM API（POST http://localhost:28789/v1/chat/completions）
 *   - 从 LLM 输出中提取 intent + confidence + entities
 *   - 10s 超时处理，超时后返回 unknown intent
 *   - 降级策略：LLM 不可用时回退到正则分类器结果
 *
 * 基于: Phase 3 M6 任务规格 (2026-07-24)
 */

import {
  TaskIntentCategory,
  TaskSubCategory,
  TaskEntity,
  IntentResult,
  IntentRequest,
} from './types';
import { logger } from './logger';

// ─── 配置 ─────────────────────────────────────────────────────────

/** LLM Fallback 配置选项 */
export interface LLMFallbackConfig {
  /** LLM API 端点 URL */
  endpoint: string;
  /** 置信度阈值，低于此值触发 LLM Fallback */
  confidenceThreshold: number;
  /** 请求超时时间（毫秒），默认 10000 */
  timeoutMs: number;
  /** 请求重试次数，默认 0（不重试） */
  maxRetries: number;
  /** 模型名称 */
  model: string;
}

/** 默认配置 */
const DEFAULT_CONFIG: LLMFallbackConfig = {
  endpoint: 'http://localhost:28789/v1/chat/completions',
  confidenceThreshold: 0.5,
  timeoutMs: 10_000,
  maxRetries: 0,
  model: 'default',
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

// ─── LLM Fallback 分类器 ──────────────────────────────────────────

/**
 * LLM Fallback 分类器。
 *
 * 当正则分类器置信度低于阈值时，调用 LLM API 进行二次分类。
 * 包含超时处理和降级策略。
 */
export class LLMFallbackClassifier {
  private config: LLMFallbackConfig;

  constructor(config?: Partial<LLMFallbackConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 调用 LLM API 进行意图分类。
   *
   * @param request - 原始分类请求
   * @returns LLM 分类结果，失败时返回 null
   */
  async classify(request: IntentRequest): Promise<IntentResult | null> {
    const startTime = Date.now();

    try {
      // 构建请求体
      const requestBody: ChatCompletionRequest = {
        model: this.config.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: request.text },
        ],
        temperature: 0.1, // 低温度，减少随机性
        max_tokens: 512,
      };

      // 发送请求（带超时）
      const response = await this.sendRequest(requestBody);

      if (!response) {
        logger.warn('LLM Fallback: 请求失败，返回 null', {
          endpoint: this.config.endpoint,
        });
        return null;
      }

      // 解析 LLM 输出
      const result = this.parseLLMResponse(response, request, Date.now() - startTime);

      if (result) {
        logger.info('LLM Fallback: 分类成功', {
          category: result.category,
          confidence: result.confidence,
          latencyMs: result.meta.processingTimeMs,
        });
      } else {
        logger.warn('LLM Fallback: 解析 LLM 响应失败', {
          endpoint: this.config.endpoint,
        });
      }

      return result;
    } catch (err) {
      logger.error('LLM Fallback: 异常', {
        error: err instanceof Error ? err.message : String(err),
        endpoint: this.config.endpoint,
      });
      return null;
    }
  }

  /**
   * 发送 HTTP 请求到 LLM API，带超时处理。
   */
  private async sendRequest(body: ChatCompletionRequest): Promise<ChatCompletionResponse | null> {
    let lastError: Error | null = null;

    const attempts = this.config.maxRetries + 1;

    for (let i = 0; i < attempts; i++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(
          () => controller.abort(),
          this.config.timeoutMs,
        );

        const response = await fetch(this.config.endpoint, {
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
            attempt: i + 1,
          });
          lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
          continue;
        }

        const data = (await response.json()) as ChatCompletionResponse;
        return data;
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          logger.warn('LLM Fallback: 请求超时', {
            timeoutMs: this.config.timeoutMs,
            attempt: i + 1,
          });
          lastError = new Error(`请求超时 (${this.config.timeoutMs}ms)`);
        } else {
          logger.warn('LLM Fallback: 请求异常', {
            error: err instanceof Error ? err.message : String(err),
            attempt: i + 1,
          });
          lastError = err instanceof Error ? err : new Error(String(err));
        }
      }
    }

    // 所有重试均失败
    logger.error('LLM Fallback: 所有尝试均失败', {
      attempts,
      lastError: lastError?.message,
    });
    return null;
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
          .filter((e: any) => e && typeof e.type === 'string' && typeof e.value === 'string')
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

  /**
   * 获取当前配置。
   */
  getConfig(): LLMFallbackConfig {
    return { ...this.config };
  }

  /**
   * 更新配置。
   */
  updateConfig(updates: Partial<LLMFallbackConfig>): void {
    this.config = { ...this.config, ...updates };
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
 *   import { llmFallback } from './llm-fallback';
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

export { DEFAULT_CONFIG as DEFAULT_LLM_FALLBACK_CONFIG };
