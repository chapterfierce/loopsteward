/**
 * Claw Task Service — M5 i18n Test Suite
 *
 * Tests for the multi-language intent classification framework.
 * Verifies that:
 *   - Chinese patterns still work correctly (backward compatibility)
 *   - English patterns produce correct classifications
 *   - Pattern loader resolves locales correctly
 *   - Locale-aware classifier routes to the right rule set
 *
 * Test structure: 12 cases (6 Chinese + 6 English)
 *
 * Based on: M5 i18n framework design (2026-07-21)
 */

import { classify, classifyText, classifyTextWithLocale, classifyBatch } from '../classifier.js';
import { normalizeLocale, resolveRules, resolveRulesByPriority, getSupportedLocales, isLocaleSupported, PatternLoader } from './pattern-loader.js';
import { EN_RULES, getEnRuleStats } from './en-patterns.js';
import { RULES, getRuleStats } from '../patterns.js';
import { IntentResult } from '../types.js';

// ─── Test Framework (minimal assert) ───────────────────────────────

interface TestResult {
  name: string;
  passed: boolean;
  detail?: string;
  expected?: string;
  actual?: string;
}

const results: TestResult[] = [];

function assert(name: string, condition: boolean, detail?: string, expected?: string, actual?: string): void {
  results.push({ name, passed: condition, detail, expected, actual });
  const status = condition ? '✅ PASS' : '❌ FAIL';
  console.log(`${status} — ${name}${detail ? ': ' + detail : ''}`);
  if (!condition && expected) {
    console.log(`         expected: ${expected}`);
    console.log(`         actual:   ${actual}`);
  }
}

function assertEqual<T>(name: string, actual: T, expected: T): void {
  const eq = actual === expected;
  assert(name, eq, `expected=${expected}, actual=${actual}`, String(expected), String(actual));
}

// ─── Test Cases ────────────────────────────────────────────────────

function runTests(): void {
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log('  M5 i18n Test Suite — Multi-Language Intent Classification');
  console.log('════════════════════════════════════════════════════════════════\n');

  // ─── Part 1: Pattern Loader Tests ───────────────────────────────

  console.log('── Part 1: Pattern Loader ────────────────────────────────────\n');

  // Test 1: Supported locales include zh-CN and en
  const locales = getSupportedLocales();
  assert(
    'Supported locales include zh-CN and en',
    locales.includes('zh-CN') && locales.includes('en'),
    `locales: ${locales.join(', ')}`,
  );

  // Test 2: normalizeLocale resolves 'en' correctly
  const enResolution = normalizeLocale('en');
  assertEqual('normalizeLocale("en") → locale', enResolution.locale, 'en');
  assertEqual('normalizeLocale("en") → recognized', enResolution.recognized, true);

  // Test 3: normalizeLocale resolves 'en-US' to 'en'
  const enUSResolution = normalizeLocale('en-US');
  assertEqual('normalizeLocale("en-US") → locale', enUSResolution.locale, 'en');

  // Test 4: normalizeLocale resolves 'zh-CN' correctly
  const zhResolution = normalizeLocale('zh-CN');
  assertEqual('normalizeLocale("zh-CN") → locale', zhResolution.locale, 'zh-CN');

  // Test 5: normalizeLocale falls back for unknown locale
  const frResolution = normalizeLocale('fr');
  assertEqual('normalizeLocale("fr") → locale (fallback)', frResolution.locale, 'zh-CN');
  assertEqual('normalizeLocale("fr") → fellBack', frResolution.fellBack, true);

  // Test 6: isLocaleSupported
  assertEqual('isLocaleSupported("en")', isLocaleSupported('en'), true);
  assertEqual('isLocaleSupported("zh-CN")', isLocaleSupported('zh-CN'), true);
  assertEqual('isLocaleSupported("fr")', isLocaleSupported('fr'), false);

  // ─── Part 2: Rule Set Integrity ─────────────────────────────────

  console.log('\n── Part 2: Rule Set Integrity ───────────────────────────────\n');

  // Test 7: English rules have same count as Chinese rules
  const zhStats = getRuleStats();
  const enStats = getEnRuleStats();
  assertEqual('EN rule count = ZH rule count', enStats.totalRules, zhStats.totalRules);

  // Test 8: English rules cover same categories
  const zhCategories = zhStats.categories.sort().join(',');
  const enCategories = enStats.categories.sort().join(',');
  assert(
    'EN categories match ZH categories',
    zhCategories === enCategories,
    `zh: ${zhCategories} | en: ${enCategories}`,
  );

  // Test 9: resolveRules returns correct rule count per locale
  const zhRules = resolveRules('zh-CN');
  const enRules = resolveRules('en');
  assertEqual('resolveRules("zh-CN") length', zhRules.length, RULES.length);
  assertEqual('resolveRules("en") length', enRules.length, EN_RULES.length);

  // ─── Part 3: Chinese Classification (Backward Compatibility) ────

  console.log('\n── Part 3: Chinese Classification (Backward Compat) ─────────\n');

  // Test 10: Chinese — create task
  const zhCreate = classifyText('创建登录页面重构任务');
  assert(
    'ZH: "创建登录页面重构任务" → create_task',
    zhCreate.category === 'create_task',
    `got: ${zhCreate.category}`,
    'create_task',
    zhCreate.category,
  );

  // Test 11: Chinese — query status
  const zhQuery = classifyText('这个任务怎么样了');
  assert(
    'ZH: "这个任务怎么样了" → query_status',
    zhQuery.category === 'query_status',
    `got: ${zhQuery.category}`,
    'query_status',
    zhQuery.category,
  );

  // Test 12: Chinese — delete task
  const zhDelete = classifyText('删除这个任务');
  assert(
    'ZH: "删除这个任务" → delete_task',
    zhDelete.category === 'delete_task',
    `got: ${zhDelete.category}`,
    'delete_task',
    zhDelete.category,
  );

  // ─── Part 4: English Classification ─────────────────────────────

  console.log('\n── Part 4: English Classification ───────────────────────────\n');

  // Test 13: English — create task
  const enCreate = classifyTextWithLocale('create a new login page task', 'en');
  assert(
    'EN: "create a new login page task" → create_task',
    enCreate.category === 'create_task',
    `got: ${enCreate.category} (conf: ${enCreate.confidence})`,
    'create_task',
    enCreate.category,
  );

  // Test 14: English — query status
  const enQuery = classifyTextWithLocale('what is the progress of this task', 'en');
  assert(
    'EN: "what is the progress of this task" → query_status',
    enQuery.category === 'query_status',
    `got: ${enQuery.category} (conf: ${enQuery.confidence})`,
    'query_status',
    enQuery.category,
  );

  // Test 15: English — delete task
  const enDelete = classifyTextWithLocale('delete this task', 'en');
  assert(
    'EN: "delete this task" → delete_task',
    enDelete.category === 'delete_task',
    `got: ${enDelete.category} (conf: ${enDelete.confidence})`,
    'delete_task',
    enDelete.category,
  );

  // Test 16: English — modify priority
  const enModify = classifyTextWithLocale('raise priority to P0', 'en');
  assert(
    'EN: "raise priority to P0" → modify_task',
    enModify.category === 'modify_task',
    `got: ${enModify.category} (conf: ${enModify.confidence})`,
    'modify_task',
    enModify.category,
  );

  // Test 17: English — debug crash
  const enDebug = classifyTextWithLocale('the app keeps crashing', 'en');
  assert(
    'EN: "the app keeps crashing" → debug',
    enDebug.category === 'debug',
    `got: ${enDebug.category} (conf: ${enDebug.confidence})`,
    'debug',
    enDebug.category,
  );

  // Test 18: English — code review
  const enReview = classifyTextWithLocale('please do a code review for this PR', 'en');
  assert(
    'EN: "please do a code review for this PR" → review',
    enReview.category === 'review',
    `got: ${enReview.category} (conf: ${enReview.confidence})`,
    'review',
    enReview.category,
  );

  // ─── Part 5: Locale-Aware Behavior ──────────────────────────────

  console.log('\n── Part 5: Locale-Aware Behavior ────────────────────────────\n');

  // Test 19: Default locale (no locale specified) uses zh-CN patterns
  const defaultResult = classifyText('创建任务');
  assert(
    'Default locale uses zh-CN patterns',
    defaultResult.category === 'create_task',
    `got: ${defaultResult.category}`,
  );

  // Test 20: Explicit zh-CN locale produces same result as default
  const zhExplicit = classifyTextWithLocale('创建任务', 'zh-CN');
  assertEqual(
    'Explicit zh-CN = default locale (category)',
    zhExplicit.category,
    defaultResult.category,
  );

  // Test 21: Batch classification with locale
  const batchResults = classifyBatch(
    ['create a task', 'delete this task', 'what is the status'],
    undefined,
    'en',
  );
  assertEqual('Batch[0] with en locale', batchResults[0].category, 'create_task');
  assertEqual('Batch[1] with en locale', batchResults[1].category, 'delete_task');

  // ─── Part 6: PatternLoader Class ────────────────────────────────

  console.log('\n── Part 6: PatternLoader Class ──────────────────────────────\n');

  // Test 22: PatternLoader instantiation
  const loader = new PatternLoader('en');
  assertEqual('PatternLoader locale', loader.getLocale(), 'en');
  assertEqual('PatternLoader rules count', loader.getRules().length, EN_RULES.length);

  // Test 23: PatternLoader setLocale
  loader.setLocale('zh-CN');
  assertEqual('PatternLoader after setLocale("zh-CN")', loader.getLocale(), 'zh-CN');
  assertEqual('PatternLoader zh-CN rules count', loader.getRules().length, RULES.length);

  // ─── Summary ────────────────────────────────────────────────────

  console.log('\n════════════════════════════════════════════════════════════════');
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const total = results.length;
  console.log(`  Results: ${passed}/${total} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\n  Failed tests:');
    for (const r of results.filter(r => !r.passed)) {
      console.log(`    ❌ ${r.name}`);
    }
  }
  console.log('════════════════════════════════════════════════════════════════\n');
}

// ─── Run ───────────────────────────────────────────────────────────

runTests();
