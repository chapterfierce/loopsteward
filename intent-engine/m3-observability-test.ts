/**
 * Claw Task Service — M3 Observability Comprehensive Tests
 *
 * Tests all M3 observability modules:
 *   1. Metrics: recording, snapshots, timeline ring buffer, error tracking
 *   2. Structured Logger: level filtering, JSON output, classification helper
 *   3. Tracer: trace/span lifecycle, attributes, events, context propagation
 *   4. Health Check: status computation, response structure
 *   5. Monitor: stats response, timeline response
 *   6. Pipeline Integration: metrics + tracer + logger on classifyIntent
 *   7. Tracer capacity & eviction
 *   8. Trace context propagation (W3C traceparent)
 */

import { classifyIntent, clearCache, resetCacheStats } from './pipeline.js';
import { metrics, MetricsCollector } from './metrics.js';
import { logger, Logger, type LogEntry } from './logger.js';
import { tracer, Tracer, type Trace, type Span } from './tracer.js';
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
  tracer.reset();
}

// ─── 1. Metrics Recording ──────────────────────────────────────────

section('1. Metrics Recording');

reset();
classifyIntent('创建登录页面重构任务');
classifyIntent('查询当前任务状态');

const snap1 = metrics.getMetrics();
assert(snap1.totalClassifications === 2, `Should have 2 classifications, got ${snap1.totalClassifications}`);
assert(snap1.averageConfidence > 0, 'Average confidence should be > 0');
assert(snap1.averageLatencyMs >= 0, 'Average latency should be >= 0');
assert(Object.keys(snap1.categories).length > 0, 'Should have at least 1 category tracked');

// ─── 2. Cache Hit/Miss Metrics ─────────────────────────────────────

section('2. Cache Hit/Miss Metrics');

reset();
classifyIntent('创建测试任务');
classifyIntent('创建测试任务'); // Same input → cache hit

const snap2 = metrics.getMetrics();
assert(snap2.totalClassifications === 2, `Should have 2 classifications, got ${snap2.totalClassifications}`);
assert(snap2.cache.hits >= 1, `Cache should have at least 1 hit, got ${snap2.cache.hits}`);
assert(snap2.cache.misses >= 1, `Cache should have at least 1 miss, got ${snap2.cache.misses}`);
assert(snap2.cache.hitRate > 0, `Cache hit rate should be > 0, got ${snap2.cache.hitRate}`);

// ─── 3. Timeline Entries ───────────────────────────────────────────

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

// ─── 4. Error Recording ────────────────────────────────────────────

section('4. Error Recording');

reset();
metrics.recordError('classification_error');
metrics.recordError('parse_error');
metrics.recordError('timeout');
metrics.recordError('cache_error');

const snap4 = metrics.getMetrics();
assert(snap4.errors.classificationErrors === 1, `Classification errors should be 1, got ${snap4.errors.classificationErrors}`);
assert(snap4.errors.parseErrors === 1, `Parse errors should be 1, got ${snap4.errors.parseErrors}`);
assert(snap4.errors.timeouts === 1, `Timeouts should be 1, got ${snap4.errors.timeouts}`);
assert(snap4.errors.cacheErrors === 1, `Cache errors should be 1, got ${snap4.errors.cacheErrors}`);
assert(snap4.errors.total === 4, `Total errors should be 4, got ${snap4.errors.total}`);

// ─── 5. Ring Buffer Overflow ───────────────────────────────────────

section('5. Ring Buffer Overflow');

reset();
for (let i = 0; i < 1100; i++) {
  classifyIntent(`溢出测试任务${i}`);
}

const snap5 = metrics.getMetrics();
assert(snap5.totalClassifications === 1100, `Should have 1100 total, got ${snap5.totalClassifications}`);
assert(snap5.timelineSize <= 1001, `Timeline should be capped at ~1000, got ${snap5.timelineSize}`);
assert(snap5.timelineCapacity === 1000, `Timeline capacity should be 1000, got ${snap5.timelineCapacity}`);

// ─── 6. Reset Functionality ────────────────────────────────────────

section('6. Reset Functionality');

reset();
classifyIntent('测试任务');

const snap6a = metrics.getMetrics();
assert(snap6a.totalClassifications === 1, `After 1 classification, total should be 1, got ${snap6a.totalClassifications}`);

metrics.resetMetrics();
const snap6b = metrics.getMetrics();
assert(snap6b.totalClassifications === 0, `After reset, total should be 0, got ${snap6b.totalClassifications}`);
assert(snap6b.cache.hits === 0, `After reset, cache hits should be 0, got ${snap6b.cache.hits}`);
assert(snap6b.timelineSize === 0, `After reset, timeline size should be 0, got ${snap6b.timelineSize}`);

// ─── 7. Structured Logger ──────────────────────────────────────────

section('7. Structured Logger');

// Test log level filtering
const testLogger = new Logger();
testLogger.setLevel('WARN');

// Capture stdout to verify filtering
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);
let stdoutOutput = '';
let stderrOutput = '';

process.stdout.write = ((chunk: string | Uint8Array) => {
  stdoutOutput += chunk.toString();
  return true;
}) as typeof process.stdout.write;
process.stderr.write = ((chunk: string | Uint8Array) => {
  stderrOutput += chunk.toString();
  return true;
}) as typeof process.stderr.write;

testLogger.debug('Should be filtered');
testLogger.info('Should be filtered');
testLogger.warn('Should appear');
testLogger.error('Should appear on stderr');

process.stdout.write = originalStdoutWrite;
process.stderr.write = originalStderrWrite;

// WARN goes to stdout, ERROR goes to stderr
const stdoutLines = stdoutOutput.trim().split('\n').filter(l => l.length > 0);
const stderrLines = stderrOutput.trim().split('\n').filter(l => l.length > 0);

assert(stdoutLines.length === 1, `stdout should have 1 line (WARN), got ${stdoutLines.length}`);
assert(stderrLines.length === 1, `stderr should have 1 line (ERROR), got ${stderrLines.length}`);

// Verify JSON structure of log entries
const warnEntry = JSON.parse(stdoutLines[0]) as LogEntry;
assert(warnEntry.level === 'WARN', `WARN entry level should be WARN, got ${warnEntry.level}`);
assert(warnEntry.message === 'Should appear', `WARN entry message should match`);
assert(typeof warnEntry.timestamp === 'string', 'Timestamp should be a string');
assert(typeof warnEntry.epochMs === 'number', 'epochMs should be a number');

const errorEntry = JSON.parse(stderrLines[0]) as LogEntry;
assert(errorEntry.level === 'ERROR', `ERROR entry level should be ERROR, got ${errorEntry.level}`);

// Test getLevel
testLogger.setLevel('DEBUG');
assert(testLogger.getLevel() === 'DEBUG', `Level should be DEBUG after setLevel`);
testLogger.setLevel('INFO');
assert(testLogger.getLevel() === 'INFO', `Level should be INFO after setLevel`);

// Test classification helper
const testLogger2 = new Logger();
testLogger2.setLevel('DEBUG');

process.stdout.write = ((chunk: string | Uint8Array) => {
  stdoutOutput += chunk.toString();
  return true;
}) as typeof process.stdout.write;

stdoutOutput = '';
testLogger2.classification('Test classification', {
  category: 'create_task',
  subCategory: 'feature',
  latencyMs: 5,
  cacheHit: true,
  confidence: 0.9,
});

process.stdout.write = originalStdoutWrite;

const clsLines = stdoutOutput.trim().split('\n').filter(l => l.length > 0);
assert(clsLines.length === 1, `Classification log should produce 1 line, got ${clsLines.length}`);
const clsEntry = JSON.parse(clsLines[0]) as LogEntry;
assert(clsEntry.category === 'create_task', `Classification entry category should match`);
assert(clsEntry.latencyMs === 5, `Classification entry latency should match`);
assert(clsEntry.cacheHit === true, `Classification entry cacheHit should match`);

// Test low-confidence classification → WARN level
const testLogger3 = new Logger();
testLogger3.setLevel('WARN');

process.stderr.write = ((chunk: string | Uint8Array) => {
  stderrOutput += chunk.toString();
  return true;
}) as typeof process.stderr.write;

stderrOutput = '';
testLogger3.classification('Low confidence', {
  confidence: 0.3,
});

process.stderr.write = originalStderrWrite;

// Low confidence (< 0.5) should log at WARN level → stdout
// Actually WARN goes to stdout, not stderr. Let me re-check.
// Looking at logger.ts: ERROR goes to stderr, everything else goes to stdout.
// So WARN goes to stdout.

process.stdout.write = ((chunk: string | Uint8Array) => {
  stdoutOutput += chunk.toString();
  return true;
}) as typeof process.stdout.write;

stdoutOutput = '';
testLogger3.classification('Low confidence', {
  confidence: 0.3,
});
process.stdout.write = originalStdoutWrite;

const lowConfLines = stdoutOutput.trim().split('\n').filter(l => l.length > 0);
assert(lowConfLines.length === 1, `Low confidence should produce 1 WARN line, got ${lowConfLines.length}`);
const lowConfEntry = JSON.parse(lowConfLines[0]) as LogEntry;
assert(lowConfEntry.level === 'WARN', `Low confidence should be WARN level, got ${lowConfEntry.level}`);

// ─── 8. Tracer: Basic Lifecycle ────────────────────────────────────

section('8. Tracer: Basic Lifecycle');

reset();

const trace = tracer.startTrace('test.operation', { requestId: 'req-001' });
assert(trace.traceId.length === 16, `Trace ID should be 16 hex chars, got ${trace.traceId.length}`);
assert(trace.rootSpanId.length === 8, `Span ID should be 8 hex chars, got ${trace.rootSpanId.length}`);
assert(trace.status === 'active', `Trace should be active, got ${trace.status}`);
assert(trace.spans.size === 1, `Trace should have 1 root span, got ${trace.spans.size}`);

const rootSpan = trace.spans.get(trace.rootSpanId)!;
assert(rootSpan.name === 'test.operation', `Root span name should be 'test.operation', got ${rootSpan.name}`);
assert(rootSpan.status === 'active', `Root span should be active`);
assert(rootSpan.attributes['requestId'] === 'req-001', `Root span attribute should match`);

// ─── 9. Tracer: Child Spans ────────────────────────────────────────

section('9. Tracer: Child Spans');

reset();

const trace2 = tracer.startTrace('intent.classify');
const childSpan = tracer.startSpan('preprocess', trace2.traceId);
assert(childSpan !== undefined, 'Child span should be created');
assert(childSpan!.traceId === trace2.traceId, `Child span trace ID should match parent`);
assert(childSpan!.parentSpanId === trace2.rootSpanId, `Child span parent should be root span`);

// Add attributes and events
tracer.setSpanAttribute(childSpan!.spanId, trace2.traceId, 'inputLength', 42);
tracer.recordEvent(childSpan!.spanId, trace2.traceId, 'tokenization_complete', { tokens: 10 });

const spanWithAttrs = tracer.getSpan(trace2.traceId, childSpan!.spanId)!;
assert(spanWithAttrs.attributes['inputLength'] === 42, `Span attribute should be set`);
assert(spanWithAttrs.events.length === 1, `Span should have 1 event`);
assert(spanWithAttrs.events[0].name === 'tokenization_complete', `Event name should match`);

// End the span
tracer.endSpan(childSpan!, trace2.traceId);
const endedSpan = tracer.getSpan(trace2.traceId, childSpan!.spanId)!;
assert(endedSpan.status === 'completed', `Ended span should be completed`);
assert(endedSpan.durationMs !== undefined, `Ended span should have duration`);
assert(endedSpan.durationMs! >= 0, `Span duration should be >= 0`);

// End the trace
tracer.endTrace(trace2);
const endedTrace = tracer.getTrace(trace2.traceId)!;
assert(endedTrace.status === 'completed', `Ended trace should be completed`);
assert(endedTrace.durationMs !== undefined, `Ended trace should have duration`);

// ─── 10. Tracer: Error Status ──────────────────────────────────────

section('10. Tracer: Error Status');

reset();

const errorTrace = tracer.startTrace('error.operation');
const errorSpan = tracer.startSpan('failing_step', errorTrace.traceId);

tracer.endSpan(errorSpan!, errorTrace.traceId, 'error');
tracer.endTrace(errorTrace, 'error');

const errTrace = tracer.getTrace(errorTrace.traceId)!;
assert(errTrace.status === 'error', `Trace should have error status, got ${errTrace.status}`);

const errSpan = errTrace.spans.get(errorSpan!.spanId)!;
assert(errSpan.status === 'error', `Span should have error status, got ${errSpan.status}`);

// ─── 11. Tracer: Summary ───────────────────────────────────────────

section('11. Tracer: Summary');

reset();

const summaryTrace = tracer.startTrace('summary.test');
tracer.startSpan('step1', summaryTrace.traceId);
tracer.startSpan('step2', summaryTrace.traceId);

// End all spans
for (const span of summaryTrace.spans.values()) {
  if (span.status === 'active') {
    tracer.endSpan(span, summaryTrace.traceId);
  }
}
tracer.endTrace(summaryTrace);

const summary = tracer.getTraceSummary(summaryTrace.traceId);
assert(summary !== undefined, 'Summary should not be undefined');
assert(summary!.traceId === summaryTrace.traceId, `Summary trace ID should match`);
assert(summary!.spanCount === 3, `Summary should have 3 spans (root + 2 children), got ${summary!.spanCount}`);
assert(summary!.rootSpan === 'summary.test', `Summary root span name should match`);
assert(summary!.spans.length === 3, `Summary spans array should have 3 entries`);
assert(summary!.spans[0].name === 'summary.test', `First span should be root`);

// ─── 12. Tracer: Context Propagation ───────────────────────────────

section('12. Tracer: Context Propagation');

reset();

const ctxTrace = tracer.startTrace('propagation.test');
const ctx = { traceId: ctxTrace.traceId, spanId: ctxTrace.rootSpanId };

// Build traceparent header
const header = tracer.buildTraceParent(ctx);
assert(header.startsWith('00-'), `Traceparent should start with '00-', got ${header.substring(0, 3)}`);
assert(header.includes(ctxTrace.traceId), `Traceparent should contain trace ID`);
assert(header.endsWith('-01'), `Traceparent should end with '-01'`);

// Parse it back
const parsed = tracer.parseTraceParent(header);
assert(parsed !== undefined, 'Parsed traceparent should not be undefined');
assert(parsed!.traceId === ctxTrace.traceId, `Parsed trace ID should match original`);
assert(parsed!.spanId === ctxTrace.rootSpanId, `Parsed span ID should match original`);

// Invalid header
const invalid = tracer.parseTraceParent('invalid-header');
assert(invalid === undefined, 'Invalid traceparent should return undefined');

// ─── 13. Tracer: Capacity & Eviction ───────────────────────────────

section('13. Tracer: Capacity & Eviction');

reset();

// Create 600 traces (exceeds MAX_TRACES=500)
for (let i = 0; i < 600; i++) {
  const t = tracer.startTrace(`batch.${i}`);
  tracer.endTrace(t);
}

assert(tracer.getTotalTraceCount() <= 500, `Trace count should be <= 500, got ${tracer.getTotalTraceCount()}`);

// ─── 14. Health Check ──────────────────────────────────────────────

section('14. Health Check');

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

// Express handler should not throw
let expressCalled = false;
const mockRes: any = {
  status(code: number) { return this; },
  json(body: any) { expressCalled = true; },
};
healthHandlerExpress({} as any, mockRes);
assert(expressCalled, 'Express health handler should call res.json');

// ─── 15. Monitor Stats ─────────────────────────────────────────────

section('15. Monitor Stats');

reset();
classifyIntent('创建任务A');
classifyIntent('查询任务B');
classifyIntent('创建任务C');

const stats = buildStatsResponse();
assert(stats.metrics.totalClassifications === 3, `Should have 3 classifications, got ${stats.metrics.totalClassifications}`);
assert(stats.categorySummary.length > 0, 'Category summary should not be empty');
assert(stats.topCategories.length <= 5, `Top categories should be <= 5, got ${stats.topCategories.length}`);
assert(['optimal', 'acceptable', 'needs_attention'].includes(stats.health.recommendation), `Health recommendation should be valid, got '${stats.health.recommendation}'`);
assert(stats.cache.capacity === 1000, `Cache capacity should be 1000, got ${stats.cache.capacity}`);

// ─── 16. Monitor Timeline ──────────────────────────────────────────

section('16. Monitor Timeline');

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

// ─── 17. Pipeline Integration: Tracer + Metrics ────────────────────

section('17. Pipeline Integration: Tracer + Metrics');

reset();
const initialTraceCount = tracer.getTotalTraceCount();

classifyIntent('创建登录页面任务');

// Each classifyIntent call should create a trace
const afterCount = tracer.getTotalTraceCount();
assert(afterCount === initialTraceCount + 1, `Trace count should increase by 1, got ${afterCount} (was ${initialTraceCount})`);

// Cache hit should also create a trace (root span + cache_lookup span)
classifyIntent('创建登录页面任务'); // cache hit
const afterCacheHit = tracer.getTotalTraceCount();
assert(afterCacheHit === initialTraceCount + 2, `Trace count should increase by 2 (cache hit also traced), got ${afterCacheHit}`);

// ─── 18. Per-Category Metrics Detail ───────────────────────────────

section('18. Per-Category Metrics Detail');

reset();
classifyIntent('创建任务一');
classifyIntent('创建任务二');
classifyIntent('查询任务状态');

const snap18 = metrics.getMetrics();
assert(snap18.totalClassifications === 3, `Should have 3 total classifications`);
const catKeys = Object.keys(snap18.categories);
assert(catKeys.length >= 2, `Should have at least 2 categories, got ${catKeys.length}`);

// Verify each category has stats
for (const key of catKeys) {
  const catStats = snap18.categories[key];
  assert(catStats.count > 0, `Category ${key} should have count > 0`);
  assert(catStats.totalConfidence > 0, `Category ${key} should have totalConfidence > 0`);
  assert(catStats.minLatencyMs >= 0, `Category ${key} minLatency should be >= 0`);
  assert(catStats.maxLatencyMs >= catStats.minLatencyMs, `Category ${key} maxLatency >= minLatency`);
}

// ─── 19. Logger Uptime ─────────────────────────────────────────────

section('19. Logger Uptime');

const uptimeMs = logger.getUptimeMs();
assert(uptimeMs >= 0, `Logger uptime should be >= 0, got ${uptimeMs}`);

// ─── 20. MetricsCollector Standalone Instance ──────────────────────

section('20. MetricsCollector Standalone Instance');

const standalone = new MetricsCollector();
assert(standalone.getMetrics().totalClassifications === 0, 'Standalone collector should start at 0');

// ─── 21. Tracer: Multiple Child Spans with Hierarchy ───────────────

section('21. Tracer: Multiple Child Spans with Hierarchy');

reset();

const parentTrace = tracer.startTrace('hierarchy.test');
const rootSpanId = parentTrace.rootSpanId;

const child1 = tracer.startSpan('child1', parentTrace.traceId, rootSpanId);
const child2 = tracer.startSpan('child2', parentTrace.traceId, rootSpanId);
const grandchild = tracer.startSpan('grandchild', parentTrace.traceId, child1!.spanId);

assert(grandchild!.parentSpanId === child1!.spanId, `Grandchild parent should be child1`);

tracer.endSpan(grandchild!, parentTrace.traceId);
tracer.endSpan(child1!, parentTrace.traceId);
tracer.endSpan(child2!, parentTrace.traceId);
tracer.endTrace(parentTrace);

const hierarchySummary = tracer.getTraceSummary(parentTrace.traceId);
assert(hierarchySummary!.spanCount === 4, `Should have 4 spans (root + 2 children + 1 grandchild), got ${hierarchySummary!.spanCount}`);

// ─── Summary ───────────────────────────────────────────────────────

console.log(`\n${'='.repeat(60)}`);
console.log(`M3 Observability Comprehensive Tests`);
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
