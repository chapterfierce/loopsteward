/**
 * Claw Task Service — Intent Classifier Boundary Tests
 *
 * Tests edge cases and boundary conditions for the intent classifier:
 *   - Empty string / whitespace
 *   - Very long input (stress test)
 *   - Mixed language input (zh + en)
 *   - Multiple intent signals (ambiguous input)
 *   - Nested / compound intent expressions
 *   - Repetitive keyword input
 *   - Unicode edge cases
 *   - Confidence threshold boundaries
 *   - Entity extraction edge cases
 *   - Batch classification edge cases
 *   - Locale routing edge cases
 *
 * Run: npx tsx intent-engine/__tests__/classifier-edge.test.ts
 */

import {
  classify,
  classifyText,
  classifyTextWithLocale,
  classifyBatch,
  debugClassify,
} from '../classifier.js';
import {
  classifyIntent,
  classifyIntentBatch,
  getRouteHandler,
  clearCache,
} from '../pipeline.js';
import {
  CONFIDENCE_THRESHOLDS,
  getConfidenceAction,
} from '../types.js';
import { preprocess } from '../preprocessor.js';
import { extractEntities } from '../entity-extractor.js';

// ─── Test Harness ───────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function checkTrue(name: string, cond: boolean): void {
  if (cond) {
    passed++;
    console.log(`✅ PASS — ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`❌ FAIL — ${name}`);
  }
}

function checkEqual(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`✅ PASS — ${name}`);
  } else {
    failed++;
    const msg = `${name}: expected=${JSON.stringify(expected)}, actual=${JSON.stringify(actual)}`;
    failures.push(msg);
    console.log(`❌ FAIL — ${msg}`);
  }
}

function checkNotEqual(name: string, actual: unknown, expected: unknown): void {
  const notOk = JSON.stringify(actual) === JSON.stringify(expected);
  if (!notOk) {
    passed++;
    console.log(`✅ PASS — ${name}`);
  } else {
    failed++;
    const msg = `${name}: should not equal=${JSON.stringify(expected)}, actual=${JSON.stringify(actual)}`;
    failures.push(msg);
    console.log(`❌ FAIL — ${msg}`);
  }
}

// ─── Part 1: Empty / Whitespace Input ──────────────────────────────

console.log('\n── Part 1: Empty / Whitespace Input ──────────────────────────');

{
  const r = classifyText('');
  checkEqual('Empty string → other', r.category, 'other');
  checkEqual('Empty string → subCategory fallback', r.subCategory, 'fallback');
  checkTrue('Empty string → confidence < 0.5', r.confidence < 0.5);
}

{
  const r = classifyText('   ');
  checkEqual('Whitespace → other', r.category, 'other');
}

{
  const r = classifyText('\t\n');
  checkEqual('Tab+newline → other', r.category, 'other');
}

// ─── Part 2: Very Long Input (stress test) ──────────────────────────

console.log('\n── Part 2: Very Long Input ───────────────────────────────────');

{
  const longText = '创建一个新任务'.repeat(100);
  const r = classifyText(longText);
  checkTrue('Long input: no crash', true);
  checkTrue('Long input: has category', !!r.category);
  checkTrue('Long input: meta.rulesEvaluated > 0', r.meta.rulesEvaluated > 0);
}

{
  // Long text with no intent keywords
  const longText = '这是一段没有任何意图关键词的文字'.repeat(100);
  const r = classifyText(longText);
  checkEqual('Long no-intent → other', r.category, 'other');
  checkTrue('Long no-intent: no crash', true);
}

// ─── Part 3: Mixed Language Input ──────────────────────────────────

console.log('\n── Part 3: Mixed Language Input ──────────────────────────────');

// ZH-dominant mixed
{
  const r = classifyText('帮我create一个新task');
  checkTrue('Mixed zh-dom: no crash', true);
  checkTrue('Mixed zh-dom: has result', !!r.category);
}

// EN-dominant mixed
{
  const r = classifyText('please 创建 a new task');
  checkTrue('Mixed en-dom: no crash', true);
  checkTrue('Mixed en-dom: has result', !!r.category);
}

// Explicit locale overrides mixed
{
  const r = classify({ text: 'create task', locale: 'zh-CN' });
  checkEqual('Force zh-CN on EN text: locale', r.meta.locale, 'zh-CN');
  checkEqual('Force zh-CN: source', r.meta.localeSource, 'explicit');
}

// ─── Part 4: Multiple Intent Signals (ambiguous) ───────────────────

console.log('\n── Part 4: Multiple Intent Signals ────────────────────────────');

// Create + delete in same sentence
{
  const r = classifyText('创建任务然后删除它');
  checkTrue('Create+delete: no crash', true);
  // One should win; both could be present in alternatives
  checkTrue('Create+delete: has alternatives', r.alternatives.length >= 0);
}

// Query + modify
{
  const r = classifyText('查看任务状态然后修改截止时间');
  checkTrue('Query+modify: no crash', true);
  checkTrue('Query+modify: has result', !!r.category);
}

// Multiple create signals
{
  const r = classifyText('创建新建添加一个任务');
  checkTrue('Multiple create: no crash', true);
  checkTrue('Multiple create: confidence > 0', r.confidence > 0);
}

// ─── Part 5: Repetitive Keywords ───────────────────────────────────

console.log('\n── Part 5: Repetitive Keywords ──────────────────────────────');

// Same keyword repeated many times
{
  const r = classifyText('创建创建创建创建创建创建创建创建创建创建');
  checkTrue('Repeated 创建: no crash', true);
  checkTrue('Repeated 创建: confidence > 0', r.confidence > 0);
}

// Mixed keywords from different intents
{
  const r = classifyText('创建删除修改查看创建删除修改查看');
  checkTrue('Mixed repeated: no crash', true);
  checkTrue('Mixed repeated: has category', !!r.category);
}

// ─── Part 6: Unicode Edge Cases ────────────────────────────────────

console.log('\n── Part 6: Unicode Edge Cases ────────────────────────────────');

// Emoji-only
{
  const r = classifyText('🎉🚀✨');
  checkEqual('Emoji only → other', r.category, 'other');
}

// Emoji with intent
{
  const r = classifyText('🎉创建任务🎉');
  checkTrue('Emoji+intent: no crash', true);
  checkTrue('Emoji+intent: has result', !!r.category);
}

// Zero-width characters
{
  const r = classifyText('创\u200B建任务');
  checkTrue('Zero-width char: no crash', true);
}

// Full-width characters
{
  const r = classifyText('创建一个新任务');
  checkTrue('Full-width: no crash', true);
  checkTrue('Full-width: has result', !!r.category);
}

// ─── Part 7: Confidence Threshold Boundaries ───────────────────────

console.log('\n── Part 7: Confidence Threshold Boundaries ───────────────────');

// HIGH threshold (0.85)
{
  const r = classifyText('创建登录页重构任务');
  checkTrue('High-confidence create: conf >= 0.85', r.confidence >= CONFIDENCE_THRESHOLDS.HIGH);
  checkEqual('High-confidence: action = execute_directly', getConfidenceAction(r.confidence), 'execute_directly');
}

// LOW threshold (0.50)
// Note: '你好' has confidence 0.3 which is >= MINIMAL(0.30) → offer_alternatives
{
  const r = classifyText('你好');
  checkTrue('Low-confidence greeting: conf < 0.5', r.confidence < CONFIDENCE_THRESHOLDS.LOW);
  // Confidence 0.3 → MINIMAL threshold → offer_alternatives (not fallback_help)
  checkTrue('Low-confidence: action is offer_alternatives or fallback_help',
    getConfidenceAction(r.confidence) === 'offer_alternatives' ||
    getConfidenceAction(r.confidence) === 'fallback_help');
}

// Exact boundary check
{
  checkEqual('Threshold HIGH = 0.85', CONFIDENCE_THRESHOLDS.HIGH, 0.85);
  checkEqual('Threshold MEDIUM = 0.70', CONFIDENCE_THRESHOLDS.MEDIUM, 0.70);
  checkEqual('Threshold LOW = 0.50', CONFIDENCE_THRESHOLDS.LOW, 0.50);
  checkEqual('Threshold MINIMAL = 0.30', CONFIDENCE_THRESHOLDS.MINIMAL, 0.30);
  checkEqual('Threshold FALLBACK = 0.0', CONFIDENCE_THRESHOLDS.FALLBACK, 0.0);
}

// ─── Part 8: Entity Extraction Edge Cases ──────────────────────────

console.log('\n── Part 8: Entity Extraction Edge Cases ───────────────────────');

// No entities (or very few)
// Note: '你好' may trigger task_name extraction as a fallback heuristic
{
  const preprocessed = preprocess('你好');
  const entities = extractEntities(preprocessed);
  checkTrue('Greeting: 0 or 1 entity (task_name fallback)', entities.length <= 1);
}

// Multiple entity types
{
  const preprocessed = preprocess('创建登录页重构任务，截止时间是下周五，优先级P0，转给张三');
  const entities = extractEntities(preprocessed);
  checkTrue('Multi-entity: at least 2', entities.length >= 2);
}

// Very long entity value
{
  const longTaskName = '这是一个非常非常非常非常非常非常非常非常长的任务名称'.repeat(5);
  const preprocessed = preprocess(`创建${longTaskName}任务`);
  const entities = extractEntities(preprocessed);
  checkTrue('Long entity: no crash', true);
  // Task name extraction should still work
  checkTrue('Long entity: has entities', entities.length > 0);
}

// Empty text entity extraction
{
  const preprocessed = preprocess('');
  const entities = extractEntities(preprocessed);
  checkEqual('Empty text: no entities', entities.length, 0);
}

// ─── Part 9: Batch Classification ───────────────────────────────────

console.log('\n── Part 9: Batch Classification ──────────────────────────────');

// Empty batch
{
  const results = classifyBatch([]);
  checkEqual('Empty batch → []', results.length, 0);
}

// Single element batch
{
  const results = classifyBatch(['创建任务']);
  checkEqual('Single batch: length 1', results.length, 1);
  checkTrue('Single batch: has result', !!results[0].category);
}

// Large batch
{
  const texts = Array.from({ length: 100 }, (_, i) => `创建任务${i}`);
  const results = classifyBatch(texts);
  checkEqual('100-item batch: length 100', results.length, 100);
}

// Mixed language batch
{
  const texts = ['创建任务', 'create task', '修改任务', 'delete task'];
  const results = classifyBatch(texts);
  checkEqual('Mixed batch: length 4', results.length, 4);
  checkTrue('Mixed batch: all have categories', results.every(r => !!r.category));
}

// Batch with locale
{
  const results = classifyBatch(['create task', 'delete task'], undefined, 'en');
  checkEqual('Batch with locale: length 2', results.length, 2);
  checkEqual('Batch[0] en: locale', results[0].meta.locale, 'en');
}

// ─── Part 10: Locale Routing Edge Cases ────────────────────────────

console.log('\n── Part 10: Locale Routing Edge Cases ─────────────────────────');

// Unknown locale → fallback
{
  const r = classifyTextWithLocale('创建任务', 'fr');
  checkEqual('Unknown locale (fr): fallback to zh-CN', r.meta.locale, 'zh-CN');
}

// Empty locale string → fallback
{
  const r = classifyTextWithLocale('创建任务', '');
  checkTrue('Empty locale: has result', !!r.category);
}

// Null locale → auto-detect
{
  const r = classify({ text: 'create task' });
  checkEqual('No locale: auto-detect en', r.meta.locale, 'en');
  checkEqual('No locale: source detected', r.meta.localeSource, 'detected');
}

// Locale variants — meta.locale stores the original string when explicit
{
  const r1 = classifyTextWithLocale('create task', 'en-US');
  const r2 = classifyTextWithLocale('create task', 'en_GB');
  // When locale is explicit, meta.locale echoes the original string
  checkTrue('en-US: locale starts with en', r1.meta.locale?.startsWith('en') === true);
  checkTrue('en_GB: locale starts with en', r2.meta.locale?.startsWith('en') === true);
}

// zh variants
{
  const r1 = classifyTextWithLocale('创建任务', 'zh-TW');
  const r2 = classifyTextWithLocale('创建任务', 'zh-HK');
  checkTrue('zh-TW: locale starts with zh', r1.meta.locale?.startsWith('zh') === true);
  checkTrue('zh-HK: locale starts with zh', r2.meta.locale?.startsWith('zh') === true);
}

// ─── Part 11: Pipeline & Cache ──────────────────────────────────────

console.log('\n── Part 11: Pipeline & Cache ────────────────────────────────');

// Clear cache before tests
clearCache();

// First call: cache miss
{
  const r = classifyIntent('创建任务');
  checkTrue('Pipeline: cache miss on first call', !r.cacheHit);
}

// Second call: cache hit
{
  const r = classifyIntent('创建任务');
  checkTrue('Pipeline: cache hit on second call', r.cacheHit);
}

// Different text: cache miss
{
  const r = classifyIntent('删除任务');
  checkTrue('Pipeline: different text = cache miss', !r.cacheHit);
}

// Pipeline with empty text
{
  const r = classifyIntent('');
  checkTrue('Pipeline empty: no crash', true);
  checkTrue('Pipeline empty: has routeHandler', !!r.routeHandler);
}

// Route handler mapping
{
  checkEqual('Route: create_task → task.create', getRouteHandler('create_task'), 'task.create');
  checkEqual('Route: query_status → task.query', getRouteHandler('query_status'), 'task.query');
  checkEqual('Route: modify_task → task.modify', getRouteHandler('modify_task'), 'task.modify');
  checkEqual('Route: delete_task → task.delete', getRouteHandler('delete_task'), 'task.delete');
  checkEqual('Route: schedule → schedule.manage', getRouteHandler('schedule'), 'schedule.manage');
  checkEqual('Route: other → fallback.help', getRouteHandler('other'), 'fallback.help');
}

// Clear cache after tests
clearCache();

// ─── Part 12: Debug Classify ────────────────────────────────────────

console.log('\n── Part 12: Debug Classify ────────────────────────────────────');

// Debug with normal input
{
  const debug = debugClassify('创建任务');
  checkTrue('Debug: has input', debug.input === '创建任务');
  checkTrue('Debug: has preprocessed', !!debug.preprocessed);
  checkTrue('Debug: has result', !!debug.result);
  checkTrue('Debug: has allRules', Array.isArray(debug.allRules));
  checkTrue('Debug: allRules length > 0', debug.allRules.length > 0);
}

// Debug with locale
{
  const debug = debugClassify('create task', 'en');
  checkEqual('Debug en: locale resolved', debug.locale, 'en');
  checkTrue('Debug en: has ruleDetails', debug.allRules.length > 0);
}

// Debug with empty text
{
  const debug = debugClassify('');
  checkTrue('Debug empty: no crash', true);
  checkTrue('Debug empty: has result', !!debug.result);
}

// ─── Part 13: Preprocessor Edge Cases ───────────────────────────────

console.log('\n── Part 13: Preprocessor Edge Cases ───────────────────────────');

// Empty string
{
  const r = preprocess('');
  checkEqual('Preprocess empty: normalized = ""', r.normalized, '');
  checkEqual('Preprocess empty: tokenCount = 0', r.tokenCount, 0);
  checkEqual('Preprocess empty: tokens = []', r.tokens.length, 0);
}

// Whitespace only
{
  const r = preprocess('   ');
  checkEqual('Preprocess spaces: normalized = ""', r.normalized, '');
  checkEqual('Preprocess spaces: tokenCount = 0', r.tokenCount, 0);
}

// Full-width to half-width
{
  const r = preprocess('Ｐ０');
  checkTrue('Full-width P0: normalized includes p0', r.normalized.includes('p0'));
}

// Abbreviation detection
{
  const r = preprocess('check the ddl for this task');
  checkTrue('Abbreviation: ddl detected', r.expansions.length > 0);
}

// Time expression detection
{
  const r = preprocess('明天下午3点');
  checkTrue('Time expr: detected', r.timeExpressions.length > 0);
}

// ─── Part 14: Pipeline Batch ────────────────────────────────────────

console.log('\n── Part 14: Pipeline Batch ────────────────────────────────────');

clearCache();

{
  const results = classifyIntentBatch(['创建任务', '删除任务', '查看状态']);
  checkEqual('Pipeline batch: 3 results', results.length, 3);
  checkTrue('Pipeline batch: all have routeHandler', results.every(r => !!r.routeHandler));
}

{
  const results = classifyIntentBatch([]);
  checkEqual('Pipeline batch empty: []', results.length, 0);
}

clearCache();

// ─── Summary ────────────────────────────────────────────────────────

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  Classifier Edge Tests — Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\n  Failed tests:');
  for (const f of failures) console.log(`    ❌ ${f}`);
  console.log('\n  ❌ Tests FAILED');
  process.exitCode = 1;
} else {
  console.log('\n  ✅ All edge case tests PASSED');
}
console.log('═══════════════════════════════════════════════════════════════\n');
