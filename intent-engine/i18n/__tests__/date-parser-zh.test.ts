/**
 * Claw Task Service — date-parser-zh.test.ts (Phase 3 M5)
 *
 * Test suite for the Chinese date parser (date-parser-zh.ts).
 * All tests use a fixed `now = Tue 2026-07-28` for deterministic results.
 *
 * Test coverage:
 *   1. Relative days: 今天 / 明天 / 后天 / 大后天
 *   2. Weekday this week: 周一 / 周二 / ... / 周日 (upcoming occurrence)
 *   3. Weekday next week: 下周一 / 下周二 / ... / 下周日
 *   4. Absolute month+day: 本月15号 / 下个月3日 / 8月20日 / 12月5日
 *   5. Time of day: 上午9点 / 下午2点半 / 晚上8点 / 早上7:30
 *   6. Relative durations: 30分钟后 / 2小时15分钟后 / 3周后 / 2个月后
 *   7. Full ISO dates: 2026-07-30 / 2026-12-01
 *   8. Mixed content: sentence containing dates
 *   9. Unparseable input: returns null / []
 *  10. Cross-year boundary: "下个月3日" in December
 *  11. Edge: today is already Monday
 *  12. Edge: "下周一" when today is Monday
 */

import {
  parseChineseDate,
  extractChineseDates,
  toIsoDate,
} from '../date-parser-zh.js';

// ─── Test Setup ──────────────────────────────────────────────────────

/** Fixed reference date: Tuesday 2026-07-28 */
const NOW = new Date(2026, 6, 28, 10, 0, 0); // July = month index 6

function iso(d: Date): string {
  return toIsoDate(d);
}

// ─── Harness ────────────────────────────────────────────────────────

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

function checkExact(name: string, actual: unknown, expected: unknown): void {
  const a = String(actual);
  const e = String(expected);
  if (a === e) {
    passed++;
    console.log(`✅ PASS — ${name}`);
  } else {
    failed++;
    failures.push(`${name}: expected=${e}, actual=${a}`);
    console.log(`❌ FAIL — ${name}: expected=${e}, actual=${a}`);
  }
}

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

// ─── Part 1: parseChineseDate — single expression ───────────────────

console.log('\n── Part 1: parseChineseDate — single expression ─────────────');

checkExact('今天', parseChineseDate('今天', NOW)?.isoDate ?? 'null', iso(new Date(2026, 6, 28)));
checkExact('明天', parseChineseDate('明天', NOW)?.isoDate ?? 'null', iso(new Date(2026, 6, 29)));
checkExact('后天', parseChineseDate('后天', NOW)?.isoDate ?? 'null', iso(new Date(2026, 6, 30)));
checkExact('大后天', parseChineseDate('大后天', NOW)?.isoDate ?? 'null', iso(new Date(2026, 6, 31)));

// Today is Tuesday (weekday 2); 周三 = diff 1
checkExact('本周周三 (2026-07-29)', parseChineseDate('周三', NOW)?.isoDate ?? 'null', iso(new Date(2026, 6, 29)));
// 周四 = diff 2
checkExact('本周周四 (2026-07-30)', parseChineseDate('周四', NOW)?.isoDate ?? 'null', iso(new Date(2026, 6, 30)));
// 周五 = diff 3
checkExact('本周周五 (2026-07-31)', parseChineseDate('周五', NOW)?.isoDate ?? 'null', iso(new Date(2026, 6, 31)));
// 周六 = diff 4
checkExact('本周周六 (2026-08-01)', parseChineseDate('周六', NOW)?.isoDate ?? 'null', iso(new Date(2026, 7, 1)));
// 周日 = diff 5
checkExact('本周周日 (2026-08-02)', parseChineseDate('周日', NOW)?.isoDate ?? 'null', iso(new Date(2026, 7, 2)));
// 周一 = diff 6
checkExact('本周周一 — next Monday (2026-08-03)', parseChineseDate('周一', NOW)?.isoDate ?? 'null', iso(new Date(2026, 7, 3)));

// 下周一 = next week's Monday (2026-08-03)
checkExact('下周一 (2026-08-03)', parseChineseDate('下周一', NOW)?.isoDate ?? 'null', iso(new Date(2026, 7, 3)));
// 下周五 = next Friday (2026-08-07)
checkExact('下周五 (2026-08-07)', parseChineseDate('下周五', NOW)?.isoDate ?? 'null', iso(new Date(2026, 7, 7)));
// 下周日 = next Sunday (2026-08-09)
checkExact('下周日 (2026-08-09)', parseChineseDate('下周日', NOW)?.isoDate ?? 'null', iso(new Date(2026, 7, 9)));

// ─── Part 2: Time of day ────────────────────────────────────────────

console.log('\n── Part 2: Time of day ────────────────────────────────────────');

{
  const r = parseChineseDate('上午9点', NOW);
  checkTrue('上午9点 → not null', r !== null);
  checkExact('上午9点 → isoDate', r!.isoDate, iso(new Date(2026, 6, 28)));
  checkExact('上午9点 → isoDateTime', r!.isoDateTime ?? 'null', '2026-07-28T09:00:00');
}

{
  const r = parseChineseDate('下午2点半', NOW);
  checkTrue('下午2点半 → not null', r !== null);
  checkExact('下午2点半 → isoDateTime', r!.isoDateTime ?? 'null', '2026-07-28T14:30:00');
}

{
  const r = parseChineseDate('晚上8点', NOW);
  checkTrue('晚上8点 → not null', r !== null);
  checkExact('晚上8点 → isoDateTime', r!.isoDateTime ?? 'null', '2026-07-28T20:00:00');
}

{
  const r = parseChineseDate('早上7:30', NOW);
  checkTrue('早上7:30 → not null', r !== null);
  checkExact('早上7:30 → isoDateTime', r!.isoDateTime ?? 'null', '2026-07-28T07:30:00');
}

{
  const r = parseChineseDate('下午3点', NOW);
  checkTrue('下午3点 → not null', r !== null);
  checkExact('下午3点 → isoDateTime', r!.isoDateTime ?? 'null', '2026-07-28T15:00:00');
}

// ─── Part 3: Relative durations ─────────────────────────────────────

console.log('\n── Part 3: Relative durations ────────────────────────────────');

checkExact('30分钟后', parseChineseDate('30分钟后', NOW)?.isoDate ?? 'null', iso(new Date(2026, 6, 28)));
checkExact('2小时15分钟后', parseChineseDate('2小时15分钟后', NOW)?.isoDate ?? 'null', iso(new Date(2026, 6, 28)));
checkExact('3周后', parseChineseDate('3周后', NOW)?.isoDate ?? 'null', iso(new Date(2026, 7, 18)));
checkExact('2个月后', parseChineseDate('2个月后', NOW)?.isoDate ?? 'null', iso(new Date(2026, 8, 28)));

// ─── Part 4: Absolute month+day ─────────────────────────────────────

console.log('\n── Part 4: Absolute month+day ───────────────────────────────');

checkExact('本月15号', parseChineseDate('本月15号', NOW)?.isoDate ?? 'null', iso(new Date(2026, 6, 15)));
checkExact('下个月3日', parseChineseDate('下个月3日', NOW)?.isoDate ?? 'null', iso(new Date(2026, 7, 3)));
checkExact('8月20日', parseChineseDate('8月20日', NOW)?.isoDate ?? 'null', iso(new Date(2026, 7, 20)));
checkExact('7月30日', parseChineseDate('7月30日', NOW)?.isoDate ?? 'null', iso(new Date(2026, 6, 30)));

// ─── Part 5: Full ISO dates ─────────────────────────────────────────

console.log('\n── Part 5: Full ISO dates ───────────────────────────────────');

checkExact('2026-07-30', parseChineseDate('2026-07-30', NOW)?.isoDate ?? 'null', '2026-07-30');
checkExact('2026-12-01', parseChineseDate('2026-12-01', NOW)?.isoDate ?? 'null', '2026-12-01');

// ─── Part 6: Cross-year boundary ────────────────────────────────────

console.log('\n── Part 6: Cross-year boundary ───────────────────────────────');

{
  const dec31 = new Date(2026, 11, 31); // 2026-12-31
  const r = parseChineseDate('下个月3日', dec31);
  checkExact(
    '下个月3日 in Dec → 2027-01-03',
    r?.isoDate ?? 'null',
    iso(new Date(2027, 0, 3)),
  );
}

// ─── Part 7: Edge cases ─────────────────────────────────────────────

console.log('\n── Part 7: Edge cases ───────────────────────────────────────');

// Today is Tuesday; bare "周二" should be next Tuesday (diff=7, not today)
{
  const r = parseChineseDate('周二', NOW);
  checkExact(
    '周二 when today=Tue → next Tuesday (2026-08-04)',
    r?.isoDate ?? 'null',
    iso(new Date(2026, 7, 4)),
  );
}

// "下周一" when today is Monday → 7 days ahead
{
  const monday = new Date(2026, 6, 27); // 2026-07-27 is a Monday
  const r = parseChineseDate('下周一', monday);
  checkExact(
    '下周一 when today=Mon → 2026-08-03',
    r?.isoDate ?? 'null',
    iso(new Date(2026, 7, 3)),
  );
}

// ─── Part 8: Unparseable input ─────────────────────────────────────

console.log('\n── Part 8: Unparseable input ────────────────────────────────');

checkTrue(
  'No date expression → null',
  parseChineseDate('你好，请问有什么可以帮助你？', NOW) === null,
);
checkTrue(
  'Random text → null',
  parseChineseDate('这是一段没有任何日期的普通文本', NOW) === null,
);
checkTrue(
  'Empty string → null',
  parseChineseDate('', NOW) === null,
);

// ─── Part 9: extractChineseDates — all matches ─────────────────────

console.log('\n── Part 9: extractChineseDates — all matches ─────────────────');

// "今天下午3点开会，明天上午9点也有"
// Patterns matched: 今天 + 明天 (and also 下午3点 time, 上午9点 time)
// But "下午3点" overlaps with "今天" already claimed,
// and 下午/上午 patterns may fire. Let's verify what's actually there.
{
  const r = extractChineseDates('今天下午3点开会，明天上午9点也有', NOW);
  checkExact(
    'Extract: 今天 + 明天 → 2 date matches (time overlap resolved)',
    r.length,
    2,
  );
  if (r.length >= 1) checkExact('First match: 今天', r[0].matched, '今天');
  if (r.length >= 2) checkExact('Second match: 明天', r[1].matched, '明天');
  if (r.length >= 1) checkExact('今天 → 2026-07-28', r[0].isoDate, '2026-07-28');
  if (r.length >= 2) checkExact('明天 → 2026-07-29', r[1].isoDate, '2026-07-29');
}

{
  const r = extractChineseDates('下周一安排评审，下周五上线', NOW);
  checkExact('Extract: 下周一 + 下周五 → 2 matches', r.length, 2);
  if (r.length >= 1) checkExact('First: 下周一', r[0].matched, '下周一');
  if (r.length >= 2) checkExact('Second: 下周五', r[1].matched, '下周五');
  if (r.length >= 1) checkExact('下周一 → 2026-08-03', r[0].isoDate, '2026-08-03');
  if (r.length >= 2) checkExact('下周五 → 2026-08-07', r[1].isoDate, '2026-08-07');
}

{
  const r = extractChineseDates('帮我创建个任务，截止到本月15号', NOW);
  checkExact('Extract: 本月15号 → 1 match', r.length, 1);
  if (r.length >= 1) checkExact('本月15号 → 2026-07-15', r[0].isoDate, '2026-07-15');
}

{
  const r = extractChineseDates('无日期文本', NOW);
  checkExact('No matches → empty array', r.length, 0);
}

// ─── Part 10: Kind classification ───────────────────────────────────

console.log('\n── Part 10: Kind classification ───────────────────────────────');

check('今天 → kind=today', parseChineseDate('今天', NOW)?.kind, 'today');
check('明天 → kind=tomorrow', parseChineseDate('明天', NOW)?.kind, 'tomorrow');
check('后天 → kind=day_after_tomorrow', parseChineseDate('后天', NOW)?.kind, 'day_after_tomorrow');
check('周五 → kind=weekday', parseChineseDate('周五', NOW)?.kind, 'weekday');
check('下周五 → kind=next_weekday', parseChineseDate('下周五', NOW)?.kind, 'next_weekday');
check('30分钟后 → kind=relative_minutes', parseChineseDate('30分钟后', NOW)?.kind, 'relative_minutes');
check('上午9点 → kind=time_of_day', parseChineseDate('上午9点', NOW)?.kind, 'time_of_day');
check('大后天 → kind=day_after_day_after_tomorrow', parseChineseDate('大后天', NOW)?.kind, 'day_after_day_after_tomorrow');

// ─── Summary ────────────────────────────────────────────────────────

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  date-parser-zh.ts — Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\n  Failed tests:');
  for (const f of failures) console.log(`    ❌ ${f}`);
  console.log('\n  ❌ Tests FAILED');
  process.exitCode = 1;
} else {
  console.log('\n  ✅ All tests PASSED');
}
console.log('═══════════════════════════════════════════════════════════════\n');
