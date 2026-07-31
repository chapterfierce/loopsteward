/**
 * Claw Task Service — M3 Observability Tests
 *
 * Tests service-level observability infrastructure:
 *   1. HTTP Metrics: request count, latency histogram, error rate
 *   2. Request Context: request_id/trace_id propagation
 *   3. Service Logger: structured JSON with context injection
 *   4. Health Check: status computation, dependency checks
 *   5. HTTP Tracing: span creation, context propagation
 *   6. W3C traceparent parsing and building
 */

import { httpMetrics, HttpMetricsCollector } from './http-metrics.js';
import {
  extractRequestContext,
  runWithRequestContext,
  getRequestContext,
  getRequestId,
  getTraceId,
  parseTraceparent,
  buildTraceparent,
  generateRequestId,
  generateTraceId,
  generateSpanId,
  type RequestContext,
} from './request-context.js';
import { serviceLogger, ServiceLogger } from './service-logger.js';
import {
  buildHealthResponse,
  healthCheckHandler,
  livenessHandler,
  readinessHandler,
} from './health-check.js';
import {
  startHttpSpan,
  endHttpSpan,
  startChildSpan,
  endChildSpan,
  injectTraceHeaders,
} from './http-tracing.js';

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
    console.error(`FAIL: ${message}`);
  }
}

function section(name: string): void {
  console.log(`\n-- ${name} --`);
}

function reset(): void {
  httpMetrics.reset();
}

// ─── Mock HTTP Request ─────────────────────────────────────────────

function mockRequest(overrides: Partial<{
  method: string;
  url: string;
  headers: Record<string, string>;
  socket: { remoteAddress: string };
}> = {}): any {
  return {
    method: overrides.method ?? 'GET',
    url: overrides.url ?? '/api/tasks',
    headers: overrides.headers ?? {},
    socket: { remoteAddress: overrides.socket?.remoteAddress ?? '127.0.0.1' },
  };
}

function mockResponse(): any {
  const headers: Record<string, string> = {};
  return {
    statusCode: 200,
    headers,
    setHeader(name: string, value: string) { headers[name] = value; },
    status(code: number) { this.statusCode = code; return this; },
    json(body: any) { this.body = body; return this; },
    end() {},
  };
}

// ─── 1. HTTP Metrics ───────────────────────────────────────────────

section('1. HTTP Metrics Recording');

reset();
httpMetrics.recordRequestStart();
httpMetrics.recordRequestEnd('GET', '/api/tasks', 200, 15);
httpMetrics.recordRequestEnd('GET', '/api/tasks', 200, 25);
httpMetrics.recordRequestEnd('POST', '/api/tasks', 201, 50);
httpMetrics.recordRequestEnd('GET', '/api/tasks/:id', 404, 5);
httpMetrics.recordRequestEnd('GET', '/api/tasks', 500, 100);

const snap1 = httpMetrics.getMetrics();
assert(snap1.totalRequests === 5, `Should have 5 total requests, got ${snap1.totalRequests}`);
assert(snap1.totalErrors === 2, `Should have 2 errors (404+500), got ${snap1.totalErrors}`);
assert(snap1.errorRate > 0, `Error rate should be > 0, got ${snap1.errorRate}`);
assert(snap1.routes.length === 3, `Should have 3 routes, got ${snap1.routes.length}`);
assert(snap1.averageLatencyMs > 0, `Average latency should be > 0`);
assert(snap1.latencyHistogram.length > 0, `Histogram should have buckets`);

// Check route breakdown
const getTasksRoute = snap1.routes.find(r => r.method === 'GET' && r.route === '/api/tasks');
assert(getTasksRoute !== undefined, 'Should have GET /api/tasks route');
assert(getTasksRoute!.count === 3, `GET /api/tasks should have 3 requests, got ${getTasksRoute!.count}`);
assert(getTasksRoute!.errorCount === 1, `GET /api/tasks should have 1 error, got ${getTasksRoute!.errorCount}`);
assert(getTasksRoute!.statusBreakdown[200] === 2, `Should have 2x 200 status`);
assert(getTasksRoute!.statusBreakdown[500] === 1, `Should have 1x 500 status`);

// ─── 2. Latency Histogram & Percentiles ────────────────────────────

section('2. Latency Histogram & Percentiles');

reset();
const latencies = [1, 2, 5, 10, 15, 25, 50, 75, 100, 200, 500, 1000];
for (const lat of latencies) {
  httpMetrics.recordRequestEnd('GET', '/test', 200, lat);
}

const snap2 = httpMetrics.getMetrics();
assert(snap2.totalRequests === latencies.length, `Should have ${latencies.length} requests`);
assert(snap2.p50LatencyMs > 0, `p50 should be > 0, got ${snap2.p50LatencyMs}`);
assert(snap2.p95LatencyMs >= snap2.p50LatencyMs, `p95 (${snap2.p95LatencyMs}) should be >= p50 (${snap2.p50LatencyMs})`);
assert(snap2.p99LatencyMs >= snap2.p95LatencyMs, `p99 (${snap2.p99LatencyMs}) should be >= p95 (${snap2.p95LatencyMs})`);

// Verify histogram has counts
const totalInBuckets = snap2.latencyHistogram.reduce((sum, b) => sum + b.count, 0);
assert(totalInBuckets === latencies.length, `All requests should be in buckets, got ${totalInBuckets}`);

// ─── 3. In-Flight Requests ─────────────────────────────────────────

section('3. In-Flight Requests');

reset();
httpMetrics.recordRequestStart();
httpMetrics.recordRequestStart();
httpMetrics.recordRequestStart();
assert(httpMetrics.getMetrics().inFlightRequests === 3, `Should have 3 in-flight, got ${httpMetrics.getMetrics().inFlightRequests}`);

httpMetrics.recordRequestEnd('GET', '/test', 200, 10);
assert(httpMetrics.getMetrics().inFlightRequests === 2, `Should have 2 in-flight after 1 end, got ${httpMetrics.getMetrics().inFlightRequests}`);

httpMetrics.recordRequestEnd('GET', '/test', 200, 10);
httpMetrics.recordRequestEnd('GET', '/test', 200, 10);
assert(httpMetrics.getMetrics().inFlightRequests === 0, `Should have 0 in-flight, got ${httpMetrics.getMetrics().inFlightRequests}`);

// ─── 4. Request ID Generation ──────────────────────────────────────

section('4. Request ID Generation');

const reqId1 = generateRequestId();
const reqId2 = generateRequestId();
assert(reqId1 !== reqId2, 'Request IDs should be unique');
assert(reqId1.length >= 32, `Request ID should be UUID-length, got ${reqId1.length}`);

const traceId = generateTraceId();
assert(traceId.length === 32, `Trace ID should be 32 hex chars, got ${traceId.length}`);
assert(/^[0-9a-f]{32}$/.test(traceId), `Trace ID should be valid hex`);

const spanId = generateSpanId();
assert(spanId.length === 16, `Span ID should be 16 hex chars, got ${spanId.length}`);
assert(/^[0-9a-f]{16}$/.test(spanId), `Span ID should be valid hex`);

// ─── 5. W3C Traceparent Parsing ────────────────────────────────────

section('5. W3C Traceparent Parsing');

const validTraceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
const parsed = parseTraceparent(validTraceparent);
assert(parsed !== undefined, 'Valid traceparent should parse');
assert(parsed!.traceId === '0af7651916cd43dd8448eb211c80319c', `Trace ID should match`);
assert(parsed!.spanId === 'b7ad6b7169203331', `Span ID should match`);

// Invalid traceparent
assert(parseTraceparent('invalid') === undefined, 'Invalid traceparent should return undefined');
assert(parseTraceparent(undefined) === undefined, 'Undefined traceparent should return undefined');
assert(parseTraceparent('00-short-b7ad6b7169203331-01') === undefined, 'Short trace ID should fail');

// Build traceparent
const built = buildTraceparent('0af7651916cd43dd8448eb211c80319c', 'b7ad6b7169203331');
assert(built === '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01', `Built traceparent should match`);

// ─── 6. Request Context ────────────────────────────────────────────

section('6. Request Context');

const mockReq = mockRequest({
  headers: { 'traceparent': validTraceparent, 'user-agent': 'test-agent' },
});
const ctx = extractRequestContext(mockReq);

assert(ctx.requestId.length >= 32, `Request ID should be generated`);
assert(ctx.traceId === '0af7651916cd43dd8448eb211c80319c', `Trace ID should come from header`);
assert(ctx.spanId === 'b7ad6b7169203331', `Span ID should come from header`);
assert(ctx.method === 'GET', `Method should be GET`);
assert(ctx.path === '/api/tasks', `Path should match`);
assert(ctx.startTimeMs > 0, `Start time should be set`);
assert(ctx.userAgent === 'test-agent', `User agent should match`);

// Without traceparent header
const mockReq2 = mockRequest();
const ctx2 = extractRequestContext(mockReq2);
assert(ctx2.traceId.length === 32, `Trace ID should be generated (32 hex), got ${ctx2.traceId.length}`);
assert(ctx2.spanId.length === 16, `Span ID should be generated (16 hex), got ${ctx2.spanId.length}`);

// ─── 7. AsyncLocalStorage Context Propagation ──────────────────────

section('7. AsyncLocalStorage Context Propagation');

// Outside context — should return undefined
assert(getRequestContext() === undefined, 'Outside context should return undefined');
assert(getRequestId() === 'no-request', `Outside context requestId should be 'no-request'`);
assert(getTraceId() === 'no-trace', `Outside context traceId should be 'no-trace'`);

// Inside context
const testCtx: RequestContext = {
  requestId: 'test-req-001',
  traceId: 'testtrace0123456789abcdef0123456789',
  spanId: 'testspan0123456789',
  method: 'POST',
  path: '/api/tasks',
  startTimeMs: Date.now(),
};

runWithRequestContext(testCtx, () => {
  const ctx = getRequestContext();
  assert(ctx !== undefined, 'Inside context should return context');
  assert(ctx!.requestId === 'test-req-001', `Request ID should match`);
  assert(ctx!.traceId === 'testtrace0123456789abcdef0123456789', `Trace ID should match`);
  assert(getRequestId() === 'test-req-001', `getRequestId should return context ID`);
  assert(getTraceId() === 'testtrace0123456789abcdef0123456789', `getTraceId should return context trace`);
});

// After context — should be undefined again
assert(getRequestContext() === undefined, 'After context should return undefined');

// ─── 8. Service Logger ─────────────────────────────────────────────

section('8. Service Logger');

const testLogger = new ServiceLogger();
testLogger.setLevel('WARN');

// Capture stdout/stderr
const origStdout = process.stdout.write.bind(process.stdout);
const origStderr = process.stderr.write.bind(process.stderr);
let stdoutBuf = '';
let stderrBuf = '';

process.stdout.write = ((chunk: string | Uint8Array) => { stdoutBuf += chunk.toString(); return true; }) as typeof process.stdout.write;
process.stderr.write = ((chunk: string | Uint8Array) => { stderrBuf += chunk.toString(); return true; }) as typeof process.stderr.write;

testLogger.debug('Should be filtered');
testLogger.info('Should be filtered');

process.stdout.write = origStdout;
process.stderr.write = origStderr;

assert(stdoutBuf === '', `DEBUG and INFO should be filtered at WARN level, got: "${stdoutBuf}"`);

// Test WARN goes to stdout
process.stdout.write = ((chunk: string | Uint8Array) => { stdoutBuf += chunk.toString(); return true; }) as typeof process.stdout.write;
stdoutBuf = '';
testLogger.warn('Warning message');
process.stdout.write = origStdout;

const warnLines = stdoutBuf.trim().split('\n').filter(l => l);
assert(warnLines.length === 1, `Should have 1 WARN line, got ${warnLines.length}`);
const warnEntry = JSON.parse(warnLines[0]);
assert(warnEntry.level === 'WARN', `Level should be WARN`);
assert(warnEntry.message === 'Warning message', `Message should match`);
assert(typeof warnEntry.timestamp === 'string', `Timestamp should be string`);
assert(typeof warnEntry.epochMs === 'number', `epochMs should be number`);

// Test ERROR goes to stderr
process.stderr.write = ((chunk: string | Uint8Array) => { stderrBuf += chunk.toString(); return true; }) as typeof process.stderr.write;
stderrBuf = '';
testLogger.error('Error message', { error: 'something broke' });
process.stderr.write = origStderr;

const errLines = stderrBuf.trim().split('\n').filter(l => l);
assert(errLines.length === 1, `Should have 1 ERROR line, got ${errLines.length}`);
const errEntry = JSON.parse(errLines[0]);
assert(errEntry.level === 'ERROR', `Level should be ERROR`);
assert(errEntry.error === 'something broke', `Error field should match`);

// ─── 9. Service Logger with Request Context ────────────────────────

section('9. Service Logger with Request Context');

const ctxLogger = new ServiceLogger();
ctxLogger.setLevel('DEBUG');

process.stdout.write = ((chunk: string | Uint8Array) => { stdoutBuf += chunk.toString(); return true; }) as typeof process.stdout.write;
stdoutBuf = '';

runWithRequestContext(testCtx, () => {
  ctxLogger.info('Processing request', { custom: 'value' });
});

process.stdout.write = origStdout;

const ctxLogLines = stdoutBuf.trim().split('\n').filter(l => l);
assert(ctxLogLines.length === 1, `Should have 1 log line, got ${ctxLogLines.length}`);
const ctxLogEntry = JSON.parse(ctxLogLines[0]);
assert(ctxLogEntry.requestId === 'test-req-001', `Request ID should be auto-injected, got ${ctxLogEntry.requestId}`);
assert(ctxLogEntry.traceId === 'testtrace0123456789abcdef0123456789', `Trace ID should be auto-injected`);
assert(ctxLogEntry.method === 'POST', `Method should be auto-injected`);
assert(ctxLogEntry.path === '/api/tasks', `Path should be auto-injected`);
assert(ctxLogEntry.custom === 'value', `Custom field should be preserved`);

// Outside context — no request fields
process.stdout.write = ((chunk: string | Uint8Array) => { stdoutBuf += chunk.toString(); return true; }) as typeof process.stdout.write;
stdoutBuf = '';
ctxLogger.info('Outside context message');
process.stdout.write = origStdout;

const noCtxLines = stdoutBuf.trim().split('\n').filter(l => l);
const noCtxEntry = JSON.parse(noCtxLines[0]);
assert(noCtxEntry.requestId === undefined, `Outside context should not have requestId`);
assert(noCtxEntry.traceId === undefined, `Outside context should not have traceId`);

// ─── 10. Health Check ──────────────────────────────────────────────

section('10. Health Check');

reset();
const health = buildHealthResponse('test-health-001');
assert(['healthy', 'degraded', 'unhealthy'].includes(health.status), `Status should be valid, got '${health.status}'`);
assert(health.uptime >= 0, `Uptime should be >= 0`);
assert(health.version !== '', 'Version should not be empty');
assert(health.requestId === 'test-health-001', `Request ID should match`);
assert(health.dependencies.length >= 2, `Should have at least 2 dependency checks`);
assert(health.stats.http !== undefined, `HTTP stats should be present`);
assert(health.stats.memory !== undefined, `Memory stats should be present`);
assert(health.stats.eventLoop !== undefined, `Event loop stats should be present`);

// Check dependency names
const depNames = health.dependencies.map(d => d.name);
assert(depNames.includes('task-store'), `Should check task-store dependency`);
assert(depNames.includes('intent-engine'), `Should check intent-engine dependency`);
assert(depNames.includes('memory'), `Should check memory dependency`);

// ─── 11. Health Check Express Handler ──────────────────────────────

section('11. Health Check Express Handler');

const mockReqHealth = { requestContext: { requestId: 'health-express-001' } };
const mockResHealth = mockResponse();
healthCheckHandler(mockReqHealth, mockResHealth);
assert(mockResHealth.statusCode === 200 || mockResHealth.statusCode === 503, `Health handler should set status code`);
assert(mockResHealth.body !== undefined, `Health handler should set body`);
assert(mockResHealth.body.status !== undefined, `Health response should have status`);

// Liveness handler
const mockResLive = mockResponse();
livenessHandler({}, mockResLive);
assert(mockResLive.statusCode === 200, `Liveness should return 200`);
assert(mockResLive.body.status === 'alive', `Liveness should return 'alive'`);

// Readiness handler
const mockResReady = mockResponse();
readinessHandler({ requestContext: { requestId: 'ready-001' } }, mockResReady);
assert(mockResReady.statusCode === 200 || mockResReady.statusCode === 503, `Readiness should return 200 or 503`);

// ─── 12. HTTP Tracing ──────────────────────────────────────────────

section('12. HTTP Tracing');

reset();
const traceReq = mockRequest({
  headers: { 'traceparent': validTraceparent },
});
const traceCtx = extractRequestContext(traceReq);
const spanCtx = startHttpSpan(traceReq, traceCtx);

assert(spanCtx.trace !== undefined, `Span context should have trace`);
assert(spanCtx.rootSpan !== undefined, `Span context should have root span`);
assert(spanCtx.trace.spans.size === 1, `Should have 1 span (root), got ${spanCtx.trace.spans.size}`);
assert(spanCtx.rootSpan.name === 'HTTP GET /api/tasks', `Root span name should match`);

// Create a child span
const childSpan = startChildSpan(spanCtx, 'db.query', { table: 'tasks' });
assert(childSpan !== undefined, `Child span should be created`);
assert(childSpan!.parentSpanId === spanCtx.rootSpan.spanId, `Child parent should be root span`);

// End child span
endChildSpan(spanCtx, childSpan!);
const endedChild = spanCtx.trace.spans.get(childSpan!.spanId)!;
assert(endedChild.status === 'completed', `Child span should be completed`);
assert(endedChild.durationMs !== undefined, `Child span should have duration`);

// End HTTP span
endHttpSpan(spanCtx, 200, 1024);
const endedRoot = spanCtx.trace.spans.get(spanCtx.rootSpan.spanId)!;
assert(endedRoot.status === 'completed', `Root span should be completed`);
assert(endedRoot.durationMs !== undefined, `Root span should have duration`);
assert(endedRoot.attributes['http.status_code'] === 200, `Status code should be recorded`);
assert(endedRoot.attributes['http.response_size'] === 1024, `Response size should be recorded`);

// ─── 13. HTTP Tracing — Error Status ───────────────────────────────

section('13. HTTP Tracing — Error Status');

reset();
const errReq = mockRequest({ method: 'POST', url: '/api/tasks' });
const errCtx = extractRequestContext(errReq);
const errSpanCtx = startHttpSpan(errReq, errCtx);

endHttpSpan(errSpanCtx, 500);
const errRootSpan = errSpanCtx.trace.spans.get(errSpanCtx.rootSpan.spanId)!;
assert(errRootSpan.status === 'error', `5xx should mark span as error, got '${errRootSpan.status}'`);
assert(errRootSpan.attributes['http.status_code'] === 500, `Status code should be 500`);

// ─── 14. Trace Header Injection ────────────────────────────────────

section('14. Trace Header Injection');

const injectReq = mockRequest();
const injectCtx = extractRequestContext(injectReq);
const injectRes = mockResponse();

injectTraceHeaders(injectRes, injectCtx);
assert(injectRes.headers['x-request-id'] === injectCtx.requestId, `x-request-id header should be set`);
assert(injectRes.headers['traceparent'] !== undefined, `traceparent header should be set`);
assert(injectRes.headers['traceparent'].includes(injectCtx.traceId), `traceparent should contain trace ID`);
assert(injectRes.headers['traceparent'].includes(injectCtx.spanId), `traceparent should contain span ID`);

// ─── 15. Metrics Reset ─────────────────────────────────────────────

section('15. Metrics Reset');

reset();
httpMetrics.recordRequestEnd('GET', '/test', 200, 10);
httpMetrics.recordRequestEnd('GET', '/test', 200, 20);
assert(httpMetrics.getMetrics().totalRequests === 2, `Should have 2 requests before reset`);

httpMetrics.reset();
const afterReset = httpMetrics.getMetrics();
assert(afterReset.totalRequests === 0, `Total requests should be 0 after reset`);
assert(afterReset.totalErrors === 0, `Total errors should be 0 after reset`);
assert(afterReset.routes.length === 0, `Routes should be empty after reset`);
assert(afterReset.inFlightRequests === 0, `In-flight should be 0 after reset`);

// ─── 16. Standalone HttpMetricsCollector ───────────────────────────

section('16. Standalone HttpMetricsCollector');

const standalone = new HttpMetricsCollector([1, 10, 100, 1000]);
standalone.recordRequestEnd('GET', '/test', 200, 5);
standalone.recordRequestEnd('GET', '/test', 200, 50);
standalone.recordRequestEnd('GET', '/test', 500, 500);

const standaloneSnap = standalone.getMetrics();
assert(standaloneSnap.totalRequests === 3, `Should have 3 requests`);
assert(standaloneSnap.totalErrors === 1, `Should have 1 error`);
assert(standaloneSnap.latencyHistogram.length === 4, `Should have 4 buckets`);

// ─── Summary ───────────────────────────────────────────────────────

console.log(`\n${'='.repeat(60)}`);
console.log(`M3 Observability Service-Level Tests`);
console.log(`${'='.repeat(60)}`);
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
console.log(`  Total:  ${passed + failed}`);
console.log(`  Pass Rate: ${((passed / (passed + failed)) * 100).toFixed(1)}%`);

if (failed > 0) {
  console.log(`\nFailures:`);
  failures.forEach(f => console.log(`  - ${f}`));
  process.exit(1);
} else {
  console.log(`\nAll tests passed!`);
  process.exit(0);
}
