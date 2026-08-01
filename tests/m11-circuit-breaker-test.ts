/**
 * Claw Task Service — M11 Circuit Breaker & LLM Fallback Enhancement Tests
 *
 * 测试场景：
 *   1. 指数退避重试 — 验证 3 次重试 + 退避延迟
 *   2. 多模型 fallback 链 — 主 endpoint 失败后切换到备 endpoint
 *   3. 熔断器触发 — 连续 5 次失败后暂停 LLM fallback
 *   4. 熔断器恢复 — 60s 后从 OPEN 恢复到 HALF_OPEN 再到 CLOSED
 *   5. 结果缓存 — 相同输入 60s 内返回缓存结果
 *   6. 熔断器半开状态 — 探测请求成功/失败的行为
 *
 * Run: npx tsx tests/m11-circuit-breaker-test.ts
 */

import { LLMFallbackClassifier, CircuitBreaker, calculateBackoff, fallbackToRegex } from '../intent-engine/llm-fallback.js';
import { LRUCache, fnv1aHash } from '../intent-engine/lru-cache.js';
import type { IntentResult } from '../intent-engine/types.js';

// ─── Test Framework ────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(message);
    console.error(`❌ FAIL: ${message}`);
  }
}

function assertApprox(val: number, expected: number, tolerance: number, message: string): void {
  assert(Math.abs(val - expected) < tolerance, `${message} (got ${val}, expected ~${expected})`);
}

function section(name: string): void {
  console.log(`\n── ${name} ──`);
}

// ─── Mock Utilities ────────────────────────────────────────────────

let originalFetch: typeof globalThis.fetch | null = null;

function installMockFetch(responses: Array<{ status?: number; body?: any; shouldThrow?: boolean }>) {
  originalFetch = globalThis.fetch;
  let callIndex = 0;

  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const idx = Math.min(callIndex, responses.length - 1);
    callIndex++;
    const resp = responses[idx];

    if (resp.shouldThrow) {
      throw new Error(resp.body?.message ?? 'Mock fetch error');
    }

    const status = resp.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      json: async () => resp.body,
    } as Response;
  }) as typeof globalThis.fetch;
}

function installAlwaysFailFetch() {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('Connection refused');
  }) as typeof globalThis.fetch;
}

function uninstallMockFetch() {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = null;
  }
}

// ─── LLM Response Factory ──────────────────────────────────────────

function makeLLMResponse(
  intent: string,
  subCategory: string,
  confidence: number,
  rationale: string = 'test',
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

function makeIntentResult(
  category: string = 'create_task',
  confidence: number = 0.85,
): IntentResult {
  return {
    category: category as any,
    subCategory: 'general' as any,
    confidence,
    entities: [],
    alternatives: [],
    rationale: 'test',
    ambiguous: false,
    meta: {
      processingTimeMs: 10,
      inputLength: 10,
      rulesEvaluated: 0,
      rulesMatched: 0,
      disambiguationTriggered: false,
      contextUsed: false,
      source: 'llm',
    },
  };
}

// ═══════════════════════════════════════════════════════════════════
// 1. Exponential Backoff — 指数退避计算
// ═══════════════════════════════════════════════════════════════════

section('1. Exponential Backoff Calculation');

assert(calculateBackoff(0) === 1000, `Backoff attempt 0 should be 1000ms, got ${calculateBackoff(0)}`);
assert(calculateBackoff(1) === 2000, `Backoff attempt 1 should be 2000ms, got ${calculateBackoff(1)}`);
assert(calculateBackoff(2) === 4000, `Backoff attempt 2 should be 4000ms, got ${calculateBackoff(2)}`);
assert(calculateBackoff(3) === 8000, `Backoff attempt 3 should be 8000ms, got ${calculateBackoff(3)}`);
// attempt 5: 2^5 * 1000 = 32000, capped at 30000
assert(calculateBackoff(5) === 30000, `Backoff attempt 5 should be capped at 30000ms, got ${calculateBackoff(5)}`);

// Max cap test
assert(calculateBackoff(10, 1000, 30000) === 30000, `Backoff should cap at 30000ms, got ${calculateBackoff(10, 1000, 30000)}`);

// Custom base
assert(calculateBackoff(0, 500) === 500, `Backoff with base 500 should be 500ms, got ${calculateBackoff(0, 500)}`);
assert(calculateBackoff(1, 500) === 1000, `Backoff with base 500 attempt 1 should be 1000ms, got ${calculateBackoff(1, 500)}`);

console.log('  ✓ Exponential backoff: 1s/2s/4s/8s with correct capping');

// ═══════════════════════════════════════════════════════════════════
// 2. Circuit Breaker — 熔断器基本逻辑
// ═══════════════════════════════════════════════════════════════════

section('2. Circuit Breaker Logic');

{
  const cb = new CircuitBreaker(5, 60_000);

  // 初始状态 CLOSED
  assert(cb.getState() === 'CLOSED', `Initial state should be CLOSED, got ${cb.getState()}`);
  assert(cb.canRequest() === true, `CLOSED state should allow requests`);

  // 4 次失败 — 还在 CLOSED
  for (let i = 0; i < 4; i++) {
    cb.recordFailure();
  }
  assert(cb.getState() === 'CLOSED', `After 4 failures, should still be CLOSED, got ${cb.getState()}`);
  assert(cb.canRequest() === true, `4 failures should still allow requests`);
  assert(cb.getFailureCount() === 4, `Failure count should be 4, got ${cb.getFailureCount()}`);

  // 第 5 次失败 — 触发熔断
  cb.recordFailure();
  assert(cb.getState() === 'OPEN', `After 5 failures, should be OPEN, got ${cb.getState()}`);
  assert(cb.canRequest() === false, `OPEN state should block requests`);
  assert(cb.getFailureCount() === 5, `Failure count should be 5, got ${cb.getFailureCount()}`);

  console.log('  ✓ Circuit breaker: CLOSED → OPEN after 5 consecutive failures');
}

// ═══════════════════════════════════════════════════════════════════
// 3. Circuit Breaker Recovery — 熔断器恢复
// ═══════════════════════════════════════════════════════════════════

section('3. Circuit Breaker Recovery (OPEN → HALF_OPEN → CLOSED)');

{
  const cb = new CircuitBreaker(3, 100); // 短恢复时间方便测试

  // 触发熔断
  for (let i = 0; i < 3; i++) {
    cb.recordFailure();
  }
  assert(cb.getState() === 'OPEN', `Should be OPEN after 3 failures, got ${cb.getState()}`);
  assert(cb.canRequest() === false, `Should block requests when OPEN`);

  // 等待恢复时间
  // 使用 fake timer — 直接检查逻辑
  // 由于 canRequest 内部会检查时间，我们需要等待
  // 这里用同步方式测试 — 先直接测试 HALF_OPEN 逻辑
  
  // 模拟时间流逝：在真实代码中 Date.now() 会自然前进
  // 对于单元测试，我们等待 120ms
  await new Promise(r => setTimeout(r, 120));

  // 恢复时间到了，canRequest 应该返回 true 并切换到 HALF_OPEN
  assert(cb.canRequest() === true, `After reset time, should allow probe request (HALF_OPEN)`);
  assert(cb.getState() === 'HALF_OPEN', `Should be HALF_OPEN after reset time, got ${cb.getState()}`);

  // 探测成功 — 恢复到 CLOSED
  cb.recordSuccess();
  assert(cb.getState() === 'CLOSED', `After successful probe, should be CLOSED, got ${cb.getState()}`);
  assert(cb.getFailureCount() === 0, `Failure count should reset to 0 after recovery, got ${cb.getFailureCount()}`);

  console.log('  ✓ Circuit breaker: OPEN → HALF_OPEN → CLOSED on successful recovery');
}

// ═══════════════════════════════════════════════════════════════════
// 4. Circuit Breaker Half-Open Failure — 半开状态失败
// ═══════════════════════════════════════════════════════════════════

section('4. Circuit Breaker Half-Open Failure');

{
  const cb = new CircuitBreaker(2, 100);

  // 触发熔断
  cb.recordFailure();
  cb.recordFailure();
  assert(cb.getState() === 'OPEN', `Should be OPEN after 2 failures`);

  // 等待恢复
  await new Promise(r => setTimeout(r, 120));
  assert(cb.canRequest() === true, `Should allow probe (HALF_OPEN)`);
  assert(cb.getState() === 'HALF_OPEN', `Should be HALF_OPEN`);

  // 探测失败 — 重新打开
  cb.recordFailure();
  assert(cb.getState() === 'OPEN', `After failed probe, should be OPEN again, got ${cb.getState()}`);
  assert(cb.canRequest() === false, `Should block requests after failed probe`);

  console.log('  ✓ Circuit breaker: HALF_OPEN → OPEN on probe failure');
}

// ═══════════════════════════════════════════════════════════════════
// 5. LLM Fallback with Retry — 指数退避重试集成测试
// ═══════════════════════════════════════════════════════════════════

section('5. LLM Fallback Retry Integration');

{
  // 测试：第一次失败，第二次成功
  let fetchCalls = 0;
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls++;
    if (fetchCalls === 1) {
      // 第一次返回 500
      return {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: async () => ({ error: 'server error' }),
      } as Response;
    }
    // 第二次成功
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => makeLLMResponse('create_task', 'general', 0.88, 'retry success'),
    } as Response;
  }) as typeof globalThis.fetch;

  const classifier = new LLMFallbackClassifier({
    maxRetries: 3,
    timeoutMs: 5000,
    circuitBreakerThreshold: 10, // 提高阈值避免影响重试测试
  });

  const result = await classifier.classify({ text: '创建任务测试重试' });

  assert(result !== null, 'Retry should succeed on 2nd attempt');
  assert(result!.category === 'create_task', `Category should be create_task, got ${result?.category}`);
  assert(result!.confidence === 0.88, `Confidence should be 0.88, got ${result?.confidence}`);
  assert(fetchCalls === 2, `Should have made exactly 2 fetch calls, got ${fetchCalls}`);

  // 验证熔断器状态正常（成功后重置）
  const cbState = classifier.getCircuitBreakerState();
  assert(cbState.state === 'CLOSED', `Circuit breaker should be CLOSED after success, got ${cbState.state}`);
  assert(cbState.failures === 0, `Failure count should be 0 after success, got ${cbState.failures}`);

  uninstallMockFetch();
  console.log('  ✓ Retry: 1st failure (500) → 2nd success with correct result');
}

// ═══════════════════════════════════════════════════════════════════
// 6. Multi-Model Fallback Chain — 多模型 fallback 链
// ═══════════════════════════════════════════════════════════════════

section('6. Multi-Model Fallback Chain');

{
  let primaryCalled = false;
  let secondaryCalled = false;
  originalFetch = globalThis.fetch;

  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = String(url);

    if (urlStr.includes('primary')) {
      primaryCalled = true;
      return {
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        json: async () => ({ error: 'primary down' }),
      } as Response;
    }

    if (urlStr.includes('secondary')) {
      secondaryCalled = true;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => makeLLMResponse('debug', 'crash', 0.91, 'secondary endpoint'),
      } as Response;
    }

    throw new Error(`Unexpected URL: ${urlStr}`);
  }) as typeof globalThis.fetch;

  const classifier = new LLMFallbackClassifier({
    maxRetries: 0, // 不重试，直接 fallback 到下一个 endpoint
    circuitBreakerThreshold: 10,
    fallbackChain: [
      { endpoint: 'http://primary:28789/v1/chat/completions', model: 'gpt-4', timeoutMs: 5000 },
      { endpoint: 'http://secondary:28790/v1/chat/completions', model: 'gpt-3.5', timeoutMs: 5000 },
    ],
  });

  const result = await classifier.classify({ text: '页面崩溃了' });

  assert(primaryCalled, 'Primary endpoint should be called');
  assert(secondaryCalled, 'Secondary endpoint should be called');
  assert(result !== null, 'Should get result from secondary endpoint');
  assert(result!.category === 'debug', `Category should be debug, got ${result?.category}`);
  assert(result!.confidence === 0.91, `Confidence should be 0.91, got ${result?.confidence}`);

  uninstallMockFetch();
  console.log('  ✓ Multi-model: primary (503) → secondary (200) with correct result');
}

// ═══════════════════════════════════════════════════════════════════
// 7. Result Caching — 结果缓存
// ═══════════════════════════════════════════════════════════════════

section('7. Result Caching');

{
  let fetchCalls = 0;
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls++;
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => makeLLMResponse('planning', 'roadmap', 0.85, 'cached result'),
    } as Response;
  }) as typeof globalThis.fetch;

  const classifier = new LLMFallbackClassifier({
    maxRetries: 0,
    circuitBreakerThreshold: 10,
    resultCacheTtlMs: 60_000,
    resultCacheCapacity: 100,
  });

  // 第一次调用 — 应该走 fetch
  const result1 = await classifier.classify({ text: '规划路线图' });
  assert(result1 !== null, 'First call should return result');
  assert(result1!.category === 'planning', `First call category should be planning`);
  assert(fetchCalls === 1, `Should make 1 fetch call, got ${fetchCalls}`);

  // 第二次相同输入 — 应该走缓存
  const result2 = await classifier.classify({ text: '规划路线图' });
  assert(result2 !== null, 'Second call should return cached result');
  assert(result2!.category === 'planning', `Cached result category should match`);
  assert(fetchCalls === 1, `Should still be 1 fetch call (cache hit), got ${fetchCalls}`);
  assert(result2 === result1, 'Should return the exact same object from cache');

  // 清空缓存后 — 应该重新 fetch
  classifier.clearResultCache();
  const result3 = await classifier.classify({ text: '规划路线图' });
  assert(fetchCalls === 2, `After cache clear, should make new fetch call, got ${fetchCalls}`);

  uninstallMockFetch();
  console.log('  ✓ Caching: 1st fetch → 2nd cache hit → clear → 3rd fetch');
}

// ═══════════════════════════════════════════════════════════════════
// 8. Circuit Breaker Integration — 熔断器与分类器集成
// ═══════════════════════════════════════════════════════════════════

section('8. Circuit Breaker Integration with Classifier');

{
  installAlwaysFailFetch();

  const classifier = new LLMFallbackClassifier({
    maxRetries: 0, // 不重试，快速触发熔断
    circuitBreakerThreshold: 3,
    circuitBreakerResetMs: 60_000,
    fallbackChain: [{ endpoint: 'http://test:28789/v1/chat/completions', model: 'test', timeoutMs: 1000 }],
  });

  // 调用 3 次 — 每次都失败
  for (let i = 0; i < 3; i++) {
    const result = await classifier.classify({ text: `测试失败${i}` });
    assert(result === null, `Call ${i + 1} should return null`);
  }

  // 熔断器应该开启
  const state = classifier.getCircuitBreakerState();
  assert(state.state === 'OPEN', `Circuit breaker should be OPEN after 3 failures, got ${state.state}`);
  assert(state.failures === 3, `Should have 3 failures, got ${state.failures}`);

  // 第 4 次调用 — 熔断器开启，不应该发 fetch 请求
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  }) as typeof globalThis.fetch;

  const result4 = await classifier.classify({ text: '熔断器测试' });
  assert(result4 === null, 'Call during circuit open should return null');
  assert(!fetchCalled, 'Fetch should NOT be called when circuit is open');

  // 手动重置熔断器
  classifier.resetCircuitBreaker();
  const stateAfterReset = classifier.getCircuitBreakerState();
  assert(stateAfterReset.state === 'CLOSED', `After reset, should be CLOSED, got ${stateAfterReset.state}`);
  assert(stateAfterReset.failures === 0, `After reset, failures should be 0, got ${stateAfterReset.failures}`);

  uninstallMockFetch();
  console.log('  ✓ Integration: 3 failures → OPEN → blocked fetch → manual reset → CLOSED');
}

// ═══════════════════════════════════════════════════════════════════
// 9. FallbackToRegex — 降级策略
// ═══════════════════════════════════════════════════════════════════

section('9. Fallback to Regex');

{
  const originalResult = makeIntentResult('create_task', 0.45);
  originalResult.rationale = 'Matched rule: task_creation_keywords';

  const result = fallbackToRegex(originalResult, 'LLM timeout');

  assert(result === originalResult, 'Should return the exact same object');
  assert(result.category === 'create_task', 'Category should be unchanged');
  assert(result.confidence === 0.45, 'Confidence should be unchanged');
  assert(result.meta.source === 'llm', 'Source should be unchanged');

  console.log('  ✓ Fallback to regex: returns original result unchanged');
}

// ═══════════════════════════════════════════════════════════════════
// 10. LRU Cache for Result Caching — LRU 缓存验证
// ═══════════════════════════════════════════════════════════════════

section('10. LRU Cache for Result Caching');

{
  const cache = new LRUCache<string, IntentResult>(3, 60_000);

  const r1 = makeIntentResult('create_task', 0.8);
  const r2 = makeIntentResult('query_status', 0.9);
  const r3 = makeIntentResult('debug', 0.7);

  cache.set('key1', r1);
  cache.set('key2', r2);
  cache.set('key3', r3);

  assert(cache.size === 3, `Cache size should be 3, got ${cache.size}`);
  assert(cache.get('key1') === r1, 'Should get key1');
  assert(cache.get('key2') === r2, 'Should get key2');
  assert(cache.get('key3') === r3, 'Should get key3');

  // 插入第 4 个 — 应该淘汰 key1（LRU）
  const r4 = makeIntentResult('review', 0.6);
  cache.set('key4', r4);

  assert(cache.size === 3, `Cache size should still be 3, got ${cache.size}`);
  assert(cache.get('key1') === undefined, 'key1 should be evicted (LRU)');
  assert(cache.get('key4') === r4, 'key4 should be present');

  console.log('  ✓ LRU cache: capacity=3, eviction works correctly');
}

// ═══════════════════════════════════════════════════════════════════
// 11. Config — 配置验证
// ═══════════════════════════════════════════════════════════════════

section('11. M11 Configuration');

{
  const classifier = new LLMFallbackClassifier({
    maxRetries: 3,
    circuitBreakerThreshold: 5,
    circuitBreakerResetMs: 60_000,
    resultCacheTtlMs: 60_000,
    resultCacheCapacity: 500,
    fallbackChain: [
      { endpoint: 'http://primary:28789/v1/chat/completions', model: 'gpt-4', timeoutMs: 10000 },
      { endpoint: 'http://backup:28790/v1/chat/completions', model: 'gpt-3.5', timeoutMs: 10000 },
    ],
  });

  const config = classifier.getConfig();
  assert(config.maxRetries === 3, `maxRetries should be 3, got ${config.maxRetries}`);
  assert(config.circuitBreakerThreshold === 5, `CB threshold should be 5, got ${config.circuitBreakerThreshold}`);
  assert(config.circuitBreakerResetMs === 60_000, `CB reset should be 60000, got ${config.circuitBreakerResetMs}`);
  assert(config.resultCacheTtlMs === 60_000, `Cache TTL should be 60000, got ${config.resultCacheTtlMs}`);
  assert(config.fallbackChain?.length === 2, `Fallback chain should have 2 endpoints, got ${config.fallbackChain?.length}`);

  // 默认配置
  const defaultClassifier = new LLMFallbackClassifier();
  const defaultConfig = defaultClassifier.getConfig();
  assert(defaultConfig.maxRetries === 3, `Default maxRetries should be 3, got ${defaultConfig.maxRetries}`);
  assert(defaultConfig.circuitBreakerThreshold === 5, `Default CB threshold should be 5, got ${defaultConfig.circuitBreakerThreshold}`);
  assert(defaultConfig.circuitBreakerResetMs === 60_000, `Default CB reset should be 60000, got ${defaultConfig.circuitBreakerResetMs}`);
  assert(defaultConfig.resultCacheTtlMs === 60_000, `Default cache TTL should be 60000, got ${defaultConfig.resultCacheTtlMs}`);
  assert(defaultConfig.resultCacheCapacity === 500, `Default cache capacity should be 500, got ${defaultConfig.resultCacheCapacity}`);

  console.log('  ✓ Config: M11 defaults (retry=3, CB=5/60s, cache=60s/500)');
}

// ═══════════════════════════════════════════════════════════════════
// 12. FNV Hash — 缓存键生成
// ═══════════════════════════════════════════════════════════════════

section('12. FNV Hash for Cache Keys');

{
  const hash1 = fnv1aHash('创建任务');
  const hash2 = fnv1aHash('创建任务');
  const hash3 = fnv1aHash('查询任务');

  assert(hash1 === hash2, 'Same input should produce same hash');
  assert(hash1 !== hash3, 'Different inputs should produce different hashes');
  assert(hash1.length === 8, `Hash should be 8 hex chars, got ${hash1.length}`);

  // 空字符串
  const emptyHash = fnv1aHash('');
  assert(emptyHash.length === 8, `Empty string hash should still be 8 chars, got ${emptyHash.length}`);

  console.log('  ✓ FNV hash: deterministic, 8 hex chars, different inputs → different hashes');
}

// ═══════════════════════════════════════════════════════════════════
// 13. All Endpoints Fail — 所有 endpoint 失败
// ═══════════════════════════════════════════════════════════════════

section('13. All Endpoints Fail');

{
  let primaryCalls = 0;
  let secondaryCalls = 0;
  originalFetch = globalThis.fetch;

  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = String(url);
    if (urlStr.includes('primary')) {
      primaryCalls++;
      return { ok: false, status: 500, json: async () => ({}) } as Response;
    }
    if (urlStr.includes('secondary')) {
      secondaryCalls++;
      return { ok: false, status: 503, json: async () => ({}) } as Response;
    }
    throw new Error('Unexpected');
  }) as typeof globalThis.fetch;

  const classifier = new LLMFallbackClassifier({
    maxRetries: 0,
    circuitBreakerThreshold: 10,
    fallbackChain: [
      { endpoint: 'http://primary:28789/v1/chat/completions', model: 'gpt-4', timeoutMs: 1000 },
      { endpoint: 'http://secondary:28790/v1/chat/completions', model: 'gpt-3.5', timeoutMs: 1000 },
    ],
  });

  const result = await classifier.classify({ text: '测试全部失败' });

  assert(result === null, 'Should return null when all endpoints fail');
  assert(primaryCalls > 0, 'Primary should have been called');
  assert(secondaryCalls > 0, 'Secondary should have been called');

  const cbState = classifier.getCircuitBreakerState();
  assert(cbState.failures === 1, `Should have 1 failure recorded, got ${cbState.failures}`);

  uninstallMockFetch();
  console.log('  ✓ All fail: primary (500) + secondary (503) → null + 1 CB failure');
}

// ─── Summary ───────────────────────────────────────────────────────

console.log(`\n${'='.repeat(60)}`);
console.log(`M11 Circuit Breaker & LLM Fallback Enhancement Tests`);
console.log(`${'='.repeat(60)}`);
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
console.log(`  Total:  ${passed + failed}`);
console.log(`  Pass Rate: ${((passed / (passed + failed)) * 100).toFixed(1)}%`);

if (failed > 0) {
  console.log(`\n❌ Failures:`);
  failures.forEach(f => console.log(`  - ${f}`));
  process.exit(1);
} else {
  console.log(`\n✅ All tests passed!`);
  process.exit(0);
}
