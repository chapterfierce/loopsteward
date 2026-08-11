/**
 * Claw Task Service — WebhookService Unit Tests (M9)
 *
 * Tests:
 *   1. validateUrl() — URL format validation
 *   2. calcBackoff() — exponential backoff computation
 *   3. buildPayload() — correct structure
 *   4. send() — successful delivery with HMAC signature
 *   5. send() — retry on failure (up to 3 times)
 *   6. Delivery callback on success and failure
 *   7. Network error handling
 *   8. Custom timeout configuration
 *   9. WebhookStore CRUD + event matching
 *
 * IMPORTANT: Node.js fetch uses a Headers exotic object for the `headers`
 * field. Headers is NOT a plain object — `Object.keys()`, `in` operator,
 * and bracket access do NOT work on it. We must normalize with
 * Object.fromEntries(headers.entries()) before inspection.
 *
 * Run: npx vitest run tests/webhook.test.ts
 */

import { describe, it, expect } from 'vitest';
import { WebhookService, validateUrl } from '../src/notifications/webhook.js';
import type { WebhookConfig, WebhookDelivery } from '../src/notifications/webhook.js';

// ─── Header Normalization ───────────────────────────────────────────
//
// Node.js fetch uses a Headers exotic object for the `headers` field.
// Unlike plain objects:
//   - 'X-Claw-Signature' in headers   → false  (HasProperty checks prototype chain)
//   - headers['X-Claw-Signature']      → undefined
//   - Object.keys(headers)            → []
//   - [...headers.entries()]           → [['X-Claw-Signature', 'sha256=...']]
//
// This function normalizes the headers argument from Node.js fetch into a
// plain Record<string, string> so that standard property access works.

function normalizeHeaders(headers: Headers | Record<string, string> | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  return headers as Record<string, string>;
}

// ─── URL Validation ───────────────────────────────────────────────

describe('validateUrl() — URL format validation', () => {
  it('accepts https URL', () => {
    expect(validateUrl('https://example.com/hook')).toBe(true);
  });

  it('accepts http URL', () => {
    expect(validateUrl('http://localhost:8080/webhook')).toBe(true);
  });

  it('accepts URL with query params', () => {
    expect(validateUrl('https://example.com/hook?token=abc')).toBe(true);
  });

  it('rejects non-URL strings', () => {
    expect(validateUrl('not-a-url')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(validateUrl('')).toBe(false);
  });

  it('rejects null/undefined', () => {
    expect(validateUrl(null as unknown as string)).toBe(false);
    expect(validateUrl(undefined as unknown as string)).toBe(false);
  });

  it('rejects ftp URL', () => {
    expect(validateUrl('ftp://example.com')).toBe(false);
  });

  // prefix 'https://a.com/' = 14 chars; need 2048 - 14 = 2034
  it('accepts URL with exactly 2048 chars', () => {
    const url = 'https://a.com/' + 'x'.repeat(2034);
    expect(url.length).toBe(2048);
    expect(validateUrl(url)).toBe(true);
  });

  it('rejects URL longer than 2048 chars', () => {
    expect(validateUrl('https://a.com/' + 'x'.repeat(2049))).toBe(false);
  });
});

// ─── Backoff Calculation ──────────────────────────────────────────

describe('calcBackoff() — exponential backoff', () => {
  it('attempt 1 → base delay (1000ms)', () => {
    const svc = new WebhookService();
    expect(svc.calcBackoff(1)).toBe(1000);
  });

  it('attempt 2 → 2x base (2000ms)', () => {
    expect(new WebhookService().calcBackoff(2)).toBe(2000);
  });

  it('attempt 3 → 4x base (4000ms)', () => {
    expect(new WebhookService().calcBackoff(3)).toBe(4000);
  });

  it('attempt 4 → 8x base (capped by maxDelayMs)', () => {
    const svc = new WebhookService({ retryConfig: { maxAttempts: 10, baseDelayMs: 1000, maxDelayMs: 10000 } });
    expect(svc.calcBackoff(4)).toBe(8000);
  });

  it('base 500ms: attempt 3 → 2000ms', () => {
    const svc = new WebhookService({ retryConfig: { baseDelayMs: 500, maxAttempts: 3, maxDelayMs: 10000 } });
    expect(svc.calcBackoff(3)).toBe(2000);
  });

  it('respects maxDelayMs cap', () => {
    const svc = new WebhookService({ retryConfig: { baseDelayMs: 1000, maxAttempts: 10, maxDelayMs: 3000 } });
    expect(svc.calcBackoff(5)).toBe(3000); // 16000ms capped to 3000ms
  });
});

// ─── buildPayload ─────────────────────────────────────────────────

describe('buildPayload() — correct structure', () => {
  it('has id and id starts with evt_', () => {
    const svc = new WebhookService();
    const payload = svc.buildPayload('task.created', { task: { id: 't1', title: 'Test' } });
    expect(typeof payload.id).toBe('string');
    expect(payload.id.startsWith('evt_')).toBe(true);
  });

  it('event matches', () => {
    const svc = new WebhookService();
    expect(svc.buildPayload('task.status_changed', {}).event).toBe('task.status_changed');
  });

  it('has timestamp in ISO format', () => {
    const svc = new WebhookService();
    expect(/^\d{4}-\d{2}-\d{2}T/.test(svc.buildPayload('task.created', {}).timestamp)).toBe(true);
  });

  it('has data object with task.id', () => {
    const svc = new WebhookService();
    const payload = svc.buildPayload('task.created', { task: { id: 't1' } });
    expect(typeof payload.data).toBe('object');
    expect((payload.data['task'] as Record<string, unknown>)?.id).toBe('t1');
  });
});

// ─── HMAC Signature ─────────────────────────────────────────────

describe('HMAC signature — X-Claw-Signature header', () => {
  it('X-Claw-Signature header is present with sha256= prefix when secret is set', async () => {
    const captured: { headers: Record<string, string> }[] = [];

    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async function (_url: URL | RequestInfo, init?: RequestInit) {
      captured.push({ headers: normalizeHeaders(init?.headers) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    try {
      const svc = new WebhookService();
      await svc.send(
        {
          id: 'wh_sig_test',
          url: 'https://example.com/webhook',
          events: ['task.created'],
          secret: 'my-test-secret',
          metadata: {},
          enabled: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        undefined,
        'task.created',
        { task: { id: 't1', title: 'Hello' } },
      );

      expect(captured.length).toBe(1);
      expect('X-Claw-Signature' in captured[0].headers).toBe(true);
      expect(captured[0].headers['X-Claw-Signature'].startsWith('sha256=')).toBe(true);
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  it('X-Claw-Delivery header is present', async () => {
    const captured: { headers: Record<string, string> }[] = [];

    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async function (_url: URL | RequestInfo, init?: RequestInit) {
      captured.push({ headers: normalizeHeaders(init?.headers) });
      return new Response('{}', { status: 200 });
    };

    try {
      const svc = new WebhookService();
      await svc.send(
        {
          id: 'wh_dlv_test',
          url: 'https://example.com/webhook',
          events: ['task.created'],
          metadata: {},
          enabled: true,
          createdAt: '',
          updatedAt: '',
        },
        undefined,
        'task.created',
        { task: { id: 't1' } },
      );

      expect('X-Claw-Delivery' in captured[0].headers).toBe(true);
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  it('X-Claw-Event header matches the event type', async () => {
    const captured: { headers: Record<string, string> }[] = [];

    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async function (_url: URL | RequestInfo, init?: RequestInit) {
      captured.push({ headers: normalizeHeaders(init?.headers) });
      return new Response('{}', { status: 200 });
    };

    try {
      const svc = new WebhookService();
      await svc.send(
        {
          id: 'wh_evt_test',
          url: 'https://example.com/webhook',
          events: ['task.deleted'],
          metadata: {},
          enabled: true,
          createdAt: '',
          updatedAt: '',
        },
        undefined,
        'task.deleted',
        { task: { id: 't1' } },
      );

      expect(captured[0].headers['X-Claw-Event']).toBe('task.deleted');
      expect(captured[0].headers['Content-Type']).toBe('application/json');
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });
});

// ─── Retry Logic ─────────────────────────────────────────────────

describe('Retry logic — exponential backoff with configurable attempts', () => {
  it('retries 3 times on HTTP 500', async () => {
    const callLog: { status: number; attempt: number }[] = [];

    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async function () {
      callLog.push({ status: 500, attempt: callLog.length + 1 });
      return new Response(JSON.stringify({ error: 'server error' }), { status: 500 });
    };

    try {
      const svc = new WebhookService({
        retryConfig: { maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 200 },
      });

      const result = await svc.send(
        {
          id: 'wh_retry_test',
          url: 'https://example.com/fail',
          events: ['task.created'],
          metadata: {},
          enabled: true,
          createdAt: '',
          updatedAt: '',
        },
        undefined,
        'task.created',
        { task: { id: 't1' } },
      );

      expect(callLog.length).toBe(3);
      expect(callLog[0].attempt).toBe(1);
      expect(callLog[2].attempt).toBe(3);
      expect(result.success).toBe(false);
      expect(result.attempts).toBe(3);
      expect(result.statusCode).toBe(500);
      expect(typeof result.error).toBe('string');
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  it('delivery callback is called with failed status on retry exhaustion', async () => {
    const originalFetch = globalThis.fetch;
    const deliveryEvents: WebhookDelivery[] = [];

    (globalThis as any).fetch = async function () {
      return new Response(JSON.stringify({}), { status: 503 });
    };

    try {
      const svc = new WebhookService({
        retryConfig: { maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 200 },
        onDeliveryAttempt: (d) => { deliveryEvents.push(d); },
      });

      await svc.send(
        {
          id: 'wh_fail',
          url: 'https://example.com/fail',
          events: ['task.created'],
          metadata: {},
          enabled: true,
          createdAt: '',
          updatedAt: '',
        },
        undefined,
        'task.created',
        { task: { id: 't1' } },
      );

      expect(deliveryEvents.length).toBe(3);
      expect(deliveryEvents.every((d) => d.status === 'failed')).toBe(true);
      expect(deliveryEvents[0].attempts).toBe(1);
      expect(deliveryEvents[1].attempts).toBe(2);
      expect(deliveryEvents[2].attempts).toBe(3);
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });
});

// ─── Success Path ────────────────────────────────────────────────

describe('Successful delivery — single attempt', () => {
  it('returns success=true on 200', async () => {
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async function () {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    try {
      const svc = new WebhookService({ retryConfig: { maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 200 } });
      const result = await svc.send(
        {
          id: 'wh_ok',
          url: 'https://example.com/ok',
          events: ['task.status_changed'],
          metadata: {},
          enabled: true,
          createdAt: '',
          updatedAt: '',
        },
        undefined,
        'task.status_changed',
        { task: { id: 't2', title: 'Updated', status: 'completed' } },
      );

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(1);
      expect(result.statusCode).toBe(200);
      expect(result.error).toBeUndefined();
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  it('delivery callback is called with delivered status on success', async () => {
    const originalFetch = globalThis.fetch;
    const deliveryEvents: WebhookDelivery[] = [];

    (globalThis as any).fetch = async function () {
      return new Response(JSON.stringify({}), { status: 200 });
    };

    try {
      const svc = new WebhookService({
        retryConfig: { maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 200 },
        onDeliveryAttempt: (d) => { deliveryEvents.push(d); },
      });

      await svc.send(
        {
          id: 'wh_cb',
          url: 'https://example.com/cb',
          events: ['task.deleted'],
          metadata: {},
          enabled: true,
          createdAt: '',
          updatedAt: '',
        },
        undefined,
        'task.deleted',
        { task: { id: 't3' } },
      );

      expect(deliveryEvents.length).toBe(1);
      expect(deliveryEvents[0].event).toBe('task.deleted');
      expect(deliveryEvents[0].webhookId).toBe('wh_cb');
      expect(deliveryEvents[0].status).toBe('delivered');
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });
});

// ─── Network Error ───────────────────────────────────────────────

describe('Network error — treated as retryable failure', () => {
  it('success=false and all attempts exhausted on ECONNREFUSED', async () => {
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async function () {
      throw new Error('ECONNREFUSED');
    };

    try {
      const svc = new WebhookService({
        retryConfig: { maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 200 },
      });

      const result = await svc.send(
        {
          id: 'wh_neterr',
          url: 'https://example.com/neterr',
          events: ['task.created'],
          metadata: {},
          enabled: true,
          createdAt: '',
          updatedAt: '',
        },
        undefined,
        'task.created',
        { task: { id: 't5' } },
      );

      expect(result.success).toBe(false);
      expect(result.attempts).toBe(3);
      expect(result.error?.includes('ECONNREFUSED')).toBe(true);
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });
});

// ─── Custom Timeout ───────────────────────────────────────────────

describe('Custom timeout configuration', () => {
  it('signal is passed to fetch', async () => {
    const originalFetch = globalThis.fetch;
    let capturedSignal: AbortSignal | null = null;

    (globalThis as any).fetch = async function (_url: URL | RequestInfo, init?: RequestInit) {
      capturedSignal = init?.signal ?? null;
      return new Response(JSON.stringify({}), { status: 200 });
    };

    try {
      const svc = new WebhookService({ timeoutMs: 3000 });
      await svc.send(
        {
          id: 'wh_timeout',
          url: 'https://example.com/timeout',
          events: ['task.created'],
          metadata: {},
          enabled: true,
          createdAt: '',
          updatedAt: '',
        },
        undefined,
        'task.created',
        { task: { id: 't6' } },
      );
      expect(capturedSignal).not.toBeNull();
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });
});

// ─── WebhookStore ────────────────────────────────────────────────

describe('WebhookStore — CRUD and event matching', () => {
  it('create returns config with id, correct events, and enabled=true', async () => {
    const { WebhookStore } = await import('../src/notifications/store.js');
    const store = new WebhookStore();

    const wh = store.create({ url: 'https://a.com/hook', events: ['task.created', 'task.deleted'] });
    expect(typeof wh.id).toBe('string');
    expect(wh.events.length).toBe(2);
    expect(wh.enabled).toBe(true);
    expect(JSON.stringify(wh.metadata)).toBe('{}');
  });

  it('getById returns object without secret', async () => {
    const { WebhookStore } = await import('../src/notifications/store.js');
    const store = new WebhookStore();
    const wh = store.create({ url: 'https://a.com/hook', events: ['task.created'] });
    const fetched = store.getById(wh.id);
    expect(typeof fetched).toBe('object');
    expect(!('secret' in (fetched ?? {}))).toBe(true);
  });

  it('getByIdWithSecret includes secret when set', async () => {
    const { WebhookStore } = await import('../src/notifications/store.js');
    const store = new WebhookStore();
    const wh = store.create({ url: 'https://b.com/hook', events: ['task.created'], secret: 'topsecret' });
    const full = store.getByIdWithSecret(wh.id);
    expect(full?.secret).toBe('topsecret');
  });

  it('list returns all webhooks without secrets', async () => {
    const { WebhookStore } = await import('../src/notifications/store.js');
    const store = new WebhookStore();
    store.create({ url: 'https://a.com/h1', events: ['task.created'] });
    store.create({ url: 'https://b.com/h2', events: ['task.created'] });
    const all = store.list();
    expect(all.length).toBe(2);
    expect(!all.some((w: any) => 'secret' in w)).toBe(true);
  });

  it('findByEvent returns subscribed enabled webhooks', async () => {
    const { WebhookStore } = await import('../src/notifications/store.js');
    const store = new WebhookStore();
    store.create({ url: 'https://a.com/hook', events: ['task.created'] });
    const byEvent = store.findByEvent('task.created');
    expect(byEvent.length).toBe(1);
    expect(byEvent.every((w) => w.enabled)).toBe(true);
  });

  it('update changes fields and findByEvent reflects changes', async () => {
    const { WebhookStore } = await import('../src/notifications/store.js');
    const store = new WebhookStore();
    const wh = store.create({ url: 'https://a.com/hook', events: ['task.created'] });

    const updated = store.update(wh.id, { enabled: false });
    expect(updated?.enabled).toBe(false);
    expect(store.findByEvent('task.created').length).toBe(0);
  });

  it('delete returns true and removes webhook', async () => {
    const { WebhookStore } = await import('../src/notifications/store.js');
    const store = new WebhookStore();
    const wh = store.create({ url: 'https://a.com/hook', events: ['task.created'] });
    expect(store.delete(wh.id)).toBe(true);
    expect(store.delete('non-existent')).toBe(false);
    expect(store.list().length).toBe(0);
  });

  it('count returns total and enabled counts', async () => {
    const { WebhookStore } = await import('../src/notifications/store.js');
    const store = new WebhookStore();
    store.create({ url: 'https://a.com/h1', events: ['task.created'] });
    const wh2 = store.create({ url: 'https://b.com/h2', events: ['task.created'] });
    store.update(wh2.id, { enabled: false });
    const cnt = store.count();
    expect(cnt.total).toBe(2);
    expect(cnt.enabled).toBe(1);
  });

  it('create throws on invalid URL', async () => {
    const { WebhookStore } = await import('../src/notifications/store.js');
    const store = new WebhookStore();
    expect(() => store.create({ url: 'ftp://bad.com', events: ['task.created'] })).toThrow();
  });

  it('create throws on empty events', async () => {
    const { WebhookStore } = await import('../src/notifications/store.js');
    const store = new WebhookStore();
    expect(() => store.create({ url: 'https://ok.com', events: [] })).toThrow();
  });

  it('recordDelivery and getDeliveries track delivery history', async () => {
    const { WebhookStore } = await import('../src/notifications/store.js');
    const store = new WebhookStore();
    const wh = store.create({ url: 'https://a.com/hook', events: ['task.created'] });

    store.recordDelivery({
      id: 'dlv_001',
      webhookId: wh.id,
      event: 'task.created',
      payload: { id: 'e1', event: 'task.created', timestamp: new Date().toISOString(), data: {} },
      status: 'delivered',
      attempts: 1,
      responseCode: 200,
      lastAttemptAt: new Date().toISOString(),
    });

    const deliveries = store.getDeliveries(wh.id);
    expect(deliveries.length).toBe(1);
    expect(deliveries[0].status).toBe('delivered');
  });
});
