import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { LoopStore } from '../src/loops/loop-store.js';
import { runRedact } from '../src/loops/redact-cli.js';
import {
  containsSecretLikeText,
  redactSecrets,
} from '../src/loops/redact.js';
import type { LoopSignal } from '../src/loops/types.js';

const stores: LoopStore[] = [];
const tempDirs: string[] = [];

const fakeOpenAi = ['s', 'k', '-', 'test', '1234567890', 'abcdef'].join('');
const fakeBearer = ['test', 'bearer', 'token', '1234567890'].join('-');
const fakePassword = ['test', 'password', '123456'].join('-');
const fakeGithub = ['ghp', '_', 'a'.repeat(24)].join('');
const fakePrivateKey = [
  ['-----BEGIN', 'RSA', 'PRIVATE KEY-----'].join(' '),
  'test',
  ['-----END', 'RSA', 'PRIVATE KEY-----'].join(' '),
].join('\n');

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

function makeSignal(text: string): LoopSignal {
  return {
    id: 'codex:s1:m1',
    source: 'session',
    sourceId: 's1',
    messageId: 'm1',
    agent: 'codex',
    role: 'assistant',
    text,
    projectDir: 'C:/work/alpha',
    capturedAt: '2026-11-10T10:00:00.000Z',
    contentHash: 'hash-m1',
  };
}

describe('redactSecrets', () => {
  it('removes common credential shapes without touching normal prose', () => {
    const text = [
      'task-id 和 risk-level 不是密钥。',
      `key: ${fakeOpenAi}`,
      `Authorization: Bearer ${fakeBearer}`,
      `api_key: "${fakePassword}"`,
      `postgres://user:${fakePassword}@example.test/db`,
      `github ${fakeGithub}`,
    ].join('\n');
    const redacted = redactSecrets(text);

    expect(redacted).toContain('task-id');
    expect(redacted).toContain('risk-level');
    expect(redacted).not.toContain(fakeOpenAi);
    expect(redacted).not.toContain(fakeBearer);
    expect(redacted).not.toContain(fakePassword);
    expect(redacted).not.toContain(fakeGithub);
    expect(redacted).toContain('[REDACTED]');
  });

  it('redacts private key blocks and is idempotent', () => {
    const once = redactSecrets(fakePrivateKey);
    expect(once).toBe('[REDACTED PRIVATE KEY]');
    expect(redactSecrets(once)).toBe(once);
  });

  it('detects credential-like text', () => {
    expect(containsSecretLikeText(`api_key: "${fakePassword}"`)).toBe(true);
    expect(containsSecretLikeText('task-id 和 risk-level 不是密钥')).toBe(false);
  });
});

describe('LoopStore.redactStoredText', () => {
  it('redacts new signals at the write boundary', () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    store.saveSignal(makeSignal(`token: "${fakePassword}"`));

    const stored = store.getSignals(['codex:s1:m1'])[0];
    expect(stored.text).toContain('[REDACTED]');
    expect(stored.text).not.toContain(fakePassword);
  });

  it('previews and then rewrites existing signals and loop text', () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    store.saveSignal(makeSignal('plain text'));
    const loop = store.saveLoop(
      {
        title: `密钥 ${fakeOpenAi} 待处理`,
        nextAction: `轮换 token: "${fakePassword}"`,
        why: `来源泄漏，password: "${fakePassword}"`,
        confidence: 0.8,
        sourceSignalIds: ['codex:s1:m1'],
      },
      {
        projectDir: 'C:/work/alpha',
        projectName: 'alpha',
        firstSeen: '2026-11-10T10:00:00.000Z',
        lastSeen: '2026-11-10T10:00:00.000Z',
      },
    ).loop;

    const preview = store.redactStoredText(false);
    expect(preview.applied).toBe(false);
    expect(preview.signalsChanged).toBe(0);
    expect(preview.loopsChanged).toBe(1);
    expect(store.getLoop(loop.id)?.title).toContain(fakeOpenAi);

    const applied = store.redactStoredText(true);
    expect(applied.applied).toBe(true);
    expect(applied.loopsChanged).toBe(1);
    expect(store.getLoop(loop.id)?.title).not.toContain(fakeOpenAi);
    expect(store.getLoop(loop.id)?.title).toContain('sk-[REDACTED]');
    expect(store.getLoop(loop.id)?.nextAction).not.toContain(fakePassword);
    expect(store.getLoop(loop.id)?.why).not.toContain(fakePassword);
  });
});

describe('runRedact CLI', () => {
  it('previews by default, then applies with a backup', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loopsteward-redact-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'loops.db');
    const store = new LoopStore(dbPath);
    store.saveSignal(makeSignal('plain text'));
    const loop = store.saveLoop(
      {
        title: `密钥 ${fakeOpenAi} 待处理`,
        nextAction: '轮换密钥',
        why: '来源泄漏',
        confidence: 0.8,
        sourceSignalIds: ['codex:s1:m1'],
      },
      {
        projectDir: 'C:/work/alpha',
        projectName: 'alpha',
        firstSeen: '2026-11-10T10:00:00.000Z',
        lastSeen: '2026-11-10T10:00:00.000Z',
      },
    ).loop;
    store.close();

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(runRedact(['--db', dbPath, '--json'])).toBe(0);
      const preview = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
      expect(preview.applied).toBe(false);
      expect(preview.loopsChanged).toBe(1);
      expect(preview.backup).toBeUndefined();

      expect(runRedact(['--db', dbPath, '--apply', '--json'])).toBe(0);
      const applied = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
      expect(applied.applied).toBe(true);
      expect(applied.loopsChanged).toBe(1);
      expect(applied.backup).toContain('archive');

      const reopened = new LoopStore(dbPath);
      stores.push(reopened);
      expect(reopened.getLoop(loop.id)?.title).toBe('密钥 sk-[REDACTED] 待处理');
    } finally {
      log.mockRestore();
    }
  });
});
