/**
 * Claw Task Service — M10 API Observability E2E Tests
 *
 * Boots the real Express app (src/index.ts) in-process and verifies:
 *   1. GET /metrics serves Prometheus text format with core metric families
 *   2. Metrics counters increment after real API traffic
 *      (request count, per-route counters, latency histogram, errors)
 *   3. Task lifecycle counters (task_created_total, status changes)
 *   4. Webhook delivery counters (dispatches + per-status deliveries) with a
 *      real local receiver verifying the delivered payload
 *   5. Request access-log middleware records method/path/status/duration
 *   6. Correlation headers (x-request-id / traceparent) on responses
 *
 * Run: npx vitest run tests/observability.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
// Type-only import — does NOT load the module at runtime, so the
// serviceLogger singleton is constructed only after LOG_LEVEL is set.
import type { ServiceLogger } from '../src/observability/service-logger.js';

// ─── Ports ──────────────────────────────────────────────────────────

const SERVER_PORT = 3210;
const MOCK_PORT = 3211;
const BASE_URL = `http://127.0.0.1:${SERVER_PORT}`;

// ─── Prometheus Text Parsers ───────────────────────────────────────

function parseCounter(text: string, name: string): number {
  const m = text.match(new RegExp(`^${name} ([0-9.]+)$`, 'm'));
  return m ? parseFloat(m[1]) : 0;
}

function parseLabeledCounter(text: string, name: string, labels: Record<string, string>): number {
  const labelStr = Object.entries(labels)
    .map(([k, v]) => `${k}="${v}"`)
    .join(',');
  const m = text.match(new RegExp(`^${name}\\{${labelStr}\\} ([0-9.]+)$`, 'm'));
  return m ? parseFloat(m[1]) : 0;
}

/** Sum all bucket counts of a histogram family (buckets are exclusive here). */
function sumHistogram(text: string, name: string): number {
  let total = 0;
  for (const m of text.matchAll(new RegExp(`^${name}\\{[^}]*\\} ([0-9.]+)$`, 'gm'))) {
    total += parseFloat(m[1]);
  }
  return total;
}

// ─── HTTP Helpers ──────────────────────────────────────────────────

async function getMetricsText(): Promise<string> {
  const res = await fetch(`${BASE_URL}/metrics`);
  expect(res.status).toBe(200);
  return res.text();
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ─── Server / Mock Receiver Lifecycle ──────────────────────────────

let server: Server | undefined;
let mockReceiver: Server | undefined;
let serviceLogger: ServiceLogger | undefined;
const receivedDeliveries: { event: string | undefined; body: unknown }[] = [];

async function pollHealth(): Promise<void> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('Server did not become healthy in time');
}

beforeAll(async () => {
  process.env['PORT'] = String(SERVER_PORT);
  process.env['LOG_LEVEL'] = 'ERROR';

  // Load the logger singleton now that LOG_LEVEL is pinned (INFO/WARN
  // access logs stay out of the test output; the spy still captures calls).
  const loggerMod = await import('../src/observability/service-logger.js');
  serviceLogger = loggerMod.serviceLogger;

  // Start the real app (src/index.ts listens at import time).
  const mod = await import('../src/index.js');
  server = mod.server as Server;

  // Wait for the listener to accept traffic.
  await pollHealth();

  // Local webhook receiver — records deliveries so we can verify them.
  mockReceiver = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      let parsed: unknown = undefined;
      try { parsed = JSON.parse(body); } catch { parsed = body; }
      receivedDeliveries.push({ event: req.headers['x-claw-event'] as string | undefined, body: parsed });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => mockReceiver!.listen(MOCK_PORT, '127.0.0.1', resolve));
});

afterAll(async () => {
  if (mockReceiver) {
    await new Promise<void>((resolve) => {
      mockReceiver!.close(() => resolve());
      setTimeout(resolve, 2000).unref?.();
    });
    mockReceiver = undefined;
  }
  if (server) {
    await new Promise<void>((resolve) => {
      server!.close(() => resolve());
      server!.closeIdleConnections?.();
      setTimeout(resolve, 3000).unref?.();
    });
    server = undefined;
  }
});

// ─── Tests ──────────────────────────────────────────────────────────

describe('M10 API observability E2E', () => {
  it('GET /metrics serves Prometheus text format with core metric families', async () => {
    const res = await fetch(`${BASE_URL}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');

    const text = await res.text();
    // HTTP metrics
    expect(text).toContain('# TYPE http_requests_total counter');
    expect(text).toContain('# TYPE http_errors_total counter');
    expect(text).toContain('# TYPE http_route_requests_total counter');
    expect(text).toContain('# TYPE http_request_duration_bucket histogram');
    // Task lifecycle metrics
    expect(text).toContain('# TYPE task_created_total counter');
    expect(text).toContain('# TYPE task_archived_total counter');
    expect(text).toContain('# TYPE task_status_changes_total counter');
    // Webhook delivery metrics
    expect(text).toContain('# TYPE webhook_dispatches_total counter');
    expect(text).toContain('# TYPE webhook_deliveries_total counter');
  });

  it('metrics counters increment after real API traffic', async () => {
    const before = await getMetricsText();
    const beforeTotal = parseCounter(before, 'http_requests_total');

    // Traffic: list, create, get by id, lifecycle, intent stats, 404
    await fetch(`${BASE_URL}/api/tasks`);
    const createRes = await postJson('/api/tasks', { title: 'observability e2e task' });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { task: { id: string } };
    await fetch(`${BASE_URL}/api/tasks/${created.task.id}`);
    await fetch(`${BASE_URL}/api/tasks/${created.task.id}/lifecycle`);
    await fetch(`${BASE_URL}/api/v1/intent/stats`);
    const notFound = await fetch(`${BASE_URL}/no-such-route`);
    expect(notFound.status).toBe(404);

    const after = await getMetricsText();
    const afterTotal = parseCounter(after, 'http_requests_total');
    expect(afterTotal).toBeGreaterThanOrEqual(beforeTotal + 6);

    // Per-route counter for the list endpoint
    expect(parseLabeledCounter(after, 'http_route_requests_total', { method: 'GET', route: '/api/tasks' }))
      .toBeGreaterThanOrEqual(1);

    // Latency histogram recorded every request (buckets are exclusive,
    // so the sum across buckets equals the recorded request count)
    expect(sumHistogram(after, 'http_request_duration_bucket')).toBeGreaterThanOrEqual(6);

    // 404 counted as an error
    expect(parseCounter(after, 'http_errors_total')).toBeGreaterThanOrEqual(1);

    // Task lifecycle counters reflect the created task
    expect(parseCounter(after, 'task_created_total')).toBeGreaterThanOrEqual(1);
  });

  it('task lifecycle counters track creation and status transitions', async () => {
    const before = await getMetricsText();
    const beforeCreated = parseCounter(before, 'task_created_total');
    const beforeCreatedAssigned = parseLabeledCounter(before, 'task_status_changes_total', { from: 'created', to: 'assigned' });
    const beforeAssignedInProgress = parseLabeledCounter(before, 'task_status_changes_total', { from: 'assigned', to: 'in_progress' });

    // Create a task, then move it created → in_progress (auto-advances via assigned)
    const createRes = await postJson('/api/tasks', { title: 'lifecycle counter task' });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { task: { id: string } };

    const patchRes = await fetch(`${BASE_URL}/api/tasks/${created.task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'in_progress' }),
    });
    expect(patchRes.status).toBe(200);

    const after = await getMetricsText();
    expect(parseCounter(after, 'task_created_total')).toBeGreaterThanOrEqual(beforeCreated + 1);
    // The status path created → assigned → in_progress is fully captured
    expect(parseLabeledCounter(after, 'task_status_changes_total', { from: 'created', to: 'assigned' }))
      .toBeGreaterThanOrEqual(beforeCreatedAssigned + 1);
    expect(parseLabeledCounter(after, 'task_status_changes_total', { from: 'assigned', to: 'in_progress' }))
      .toBeGreaterThanOrEqual(beforeAssignedInProgress + 1);
  });

  it('webhook dispatch + delivery metrics track real deliveries to a receiver', async () => {
    const before = await getMetricsText();
    const beforeDispatches = parseCounter(before, 'webhook_dispatches_total');
    const beforeDelivered = parseLabeledCounter(before, 'webhook_deliveries_total', { status: 'delivered' });

    // Register a webhook pointing at the in-process receiver
    const whRes = await postJson('/api/v1/webhooks', {
      url: `http://127.0.0.1:${MOCK_PORT}/hook`,
      events: ['task.created'],
      secret: 'e2e-secret',
    });
    expect(whRes.status).toBe(201);

    // Create a task → dispatch('task.created') fires asynchronously
    const createRes = await postJson('/api/tasks', { title: 'webhook metric task' });
    expect(createRes.status).toBe(201);

    // The dispatch counter increments synchronously at call time
    const syncMetrics = await getMetricsText();
    expect(parseCounter(syncMetrics, 'webhook_dispatches_total')).toBeGreaterThanOrEqual(beforeDispatches + 1);

    // Poll until the receiver confirms a delivered attempt
    let delivered = 0;
    for (let i = 0; i < 50; i++) {
      const text = await getMetricsText();
      delivered = parseLabeledCounter(text, 'webhook_deliveries_total', { status: 'delivered' });
      if (delivered >= beforeDelivered + 1) break;
      await sleep(100);
    }
    expect(delivered).toBeGreaterThanOrEqual(beforeDelivered + 1);

    // Receiver actually got the delivery with the right event + payload
    const delivery = receivedDeliveries.find((d) => d.event === 'task.created');
    expect(delivery).toBeDefined();
    const payload = delivery!.body as { event?: string; data?: { task?: { title?: string } } };
    expect(payload.event).toBe('task.created');
    expect(payload.data?.task?.title).toBe('webhook metric task');
  });

  it('request access-log middleware records method/path/status/duration', async () => {
    const spy = vi.spyOn(serviceLogger!, 'request').mockImplementation(() => {});
    try {
      const okRes = await fetch(`${BASE_URL}/api/tasks`);
      expect(okRes.status).toBe(200);

      const missing = await fetch(`${BASE_URL}/api/tasks/nonexistent-id-999`);
      expect(missing.status).toBe(404);

      const calls = spy.mock.calls;

      // 200 entry: GET /api/tasks with status 200 + numeric duration
      const okEntry = calls.find((c) => c[1].method === 'GET' && c[1].path === '/api/tasks' && c[2] === 200);
      expect(okEntry).toBeDefined();
      expect(okEntry![0]).toBe('HTTP request completed');
      expect(typeof okEntry![3]).toBe('number');
      expect(okEntry![3]).toBeGreaterThanOrEqual(0);
      expect(okEntry![1].requestId).toBeTruthy();
      expect(okEntry![1].traceId).toBeTruthy();

      // 404 entry: correct status + raw path captured
      const notFoundEntry = calls.find(
        (c) => c[1].method === 'GET' && c[1].path === '/api/tasks/nonexistent-id-999' && c[2] === 404,
      );
      expect(notFoundEntry).toBeDefined();
      expect(typeof notFoundEntry![3]).toBe('number');
    } finally {
      spy.mockRestore();
    }
  });

  it('responses carry x-request-id and traceparent correlation headers', async () => {
    const res = await fetch(`${BASE_URL}/api/tasks`);
    const requestId = res.headers.get('x-request-id');
    expect(requestId).toBeTruthy();
    expect(String(requestId).length).toBeGreaterThan(0);

    const traceparent = res.headers.get('traceparent');
    expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });
});
