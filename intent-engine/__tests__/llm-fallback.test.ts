/**
 * Claw Task Service — LLM Fallback Tests (Phase 3 M6)
 *
 * Unit tests for LLMFallbackClassifier and related utilities.
 * Uses globalThis.fetch mocking to simulate LLM API responses.
 *
 * Run: npx tsx intent-engine/__tests__/llm-fallback.test.ts
 */

import { LLMFallbackClassifier, classifyWithLLM, fallbackToRegex } from '../llm-fallback.js';
import { IntentRequest } from '../types.js';

const { describe, it, expect, beforeEach, afterEach, mock } = await import('bun:test');

// ─── Test Utilities ─────────────────────────────────────────────────

/** Mock fetch implementation storage */
let mockFetch: ReturnType<typeof mock<typeof globalThis.fetch>> | null = null;
let originalFetch: typeof globalThis.fetch | null = null;

/** Install a mock fetch with controlled response. */
function installMockFetch(response: unknown, status = 200) {
  mockFetch = mock<typeof globalThis.fetch>(async () => {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      json: async () => response,
    } as Response;
  });
  // Install the mock on globalThis.fetch so the classifier uses it
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;
}

/** Install a mock fetch that throws an error. */
function installMockFetchError(error: Error) {
  mockFetch = mock<typeof globalThis.fetch>(async () => {
    throw error;
  });
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;
}

/** Remove mock fetch, restore original. */
function uninstallMockFetch() {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = null;
  }
  if (mockFetch) {
    mockFetch.mockRestore();
    mockFetch = null;
  }
}

// ─── Shared LLM response factories (module scope) ──────────────────

function makeLLMResponse(
  intent: string,
  subCategory: string,
  confidence: number,
  rationale: string,
  entities: Array<{ type: string; value: string }> = [],
) {
  return {
    id: 'chatcmpl-test-001',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: JSON.stringify({ intent, subCategory, confidence, rationale, entities }),
        },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
  };
}

function makeLLMResponseInCodeBlock(
  intent: string,
  subCategory: string,
  confidence: number,
) {
  return {
    id: 'chatcmpl-test-001',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: `\`\`\`json\n${JSON.stringify({ intent, subCategory, confidence })}\n\`\`\``,
        },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
  };
}

// ─── Test Suite ─────────────────────────────────────────────────────

describe('LLMFallbackClassifier', () => {
  beforeEach(() => {
    // Install mock fetch for all tests
  });

  afterEach(() => {
    uninstallMockFetch();
  });

  // ══════════════════════════════════════════════════════════════════
  // 1. Basic Classification
  // ══════════════════════════════════════════════════════════════════

  describe('classify()', () => {
    it('should classify create_task intent correctly', async () => {
      installMockFetch(makeLLMResponse('create_task', 'general', 0.88, '检测到任务创建关键词'));

      const classifier = new LLMFallbackClassifier();
      const result = await classifier.classify({ text: '帮我创建登录页重构任务' });

      expect(result).not.toBeNull();
      expect(result!.category).toBe('create_task');
      expect(result!.subCategory).toBe('general');
      expect(result!.confidence).toBe(0.88);
      expect(result!.meta.source).toBe('llm');
    });

    it('should classify query_status intent correctly', async () => {
      installMockFetch(makeLLMResponse('query_status', 'single', 0.92, '检测到状态查询关键词'));

      const classifier = new LLMFallbackClassifier();
      const result = await classifier.classify({ text: '登录模块现在什么状态' });

      expect(result).not.toBeNull();
      expect(result!.category).toBe('query_status');
      expect(result!.subCategory).toBe('single');
      expect(result!.confidence).toBe(0.92);
    });

    it('should classify modify_task intent correctly', async () => {
      installMockFetch(makeLLMResponse('modify_task', 'deadline', 0.85, '检测到截止时间修改'));

      const classifier = new LLMFallbackClassifier();
      const result = await classifier.classify({ text: '把截止时间改到下周五' });

      expect(result).not.toBeNull();
      expect(result!.category).toBe('modify_task');
      expect(result!.subCategory).toBe('deadline');
    });

    it('should classify development intent correctly', async () => {
      installMockFetch(makeLLMResponse('development', 'feature_impl', 0.90, '检测到功能开发'));

      const classifier = new LLMFallbackClassifier();
      const result = await classifier.classify({ text: '实现用户注册功能' });

      expect(result).not.toBeNull();
      expect(result!.category).toBe('development');
      expect(result!.subCategory).toBe('feature_impl');
    });

    it('should classify review intent correctly', async () => {
      installMockFetch(makeLLMResponse('review', 'code_review', 0.87, '检测到代码评审'));

      const classifier = new LLMFallbackClassifier();
      const result = await classifier.classify({ text: '帮我review一下这段代码' });

      expect(result).not.toBeNull();
      expect(result!.category).toBe('review');
      expect(result!.subCategory).toBe('code_review');
    });

    it('should extract entities from LLM response', async () => {
      installMockFetch(
        makeLLMResponse('create_task', 'general', 0.80, '检测到任务创建', [
          { type: 'task_name', value: '登录页重构' },
          { type: 'deadline', value: '下周五' },
          { type: 'priority', value: 'P0' },
        ]),
      );

      const classifier = new LLMFallbackClassifier();
      const result = await classifier.classify({ text: '创建登录页重构任务，截止时间是下周五，优先级P0' });

      expect(result).not.toBeNull();
      expect(result!.entities).toHaveLength(3);
      expect(result!.entities[0].type).toBe('task_name');
      expect(result!.entities[0].value).toBe('登录页重构');
      expect(result!.entities[1].type).toBe('deadline');
      expect(result!.entities[1].value).toBe('下周五');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 2. JSON Extraction
  // ══════════════════════════════════════════════════════════════════

  describe('JSON extraction from LLM output', () => {
    it('should extract JSON from markdown code block', async () => {
      installMockFetch(
        makeLLMResponseInCodeBlock('planning', 'sprint_planning', 0.83),
      );

      const classifier = new LLMFallbackClassifier();
      const result = await classifier.classify({ text: '下个迭代做个规划' });

      expect(result).not.toBeNull();
      expect(result!.category).toBe('planning');
      expect(result!.subCategory).toBe('sprint_planning');
      expect(result!.confidence).toBe(0.83);
    });

    it('should extract JSON from plain text response with surrounding text', async () => {
      const rawResponse = {
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content:
                '好的，我来帮你分析这个请求。根据你的描述，这是一个debug类型的任务。\n{"intent":"debug","subCategory":"crash","confidence":0.89,"rationale":"检测到崩溃关键词","entities":[]}',
            },
            finish_reason: 'stop',
          },
        ],
      };
      installMockFetch(rawResponse);

      const classifier = new LLMFallbackClassifier();
      const result = await classifier.classify({ text: '页面崩溃了' });

      expect(result).not.toBeNull();
      expect(result!.category).toBe('debug');
      expect(result!.subCategory).toBe('crash');
    });

    it('should handle JSON with extra whitespace and newlines', async () => {
      const rawResponse = {
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '  \n  {"intent":"research","subCategory":"spike","confidence":0.75}  \n  ',
            },
            finish_reason: 'stop',
          },
        ],
      };
      installMockFetch(rawResponse);

      const classifier = new LLMFallbackClassifier();
      const result = await classifier.classify({ text: '做个POC验证可行性' });

      expect(result).not.toBeNull();
      expect(result!.category).toBe('research');
      expect(result!.subCategory).toBe('spike');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 3. Confidence Normalization
  // ══════════════════════════════════════════════════════════════════

  describe('confidence normalization', () => {
    it('should clamp confidence to [0, 1] range (high)', async () => {
      installMockFetch(makeLLMResponse('create_task', 'general', 1.5, 'test'));

      const classifier = new LLMFallbackClassifier();
      const result = await classifier.classify({ text: '创建任务' });

      expect(result!.confidence).toBe(1);
    });

    it('should clamp confidence to [0, 1] range (negative)', async () => {
      installMockFetch(makeLLMResponse('create_task', 'general', -0.3, 'test'));

      const classifier = new LLMFallbackClassifier();
      const result = await classifier.classify({ text: '创建任务' });

      expect(result!.confidence).toBe(0);
    });

    it('should default to 0.5 when confidence is missing', async () => {
      installMockFetch({
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: JSON.stringify({ intent: 'create_task', subCategory: 'general' }),
            },
            finish_reason: 'stop',
          },
        ],
      });

      const classifier = new LLMFallbackClassifier();
      const result = await classifier.classify({ text: '创建任务' });

      expect(result!.confidence).toBe(0.5);
    });

    it('should default to other when intent is invalid', async () => {
      installMockFetch(makeLLMResponse('invalid_intent_xyz', 'general', 0.8, 'test'));

      const classifier = new LLMFallbackClassifier();
      const result = await classifier.classify({ text: '随便说点什么' });

      expect(result!.category).toBe('other');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 4. Timeout Handling
  // ══════════════════════════════════════════════════════════════════

  describe('timeout handling', () => {
    it('should return null when request times out', async () => {
      installMockFetchError(new Error('Request timeout') as any);
      // Override with AbortError behavior
      installMockFetchError(Object.assign(new Error('timeout'), { name: 'AbortError' }));

      const classifier = new LLMFallbackClassifier({ timeoutMs: 100 });
      const result = await classifier.classify({ text: '创建任务' });

      expect(result).toBeNull();
    });

    it('should return null when fetch throws network error', async () => {
      installMockFetchError(new Error('Network error: connection refused'));

      const classifier = new LLMFallbackClassifier({ timeoutMs: 5000 });
      const result = await classifier.classify({ text: '创建任务' });

      expect(result).toBeNull();
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 5. HTTP Error Handling
  // ══════════════════════════════════════════════════════════════════

  describe('HTTP error handling', () => {
    it('should return null on HTTP 500 error', async () => {
      installMockFetch({ error: 'Internal server error' }, 500);

      const classifier = new LLMFallbackClassifier();
      const result = await classifier.classify({ text: '创建任务' });

      expect(result).toBeNull();
    });

    it('should return null on HTTP 429 rate limit', async () => {
      installMockFetch({ error: 'Rate limit exceeded' }, 429);

      const classifier = new LLMFallbackClassifier();
      const result = await classifier.classify({ text: '创建任务' });

      expect(result).toBeNull();
    });

    it('should return null on HTTP 401 unauthorized', async () => {
      installMockFetch({ error: 'Unauthorized' }, 401);

      const classifier = new LLMFallbackClassifier();
      const result = await classifier.classify({ text: '创建任务' });

      expect(result).toBeNull();
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 6. Invalid Response Handling
  // ══════════════════════════════════════════════════════════════════

  describe('invalid response handling', () => {
    it('should return null when response has no content', async () => {
      installMockFetch({
        id: 'chatcmpl-test',
        choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
      });

      const classifier = new LLMFallbackClassifier();
      const result = await classifier.classify({ text: '创建任务' });

      expect(result).toBeNull();
    });

    it('should return null when choices is missing', async () => {
      installMockFetch({ id: 'chatcmpl-test', choices: [] });

      const classifier = new LLMFallbackClassifier();
      const result = await classifier.classify({ text: '创建任务' });

      expect(result).toBeNull();
    });

    it('should return null when response is malformed JSON', async () => {
      installMockFetch({
        choices: [
          { index: 0, message: { role: 'assistant', content: '这不是合法的JSON内容' }, finish_reason: 'stop' },
        ],
      });

      const classifier = new LLMFallbackClassifier();
      const result = await classifier.classify({ text: '创建任务' });

      expect(result).toBeNull();
    });

    it('should return null when response is not valid JSON at all', async () => {
      installMockFetch({
        choices: [
          { index: 0, message: { role: 'assistant', content: 'Hello, how can I help you?' }, finish_reason: 'stop' },
        ],
      });

      const classifier = new LLMFallbackClassifier();
      const result = await classifier.classify({ text: '创建任务' });

      expect(result).toBeNull();
    });

    it('should return null when intent is missing from parsed JSON', async () => {
      installMockFetch({
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: JSON.stringify({ subCategory: 'general', confidence: 0.8 }),
            },
            finish_reason: 'stop',
          },
        ],
      });

      const classifier = new LLMFallbackClassifier();
      const result = await classifier.classify({ text: '创建任务' });

      // intent missing → defaults to 'other' but still valid
      expect(result).not.toBeNull();
      expect(result!.category).toBe('other');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 7. Configuration
  // ══════════════════════════════════════════════════════════════════

  describe('configuration', () => {
    it('should use custom endpoint', async () => {
      let capturedUrl = '';
      installMockFetch(makeLLMResponse('create_task', 'general', 0.8, 'test'));

      // Override fetch to capture URL
      globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = String(url);
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => makeLLMResponse('create_task', 'general', 0.8, 'test'),
        } as Response;
      };

      const classifier = new LLMFallbackClassifier({
        endpoint: 'https://custom-llm.example.com/v1/chat/completions',
      });
      await classifier.classify({ text: '创建任务' });

      expect(capturedUrl).toContain('custom-llm.example.com');
    });

    it('should get and update config', () => {
      const classifier = new LLMFallbackClassifier({
        confidenceThreshold: 0.7,
        timeoutMs: 5000,
        model: 'claude-3',
      });

      const config = classifier.getConfig();
      expect(config.confidenceThreshold).toBe(0.7);
      expect(config.timeoutMs).toBe(5000);
      expect(config.model).toBe('claude-3');

      classifier.updateConfig({ timeoutMs: 3000 });
      expect(classifier.getConfig().timeoutMs).toBe(3000);
    });

    it('should use default values when config not provided', () => {
      const classifier = new LLMFallbackClassifier();
      const config = classifier.getConfig();

      expect(config.confidenceThreshold).toBe(0.5);
      expect(config.timeoutMs).toBe(10_000);
      expect(config.maxRetries).toBe(0);
      expect(config.endpoint).toBe('http://localhost:28789/v1/chat/completions');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 8. Intent Meta
  // ══════════════════════════════════════════════════════════════════

  describe('intent metadata', () => {
    it('should set source to llm in meta', async () => {
      installMockFetch(makeLLMResponse('planning', 'roadmap', 0.85, '检测到路线图规划'));

      const classifier = new LLMFallbackClassifier();
      const result = await classifier.classify({ text: '规划下版本的roadmap' });

      expect(result!.meta.source).toBe('llm');
      expect(result!.meta.inputLength).toBe('规划下版本的roadmap'.length);
      expect(result!.meta.processingTimeMs).toBeGreaterThanOrEqual(0);
      expect(result!.meta.rulesEvaluated).toBe(0);
      expect(result!.meta.contextUsed).toBe(false);
      expect(result!.meta.disambiguationTriggered).toBe(false);
    });

    it('should record processing time', async () => {
      installMockFetch(makeLLMResponse('create_task', 'general', 0.8, 'test'));

      const classifier = new LLMFallbackClassifier();
      const result = await classifier.classify({ text: '创建任务' });

      expect(result!.meta.processingTimeMs).toBeGreaterThanOrEqual(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 9. Entity Validation
  // ══════════════════════════════════════════════════════════════════

  describe('entity validation', () => {
    it('should filter out invalid entities with missing type or value', async () => {
      installMockFetch(
        makeLLMResponse('create_task', 'general', 0.8, 'test', [
          { type: 'task_name', value: '登录页重构' },
          { type: '', value: 'missing_type' }, // invalid
          { type: 'deadline', value: '' }, // invalid
          { type: 'priority', value: 'P0' },
          null as any, // invalid
        ]),
      );

      const classifier = new LLMFallbackClassifier();
      const result = await classifier.classify({ text: '创建任务' });

      expect(result!.entities).toHaveLength(2);
      expect(result!.entities[0].type).toBe('task_name');
      expect(result!.entities[1].type).toBe('priority');
    });

    it('should default entity position and confidence when missing', async () => {
      installMockFetch(
        makeLLMResponse('create_task', 'general', 0.8, 'test', [
          { type: 'task_name', value: '登录页重构' },
        ]),
      );

      const classifier = new LLMFallbackClassifier();
      const result = await classifier.classify({ text: '创建任务' });

      expect(result!.entities[0].position).toBe(0);
      expect(result!.entities[0].confidence).toBe(0.7); // default
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 10. Rationale
  // ══════════════════════════════════════════════════════════════════

  describe('rationale', () => {
    it('should use LLM-provided rationale when available', async () => {
      installMockFetch(makeLLMResponse('create_task', 'general', 0.8, '检测到关键词：创建'));

      const classifier = new LLMFallbackClassifier();
      const result = await classifier.classify({ text: '创建任务' });

      expect(result!.rationale).toBe('检测到关键词：创建');
    });

    it('should generate rationale when missing from LLM response', async () => {
      installMockFetch({
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: JSON.stringify({ intent: 'create_task', subCategory: 'general', confidence: 0.8 }),
            },
            finish_reason: 'stop',
          },
        ],
      });

      const classifier = new LLMFallbackClassifier();
      const result = await classifier.classify({ text: '创建任务' });

      expect(result!.rationale).toContain('LLM 分类');
    });
  });
});

// ══════════════════════════════════════════════════════════════════════
// 11. fallbackToRegex
// ══════════════════════════════════════════════════════════════════════

describe('fallbackToRegex()', () => {
  it('should return the original regex result unchanged', () => {
    const originalResult = {
      category: 'create_task' as const,
      subCategory: 'general' as const,
      confidence: 0.45,
      entities: [],
      alternatives: [],
      rationale: 'Matched rule: task_creation_keywords',
      ambiguous: false,
      meta: {
        processingTimeMs: 2,
        inputLength: 10,
        rulesEvaluated: 25,
        rulesMatched: 3,
        disambiguationTriggered: false,
        contextUsed: false,
        source: 'rule_engine' as const,
      },
    };

    const result = fallbackToRegex(originalResult, 'LLM timeout');

    expect(result).toBe(originalResult);
    expect(result.category).toBe('create_task');
    expect(result.confidence).toBe(0.45);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 12. classifyWithLLM convenience function
// ══════════════════════════════════════════════════════════════════════

describe('classifyWithLLM()', () => {
  afterEach(() => {
    uninstallMockFetch();
  });

  it('should work as a convenience wrapper', async () => {
    installMockFetch(makeLLMResponse('debug', 'crash', 0.91, '检测到崩溃'));

    const result = await classifyWithLLM('页面崩溃了');

    expect(result).not.toBeNull();
    expect(result!.category).toBe('debug');
    expect(result!.subCategory).toBe('crash');
    expect(result!.confidence).toBe(0.91);
  });

  it('should accept config override', async () => {
    installMockFetch(makeLLMResponse('create_task', 'general', 0.8, 'test'));

    const result = await classifyWithLLM('创建任务', {
      confidenceThreshold: 0.3,
      model: 'claude-3-sonnet',
    });

    expect(result).not.toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════
// 13. All Intent Categories
// ══════════════════════════════════════════════════════════════════════

describe('all intent categories', () => {
  afterEach(() => {
    uninstallMockFetch();
  });

  const categoryTests: Array<{
    text: string;
    expectedCategory: string;
    expectedSubCategory: string;
    confidence: number;
  }> = [
    { text: '创建登录页重构任务', expectedCategory: 'create_task', expectedSubCategory: 'general', confidence: 0.88 },
    { text: '登录模块怎么样了', expectedCategory: 'query_status', expectedSubCategory: 'single', confidence: 0.90 },
    { text: '把截止时间改到周五', expectedCategory: 'modify_task', expectedSubCategory: 'deadline', confidence: 0.85 },
    { text: '删除那个任务', expectedCategory: 'delete_task', expectedSubCategory: 'single', confidence: 0.87 },
    { text: '周三下午安排评审', expectedCategory: 'schedule', expectedSubCategory: 'create', confidence: 0.82 },
    { text: '页面崩溃了', expectedCategory: 'debug', expectedSubCategory: 'crash', confidence: 0.91 },
    { text: '实现登录功能', expectedCategory: 'development', expectedSubCategory: 'feature_impl', confidence: 0.89 },
    { text: '排查原因', expectedCategory: 'research', expectedSubCategory: 'investigation', confidence: 0.86 },
    { text: '做个code review', expectedCategory: 'review', expectedSubCategory: 'code_review', confidence: 0.90 },
    { text: '下个迭代规划', expectedCategory: 'planning', expectedSubCategory: 'sprint_planning', confidence: 0.88 },
    { text: '随便说点什么', expectedCategory: 'other', expectedSubCategory: 'fallback', confidence: 0.5 },
  ];

  for (const tc of categoryTests) {
    it(`should classify "${tc.text}" as ${tc.expectedCategory}.${tc.expectedSubCategory}`, async () => {
      installMockFetch(
        makeLLMResponse(tc.expectedCategory, tc.expectedSubCategory, tc.confidence, 'test'),
      );

      const classifier = new LLMFallbackClassifier();
      const result = await classifier.classify({ text: tc.text });

      expect(result).not.toBeNull();
      expect(result!.category).toBe(tc.expectedCategory);
      expect(result!.subCategory).toBe(tc.expectedSubCategory);
    });
  }
});

// ─── Run ────────────────────────────────────────────────────────────

console.log('\n  LLM Fallback Test Suite (Phase 3 M6)\n');
