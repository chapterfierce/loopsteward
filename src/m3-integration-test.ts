/**
 * Claw Task Service — M3 Integration Smoke Test
 *
 * Verifies that the Express server entry point correctly wires
 * observability middleware, health endpoints, metrics, and task API.
 *
 * Uses Node's built-in fetch against a live server instance.
 */

import { app, server, taskManager } from './index.js';
import { serviceLogger } from './observability/service-logger.js';

// ─── Test Framework ────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(msg);
    console.error(`FAIL: ${msg}`);
  }
}

async function fetchJson(path: string, opts?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://localhost:${(server as any).address().port}${path}`, opts);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

// ─── Tests ─────────────────────────────────────────────────────────

async function run(): Promise<void> {
  // Wait for server to be ready
  await new Promise(r => setTimeout(r, 200));

  const port = (server as any).address().port;
  const base = `http://localhost:${port}`;

  // ── 1. Health endpoint ──────────────────────────────────────────
  console.log('-- 1. Health endpoint --');
  {
    const r = await fetchJson('/health');
    assert(r.status === 200 || r.status === 503, `Health should return 200 or 503, got ${r.status}`);
    assert(r.body?.status !== undefined, 'Health body should have status');
    assert(r.body?.uptime !== undefined, 'Health body should have uptime');
    assert(r.body?.version !== undefined, 'Health body should have version');
    assert(r.body?.dependencies !== undefined, 'Health body should have dependencies');
    assert(r.body?.timestamp !== undefined, 'Health body should have timestamp');
    assert(r.body?.requestId !== undefined, 'Health body should have requestId');
  }

  // ── 2. /ready endpoint ─────────────────────────────────────────
  console.log('-- 2. /ready endpoint --');
  {
    const r = await fetchJson('/ready');
    assert(r.status === 200 || r.status === 503, `Ready should return 200 or 503, got ${r.status}`);
    assert(r.body?.timestamp !== undefined, 'Ready body should have timestamp');
  }

  // ── 3. /health/live endpoint ───────────────────────────────────
  console.log('-- 3. /health/live endpoint --');
  {
    const r = await fetchJson('/health/live');
    assert(r.status === 200, `Liveness should return 200, got ${r.status}`);
    assert(r.body?.status === 'alive', `Liveness should return 'alive', got ${r.body?.status}`);
  }

  // ── 4. /metrics endpoint ───────────────────────────────────────
  console.log('-- 4. /metrics endpoint --');
  {
    const r = await fetchJson('/metrics');
    assert(r.status === 200, `Metrics should return 200, got ${r.status}`);
    assert(r.body?.http !== undefined, 'Metrics body should have http section');
    assert(r.body?.http?.totalRequests !== undefined, 'Metrics should have totalRequests');
    assert(r.body?.http?.errorRate !== undefined, 'Metrics should have errorRate');
    assert(r.body?.timestamp !== undefined, 'Metrics should have timestamp');
  }

  // ── 5. Create a task ───────────────────────────────────────────
  console.log('-- 5. Create a task --');
  {
    const r = await fetchJson('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Test M3 task', priority: 'P1' }),
    });
    assert(r.status === 201, `Create should return 201, got ${r.status}`);
    assert(r.body?.ok === true, `Create should return ok=true`);
    assert(r.body?.task?.title === 'Test M3 task', `Task title should match`);
    assert(r.body?.task?.status === 'created', `Task status should be 'created'`);
    assert(r.body?.task?.id !== undefined, 'Task should have an id');
  }

  // ── 6. Query tasks ─────────────────────────────────────────────
  console.log('-- 6. Query tasks --');
  {
    const r = await fetchJson('/api/tasks');
    assert(r.status === 200, `Query should return 200, got ${r.status}`);
    assert(r.body?.total !== undefined, 'Query should have total');
    assert((r.body?.total ?? 0) >= 1, `Should have at least 1 task, got ${r.body?.total}`);
  }

  // ── 7. Get single task ─────────────────────────────────────────
  console.log('-- 7. Get single task --');
  {
    const list = await fetchJson('/api/tasks');
    const taskId = list.body.tasks[0].id;
    const r = await fetchJson(`/api/tasks/${taskId}`);
    assert(r.status === 200, `Get task should return 200, got ${r.status}`);
    assert(r.body?.task?.id === taskId, `Task id should match`);
  }

  // ── 8. Modify a task ───────────────────────────────────────────
  console.log('-- 8. Modify a task --');
  {
    const list = await fetchJson('/api/tasks');
    const taskId = list.body.tasks[0].id;
    const r = await fetchJson(`/api/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ priority: 'P0' }),
    });
    assert(r.status === 200, `Modify should return 200, got ${r.status}`);
    assert(r.body?.task?.priority === 'P0', `Priority should be P0, got ${r.body?.task?.priority}`);
  }

  // ── 9. Intent endpoint ─────────────────────────────────────────
  console.log('-- 9. Intent endpoint --');
  {
    const r = await fetchJson('/api/intent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '创建一个测试任务' }),
    });
    assert(r.status === 200, `Intent should return 200, got ${r.status}`);
    assert(r.body?.executed === true || r.body?.needsConfirmation === true,
      `Intent should be executed or need confirmation`);
  }

  // ── 10. Metrics after requests ─────────────────────────────────
  console.log('-- 10. Metrics after requests --');
  {
    const r = await fetchJson('/metrics');
    assert(r.body?.http?.totalRequests >= 10, `Should have ≥10 requests logged, got ${r.body?.http?.totalRequests}`);
    assert(r.body?.http?.routes?.length >= 3, `Should have ≥3 routes tracked, got ${r.body?.http?.routes?.length}`);
    assert(r.body?.http?.averageLatencyMs >= 0, `Average latency should be ≥ 0`);
  }

  // ── 11. 404 handler ────────────────────────────────────────────
  console.log('-- 11. 404 handler --');
  {
    const r = await fetchJson('/nonexistent');
    assert(r.status === 404, `Unknown route should return 404, got ${r.status}`);
    assert(r.body?.success === false, '404 body should have success=false');
  }

  // ── 12. Health check requestId in response header ──────────────
  console.log('-- 12. Request ID header --');
  {
    const res = await fetch(`${base}/health`);
    const reqId = res.headers.get('x-request-id');
    assert(reqId !== null && reqId !== '', 'x-request-id header should be set');
  }

  // ── 13. Traceparent header ─────────────────────────────────────
  console.log('-- 13. Traceparent header --');
  {
    const res = await fetch(`${base}/health`);
    const tp = res.headers.get('traceparent');
    assert(tp !== null && tp !== '', 'traceparent header should be set');
    assert(tp!.startsWith('00-'), `traceparent should start with '00-', got '${tp}'`);
  }

  // ── 14. Structured log format ──────────────────────────────────
  console.log('-- 14. Structured log format --');
  {
    // Capture a log entry by checking that serviceLogger produces JSON
    const origWrite = process.stdout.write.bind(process.stdout);
    let captured = '';
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured += chunk.toString();
      return true;
    }) as typeof process.stdout.write;

    serviceLogger.info('Test structured log', { customField: 'test123' });

    process.stdout.write = origWrite;
    const lines = captured.trim().split('\n').filter(l => l);
    assert(lines.length >= 1, 'Should produce at least 1 log line');
    const entry = JSON.parse(lines[lines.length - 1]);
    assert(entry.timestamp !== undefined, 'Log entry should have timestamp');
    assert(entry.epochMs !== undefined, 'Log entry should have epochMs');
    assert(entry.level === 'INFO', `Log entry level should be INFO, got ${entry.level}`);
    assert(entry.message === 'Test structured log', 'Log entry message should match');
    assert(entry.customField === 'test123', 'Log entry should preserve custom fields');
  }

  // ── Summary ────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(60)}`);
  console.log(`M3 Integration Smoke Test`);
  console.log(`${'='.repeat(60)}`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Total:  ${passed + failed}`);
  console.log(`  Pass Rate: ${((passed / (passed + failed)) * 100).toFixed(1)}%`);

  if (failed > 0) {
    console.log(`\nFailures:`);
    failures.forEach(f => console.log(`  - ${f}`));
  } else {
    console.log(`\nAll tests passed!`);
  }

  server.close();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Test runner crashed:', err);
  server.close();
  process.exit(1);
});
