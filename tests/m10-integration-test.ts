/**
 * Claw Task Service — M10 Integration Tests
 *
 * End-to-end integration tests for:
 *   1. HTTP API layer (health, metrics, intent classify, intent stats)
 *   2. Observability pipeline integration (tracer + metrics on every request)
 *   3. Request-id propagation through the pipeline
 *
 * Test scenarios:
 *   1. Health check endpoint returns structured status with dependencies
 *   2. Prometheus /metrics endpoint returns text/plain with standard metric names
 *   3. POST /api/v1/intent/classify classifies text and returns PipelineResult
 *   4. GET /api/v1/intent/stats returns classification metrics + cache + tracer stats
 *   5. GET /api/v1/intent/timeline returns recent classification entries
 *   6. Request-id header propagation (x-request-id on response)
 *   7. Trace context propagation (traceparent header on response)
 *   8. Error handling: POST classify without text returns 400
 *   9. Metrics increment after classification requests
 *  10. Unknown route returns 404 with structured error
 *
 * Run: npx tsx tests/m10-integration-test.ts
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

// ─── Test Harness ──────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✅ PASS — ${name}`);
  } else {
    failed++;
    failures.push(name + (detail ? ` [${detail}]` : ''));
    console.log(`  ❌ FAIL — ${name}${detail ? ` [${detail}]` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(4, 60 - title.length))}`);
}

// ─── HTTP Client Helper ────────────────────────────────────────────

const BASE_URL = 'http://localhost:3199';

interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: any;
  text: string;
}

async function http(
  method: string,
  path: string,
  body?: any,
  customHeaders?: Record<string, string>,
): Promise<HttpResponse> {
  const url = `${BASE_URL}${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...customHeaders,
  };

  const init: RequestInit = {
    method,
    headers,
  };

  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  const res = await fetch(url, init);
  const text = await res.text();
  let parsed: any = undefined;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON — that's fine for Prometheus metrics
  }

  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  return {
    status: res.status,
    headers: responseHeaders,
    body: parsed,
    text,
  };
}

// ─── Server Lifecycle ──────────────────────────────────────────────

let serverProc: ChildProcess | null = null;

async function startServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    // On Windows, use node with tsx loader directly instead of npx to avoid
    // .cmd wrapper output buffering issues.
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'node' : 'npx';
    const args = isWin
      ? ['--import', 'tsx', 'src/index.ts']
      : ['tsx', 'src/index.ts'];

    serverProc = spawn(
      cmd,
      args,
      {
        cwd: 'C:\\Users\\46927\\Desktop\\project\\claw-task-service',
        env: { ...process.env, PORT: '3199', LOG_LEVEL: 'ERROR' },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: isWin ? false : true,
      },
    );

    let started = false;
    const timeout = setTimeout(() => {
      if (!started) {
        // Last resort: try polling the health endpoint
        pollHealthEndpoint()
          .then(() => {
            started = true;
            clearTimeout(timeout);
            setTimeout(resolve, 500);
          })
          .catch(() => {
            reject(new Error('Server failed to start within 15s'));
          });
      }
    }, 15000);

    // Also try polling health endpoint early (after 2s) in case stdout is buffered
    setTimeout(() => {
      if (!started) {
        pollHealthEndpoint()
          .then(() => {
            if (!started) {
              started = true;
              clearTimeout(timeout);
              setTimeout(resolve, 500);
            }
          })
          .catch(() => {
            // server not ready yet, keep waiting
          });
      }
    }, 2000);

    serverProc.stdout?.on('data', (data: Buffer) => {
      const msg = data.toString();
      if (msg.includes('started') && !started) {
        started = true;
        clearTimeout(timeout);
        // Give the server a moment to fully settle
        setTimeout(resolve, 500);
      }
    });

    serverProc.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString();
      // Only reject on startup errors, not runtime warnings
      if (msg.includes('Error') && !started) {
        // Check if it's a fatal startup error
        if (msg.includes('EADDRINUSE') || msg.includes('Cannot find module')) {
          clearTimeout(timeout);
          reject(new Error(`Server startup error: ${msg}`));
        }
      }
    });

    serverProc.on('error', (err: Error) => {
      if (!started) {
        clearTimeout(timeout);
        reject(err);
      }
    });

    serverProc.on('exit', (code: number | null) => {
      if (!started) {
        clearTimeout(timeout);
        reject(new Error(`Server exited early with code ${code}`));
      }
    });
  });
}

/**
 * Poll the health endpoint to check if the server is ready.
 * Retries every 500ms for up to 13 attempts.
 */
async function pollHealthEndpoint(): Promise<void> {
  const maxAttempts = 26;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch('http://localhost:3199/health');
      if (res.ok) return;
    } catch {
      // server not ready
    }
    await sleep(500);
  }
  throw new Error('Health endpoint not reachable after polling');
}

async function stopServer(): Promise<void> {
  if (serverProc) {
    return new Promise((resolve) => {
      serverProc!.on('exit', () => {
        serverProc = null;
        resolve();
      });
      serverProc!.kill('SIGTERM');
      // Force kill after 5 seconds
      setTimeout(() => {
        if (serverProc) {
          serverProc.kill('SIGKILL');
          serverProc = null;
        }
        resolve();
      }, 5000);
    });
  }
}

// ─── Test Suite ────────────────────────────────────────────────────

async function runTests(): Promise<void> {
  // ── Setup: start server ──────────────────────────────────────
  console.log('\n═'.repeat(60));
  console.log('  M10 Integration Tests — HTTP API + Observability Pipeline');
  console.log('═'.repeat(60));
  console.log('\nStarting test server on port 3199...');

  try {
    await startServer();
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }

  console.log('Server started. Running tests...\n');

  // ── Test 1: Health check endpoint ────────────────────────────

  section('Test 1: GET /health — structured health status');

  {
    const res = await http('GET', '/health');
    check('status 200', res.status === 200, `got ${res.status}`);
    check('response has status field', typeof res.body?.status === 'string');
    check('status is healthy or degraded',
      res.body?.status === 'healthy' || res.body?.status === 'degraded');
    check('has uptime', typeof res.body?.uptime === 'number' && res.body.uptime >= 0);
    check('has version', typeof res.body?.version === 'string');
    check('has timestamp', typeof res.body?.timestamp === 'string');
    check('has dependencies array', Array.isArray(res.body?.dependencies));
    check('has task-store dependency',
      res.body?.dependencies?.some((d: any) => d.name === 'task-store'));
    check('has intent-engine dependency',
      res.body?.dependencies?.some((d: any) => d.name === 'intent-engine'));
    check('has memory dependency',
      res.body?.dependencies?.some((d: any) => d.name === 'memory'));
    check('has http stats', typeof res.body?.stats?.http === 'object');
    check('has memory stats', typeof res.body?.stats?.memory === 'object');
  }

  // ── Test 2: Prometheus /metrics endpoint ─────────────────────

  section('Test 2: GET /metrics — Prometheus text format');

  {
    const res = await http('GET', '/metrics');
    check('status 200', res.status === 200, `got ${res.status}`);
    check('content-type is text/plain',
      res.headers['content-type']?.includes('text/plain'));
    check('contains http_requests_total', res.text.includes('http_requests_total'));
    check('contains http_errors_total', res.text.includes('http_errors_total'));
    check('contains http_request_duration_ms', res.text.includes('http_request_duration_ms'));
    check('contains http_in_flight_requests', res.text.includes('http_in_flight_requests'));
    check('contains intent_classifications_total', res.text.includes('intent_classifications_total'));
    check('contains intent_average_confidence', res.text.includes('intent_average_confidence'));
    check('contains intent_cache_hits_total', res.text.includes('intent_cache_hits_total'));
    check('contains intent_cache_misses_total', res.text.includes('intent_cache_misses_total'));
    check('contains intent_cache_hit_rate', res.text.includes('intent_cache_hit_rate'));
    check('contains tracer_total_traces', res.text.includes('tracer_total_traces'));
    check('contains process_resident_memory_bytes', res.text.includes('process_resident_memory_bytes'));
    check('has HELP comments', res.text.includes('# HELP'));
    check('has TYPE comments', res.text.includes('# TYPE'));
  }

  // ── Test 3: POST /api/v1/intent/classify — classification ────

  section('Test 3: POST /api/v1/intent/classify — classify text');

  {
    const res = await http('POST', '/api/v1/intent/classify', {
      text: '创建登录页面开发任务，优先级P0',
    });
    check('status 200', res.status === 200, `got ${res.status}`);
    check('success true', res.body?.success === true);
    check('has requestId', typeof res.body?.requestId === 'string');
    check('has result object', typeof res.body?.result === 'object');
    check('has category', typeof res.body?.result?.category === 'string');
    check('category is create_task',
      res.body?.result?.category === 'create_task',
      `got ${res.body?.result?.category}`);
    check('has subCategory', typeof res.body?.result?.subCategory === 'string');
    check('has confidence (number)', typeof res.body?.result?.confidence === 'number');
    check('confidence >= 0', res.body?.result?.confidence >= 0);
    check('has entities array', Array.isArray(res.body?.result?.entities));
    check('has alternatives array', Array.isArray(res.body?.result?.alternatives));
    check('has recommendedAction', typeof res.body?.result?.recommendedAction === 'string');
    check('has routeHandler', typeof res.body?.result?.routeHandler === 'string');
    check('routeHandler is task.create',
      res.body?.result?.routeHandler === 'task.create');
    check('has pipelineVersion', typeof res.body?.result?.pipelineVersion === 'string');
    check('has cacheHit flag', typeof res.body?.result?.cacheHit === 'boolean');
    check('has trace metadata', typeof res.body?.trace === 'object');
    check('trace has traceId', typeof res.body?.trace?.traceId === 'string');
  }

  // ── Test 4: GET /api/v1/intent/stats — statistics ────────────

  section('Test 4: GET /api/v1/intent/stats — classification statistics');

  {
    const res = await http('GET', '/api/v1/intent/stats');
    check('status 200', res.status === 200, `got ${res.status}`);
    check('success true', res.body?.success === true);
    check('has requestId', typeof res.body?.requestId === 'string');
    check('has metrics object', typeof res.body?.metrics === 'object');
    check('metrics has totalClassifications',
      typeof res.body?.metrics?.totalClassifications === 'number');
    check('totalClassifications >= 1 (from Test 3)',
      res.body?.metrics?.totalClassifications >= 1,
      `got ${res.body?.metrics?.totalClassifications}`);
    check('metrics has categories', typeof res.body?.metrics?.categories === 'object');
    check('metrics has cache object', typeof res.body?.metrics?.cache === 'object');
    check('cache has hits', typeof res.body?.metrics?.cache?.hits === 'number');
    check('cache has misses', typeof res.body?.metrics?.cache?.misses === 'number');
    check('cache has hitRate', typeof res.body?.metrics?.cache?.hitRate === 'number');
    check('metrics has errors', typeof res.body?.metrics?.errors === 'object');
    check('has cache stats (top-level)', typeof res.body?.cache === 'object');
    check('cache stats has size', typeof res.body?.cache?.size === 'number');
    check('cache stats has capacity', typeof res.body?.cache?.capacity === 'number');
    check('has tracer stats', typeof res.body?.tracer === 'object');
    check('tracer has activeTraces',
      typeof res.body?.tracer?.activeTraces === 'number');
    check('tracer has totalTraces',
      typeof res.body?.tracer?.totalTraces === 'number');
    check('tracer has totalSpans',
      typeof res.body?.tracer?.totalSpans === 'number');
    check('tracer totalTraces >= 1',
      res.body?.tracer?.totalTraces >= 1,
      `got ${res.body?.tracer?.totalTraces}`);
  }

  // ── Test 5: GET /api/v1/intent/timeline ──────────────────────

  section('Test 5: GET /api/v1/intent/timeline — recent classifications');

  {
    const res = await http('GET', '/api/v1/intent/timeline?limit=10');
    check('status 200', res.status === 200, `got ${res.status}`);
    check('success true', res.body?.success === true);
    check('has timeline array', Array.isArray(res.body?.timeline));
    check('timeline has at least 1 entry (from Test 3)',
      res.body?.timeline?.length >= 1,
      `got ${res.body?.timeline?.length}`);
    if (res.body?.timeline?.length > 0) {
      const entry = res.body.timeline[0];
      check('entry has timestamp', typeof entry.timestamp === 'string');
      check('entry has category', typeof entry.category === 'string');
      check('entry has confidence', typeof entry.confidence === 'number');
      check('entry has latencyMs', typeof entry.latencyMs === 'number');
      check('entry has cacheHit', typeof entry.cacheHit === 'boolean');
    }
  }

  // ── Test 6: Request-id header propagation ─────────────────────

  section('Test 6: Request-id propagation (x-request-id header)');

  {
    const customRequestId = 'test-req-id-m10-12345';
    const res = await http('GET', '/health', undefined, {
      'x-custom-test': 'true',
    });
    check('response has x-request-id header',
      typeof res.headers['x-request-id'] === 'string');
    check('x-request-id is a valid UUID-like string',
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        res.headers['x-request-id'] ?? '',
      ),
      `got ${res.headers['x-request-id']}`);

    // Verify request-id appears in classify response
    const classifyRes = await http('POST', '/api/v1/intent/classify', {
      text: '查看所有任务',
    });
    check('classify response requestId matches UUID format',
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        classifyRes.body?.requestId ?? '',
      ),
      `got ${classifyRes.body?.requestId}`);
  }

  // ── Test 7: Trace context propagation (traceparent header) ────

  section('Test 7: Trace context propagation (traceparent header)');

  {
    const res = await http('GET', '/health');
    check('response has traceparent header',
      typeof res.headers['traceparent'] === 'string');
    if (res.headers['traceparent']) {
      const parts = res.headers['traceparent'].split('-');
      check('traceparent has 4 parts', parts.length >= 4);
      check('traceparent version is 00', parts[0] === '00');
      check('traceId is 32 hex chars',
        /^[0-9a-f]{32}$/.test(parts[1] ?? ''),
        `got ${parts[1]}`);
      check('spanId is 16 hex chars',
        /^[0-9a-f]{16}$/.test(parts[2] ?? ''),
        `got ${parts[2]}`);
    }
  }

  // ── Test 8: Error handling — missing text ─────────────────────

  section('Test 8: POST /api/v1/intent/classify — error handling');

  {
    // Missing text field
    const res1 = await http('POST', '/api/v1/intent/classify', {});
    check('missing text → 400', res1.status === 400, `got ${res1.status}`);
    check('error response has success false', res1.body?.success === false);
    check('error message mentions text', res1.body?.message?.includes('text'));
    check('error response has requestId',
      typeof res1.body?.requestId === 'string');

    // Non-string text
    const res2 = await http('POST', '/api/v1/intent/classify', { text: 12345 });
    check('non-string text → 400', res2.status === 400, `got ${res2.status}`);

    // Empty text
    const res3 = await http('POST', '/api/v1/intent/classify', { text: '' });
    check('empty text → 400', res3.status === 400, `got ${res3.status}`);
  }

  // ── Test 9: Metrics increment after classification ───────────

  section('Test 9: Metrics increment after classification requests');

  {
    // Get initial stats
    const before = await http('GET', '/api/v1/intent/stats');
    const beforeTotal = before.body?.metrics?.totalClassifications ?? 0;

    // Perform several classifications
    await http('POST', '/api/v1/intent/classify', { text: '创建测试任务' });
    await http('POST', '/api/v1/intent/classify', { text: '查看任务列表' });
    await http('POST', '/api/v1/intent/classify', { text: '把测试任务标记为已完成' });

    // Get updated stats
    const after = await http('GET', '/api/v1/intent/stats');
    const afterTotal = after.body?.metrics?.totalClassifications ?? 0;

    check('totalClassifications increased by >= 3',
      afterTotal - beforeTotal >= 3,
      `before=${beforeTotal}, after=${afterTotal}`);

    // Check that categories are populated
    const categories = after.body?.metrics?.categories ?? {};
    const categoryKeys = Object.keys(categories);
    check('categories has at least 1 entry', categoryKeys.length >= 1,
      `got ${categoryKeys.length}`);

    // Verify cache stats are updated
    const cacheSize = after.body?.cache?.size;
    check('cache size >= 3 (new entries)',
      cacheSize >= 3,
      `got ${cacheSize}`);
  }

  // ── Test 10: Unknown route returns 404 ────────────────────────

  section('Test 10: Unknown route returns structured 404');

  {
    const res = await http('GET', '/api/v1/nonexistent');
    check('unknown route → 404', res.status === 404, `got ${res.status}`);
    check('has success false', res.body?.success === false);
    check('message contains Route not found',
      res.body?.message?.includes('Route not found'));
  }

  // ── Test 11: Multiple classifications via pipeline with cache ──

  section('Test 11: Cache behavior — repeated classification');

  {
    // First classification (cache miss)
    const res1 = await http('POST', '/api/v1/intent/classify', {
      text: '创建缓存测试任务',
    });
    check('first call: cacheHit false',
      res1.body?.result?.cacheHit === false);

    // Second identical classification (should be cache hit)
    const res2 = await http('POST', '/api/v1/intent/classify', {
      text: '创建缓存测试任务',
    });
    check('second call: cacheHit true',
      res2.body?.result?.cacheHit === true,
      `got cacheHit=${res2.body?.result?.cacheHit}`);

    // Verify same category returned
    check('both calls return same category',
      res1.body?.result?.category === res2.body?.result?.category);

    // Verify cache stats reflect the hit
    const stats = await http('GET', '/api/v1/intent/stats');
    check('cache hits >= 1',
      stats.body?.metrics?.cache?.hits >= 1,
      `got ${stats.body?.metrics?.cache?.hits}`);
  }

  // ── Test 12: Legacy intent endpoint still works ───────────────

  section('Test 12: POST /api/intent — legacy endpoint compatibility');

  {
    const res = await http('POST', '/api/intent', {
      text: '创建兼容性测试任务',
    });
    check('legacy endpoint status 200', res.status === 200, `got ${res.status}`);
    check('has executed flag', typeof res.body?.executed === 'boolean');
    check('has intent object', typeof res.body?.intent === 'object');
    check('has routeHandler', typeof res.body?.routeHandler === 'string');
  }

  // ── Summary ──────────────────────────────────────────────────

  console.log('\n' + '═'.repeat(60));
  console.log(`  M10 Integration Tests: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log('═'.repeat(60));
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  ✗ ${f}`);
  } else {
    console.log('\n✅ All M10 integration tests passed!');
  }

  await stopServer();

  if (failed > 0) {
    process.exit(1);
  }
}

// ─── Run ───────────────────────────────────────────────────────────

runTests().catch(async (err) => {
  console.error('\nFatal error:', err);
  await stopServer();
  process.exit(1);
});
