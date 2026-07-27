/**
 * Claw Task Service — M3 Observability Integration Tests
 *
 * Tests that metrics, health, and monitor endpoints work correctly
 * when integrated with the pipeline.
 *
 * Test areas:
 *   1. Metrics recording on classification
 *   2. Cache hit/miss metrics
 *   3. Timeline entries
 *   4. Health check response
 *   5. Monitor stats response
 *   6. Monitor timeline response
 *   7. Error recording
 *   8. Reset functionality
 */

import { classifyIntent, clearCache, resetCacheStats } from './pipeline.js';
import { metrics } from './metrics.js';
import { buildHealthResponse, healthHandlerExpress } from './health.js';
import { buildStatsResponse, buildTimelineResponse } from './monitor.js';

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

function reset(): void {
  metrics.resetMetrics();
  clearCache();
  resetCacheStats();
}

// ─── Tests ─────────────────────────────────────────────────────────

section('1. Metrics Recording on Classification');

reset();
classifyIntent('创建登录页面重构任务');
classifyIntent('查询当前任务状态');

const snap1 = metrics.getMetrics();
assert(snap1.totalClassifications === 2, `Should have 2 classifications, got ${snap1.totalClassifications}`);
assert(snap1.averageConfidence > 0, 'Average confidence should be > 0');
assert(snap1.averageLatencyMs >= 0, 'Average latency should be >= 0');
assert(Object.keys(snap1.categories).length > 0, 'Should have at least 1 category tracked');

section('2. Cache Hit/Miss Metrics');

reset();
classifyIntent('创建测试任务');
classifyIntent('创建测试任务'); // Same input → cache hit

const snap2 = metrics.getMetrics();
assert(snap2.totalClassifications === 2, `Should have 2 classifications, got ${snap2.totalClassifications}`);
assert(snap2.cache.hits >= 1, `Cache should have at least 1 hit, got ${snap2.cache.hits}`);
assert(snap2.cache.misses >= 1, `Cache should have at least 1 miss, got ${snap2.cache.misses}`);
assert(snap2.cache.hitRate > 0, `Cache hit rate should be > 0, got ${snap2.cache.hitRate}`);

section('3. Timeline Entries');

reset();
for (let i = 0; i < 5; i++) {
  classifyIntent(`测试任务${i}创建`);
}

const timeline = metrics.getTimeline(10);
assert(timeline.length === 5, `Timeline should have 5 entries, got ${timeline.length}`);
assert(timeline[0].epochMs >= timeline[4].epochMs, 'Timeline should be most-recent-first');

const snap3 = metrics.getMetrics();
assert(snap3.timelineSize === 5, `Timeline size should be 5, got ${snap3.timelineSize}`);
assert(snap3.timelineCapacity === 1000, `Timeline capacity should be 1000, got ${snap3.timelineCapacity}`);

section('4. Health Check Response');

reset();
classifyIntent('创建任务');

const health = buildHealthResponse();
assert(health.status === 'healthy', `Health should be 'healthy', got '${health.status}'`);
assert(health.uptime >= 0, `Uptime should be >= 0, got ${health.uptime}`);
assert(health.version !== '', 'Version should not be empty');
assert(health.stats.intentEngine.operational === true, 'Intent engine should be operational');
assert(health.stats.intentEngine.totalClassifications === 1, `Should have 1 classification, got ${health.stats.intentEngine.totalClassifications}`);
assert(health.stats.cache.capacity === 1000, `Cache capacity should be 1000, got ${health.stats.cache.capacity}`);
assert(health.stats.errors.total === 0, `Error count should be 0, got ${health.stats.errors.total}`);

section('5. Monitor Stats Response');

reset();
classifyIntent('创建任务A');
classifyIntent('查询任务B');
classifyIntent('创建任务C');

const stats = buildStatsResponse();
assert(stats.metrics.totalClassifications === 3, `Should have 3 classifications, got ${stats.metrics.totalClassifications}`);
assert(stats.categorySummary.length > 0, 'Category summary should not be empty');
assert(stats.topCategories.length <= 5, `Top categories should be <= 5, got ${stats.topCategories.length}`);
// After only 3 classifications with 2/3 cache misses, recommendation may not be 'optimal'
// Just check it's a valid value
assert(['optimal', 'acceptable', 'needs_attention'].includes(stats.health.recommendation), `Health recommendation should be valid, got '${stats.health.recommendation}'`);
assert(stats.cache.capacity === 1000, `Cache capacity should be 1000, got ${stats.cache.capacity}`);

section('6. Monitor Timeline Response');

reset();
for (let i = 0; i < 3; i++) {
  classifyIntent(`时间线测试${i}`);
}

const tlResp = buildTimelineResponse(10);
assert(tlResp.count === 3, `Timeline response count should be 3, got ${tlResp.count}`);
assert(tlResp.entries.length === 3, `Entries length should be 3, got ${tlResp.entries.length}`);
assert(tlResp.summary.avgConfidence > 0, `Summary avg confidence should be > 0, got ${tlResp.summary.avgConfidence}`);
assert(tlResp.summary.uniqueCategories > 0, `Summary unique categories should be > 0, got ${tlResp.summary.uniqueCategories}`);

// Test with limit
const tlLimited = buildTimelineResponse(2);
assert(tlLimited.count === 2, `Timeline response with limit=2 should have count=2, got ${tlLimited.count}`);

section('7. Error Recording');

reset();
metrics.recordError('classification_error');
metrics.recordError('parse_error');
metrics.recordError('timeout');

const snap7 = metrics.getMetrics();
assert(snap7.errors.classificationErrors === 1, `Classification errors should be 1, got ${snap7.errors.classificationErrors}`);
assert(snap7.errors.parseErrors === 1, `Parse errors should be 1, got ${snap7.errors.parseErrors}`);
assert(snap7.errors.timeouts === 1, `Timeouts should be 1, got ${snap7.errors.timeouts}`);
assert(snap7.errors.total === 3, `Total errors should be 3, got ${snap7.errors.total}`);

section('8. Reset Functionality');

reset();
classifyIntent('测试任务');

const snap8a = metrics.getMetrics();
assert(snap8a.totalClassifications === 1, `After 1 classification, total should be 1, got ${snap8a.totalClassifications}`);

metrics.resetMetrics();
const snap8b = metrics.getMetrics();
assert(snap8b.totalClassifications === 0, `After reset, total should be 0, got ${snap8b.totalClassifications}`);
assert(snap8b.cache.hits === 0, `After reset, cache hits should be 0, got ${snap8b.cache.hits}`);
assert(snap8b.timelineSize === 0, `After reset, timeline size should be 0, got ${snap8b.timelineSize}`);

section('9. Ring Buffer Overflow');

reset();
for (let i = 0; i < 1100; i++) {
  classifyIntent(`溢出测试任务${i}`);
}

const snap9 = metrics.getMetrics();
assert(snap9.totalClassifications === 1100, `Should have 1100 total, got ${snap9.totalClassifications}`);
assert(snap9.timelineSize <= 1001, `Timeline should be capped at ~1000, got ${snap9.timelineSize}`);
assert(snap9.timelineCapacity === 1000, `Timeline capacity should be 1000, got ${snap9.timelineCapacity}`);

// ─── Summary ────────────────────────────────────────────────────────

console.log(`\n${'='.repeat(60)}`);
console.log(`M3 Observability Integration Tests`);
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
