import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LoopStore } from '../src/loops/loop-store.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function seedWithRole(store: LoopStore, title: string, role: 'user' | 'assistant') {
  const signalId = `sig-${title}`;
  store.saveSignal({
    id: signalId,
    source: 'session',
    sourceId: `session-${role}`,
    messageId: `msg-${title}`,
    agent: 'codex',
    role,
    text: `${role} message ${title}`,
    projectDir: 'C:/work/alpha',
    capturedAt: '2026-11-10T10:00:00.000Z',
    contentHash: `hash-${signalId}`,
  });
  return store.saveLoop(
    {
      title,
      nextAction: `next ${title}`,
      why: `why ${title}`,
      confidence: 0.9,
      sourceSignalIds: [signalId],
    },
    {
      projectDir: 'C:/work/alpha',
      projectName: 'alpha',
      firstSeen: '2026-11-10T10:00:00.000Z',
      lastSeen: '2026-11-10T10:00:00.000Z',
    },
  ).loop;
}

function runClosing(dbPath: string, args: string[]) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', path.join('src', 'loops', 'cli.ts'), 'closing', '--db', dbPath, ...args],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
}

describe('loops:closing CLI', () => {
  it('filters by origin and reports totals for every source', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-closing-cli-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'loops.db');
    const store = new LoopStore(dbPath);
    try {
      const user = seedWithRole(store, 'User task', 'user');
      const assistant = seedWithRole(store, 'Assistant follow-up', 'assistant');
      store.recordPresentation([user.id], '2026-11-10T11:00:00.000Z', 'hot', 'hot');
      store.recordPresentation([assistant.id], '2026-11-10T12:00:00.000Z', 'hot', 'hot');
    } finally {
      store.close();
    }

    const result = runClosing(dbPath, ['--origin', 'assistant', '--json']);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.origin).toBe('assistant');
    expect(parsed.total).toBe(1);
    expect(parsed.items[0].title).toBe('Assistant follow-up');
    expect(parsed.originTotals).toEqual({ user: 1, assistant: 1, mixed: 0 });

    const invalid = runClosing(dbPath, ['--origin', 'system']);
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain('--origin must be user, assistant, or mixed');
  });

  it('filters to items with completion evidence', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-closing-cli-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'loops.db');
    const store = new LoopStore(dbPath);
    try {
      const completed = seedWithRole(store, 'Completed task', 'user');
      const plain = seedWithRole(store, 'Plain task', 'user');
      store.recordPresentation([completed.id], '2026-11-10T11:00:00.000Z', 'hot', 'hot');
      store.recordPresentation([plain.id], '2026-11-10T12:00:00.000Z', 'hot', 'hot');
      store.setReconcileCache(
        'session-user',
        'hash-user',
        [{
          loopId: completed.id,
          confidence: 0.97,
          reason: '后续提交已完成',
          evidenceMessageIds: [],
        }],
        '2026-11-10T12:30:00.000Z',
      );
    } finally {
      store.close();
    }

    const result = runClosing(dbPath, ['--completion', '--json']);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.completionOnly).toBe(true);
    expect(parsed.total).toBe(1);
    expect(parsed.items[0].title).toBe('Completed task');
  });
});
