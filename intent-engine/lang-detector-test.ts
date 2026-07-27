/**
 * Claw Task Service — Phase 3 M5 Multi-language Framework Tests
 *
 * Covers:
 *   Part 1: lang-detector unit tests (zh / en / mixed / unknown)
 *   Part 2: lang-router tests (explicit > detected > fallback, registry)
 *   Part 3: date-parser-en tests (deterministic `now` = Tue 2026-07-28)
 *   Part 4: E2E language-aware classification (auto locale routing)
 *   Part 5: Performance (<50μs per detection)
 *
 * Run: npx tsx intent-engine/lang-detector-test.ts
 */

import { detectLanguage, detectLang } from './lang-detector';
import {
  resolveRequestLocale,
  routeLang,
  registerLanguageRoute,
  getLanguageRoutes,
} from './lang-router';
import { parseEnglishDate, extractEnglishDates } from './i18n/date-parser-en';
import { classify, classifyText } from './classifier';

// ─── Tiny Test Harness (repo convention) ────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, actual: unknown, expected: unknown): void {
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

function checkTrue(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`✅ PASS — ${name}`);
  } else {
    failed++;
    failures.push(`${name} ${detail}`);
    console.log(`❌ FAIL — ${name} ${detail}`);
  }
}

// ═══ Part 1: Language Detector ═══════════════════════════════════════

console.log('\n── Part 1: Language Detector ──────────────────────────────');

// Pure Chinese
check('zh: 创建一个新任务', detectLang('创建一个新任务'), 'zh');
check('zh: 查看本周的日程安排', detectLang('查看本周的日程安排'), 'zh');

// Pure English
check('en: create a new task', detectLang('create a new task'), 'en');
check('en: show me all my tasks', detectLang('show me all my tasks'), 'en');

// Mixed — zh dominant (English tech terms inside Chinese sentence)
{
  const r = detectLanguage('修复登录bug');
  check('mixed: 修复登录bug → mixed', r.lang, 'mixed');
  check('mixed: 修复登录bug dominant=zh', r.dominant, 'zh');
}
{
  const r = detectLanguage('创建一个新任务：fix login bug');
  check('mixed: 创建…fix login bug → mixed', r.lang, 'mixed');
  check('mixed: 创建…fix login bug dominant=zh', r.dominant, 'zh');
}

// Mixed — en dominant (Chinese noun inside English sentence)
{
  const r = detectLanguage('Fix the bug in 用户 module');
  check('mixed: Fix the bug in 用户 module → mixed', r.lang, 'mixed');
  check('mixed: … dominant=en', r.dominant, 'en');
}
{
  const r = detectLanguage('deploy 部署');
  check('mixed: deploy 部署 → mixed', r.lang, 'mixed');
  check('mixed: deploy 部署 dominant=en', r.dominant, 'en');
}

// Single stray letter does NOT make it mixed (minority count < 2)
check('zh not mixed: 帮我把这个任务优先级提到p0', detectLang('帮我把这个任务优先级提到p0'), 'zh');

// Unknown
check('unknown: empty string', detectLang(''), 'unknown');
check('unknown: digits/punct only', detectLang('12345 !!! ---'), 'unknown');

// Counting sanity
{
  const r = detectLanguage('修复登录bug');
  check('counts: 修复登录bug zhCount', r.zhCount, 4);
  check('counts: 修复登录bug enCount', r.enCount, 3);
}

// ═══ Part 2: Language Router ═════════════════════════════════════════

console.log('\n── Part 2: Language Router ────────────────────────────────');

// Detected routing
check('route: en text → en', resolveRequestLocale('create a new task').locale, 'en');
check('route: zh text → zh-CN', resolveRequestLocale('创建一个新任务').locale, 'zh-CN');
check(
  'route: mixed zh-dominant → zh-CN',
  resolveRequestLocale('修复登录bug').locale,
  'zh-CN',
);
check(
  'route: mixed en-dominant → en',
  resolveRequestLocale('Fix the bug in 用户 module').locale,
  'en',
);
check('route source: detected', resolveRequestLocale('create a task').source, 'detected');

// Explicit locale wins over detection
{
  const r = resolveRequestLocale('create a new task', 'zh-CN');
  check('route: explicit zh-CN beats detected en', r.locale, 'zh-CN');
  check('route source: explicit', r.source, 'explicit');
}

// Fallback for unknown-language input
{
  const r = resolveRequestLocale('12345 !!!');
  check('route: unknown → fallback zh-CN', r.locale, 'zh-CN');
  check('route source: fallback', r.source, 'fallback');
}

// Registry: routes table + dynamic registration
check('routes table has zh', getLanguageRoutes()['zh'], 'zh-CN');
registerLanguageRoute('unknown', 'en');
check(
  'registerLanguageRoute: unknown → en',
  routeLang(detectLanguage('¡¿')),
  'en',
);
registerLanguageRoute('unknown', 'zh-CN'); // restore
check('registerLanguageRoute: restored', routeLang(detectLanguage('¡¿')), 'zh-CN');

// ═══ Part 3: English Date Parser ═════════════════════════════════════

console.log('\n── Part 3: English Date Parser ────────────────────────────');

// Deterministic reference: Tuesday 2026-07-28
const NOW = new Date(2026, 6, 28, 10, 30);

function iso(text: string): string | null {
  const r = parseEnglishDate(text, NOW);
  return r ? r.isoDate : null;
}

check('date: today', iso('finish it today'), '2026-07-28');
check('date: tomorrow', iso('remind me tomorrow'), '2026-07-29');
check('date: day after tomorrow', iso('day after tomorrow works'), '2026-07-30');
check('date: yesterday', iso('I saw it yesterday'), '2026-07-27');
check('date: next Monday', iso('finish the report by next Monday'), '2026-08-03');
check('date: next Friday', iso('deadline is next Friday'), '2026-08-07');
check('date: this Friday', iso('due this Friday'), '2026-07-31');
check('date: bare weekday (Friday)', iso('ship it on Friday'), '2026-07-31');
check('date: next week', iso('start next week'), '2026-08-03');
check('date: next month', iso('plan for next month'), '2026-08-01');
check('date: in 3 days', iso('in 3 days please'), '2026-07-31');
check('date: in three days (word)', iso('in three days please'), '2026-07-31');
check('date: in 2 weeks', iso('review in 2 weeks'), '2026-08-11');
check('date: in a week', iso('circle back in a week'), '2026-08-04');
check('date: 3 days later', iso('3 days later we deploy'), '2026-07-31');
check('date: no match → null', iso('nothing dated here'), null);

// kind + multiple extraction
{
  const r = parseEnglishDate('by next Monday', NOW);
  check('date kind: next_weekday', r?.kind, 'next_weekday');
}
{
  const all = extractEnglishDates('tomorrow or next week or in 3 days', NOW);
  check('extract: 3 expressions found', all.length, 3);
  check(
    'extract: ordered by position',
    all.map(d => d.kind),
    ['tomorrow', 'next_week', 'relative_days'],
  );
}
{
  // "day after tomorrow" must not double-match "tomorrow"
  const all = extractEnglishDates('day after tomorrow', NOW);
  check('extract: no overlap on day-after-tomorrow', all.length, 1);
  check('extract: kind is day_after_tomorrow', all[0].kind, 'day_after_tomorrow');
}

// ═══ Part 4: E2E Language-aware Classification ═══════════════════════

console.log('\n── Part 4: E2E Language-aware Classification ──────────────');

// English input auto-routes to English rules — no explicit locale!
{
  const r = classifyText('create a new task for deployment');
  check('e2e en: create → create_task', r.category, 'create_task');
  check('e2e en: meta.locale = en', r.meta.locale, 'en');
  check('e2e en: meta.localeSource = detected', r.meta.localeSource, 'detected');
}
{
  const r = classifyText('show me all my tasks');
  check('e2e en: list tasks → query_status', r.category, 'query_status');
  check('e2e en: meta.locale = en', r.meta.locale, 'en');
}
{
  const r = classifyText('fix the login crash bug');
  check('e2e en: bugfix → create_task', r.category, 'create_task');
  check('e2e en: bugfix subCategory', r.subCategory, 'bugfix');
}

// Chinese input keeps the zh-CN pre-compiled fast path
{
  const r = classifyText('创建一个新任务：部署上线');
  check('e2e zh: 创建任务 → create_task', r.category, 'create_task');
  check('e2e zh: meta.locale = zh-CN', r.meta.locale, 'zh-CN');
  check('e2e zh: meta.localeSource = detected', r.meta.localeSource, 'detected');
}

// Mixed zh-dominant input routes to Chinese rules
{
  const r = classifyText('帮我创建一个新任务：deploy service');
  check('e2e mixed(zh): → create_task', r.category, 'create_task');
  check('e2e mixed(zh): meta.locale = zh-CN', r.meta.locale, 'zh-CN');
}
{
  const r = classifyText('修复登录页面的bug');
  check('e2e mixed(zh): 修复bug locale = zh-CN', r.meta.locale, 'zh-CN');
}

// Mixed en-dominant input routes to English rules
{
  const r = classifyText('please check the 部署 status');
  check('e2e mixed(en): locale = en', r.meta.locale, 'en');
}

// Explicit locale still wins over detection
{
  const r = classify({ text: 'create a new task', locale: 'zh-CN' });
  check('e2e explicit: locale = zh-CN', r.meta.locale, 'zh-CN');
  check('e2e explicit: localeSource = explicit', r.meta.localeSource, 'explicit');
}
{
  const r = classify({ text: '创建一个新任务', locale: 'en' });
  check('e2e explicit: locale = en', r.meta.locale, 'en');
  check('e2e explicit: localeSource = explicit', r.meta.localeSource, 'explicit');
}

// ═══ Part 5: Performance ═════════════════════════════════════════════

console.log('\n── Part 5: Performance ────────────────────────────────────');

{
  const samples = [
    '创建一个新任务：部署上线并通知团队成员',
    'create a new task for the deployment pipeline and notify everyone',
    '修复登录页面的bug，deadline是下周三',
    'Fix the bug in 用户 module before next Monday',
  ];
  const N = 20000;
  // Warm-up
  for (let i = 0; i < 1000; i++) detectLanguage(samples[i % samples.length]);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) detectLanguage(samples[i % samples.length]);
  const t1 = process.hrtime.bigint();
  const avgUs = Number(t1 - t0) / 1000 / N;
  console.log(`   detectLanguage avg: ${avgUs.toFixed(3)}μs over ${N} runs`);
  checkTrue(`perf: avg ${avgUs.toFixed(3)}μs < 50μs`, avgUs < 50);
}

// ═══ Summary ═════════════════════════════════════════════════════════

console.log('\n═══════════════════════════════════════════════════════════');
console.log(`  M5 Multi-language Tests: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log('═══════════════════════════════════════════════════════════');

if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
} else {
  console.log('\n✅ All M5 multi-language tests passed!');
}
