import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { LoopStore } from '../src/loops/loop-store.js';
import { recordLoopFeedback } from '../src/loops/feedback.js';
import { buildLoopStats, formatLoopStats } from '../src/loops/stats.js';

const stores: LoopStore[] = [];

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
});

function openStore(): LoopStore {
  const store = new LoopStore(':memory:');
  stores.push(store);
  return store;
}

function seed(store: LoopStore, title: string, project = 'alpha') {
  return store.saveLoop(
    {
      title,
      nextAction: `next: ${title}`,
      why: 'test',
      confidence: 0.8,
      sourceSignalIds: [`${project}:${title}`],
    },
    {
      projectDir: path.normalize(`C:/work/${project}`),
      projectName: project,
    },
  ).loop;
}

describe('loop feedback', () => {
  it('records a unique match without changing the loop lifecycle', () => {
    const store = openStore();
    const target = seed(store, '补齐登录页错误提示');
    seed(store, '修复导出重试');

    const result = recordLoopFeedback(store, {
      match: '错误提示',
      verdict: 'forgotten',
      note: '确实忘了',
    });

    expect(result.status).toBe('recorded');
    if (result.status !== 'recorded') throw new Error('expected recorded feedback');
    expect(result.loop.id).toBe(target.id);
    expect(result.feedback).toMatchObject({
      loopId: target.id,
      verdict: 'forgotten',
      note: '确实忘了',
    });
    expect(store.getLoop(target.id)?.status).toBe('open');
    expect(store.getFeedbackCounts()).toEqual({ forgotten: 1, noise: 0 });
  });

  it('does not write feedback when the title match is ambiguous', () => {
    const store = openStore();
    seed(store, '登录页错误提示');
    seed(store, '登录页样式错位');

    const result = recordLoopFeedback(store, {
      match: '登录页',
      verdict: 'noise',
    });

    expect(result.status).toBe('ambiguous');
    if (result.status !== 'ambiguous') throw new Error('expected ambiguous match');
    expect(result.matches).toHaveLength(2);
    expect(store.getFeedbackCounts()).toEqual({ forgotten: 0, noise: 0 });
  });

  it('does not write feedback when nothing matches', () => {
    const store = openStore();
    seed(store, '登录页错误提示');

    const result = recordLoopFeedback(store, {
      match: '不存在的标题',
      verdict: 'noise',
    });

    expect(result.status).toBe('not_found');
    expect(store.getFeedbackCounts()).toEqual({ forgotten: 0, noise: 0 });
  });

  it('reports a null useful rate when there are no feedback samples', () => {
    const store = openStore();
    seed(store, '尚未反馈');

    const stats = buildLoopStats({ store });

    expect(stats.feedback).toEqual({
      forgotten: 0,
      noise: 0,
      usefulRate: null,
      forgottenInWindow: 0,
      noiseInWindow: 0,
      usefulRateInWindow: null,
    });
    const output = formatLoopStats(stats);
    expect(output).toContain('历史反馈：确实忘了 0 条 / 噪音 0 条；有效率 n/a（暂无反馈样本）');
    expect(output).not.toContain('历史反馈：确实忘了 0 条 / 噪音 0 条；有效率 0%');
  });

  it('computes the useful rate from forgotten and noise samples', () => {
    const store = openStore();
    const usefulA = seed(store, '有用 A');
    const usefulB = seed(store, '有用 B');
    const noisy = seed(store, '噪音 C');

    store.recordFeedback(usefulA.id, 'forgotten');
    store.recordFeedback(usefulB.id, 'forgotten');
    store.recordFeedback(noisy.id, 'noise');

    const stats = buildLoopStats({ store });

    expect(stats.feedback.forgotten).toBe(2);
    expect(stats.feedback.noise).toBe(1);
    expect(stats.feedback.usefulRate).toBeCloseTo(2 / 3);
    expect(formatLoopStats(stats)).toContain('历史反馈：确实忘了 2 条 / 噪音 1 条；有效率 67%');
  });

  it('returns the latest feedback for a loop', () => {
    const store = openStore();
    const loop = seed(store, '需要判断的循环');
    store.recordFeedback(loop.id, 'noise', '第一次是误报', '2026-11-11T18:00:00+08:00');
    store.recordFeedback(loop.id, 'forgotten', '第二次确认忘了', '2026-11-11T11:00:00Z');

    expect(store.getLatestFeedbackForLoop(loop.id)).toMatchObject({
      loopId: loop.id,
      verdict: 'forgotten',
      note: '第二次确认忘了',
      createdAt: '2026-11-11T11:00:00.000Z',
    });
    expect(store.getLatestFeedback()).toHaveLength(1);
  });

  it('creates the feedback table when upgrading a pre-M18 database', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-feedback-migration-'));
    const dbPath = path.join(dir, 'loops.db');
    try {
      const first = new LoopStore(dbPath);
      const loop = seed(first, '升级前的循环');
      (first as any).db.exec('DROP TABLE loop_feedback');
      first.close();

      const upgraded = new LoopStore(dbPath);
      try {
        expect(upgraded.recordFeedback(loop.id, 'forgotten')).toMatchObject({
          loopId: loop.id,
          verdict: 'forgotten',
        });
        expect(upgraded.getFeedbackCounts()).toEqual({ forgotten: 1, noise: 0 });
      } finally {
        upgraded.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns an ambiguous match before waiting for a write lock', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-feedback-lock-'));
    const dbPath = path.join(dir, 'loops.db');
    try {
      const store = new LoopStore(dbPath);
      seed(store, '登录页错误提示');
      seed(store, '登录页样式错位');

      const req = createRequire(import.meta.url);
      const { DatabaseSync } = req('node:sqlite') as {
        DatabaseSync: new (file: string) => any;
      };
      const writer = new DatabaseSync(dbPath);
      writer.exec('PRAGMA busy_timeout = 200;');
      writer.exec('BEGIN IMMEDIATE;');
      try {
        const result = recordLoopFeedback(store, {
          match: '登录页',
          verdict: 'noise',
        });
        expect(result.status).toBe('ambiguous');
      } finally {
        writer.exec('ROLLBACK;');
        writer.close();
        store.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
