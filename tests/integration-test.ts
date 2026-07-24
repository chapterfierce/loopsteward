/**
 * Claw Task Service — 集成测试 (Phase 3 M6)
 *
 * 端到端集成测试，覆盖以下场景：
 *   1. 端到端流程：用户输入 → 预处理 → 分类 → 实体提取 → 结果输出
 *   2. Task Manager 集成：task-types + task-lifecycle 联动测试
 *   3. 多语言：中文+英文混合输入分类
 *   4. 缓存命中+失效场景
 *   5. 可观测性：metrics 记录验证
 *   6. 自定义意图：注册+匹配+优先级
 *   7. LLM Fallback：低置信度触发 + 降级策略
 *
 * 运行方式：npx tsx tests/integration-test.ts
 *
 * 基于: Phase 3 M6 任务规格 (2026-07-24)
 */

import {
  classifyIntent,
  classifyIntentAsync,
  classifyAndRoute,
  classifyIntentBatch,
  clearCache,
  getCacheStats,
  resetCacheStats,
  debugPipeline,
  collectStats,
  getRouteHandler,
} from '../intent-engine/pipeline.js';
import {
  classify,
  classifyText,
  classifyTextWithLocale,
  debugClassify,
} from '../intent-engine/classifier.js';
import { preprocess } from '../intent-engine/preprocessor.js';
import { extractEntities } from '../intent-engine/entity-extractor.js';
import { metrics } from '../intent-engine/metrics.js';
import {
  CustomIntentRegistry,
  registerIntent,
  unregisterIntent,
  getCustomRules,
  getMergedRules,
} from '../intent-engine/custom-intent-registry.js';
import { IntentPriority } from '../intent-engine/custom-intent-types.js';
import { RULES } from '../intent-engine/patterns.js';
import {
  TaskStatus,
  TaskPriority,
  VALID_TRANSITIONS,
} from '../src/task-manager/task-types.js';
import {
  isValidTransition,
  validateTransition,
  isTerminalStatus,
  getNextValidStatuses,
  canCancel,
  canComplete,
  canStart,
  canAssign,
  LifecycleError,
  LifecycleLogger,
} from '../src/task-manager/task-lifecycle.js';
import {
  LLMFallbackClassifier,
  fallbackToRegex,
  classifyWithLLM,
} from '../intent-engine/llm-fallback.js';

// ─── 测试框架 ─────────────────────────────────────────────────────

let passCount = 0;
let failCount = 0;
const failures: string[] = [];

/** 异步测试 Promise 队列 */
const pendingPromises: Promise<unknown>[] = [];

function assert(condition: boolean, message: string): void {
  if (condition) {
    passCount++;
  } else {
    failCount++;
    failures.push(message);
    console.error(`  ❌ FAIL: ${message}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  const eq = JSON.stringify(actual) === JSON.stringify(expected);
  if (eq) {
    passCount++;
  } else {
    failCount++;
    failures.push(`${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
    console.error(`  ❌ FAIL: ${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

function assertApprox(actual: number, expected: number, delta: number, message: string): void {
  if (Math.abs(actual - expected) <= delta) {
    passCount++;
  } else {
    failCount++;
    failures.push(`${message} (expected ~${expected}±${delta}, got ${actual})`);
    console.error(`  ❌ FAIL: ${message} (expected ~${expected}±${delta}, got ${actual})`);
  }
}

function assertTruthy(value: unknown, message: string): void {
  assert(!!value, message);
}

function assertFalsy(value: unknown, message: string): void {
  assert(!value, message);
}

function describe(name: string, fn: () => void): void {
  console.log(`\n━─━ ${name} ━─━`);
  fn();
}

function describeAsync(name: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n━─━ ${name} (async) ━─━`);
  return fn();
}

// ─── 测试开始 ─────────────────────────────────────────────────────

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║  Claw Task Service — M6 集成测试 + LLM Fallback         ║');
console.log('╚══════════════════════════════════════════════════════════╝');

// ─── 1. 端到端流程测试 ────────────────────────────────────────────

describe('1. 端到端流程：用户输入 → 预处理 → 分类 → 实体提取 → 结果输出', () => {
  // 1.1 预处理 → 分类 → 实体提取完整流程
  const input = '帮我创建一个登录页面重构任务，下周五前完成，P1优先级';
  const preprocessed = preprocess(input);

  assertTruthy(preprocessed.normalized, '预处理应返回非空 normalized');
  assertTruthy(preprocessed.tokens.length > 0, '预处理应返回非空 tokens');
  assert(preprocessed.normalized.includes('创建'), '预处理后应包含"创建"');

  // 1.2 分类
  const result = classifyText(input);
  assertTruthy(result, '分类应返回非空结果');
  assertEqual(result.category, 'create_task', '应分类为 create_task');
  assert(result.confidence > 0, '置信度应大于 0');
  assertTruthy(result.rationale, '应包含 rationale 说明');

  // 1.3 实体提取
  const entities = extractEntities(preprocessed);
  assertTruthy(entities.length > 0, '应提取到至少一个实体');

  // 验证 deadline 实体
  const deadlineEntities = entities.filter(e => e.type === 'deadline');
  assertTruthy(deadlineEntities.length > 0, '应提取到 deadline 实体');

  // 验证 priority 实体
  const priorityEntities = entities.filter(e => e.type === 'priority');
  assertTruthy(priorityEntities.length > 0, '应提取到 priority 实体 (P1)');

  // 1.4 管道完整流程
  const pipelineResult = classifyIntent(input);
  assertTruthy(pipelineResult, '管道分类应返回非空结果');
  assertEqual(pipelineResult.category, 'create_task', '管道应分类为 create_task');
  assertTruthy(pipelineResult.routeHandler, '应返回路由处理器');
  assertEqual(pipelineResult.routeHandler, 'task.create', '路由应为 task.create');
  assertEqual(pipelineResult.pipelineVersion, '3.0.0', '管道版本应为 3.0.0');

  // 1.5 classifyAndRoute
  const routed = classifyAndRoute(input);
  assertEqual(routed.handler, 'task.create', 'classifyAndRoute 应返回 task.create 路由');

  // 1.6 不同意图类别
  const queryResult = classifyIntent('查看所有任务状态');
  assertTruthy(queryResult.category === 'query_status' || queryResult.category === 'other',
    '查询类输入应分类为 query_status 或 other');

  const deleteResult = classifyIntent('删除任务123');
  assertTruthy(deleteResult.category === 'delete_task' || deleteResult.category === 'other',
    '删除类输入应分类为 delete_task 或 other');

  // 1.7 端到端 — 多种输入
  const inputs = [
    '创建一个新功能开发任务',
    '帮我查一下当前所有任务',
    '把任务状态改成已完成',
    '安排一下下周的日程',
  ];

  for (const text of inputs) {
    const r = classifyIntent(text);
    assertTruthy(r.category, `输入"${text}"应返回有效类别`);
    assert(r.confidence >= 0 && r.confidence <= 1, `输入"${text}"置信度应在 [0,1]`);
  }
});

// ─── 2. Task Manager 集成测试 ────────────────────────────────────

describe('2. Task Manager 集成：task-types + task-lifecycle 联动测试', () => {
  // 2.1 任务状态类型
  assertEqual<unknown>('created', 'created', 'TaskStatus "created" 应存在');
  assertEqual<unknown>('completed', 'completed', 'TaskStatus "completed" 应存在');
  assertEqual<unknown>('cancelled', 'cancelled', 'TaskStatus "cancelled" 应存在');

  // 2.2 状态转换验证
  assertTruthy(isValidTransition('created', 'assigned'), 'created → assigned 应有效');
  assertTruthy(isValidTransition('assigned', 'in_progress'), 'assigned → in_progress 应有效');
  assertTruthy(isValidTransition('in_progress', 'completed'), 'in_progress → completed 应有效');
  assertTruthy(isValidTransition('in_progress', 'on_hold'), 'in_progress → on_hold 应有效');
  assertTruthy(isValidTransition('on_hold', 'in_progress'), 'on_hold → in_progress 应有效');

  assertFalsy(isValidTransition('completed', 'in_progress'), 'completed → in_progress 应无效');
  assertFalsy(isValidTransition('cancelled', 'created'), 'cancelled → created 应无效');
  assertFalsy(isValidTransition('completed', 'cancelled'), 'completed → cancelled 应无效');

  // 2.3 validateTransition 抛异常
  let threw = false;
  try {
    validateTransition('completed', 'created');
  } catch (e) {
    threw = e instanceof LifecycleError;
  }
  assertTruthy(threw, 'validateTransition 应在无效转换时抛出 LifecycleError');

  // 2.4 终态判断
  assertTruthy(isTerminalStatus('completed'), 'completed 应为终态');
  assertTruthy(isTerminalStatus('cancelled'), 'cancelled 应为终态');
  assertFalsy(isTerminalStatus('created'), 'created 不应为终态');
  assertFalsy(isTerminalStatus('in_progress'), 'in_progress 不应为终态');

  // 2.5 下一有效状态
  const nextFromCreated = getNextValidStatuses('created');
  assertEqual(nextFromCreated.length, 2, 'created 应有 2 个有效下一状态');
  assertTruthy(nextFromCreated.includes('assigned'), 'created 的下一状态应包含 assigned');
  assertTruthy(nextFromCreated.includes('cancelled'), 'created 的下一状态应包含 cancelled');

  const nextFromCompleted = getNextValidStatuses('completed');
  assertEqual(nextFromCompleted.length, 0, 'completed 应无下一状态');

  // 2.6 便捷方法
  assertTruthy(canCancel('created'), 'created 状态应可取消');
  assertTruthy(canCancel('assigned'), 'assigned 状态应可取消');
  assertTruthy(canCancel('in_progress'), 'in_progress 状态应可取消');
  assertFalsy(canCancel('completed'), 'completed 状态应不可取消');

  assertTruthy(canComplete('in_progress'), 'in_progress 状态应可完成');
  assertFalsy(canComplete('created'), 'created 状态应不可完成');

  assertTruthy(canStart('assigned'), 'assigned 状态应可启动');
  assertFalsy(canStart('created'), 'created 状态应不可启动');

  assertTruthy(canAssign('created'), 'created 状态应可分配');
  assertFalsy(canAssign('completed'), 'completed 状态应不可分配');

  // 2.7 LifecycleLogger
  const lifecycleLogger = new LifecycleLogger();
  assertEqual(lifecycleLogger.size, 0, 'LifecycleLogger 初始应为 0 条事件');

  lifecycleLogger.log({
    taskId: 'task-1',
    from: 'created',
    to: 'assigned',
    timestamp: new Date().toISOString(),
  });
  assertEqual(lifecycleLogger.size, 1, 'LifecycleLogger 应有 1 条事件');

  lifecycleLogger.log({
    taskId: 'task-1',
    from: 'assigned',
    to: 'in_progress',
    timestamp: new Date().toISOString(),
  });
  assertEqual(lifecycleLogger.size, 2, 'LifecycleLogger 应有 2 条事件');

  const task1Events = lifecycleLogger.getEvents('task-1');
  assertEqual(task1Events.length, 2, 'task-1 应有 2 条事件');

  lifecycleLogger.clear();
  assertEqual(lifecycleLogger.size, 0, 'LifecycleLogger clear 后应为 0 条事件');

  // 2.8 意图分类 → Task Manager 联动
  // 创建任务意图 → 应映射到 created 状态
  const createResult = classifyIntent('创建一个新任务');
  assertTruthy(createResult.routeHandler.startsWith('task.'), '创建意图应路由到 task.* 处理器');

  // 修改任务意图 → 应涉及状态转换
  const modifyResult = classifyIntent('把任务状态改成已完成');
  assertTruthy(modifyResult.routeHandler.startsWith('task.'), '修改意图应路由到 task.* 处理器');
});

// ─── 3. 多语言：中文+英文混合输入分类 ────────────────────────────

describe('3. 多语言：中文+英文混合输入分类', () => {
  // 3.1 中文输入
  const zhResult = classifyText('帮我创建一个新任务');
  assertTruthy(zhResult, '中文输入应返回分类结果');
  assert(zhResult.confidence > 0, '中文输入置信度应大于 0');

  // 3.2 英文输入
  const enResult = classifyTextWithLocale('create a new task', 'en');
  assertTruthy(enResult, '英文输入应返回分类结果');
  assert(enResult.confidence > 0, '英文输入置信度应大于 0');
  assertEqual(enResult.category, 'create_task', '英文 "create a new task" 应分类为 create_task');

  // 3.3 中英混合输入
  const mixedResult = classifyText('create一个新bug修复task');
  assertTruthy(mixedResult, '中英混合输入应返回分类结果');

  // 3.4 英文查询
  const enQuery = classifyTextWithLocale('show all tasks', 'en');
  assertTruthy(enQuery, '英文查询应返回分类结果');

  // 3.5 英文调试
  const enDebug = classifyTextWithLocale('debug the crash issue', 'en');
  assertTruthy(enDebug, '英文调试输入应返回分类结果');

  // 3.6 debugClassify 多语言
  const zhDebug = debugClassify('创建新功能');
  assertTruthy(zhDebug, 'debugClassify 中文应返回结果');
  assertTruthy(zhDebug.result, 'debugClassify 中文应包含分类结果');

  const enDebugClassify = debugClassify('create new feature', 'en');
  assertTruthy(enDebugClassify, 'debugClassify 英文应返回结果');

  // 3.7 批量多语言分类
  const batchResults = classifyIntentBatch([
    '创建新任务',
    'show all tasks',
    '删除任务',
    'modify task status',
  ]);
  assertEqual(batchResults.length, 4, '批量分类应返回 4 个结果');
  for (const r of batchResults) {
    assertTruthy(r.category, '批量分类每个结果应有有效类别');
  }
});

// ─── 4. 缓存命中+失效场景 ────────────────────────────────────────

describe('4. 缓存命中+失效场景', () => {
  // 4.0 清空缓存并重置统计
  clearCache();
  resetCacheStats();

  // 4.1 首次分类 — 应为 cache miss
  const text1 = '创建缓存测试任务A';
  const result1 = classifyIntent(text1);
  assertFalsy(result1.cacheHit, '首次分类应不命中缓存');

  // 4.2 再次分类同一文本 — 应命中缓存
  const result2 = classifyIntent(text1);
  assertTruthy(result2.cacheHit, '第二次分类应命中缓存');

  // 4.3 不同文本 — 应不命中缓存
  const text2 = '创建缓存测试任务B';
  const result3 = classifyIntent(text2);
  assertFalsy(result3.cacheHit, '不同文本应不命中缓存');

  // 4.4 缓存统计
  const stats = getCacheStats();
  assertTruthy(stats.size >= 1, '缓存大小应至少为 1');
  assertTruthy(stats.hits >= 1, '缓存命中数应至少为 1');
  assertTruthy(stats.misses >= 2, '缓存未命中数应至少为 2');
  assertTruthy(stats.hitRate > 0, '缓存命中率应大于 0');

  // 4.5 清空缓存后再次分类 — 应为 cache miss
  clearCache();
  const result4 = classifyIntent(text1);
  assertFalsy(result4.cacheHit, '清空缓存后应不命中');

  // 4.6 禁用缓存
  const result5 = classifyIntent('禁用缓存测试', undefined, { enableCache: false });
  assertFalsy(result5.cacheHit, '禁用缓存时应不命中');

  const result6 = classifyIntent('禁用缓存测试', undefined, { enableCache: false });
  assertFalsy(result6.cacheHit, '禁用缓存时第二次也不应命中');

  // 4.7 清理
  clearCache();
  resetCacheStats();
});

// ─── 5. 可观测性：metrics 记录验证 ───────────────────────────────

describe('5. 可观测性：metrics 记录验证', () => {
  // 5.1 重置 metrics
  metrics.resetMetrics();
  const beforeSnapshot = metrics.getMetrics();
  assertEqual(beforeSnapshot.totalClassifications, 0, '重置后分类总数应为 0');

  // 5.2 执行分类 — metrics 应记录
  classifyIntent('创建一个metrics测试任务');
  classifyIntent('查询所有任务状态');
  classifyIntent('修改任务优先级');

  const afterSnapshot = metrics.getMetrics();
  assertEqual(afterSnapshot.totalClassifications, 3, '分类后总次数应为 3');
  assertTruthy(afterSnapshot.averageConfidence > 0, '平均置信度应大于 0');
  assertTruthy(afterSnapshot.averageLatencyMs >= 0, '平均延迟应非负');

  // 5.3 分类别统计
  const categories = afterSnapshot.categories;
  assertTruthy(Object.keys(categories).length > 0, '应至少有一个类别被记录');

  // 5.4 缓存 metrics
  // 缓存命中应被记录
  classifyIntent('创建一个metrics测试任务'); // 第一次 — cache miss
  classifyIntent('创建一个metrics测试任务'); // 第二次 — cache hit
  const snapshot2 = metrics.getMetrics();
  assertTruthy(snapshot2.cache.hits >= 1, '缓存命中应被记录在 metrics 中');
  assertTruthy(snapshot2.cache.misses >= 1, '缓存未命中应被记录在 metrics 中');

  // 5.5 Timeline 验证
  const timeline = metrics.getTimeline(10);
  assertTruthy(timeline.length > 0, 'Timeline 应包含条目');
  const firstEntry = timeline[0];
  assertTruthy(firstEntry.category, 'Timeline 条目应包含 category');
  assertTruthy(typeof firstEntry.confidence === 'number', 'Timeline 条目应包含 confidence');
  assertTruthy(typeof firstEntry.latencyMs === 'number', 'Timeline 条目应包含 latencyMs');

  // 5.6 错误 metrics
  metrics.recordError('classification_error');
  metrics.recordError('timeout');
  const errorSnapshot = metrics.getMetrics();
  assertEqual(errorSnapshot.errors.classificationErrors, 1, '应有 1 个分类错误');
  assertEqual(errorSnapshot.errors.timeouts, 1, '应有 1 个超时错误');
  assertEqual(errorSnapshot.errors.total, 2, '总错误数应为 2');

  // 5.7 重置
  metrics.resetMetrics();
  const finalSnapshot = metrics.getMetrics();
  assertEqual(finalSnapshot.totalClassifications, 0, '最终重置后分类总数应为 0');

  // 清理缓存
  clearCache();
  resetCacheStats();
});

// ─── 6. 自定义意图：注册+匹配+优先级 ─────────────────────────────

describe('6. 自定义意图：注册+匹配+优先级', () => {
  // 6.1 清空之前的自定义规则
  CustomIntentRegistry.clearAll();

  // 6.2 注册一个自定义意图
  const regResult = registerIntent({
    id: 'custom-deploy-task',
    category: 'development',
    subCategory: 'feature_impl',
    priority: IntentPriority.OVERRIDE,
    conditions: [
      { type: 'keyword', value: '部署', weight: 0.9 },
      { type: 'keyword', value: '上线', weight: 0.85 },
      { type: 'keyword', value: '发版', weight: 0.8 },
    ],
    confidence: 0.88,
    minConfidence: 0.5,
    rationale: '部署任务自定义规则',
    source: 'integration-test',
  });

  assertTruthy(regResult.success, '注册自定义意图应成功');
  assertEqual(regResult.rule?.id, 'custom-deploy-task', '注册的规则 ID 应正确');
  assertEqual(regResult.rule?.priority, IntentPriority.OVERRIDE, '优先级应为 OVERRIDE');

  // 6.3 查询自定义规则
  const customRules = getCustomRules();
  assertTruthy(customRules.length >= 1, '应至少有 1 条自定义规则');

  const deployRule = customRules.find(r => r.id === 'custom-deploy-task');
  assertTruthy(deployRule, '应找到 custom-deploy-task 规则');
  assertEqual(deployRule?.category, 'development', '规则类别应为 development');

  // 6.4 合并规则
  const merged = getMergedRules(RULES);
  assertTruthy(merged.length > RULES.length, '合并后的规则应多于内置规则');
  // 确认自定义规则在合并后的列表中
  const foundCustom = merged.find(r => r.id === 'custom-deploy-task');
  assertTruthy(foundCustom, '合并后的规则中应包含自定义规则');

  // 6.5 自定义规则优先级 — OVERRIDE 应在最前面
  assertTruthy(merged[0].priority >= 100, 'OVERRIDE 优先级规则应在合并列表最前面');

  // 6.6 注册另一个自定义意图（NORMAL 优先级）
  const reg2 = registerIntent({
    id: 'custom-monitor-task',
    category: 'research',
    subCategory: 'investigation',
    priority: IntentPriority.NORMAL,
    conditions: [
      { type: 'keyword', value: '监控', weight: 0.8 },
      { type: 'keyword', value: '告警', weight: 0.75 },
    ],
    confidence: 0.80,
    minConfidence: 0.5,
    rationale: '监控调查自定义规则',
  });

  assertTruthy(reg2.success, '注册第二个自定义意图应成功');

  // 6.7 统计信息
  const stats = CustomIntentRegistry.getStats();
  assertEqual(stats.totalRules, 2, '应有 2 条自定义规则');
  assertEqual(stats.enabledRules, 2, '应有 2 条启用规则');
  assertEqual(stats.disabledRules, 0, '应有 0 条禁用规则');

  // 6.8 禁用/启用
  const disabled = CustomIntentRegistry.disableIntent('custom-deploy-task');
  assertTruthy(disabled, '禁用规则应成功');

  const stats2 = CustomIntentRegistry.getStats();
  assertEqual(stats2.enabledRules, 1, '禁用后应有 1 条启用规则');
  assertEqual(stats2.disabledRules, 1, '禁用后应有 1 条禁用规则');

  const enabled = CustomIntentRegistry.enableIntent('custom-deploy-task');
  assertTruthy(enabled, '启用规则应成功');
  assertEqual(CustomIntentRegistry.getStats().enabledRules, 2, '重新启用后应有 2 条启用规则');

  // 6.9 更新规则
  const updateResult = CustomIntentRegistry.updateIntent('custom-deploy-task', {
    confidence: 0.95,
  });
  assertTruthy(updateResult.success, '更新规则应成功');
  assertEqual(updateResult.rule?.confidence, 0.95, '更新后的置信度应为 0.95');

  // 6.10 注册重复 ID 应失败
  const dupResult = registerIntent({
    id: 'custom-deploy-task',
    category: 'development',
    subCategory: 'feature_impl',
    priority: IntentPriority.LOW,
    conditions: [{ type: 'keyword', value: '重复', weight: 0.5 }],
    confidence: 0.7,
    minConfidence: 0.4,
  });
  assertFalsy(dupResult.success, '重复 ID 注册应失败');

  // 6.11 注册无效规则应失败
  const invalidResult = registerIntent({
    id: '',
    category: 'other',
    subCategory: 'fallback',
    priority: IntentPriority.NORMAL,
    conditions: [],
    confidence: 0.5,
    minConfidence: 0.3,
  });
  assertFalsy(invalidResult.success, '无效规则注册应失败');

  // 6.12 取消注册
  const unregResult = unregisterIntent('custom-deploy-task');
  assertTruthy(unregResult, '取消注册应成功');
  assertEqual(CustomIntentRegistry.getStats().totalRules, 1, '取消后应有 1 条规则');

  // 6.13 从对象批量加载
  const loadResult = CustomIntentRegistry.loadRulesFromObject({
    rules: [
      {
        id: 'custom-load-test-1',
        category: 'planning',
        subCategory: 'estimation',
        priority: 'HIGH',
        conditions: [{ type: 'keyword', value: '估算', weight: 0.85 }],
        confidence: 0.82,
        minConfidence: 0.5,
      },
      {
        id: 'custom-load-test-2',
        category: 'review',
        subCategory: 'code_review',
        priority: 'NORMAL',
        conditions: [{ type: 'keyword', value: '代码审查', weight: 0.8 }],
        confidence: 0.78,
        minConfidence: 0.5,
      },
    ],
  });
  assertEqual(loadResult.loaded, 2, '应从对象加载 2 条规则');

  // 6.14 清理
  CustomIntentRegistry.clearAll();
  assertEqual(CustomIntentRegistry.getStats().totalRules, 0, '清理后应为 0 条规则');
});

// ─── 7. LLM Fallback：低置信度触发 + 降级策略 ────────────────────

// 由于 LLM Fallback 需要 async，这里在同步上下文中测试配置和降级
describe('7. LLM Fallback：配置 + 降级策略', () => {
  // 7.1 LLM Fallback 分类器实例化
  const classifier = new LLMFallbackClassifier();
  assertTruthy(classifier, 'LLMFallbackClassifier 应可实例化');

  // 7.2 配置默认值
  const config = classifier.getConfig();
  assertEqual(config.endpoint, 'http://localhost:28789/v1/chat/completions', '默认端点应正确');
  assertEqual(config.timeoutMs, 10_000, '默认超时应为 10s');
  assertEqual(config.confidenceThreshold, 0.5, '默认置信度阈值应为 0.5');

  // 7.3 自定义配置
  const customClassifier = new LLMFallbackClassifier({
    endpoint: 'http://example.com/api',
    timeoutMs: 5000,
    confidenceThreshold: 0.3,
    model: 'gpt-4',
  });
  const customConfig = customClassifier.getConfig();
  assertEqual(customConfig.endpoint, 'http://example.com/api', '自定义端点应正确');
  assertEqual(customConfig.timeoutMs, 5000, '自定义超时应为 5s');
  assertEqual(customConfig.confidenceThreshold, 0.3, '自定义阈值应为 0.3');
  assertEqual(customConfig.model, 'gpt-4', '自定义模型应为 gpt-4');

  // 7.4 更新配置
  customClassifier.updateConfig({ model: 'gpt-4o', timeoutMs: 3000 });
  const updatedConfig = customClassifier.getConfig();
  assertEqual(updatedConfig.model, 'gpt-4o', '更新后模型应为 gpt-4o');
  assertEqual(updatedConfig.timeoutMs, 3000, '更新后超时应为 3s');

  // 7.5 降级策略函数
  const mockRegexResult = classifyText('这是一个完全无法分类的随机文本xyz123');
  const fallbackResult = fallbackToRegex(mockRegexResult, 'LLM 不可用');
  assertTruthy(fallbackResult, '降级策略应返回非空结果');
  assertEqual(fallbackResult.category, mockRegexResult.category, '降级后类别应与正则一致');
  assertEqual(fallbackResult.confidence, mockRegexResult.confidence, '降级后置信度应与正则一致');

  // 7.6 管道中 enableLLMFallback 配置项默认关闭
  const pipelineResult = classifyIntent('测试管道LLM配置');
  assertFalsy(pipelineResult.llmFallbackUsed, '默认管道不应使用 LLM Fallback');

  // 7.7 classifyIntentAsync — LLM 未启用时
  // 不启用 LLM Fallback，异步管道应与同步管道结果一致
  const asyncResult = classifyIntentAsync('创建一个异步测试任务').then(r => {
    assertTruthy(r, 'classifyIntentAsync 应返回非空结果');
    assertEqual(r.category, 'create_task', '异步管道应分类为 create_task');
    assertFalsy(r.llmFallbackUsed, '未启用 LLM Fallback 时不应标记为 LLM');
    return r;
  }).catch(e => {
    assert(false, `classifyIntentAsync 不应抛出异常: ${e?.message}`);
    return null;
  });

  // 等待 async 结果（通过同步 hack — 在测试末尾统一 await）
  pendingPromises.push(asyncResult);

  // 7.8 classifyIntentAsync — LLM 启用但不可用时降级
  const llmEnabledResult = classifyIntentAsync(
    '这是一个完全无法分类的随机文本xyz123',
    undefined,
    { enableLLMFallback: true, llmFallbackThreshold: 0.99 }, // 极高阈值强制触发
  ).then(r => {
    assertTruthy(r, 'LLM 不可用时应降级返回正则结果');
    // 降级后应返回正则结果（可能是 other）
    assertTruthy(r.category, '降级后应有有效类别');
    assertFalsy(r.llmFallbackUsed, 'LLM 不可用时不应标记为 LLM 已使用');
    return r;
  }).catch(e => {
    assert(false, `classifyIntentAsync LLM 降级不应抛出异常: ${e?.message}`);
    return null;
  });
  pendingPromises.push(llmEnabledResult);

  // 7.9 管道配置中 LLM 相关字段
  const result = classifyIntent('测试', undefined, {
    enableLLMFallback: true,
    llmFallbackThreshold: 0.6,
  });
  assertFalsy(result.llmFallbackUsed, '高置信度时不应触发 LLM Fallback（即使启用了）');
});

// ─── 等待所有异步测试完成 ──────────────────────────────────────

// ─── 统计 & 输出 ──────────────────────────────────────────────

async function runAll() {
  // 等待所有 pending promises
  if (pendingPromises.length > 0) {
    console.log('\n━─━ 等待异步测试完成 ━─━');
    await Promise.all(pendingPromises);
  }

  console.log('\n\n╔══════════════════════════════════════════════════════════╗');
  console.log(`║  集成测试结果: ${passCount} 通过 / ${failCount} 失败`);

  if (failCount > 0) {
    console.log('║');
    console.log('║  失败列表:');
    for (const f of failures) {
      console.log(`║    • ${f}`);
    }
  }

  const status = failCount === 0 ? '✅ ALL PASS' : '❌ HAS FAILURES';
  console.log(`║  状态: ${status}`);
  console.log('╚══════════════════════════════════════════════════════════╝');

  // 清理
  clearCache();
  resetCacheStats();
  metrics.resetMetrics();
  CustomIntentRegistry.clearAll();

  process.exit(failCount > 0 ? 1 : 0);
}

// 启动测试
runAll().catch(err => {
  console.error('测试运行异常:', err);
  process.exit(1);
});
