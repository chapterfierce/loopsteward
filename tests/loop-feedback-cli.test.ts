import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LoopStore } from '../src/loops/loop-store.js';

const stores: LoopStore[] = [];

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
});

function seed(store: LoopStore, title: string, lastSeen?: string) {
  return store.saveLoop(
    {
      title,
      nextAction: `next: ${title}`,
      why: 'test',
      confidence: 0.8,
      sourceSignalIds: [`alpha:${title}`],
    },
    {
      projectDir: path.normalize('C:/work/alpha'),
      projectName: 'alpha',
      lastSeen,
    },
  ).loop;
}

function runFeedback(dbPath: string, args: string[]) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', path.join('src', 'loops', 'cli.ts'), 'feedback', '--db', dbPath, ...args],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
    },
  );
}

function runUpdate(dbPath: string, args: string[]) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', path.join('src', 'loops', 'cli.ts'), 'update', '--db', dbPath, ...args],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
    },
  );
}

describe('loops:feedback CLI', () => {
  it('writes a unique match without touching surfacing or lifecycle fields', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-feedback-cli-'));
    const dbPath = path.join(dir, 'loops.db');
    try {
      const store = new LoopStore(dbPath);
      const loop = seed(store, '补齐登录页错误提示');
      store.recordSurfaced([loop.id], '2026-11-10T10:00:00.000Z', false);
      store.close();

      const result = runFeedback(dbPath, [
        '--match', '错误提示',
        '--verdict', 'forgotten',
        '--note', '确实忘了',
      ]);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('已记录反馈：确实忘了');
      expect(result.stdout).toContain('循环状态未改动');

      const reopened = new LoopStore(dbPath);
      try {
        const persisted = reopened.getLoop(loop.id)!;
        expect(persisted.status).toBe('open');
        expect(persisted.lastSurfacedAt).toBe('2026-11-10T10:00:00.000Z');
        expect(persisted.ignoredCount).toBe(0);
        expect(reopened.getFeedbackCounts()).toEqual({ forgotten: 1, noise: 0 });
      } finally {
        reopened.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 2 on an ambiguous match and writes nothing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-feedback-cli-'));
    const dbPath = path.join(dir, 'loops.db');
    try {
      const store = new LoopStore(dbPath);
      const first = seed(store, '登录页错误提示');
      const second = seed(store, '登录页样式错位');
      store.close();

      const result = runFeedback(dbPath, ['--match', '登录页', '--verdict', 'noise']);

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('ambiguous match: 登录页');
      expect(result.stderr).toContain(first.id);
      expect(result.stderr).toContain(second.id);

      const reopened = new LoopStore(dbPath);
      try {
        expect(reopened.getFeedbackCounts()).toEqual({ forgotten: 0, noise: 0 });
        expect(reopened.getLoop(first.id)?.status).toBe('open');
        expect(reopened.getLoop(second.id)?.status).toBe('open');
      } finally {
        reopened.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 1 when nothing matches and writes nothing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-feedback-cli-'));
    const dbPath = path.join(dir, 'loops.db');
    try {
      const store = new LoopStore(dbPath);
      seed(store, '登录页错误提示');
      store.close();

      const result = runFeedback(dbPath, ['--match', '不存在', '--verdict', 'noise']);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('no active loop matches: 不存在');

      const reopened = new LoopStore(dbPath);
      try {
        expect(reopened.getFeedbackCounts()).toEqual({ forgotten: 0, noise: 0 });
      } finally {
        reopened.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not claim noise suppressed when newer evidence already exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-feedback-cli-'));
    const dbPath = path.join(dir, 'loops.db');
    try {
      const store = new LoopStore(dbPath);
      seed(store, '未来证据', '2030-01-01T00:00:00.000Z');
      store.close();

      const result = runFeedback(dbPath, ['--match', '未来证据', '--verdict', 'noise']);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('已有更新证据');
      expect(result.stdout).not.toContain('在出现新证据前不再回访');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('maps the latest digest numbers to loop ids', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-feedback-index-'));
    const dbPath = path.join(dir, 'loops.db');
    try {
      const store = new LoopStore(dbPath);
      const now = new Date().toISOString();
      store.recordProjectActivity('C:/work/alpha', 'alpha', now, 's1');
      const target = seed(store, '补齐登录页错误提示', now);
      store.close();

      const digest = spawnSync(
        process.execPath,
        ['--import', 'tsx', path.join('src', 'loops', 'cli.ts'), 'digest', '--db', dbPath, '--skill'],
        { cwd: process.cwd(), encoding: 'utf8' },
      );
      expect(digest.status).toBe(0);
      expect(digest.stdout).toContain('1. **补齐登录页错误提示**');

      const result = runFeedback(dbPath, [
        '--index', '1',
        '--verdict', 'forgotten',
        '--note', '确实忘了',
      ]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('已记录反馈：确实忘了');

      const reopened = new LoopStore(dbPath);
      try {
        const recorded = reopened.getLatestFeedback();
        expect(recorded).toHaveLength(1);
        expect(recorded[0].loopId).toBe(target.id);
      } finally {
        reopened.close();
      }

      const outOfRange = runFeedback(dbPath, ['--index', '2', '--verdict', 'noise']);
      expect(outOfRange.status).toBe(1);
      expect(outOfRange.stderr).toContain('超出范围');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('closes the loop selected by the latest digest number', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-update-index-'));
    const dbPath = path.join(dir, 'loops.db');
    try {
      const store = new LoopStore(dbPath);
      const now = new Date().toISOString();
      store.recordProjectActivity('C:/work/alpha', 'alpha', now, 's1');
      const target = seed(store, '补齐登录页错误提示', now);
      store.close();

      const digest = spawnSync(
        process.execPath,
        ['--import', 'tsx', path.join('src', 'loops', 'cli.ts'), 'digest', '--db', dbPath, '--skill'],
        { cwd: process.cwd(), encoding: 'utf8' },
      );
      expect(digest.status).toBe(0);

      const result = spawnSync(
        process.execPath,
        [
          '--import', 'tsx', path.join('src', 'loops', 'cli.ts'),
          'update', '--db', dbPath, '--index', '1',
          '--status', 'resolved', '--note', '已完成并验证',
        ],
        { cwd: process.cwd(), encoding: 'utf8' },
      );
      expect(result.status).toBe(0);

      const reopened = new LoopStore(dbPath);
      try {
        expect(reopened.getLoop(target.id)?.status).toBe('resolved');
      } finally {
        reopened.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records feedback and closes by the stable ref printed in the digest', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-feedback-ref-'));
    const dbPath = path.join(dir, 'loops.db');
    try {
      const store = new LoopStore(dbPath);
      const now = new Date().toISOString();
      store.recordProjectActivity('C:/work/alpha', 'alpha', now, 's1');
      const feedbackTarget = seed(store, '补齐登录页错误提示', now);
      const closeTarget = seed(store, '修复导出重试', now);
      store.close();

      const digest = spawnSync(
        process.execPath,
        ['--import', 'tsx', path.join('src', 'loops', 'cli.ts'), 'digest', '--db', dbPath, '--skill'],
        { cwd: process.cwd(), encoding: 'utf8' },
      );
      expect(digest.status).toBe(0);
      const lineOf = (title: string) =>
        digest.stdout.split('\n').find((line) => line.includes(title))!;
      const refOf = (title: string) => {
        const match = /\[ref ([0-9a-f]{8})\]/.exec(lineOf(title));
        expect(match, `missing ref for ${title}`).toBeTruthy();
        return match![1];
      };

      const feedback = runFeedback(dbPath, [
        '--ref', refOf('补齐登录页错误提示'),
        '--verdict', 'forgotten',
        '--note', '确实忘了',
      ]);
      expect(feedback.status).toBe(0);
      expect(feedback.stdout).toContain('已记录反馈：确实忘了');

      const closed = spawnSync(
        process.execPath,
        [
          '--import', 'tsx', path.join('src', 'loops', 'cli.ts'),
          'update', '--db', dbPath, '--ref', refOf('修复导出重试'),
          '--status', 'resolved', '--note', '已完成并验证',
        ],
        { cwd: process.cwd(), encoding: 'utf8' },
      );
      expect(closed.status).toBe(0);

      const reopened = new LoopStore(dbPath);
      try {
        expect(reopened.getLoop(feedbackTarget.id)?.status).toBe('open');
        expect(reopened.getLoop(closeTarget.id)?.status).toBe('resolved');
        expect(reopened.getFeedbackCounts()).toEqual({ forgotten: 1, noise: 0 });
      } finally {
        reopened.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 2 when a ref prefix is ambiguous', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-feedback-ref-ambiguous-'));
    const dbPath = path.join(dir, 'loops.db');
    try {
      const store = new LoopStore(dbPath);
      const db = (store as any).db;
      const insert = db.prepare(`
        INSERT INTO loops (
          id, title, next_action, why, status, confidence, project_dir, project_name,
          source_signal_ids, first_seen, last_seen, dedupe_key, ignored_count
        ) VALUES (?, ?, ?, ?, 'open', 0.8, 'C:/work/alpha', 'alpha', '[]', ?, ?, ?, 0)
      `);
      const at = new Date().toISOString();
      insert.run('loop_abcd111111111111', 'One', 'next', 'why', at, at, 'ref-one');
      insert.run('loop_abcd222222222222', 'Two', 'next', 'why', at, at, 'ref-two');
      store.close();

      const result = runFeedback(dbPath, ['--ref', 'abcd', '--verdict', 'noise']);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('ambiguous ref: abcd');

      const reopened = new LoopStore(dbPath);
      try {
        expect(reopened.getFeedbackCounts()).toEqual({ forgotten: 0, noise: 0 });
      } finally {
        reopened.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('snoozes every item in the latest digest without recording feedback', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-snooze-shown-'));
    const dbPath = path.join(dir, 'loops.db');
    try {
      const store = new LoopStore(dbPath);
      const now = new Date().toISOString();
      store.recordProjectActivity('C:/work/alpha', 'alpha', now, 's1');
      const first = seed(store, '补齐登录页错误提示', now);
      const second = seed(store, '修复导出重试', now);
      store.close();

      const digest = spawnSync(
        process.execPath,
        ['--import', 'tsx', path.join('src', 'loops', 'cli.ts'), 'digest', '--db', dbPath, '--skill'],
        { cwd: process.cwd(), encoding: 'utf8' },
      );
      expect(digest.status).toBe(0);
      expect(digest.stdout).toContain('补齐登录页错误提示');
      expect(digest.stdout).toContain('修复导出重试');

      const snooze = spawnSync(
        process.execPath,
        [
          '--import', 'tsx', path.join('src', 'loops', 'cli.ts'),
          'update', '--db', dbPath, '--shown', '--status', 'snoozed',
          '--note', '今天先别提醒',
        ],
        { cwd: process.cwd(), encoding: 'utf8' },
      );
      expect(snooze.status).toBe(0);
      expect(snooze.stdout).toContain('已暂停回访 · 2 条');
      expect(snooze.stdout).toContain('不记作噪音');

      const reopened = new LoopStore(dbPath);
      try {
        for (const id of [first.id, second.id]) {
          const loop = reopened.getLoop(id)!;
          expect(loop.status).toBe('snoozed');
          expect(Date.parse(loop.snoozeUntil!)).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
        }
        expect(reopened.getFeedbackCounts()).toEqual({ forgotten: 0, noise: 0 });
      } finally {
        reopened.close();
      }

      const next = spawnSync(
        process.execPath,
        ['--import', 'tsx', path.join('src', 'loops', 'cli.ts'), 'digest', '--db', dbPath, '--skill', '--no-mark'],
        { cwd: process.cwd(), encoding: 'utf8' },
      );
      expect(next.status).toBe(0);
      expect(next.stdout).not.toContain('补齐登录页错误提示');
      expect(next.stdout).not.toContain('修复导出重试');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('snoozes selected refs without recording feedback', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-snooze-refs-'));
    const dbPath = path.join(dir, 'loops.db');
    try {
      const store = new LoopStore(dbPath);
      const now = new Date().toISOString();
      store.recordProjectActivity('C:/work/alpha', 'alpha', now, 's1');
      const first = seed(store, '补齐登录页错误提示', now);
      const second = seed(store, '修复导出重试', now);
      const third = seed(store, '更新部署说明', now);
      store.close();

      const digest = spawnSync(
        process.execPath,
        ['--import', 'tsx', path.join('src', 'loops', 'cli.ts'), 'digest', '--db', dbPath, '--skill'],
        { cwd: process.cwd(), encoding: 'utf8' },
      );
      expect(digest.status).toBe(0);
      const refOf = (title: string) => {
        const line = digest.stdout.split('\n').find((item) => item.includes(title))!;
        const match = /\[ref ([0-9a-f]{8})\]/.exec(line);
        expect(match, `missing ref for ${title}`).toBeTruthy();
        return match![1];
      };

      const snooze = spawnSync(
        process.execPath,
        [
          '--import', 'tsx', path.join('src', 'loops', 'cli.ts'),
          'update', '--db', dbPath,
          '--refs', `${refOf('补齐登录页错误提示')},${refOf('修复导出重试')}`,
          '--status', 'snoozed', '--snooze-hours', '12',
        ],
        { cwd: process.cwd(), encoding: 'utf8' },
      );
      expect(snooze.status).toBe(0);
      expect(snooze.stdout).toContain('已暂停回访 · 2 条');
      expect(snooze.stdout).toContain('不记作噪音');

      const reopened = new LoopStore(dbPath);
      try {
        for (const id of [first.id, second.id]) {
          const loop = reopened.getLoop(id)!;
          expect(loop.status).toBe('snoozed');
          expect(Date.parse(loop.snoozeUntil!)).toBeGreaterThan(Date.now() + 11 * 60 * 60 * 1000);
        }
        expect(reopened.getLoop(third.id)?.status).toBe('open');
        expect(reopened.getFeedbackCounts()).toEqual({ forgotten: 0, noise: 0 });
      } finally {
        reopened.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes nothing when any ref in --refs is unknown', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-snooze-refs-bad-'));
    const dbPath = path.join(dir, 'loops.db');
    try {
      const store = new LoopStore(dbPath);
      const now = new Date().toISOString();
      store.recordProjectActivity('C:/work/alpha', 'alpha', now, 's1');
      const target = seed(store, '补齐登录页错误提示', now);
      store.close();

      const digest = spawnSync(
        process.execPath,
        ['--import', 'tsx', path.join('src', 'loops', 'cli.ts'), 'digest', '--db', dbPath, '--skill'],
        { cwd: process.cwd(), encoding: 'utf8' },
      );
      expect(digest.status).toBe(0);
      const match = /\[ref ([0-9a-f]{8})\]/.exec(digest.stdout);
      expect(match).toBeTruthy();

      const snooze = spawnSync(
        process.execPath,
        [
          '--import', 'tsx', path.join('src', 'loops', 'cli.ts'),
          'update', '--db', dbPath,
          '--refs', `${match![1]},zzzz`,
          '--status', 'snoozed',
        ],
        { cwd: process.cwd(), encoding: 'utf8' },
      );
      expect(snooze.status).toBe(1);
      expect(snooze.stderr).toContain('no loop matches ref: zzzz');

      const reopened = new LoopStore(dbPath);
      try {
        expect(reopened.getLoop(target.id)?.status).toBe('open');
      } finally {
        reopened.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records batch feedback for every ref atomically', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-feedback-refs-'));
    const dbPath = path.join(dir, 'loops.db');
    try {
      const store = new LoopStore(dbPath);
      const now = new Date().toISOString();
      store.recordProjectActivity('C:/work/alpha', 'alpha', now, 's1');
      const first = seed(store, '补齐登录页错误提示', now);
      const second = seed(store, '修复导出重试', now);
      const third = seed(store, '更新部署说明', now);
      store.close();

      const digest = spawnSync(
        process.execPath,
        ['--import', 'tsx', path.join('src', 'loops', 'cli.ts'), 'digest', '--db', dbPath, '--skill'],
        { cwd: process.cwd(), encoding: 'utf8' },
      );
      expect(digest.status).toBe(0);
      const refOf = (title: string) => {
        const line = digest.stdout.split('\n').find((item) => item.includes(title))!;
        const match = /\[ref ([0-9a-f]{8})\]/.exec(line);
        expect(match, `missing ref for ${title}`).toBeTruthy();
        return match![1];
      };

      const result = runFeedback(dbPath, [
        '--refs', `${refOf('补齐登录页错误提示')},${refOf('修复导出重试')}`,
        '--verdict', 'forgotten',
        '--note', '这几条都有用',
        '--json',
      ]);
      expect(result.status).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.count).toBe(2);

      const reopened = new LoopStore(dbPath);
      try {
        expect(reopened.getFeedbackCounts()).toEqual({ forgotten: 2, noise: 0 });
        expect(reopened.getLoop(first.id)?.status).toBe('open');
        expect(reopened.getLoop(second.id)?.status).toBe('open');
        expect(reopened.getLoop(third.id)?.status).toBe('open');
      } finally {
        reopened.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes no batch feedback when any ref is unknown', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-feedback-refs-bad-'));
    const dbPath = path.join(dir, 'loops.db');
    try {
      const store = new LoopStore(dbPath);
      const now = new Date().toISOString();
      store.recordProjectActivity('C:/work/alpha', 'alpha', now, 's1');
      const target = seed(store, '补齐登录页错误提示', now);
      store.close();

      const digest = spawnSync(
        process.execPath,
        ['--import', 'tsx', path.join('src', 'loops', 'cli.ts'), 'digest', '--db', dbPath, '--skill'],
        { cwd: process.cwd(), encoding: 'utf8' },
      );
      expect(digest.status).toBe(0);
      const match = /\[ref ([0-9a-f]{8})\]/.exec(digest.stdout);
      expect(match).toBeTruthy();

      const result = runFeedback(dbPath, [
        '--refs', `${match![1]},zzzz`,
        '--verdict', 'forgotten',
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('no loop matches ref: zzzz');

      const reopened = new LoopStore(dbPath);
      try {
        expect(reopened.getFeedbackCounts()).toEqual({ forgotten: 0, noise: 0 });
        expect(reopened.getLoop(target.id)?.status).toBe('open');
      } finally {
        reopened.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('closes every named ref atomically', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-close-refs-'));
    const dbPath = path.join(dir, 'loops.db');
    try {
      const store = new LoopStore(dbPath);
      const now = new Date().toISOString();
      store.recordProjectActivity('C:/work/alpha', 'alpha', now, 's1');
      const first = seed(store, '补齐登录页错误提示', now);
      const second = seed(store, '修复导出重试', now);
      const third = seed(store, '更新部署说明', now);
      store.close();

      const digest = spawnSync(
        process.execPath,
        ['--import', 'tsx', path.join('src', 'loops', 'cli.ts'), 'digest', '--db', dbPath, '--skill'],
        { cwd: process.cwd(), encoding: 'utf8' },
      );
      expect(digest.status).toBe(0);
      const refOf = (title: string) => {
        const line = digest.stdout.split('\n').find((item) => item.includes(title))!;
        const match = /\[ref ([0-9a-f]{8})\]/.exec(line);
        expect(match, `missing ref for ${title}`).toBeTruthy();
        return match![1];
      };

      const result = runUpdate(dbPath, [
        '--refs', `${refOf('补齐登录页错误提示')},${refOf('修复导出重试')}`,
        '--status', 'resolved',
        '--note', 'user confirmed done',
      ]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('# 已关闭 · 2 条');
      expect(result.stdout).toContain('不会再出现在回访里');

      const reopened = new LoopStore(dbPath);
      try {
        expect(reopened.getLoop(first.id)?.status).toBe('resolved');
        expect(reopened.getLoop(second.id)?.status).toBe('resolved');
        expect(reopened.getLoop(third.id)?.status).toBe('open');
      } finally {
        reopened.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes no batch close when any ref is unknown', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-close-refs-bad-'));
    const dbPath = path.join(dir, 'loops.db');
    try {
      const store = new LoopStore(dbPath);
      const now = new Date().toISOString();
      store.recordProjectActivity('C:/work/alpha', 'alpha', now, 's1');
      const target = seed(store, '补齐登录页错误提示', now);
      store.close();

      const digest = spawnSync(
        process.execPath,
        ['--import', 'tsx', path.join('src', 'loops', 'cli.ts'), 'digest', '--db', dbPath, '--skill'],
        { cwd: process.cwd(), encoding: 'utf8' },
      );
      expect(digest.status).toBe(0);
      const match = /\[ref ([0-9a-f]{8})\]/.exec(digest.stdout);
      expect(match).toBeTruthy();

      const result = runUpdate(dbPath, [
        '--refs', `${match![1]},zzzz`,
        '--status', 'resolved',
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('no loop matches ref: zzzz');

      const reopened = new LoopStore(dbPath);
      try {
        expect(reopened.getLoop(target.id)?.status).toBe('open');
      } finally {
        reopened.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 1 when --shown has no recent digest', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-snooze-empty-'));
    const dbPath = path.join(dir, 'loops.db');
    try {
      const store = new LoopStore(dbPath);
      store.close();
      const result = spawnSync(
        process.execPath,
        [
          '--import', 'tsx', path.join('src', 'loops', 'cli.ts'),
          'update', '--db', dbPath, '--shown', '--status', 'snoozed',
        ],
        { cwd: process.cwd(), encoding: 'utf8' },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('没有可用的最近回访');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
