import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { LoopStore } from '../src/loops/loop-store.js';
import { buildDigest } from '../src/loops/digest.js';
import type { LoopSignal } from '../src/loops/types.js';

const stores: LoopStore[] = [];

function openStore(): LoopStore {
  const store = new LoopStore(':memory:');
  stores.push(store);
  return store;
}

function makeSignal(overrides: Partial<LoopSignal> = {}): LoopSignal {
  return {
    id: 'codex:session-1:m1',
    source: 'session',
    sourceId: 'session-1',
    messageId: 'm1',
    agent: 'codex',
    role: 'user',
    text: '登录页还差错误提示没做',
    projectDir: 'C:/work/alpha',
    capturedAt: '2026-11-10T10:00:00.000Z',
    contentHash: 'hash-m1',
    ...overrides,
  };
}

function insertBulkLoops(store: LoopStore, titles: string[]): void {
  const db = (store as any).db;
  const insert = db.prepare(`
    INSERT INTO loops (
      id, title, next_action, why, status, confidence, project_dir, project_name,
      source_signal_ids, first_seen, last_seen, dedupe_key, ignored_count
    ) VALUES (?, ?, ?, ?, 'open', 0.8, 'C:/work/bulk', 'bulk', '[]', ?, ?, ?, 0)
  `);
  const at = '2026-11-10T10:00:00.000Z';
  db.exec('BEGIN;');
  try {
    titles.forEach((title, index) => {
      insert.run(`loop_bulk_${index}`, title, `next ${title}`, 'bulk', at, at, `dedupe_bulk_${index}`);
    });
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
}

function makeLoop(store: LoopStore, title: string, lastSeen = '2026-11-10T10:00:00.000Z') {
  return store.saveLoop(
    {
      title,
      nextAction: `next: ${title}`,
      why: 'test',
      confidence: 0.8,
      sourceSignalIds: [`alpha:${title}`],
    },
    {
      projectDir: 'C:/work/alpha',
      projectName: 'alpha',
      lastSeen,
    },
  ).loop;
}

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
});

describe('LoopStore', () => {
  it('stores a signal once and reports duplicates', () => {
    const store = openStore();
    expect(store.saveSignal(makeSignal())).toBe(true);
    expect(store.saveSignal(makeSignal())).toBe(false);
    expect(store.getSignals(['codex:session-1:m1'])).toHaveLength(1);
  });

  it('keeps the newest message timestamp and upgrades a session fallback', () => {
    const store = openStore();
    const fallback = makeSignal({
      id: 'codex:session-1:dup',
      capturedAt: '2026-11-12T10:00:00.000Z',
      capturedAtSource: 'session',
    });
    store.saveSignal(fallback);
    store.saveSignal({
      ...fallback,
      capturedAt: '2026-11-10T10:00:00.000Z',
      capturedAtSource: 'message',
    });
    expect(store.getSignals(['codex:session-1:dup'])[0]).toMatchObject({
      capturedAt: '2026-11-10T10:00:00.000Z',
      capturedAtSource: 'message',
    });

    store.saveSignal({
      ...fallback,
      capturedAt: '2026-11-11T10:00:00.000Z',
      capturedAtSource: 'message',
    });
    expect(store.getSignals(['codex:session-1:dup'])[0].capturedAt)
      .toBe('2026-11-11T10:00:00.000Z');

    store.saveSignal(fallback);
    expect(store.getSignals(['codex:session-1:dup'])[0].capturedAt)
      .toBe('2026-11-11T10:00:00.000Z');
  });

  it('recomputes loop range when a session fallback signal is upgraded', () => {
    const store = openStore();
    store.saveSignal(makeSignal({
      id: 'codex:session-1:upgrade-old',
      messageId: 'm9',
      capturedAt: '2026-11-12T12:00:00.000Z',
      capturedAtSource: 'session',
    }));
    const older = store.saveLoop(
      {
        title: '兜底升级为更早真实时间',
        nextAction: '重算',
        why: '测试升级',
        confidence: 0.8,
        sourceSignalIds: ['codex:session-1:upgrade-old'],
      },
      {
        projectDir: 'C:/work/alpha',
        projectName: 'alpha',
        firstSeen: '2026-11-12T12:00:00.000Z',
        lastSeen: '2026-11-12T12:00:00.000Z',
        firstSeenIsFallback: true,
        lastSeenIsFallback: true,
      },
    ).loop;
    store.saveSignal(makeSignal({
      id: 'codex:session-1:upgrade-old',
      messageId: 'm9',
      capturedAt: '2026-11-10T10:00:00.000Z',
      capturedAtSource: 'message',
    }));
    const corrected = store.saveLoop(
      {
        title: '兜底升级为更早真实时间',
        nextAction: '重算',
        why: '测试升级',
        confidence: 0.8,
        sourceSignalIds: ['codex:session-1:upgrade-old'],
      },
      {
        projectDir: 'C:/work/alpha',
        projectName: 'alpha',
        firstSeen: '2026-11-10T10:00:00.000Z',
        lastSeen: '2026-11-10T10:00:00.000Z',
      },
    ).loop;
    expect(corrected.id).toBe(older.id);
    expect(corrected.firstSeen).toBe('2026-11-10T10:00:00.000Z');
    expect(corrected.lastSeen).toBe('2026-11-10T10:00:00.000Z');

    store.saveSignal(makeSignal({
      id: 'codex:session-1:upgrade-new',
      messageId: 'm10',
      capturedAt: '2026-11-09T10:00:00.000Z',
      capturedAtSource: 'session',
    }));
    const newer = store.saveLoop(
      {
        title: '兜底升级为更晚真实时间',
        nextAction: '重算',
        why: '测试升级',
        confidence: 0.8,
        sourceSignalIds: ['codex:session-1:upgrade-new'],
      },
      {
        projectDir: 'C:/work/beta',
        projectName: 'beta',
        firstSeen: '2026-11-09T10:00:00.000Z',
        lastSeen: '2026-11-09T10:00:00.000Z',
        firstSeenIsFallback: true,
        lastSeenIsFallback: true,
      },
    ).loop;
    store.saveSignal(makeSignal({
      id: 'codex:session-1:upgrade-new',
      messageId: 'm10',
      capturedAt: '2026-11-13T10:00:00.000Z',
      capturedAtSource: 'message',
    }));
    const correctedNewer = store.saveLoop(
      {
        title: '兜底升级为更晚真实时间',
        nextAction: '重算',
        why: '测试升级',
        confidence: 0.8,
        sourceSignalIds: ['codex:session-1:upgrade-new'],
      },
      {
        projectDir: 'C:/work/beta',
        projectName: 'beta',
        firstSeen: '2026-11-13T10:00:00.000Z',
        lastSeen: '2026-11-13T10:00:00.000Z',
      },
    ).loop;
    expect(correctedNewer.id).toBe(newer.id);
    expect(correctedNewer.firstSeen).toBe('2026-11-13T10:00:00.000Z');
    expect(correctedNewer.lastSeen).toBe('2026-11-13T10:00:00.000Z');
  });

  it('creates an open loop for high confidence and merges the same normalized title', () => {
    const store = openStore();
    const first = store.saveLoop(
      {
        title: '补齐登录页错误提示',
        nextAction: '在登录失败时展示具体原因',
        why: '会话结束时还没做',
        confidence: 0.82,
        sourceSignalIds: ['codex:session-1:m1'],
      },
      {
        projectDir: 'C:/work/alpha',
        projectName: 'alpha',
        firstSeen: '2026-11-10T10:00:00.000Z',
        lastSeen: '2026-11-10T10:00:00.000Z',
      },
    );

    expect(first.created).toBe(true);
    expect(first.loop.status).toBe('open');
    expect(first.loop.sourceSignalIds).toEqual(['codex:session-1:m1']);

    const second = store.saveLoop(
      {
        title: '补齐登录页错误提示！',
        nextAction: '补错误提示',
        why: '第二次会话又提到了',
        confidence: 0.9,
        sourceSignalIds: ['codex:session-1:m2'],
      },
      {
        projectDir: 'C:/work/alpha',
        projectName: 'alpha',
        lastSeen: '2026-11-11T10:00:00.000Z',
      },
    );

    expect(second.created).toBe(false);
    expect(second.loop.id).toBe(first.loop.id);
    expect(second.loop.sourceSignalIds).toEqual(['codex:session-1:m1', 'codex:session-1:m2']);
    expect(second.loop.lastSeen).toBe('2026-11-11T10:00:00.000Z');
  });

  it('puts low-confidence loops into pending', () => {
    const store = openStore();
    const result = store.saveLoop(
      {
        title: '可能还要补测试',
        nextAction: '确认是否需要补集成测试',
        why: '模型不确定',
        confidence: 0.42,
        sourceSignalIds: ['codex:session-1:m3'],
      },
      { projectDir: 'C:/work/beta', projectName: 'beta' },
    );

    expect(result.loop.status).toBe('pending');
    expect(store.listLoops({ status: 'open' })).toHaveLength(0);
    expect(store.listLoops({ status: 'pending' })).toHaveLength(1);
  });

  it('moves firstSeen earlier when older evidence is merged', () => {
    const store = openStore();
    const first = store.saveLoop(
      {
        title: '补登录提示',
        nextAction: '补提示',
        why: '后来的证据',
        confidence: 0.8,
        sourceSignalIds: ['s2'],
      },
      {
        projectDir: 'C:/work/alpha',
        projectName: 'alpha',
        firstSeen: '2026-11-10T10:00:00.000Z',
        lastSeen: '2026-11-10T10:00:00.000Z',
      },
    ).loop;

    const merged = store.saveLoop(
      {
        title: '补登录提示',
        nextAction: '补提示',
        why: '更早的证据',
        confidence: 0.9,
        sourceSignalIds: ['s1'],
      },
      {
        projectDir: 'C:/work/alpha',
        projectName: 'alpha',
        firstSeen: '2026-11-08T10:00:00.000Z',
        lastSeen: '2026-11-10T10:00:00.000Z',
      },
    ).loop;

    expect(merged.id).toBe(first.id);
    expect(merged.firstSeen).toBe('2026-11-08T10:00:00.000Z');
    expect(merged.lastSeen).toBe('2026-11-10T10:00:00.000Z');
    expect(merged.confidence).toBe(0.8);
  });

  it('merges near-duplicate titles in the same project', () => {
    const store = openStore();
    const first = store.saveLoop(
      {
        title: '后台 shell 任务 b2nuqq47k 结果未核查',
        nextAction: '查看输出文件',
        why: '会话结束时没有完成记录',
        confidence: 0.6,
        sourceSignalIds: ['s1'],
      },
      {
        projectDir: 'C:/work/alpha',
        projectName: 'alpha',
        firstSeen: '2026-11-10T10:00:00.000Z',
        lastSeen: '2026-11-10T10:00:00.000Z',
      },
    ).loop;

    const second = store.saveLoop(
      {
        title: '后台 shell 任务 b2nuqq47k 中断，输出未核查',
        nextAction: '确认命令是否完成，必要时重跑',
        why: '任务被中断',
        confidence: 0.75,
        sourceSignalIds: ['s2'],
      },
      {
        projectDir: 'C:/work/alpha',
        projectName: 'alpha',
        lastSeen: '2026-11-11T10:00:00.000Z',
      },
    );

    expect(second.created).toBe(false);
    expect(second.loop.id).toBe(first.id);
    expect(second.loop.sourceSignalIds).toEqual(['s1', 's2']);
    expect(second.loop.title).toContain('中断');
  });

  it('refreshes a stale description when newer evidence arrives with lower confidence', () => {
    const store = openStore();
    store.saveSignal(makeSignal({
      id: 'codex:session-1:stale-old',
      messageId: 'stale-old',
      capturedAt: '2026-11-06T16:40:45.647Z',
    }));
    const first = store.saveLoop(
      {
        title: '旧进程未退出，新包从未加载',
        nextAction: '结束旧进程并重启新包',
        why: '旧进程仍在运行',
        confidence: 0.9,
        sourceSignalIds: ['codex:session-1:stale-old'],
      },
      {
        projectDir: 'C:/work/alpha',
        projectName: 'alpha',
        firstSeen: '2026-11-06T16:40:45.647Z',
        lastSeen: '2026-11-06T16:40:45.647Z',
      },
    ).loop;

    store.saveSignal(makeSignal({
      id: 'codex:session-1:stale-new',
      messageId: 'stale-new',
      capturedAt: '2026-11-08T09:49:56.566Z',
    }));
    const merged = store.saveLoop(
      {
        title: '三项真机回签未完成',
        nextAction: '逐项完成全屏、语义搜索和稳定性回签',
        why: '新包已经加载，剩余的是真机验证',
        confidence: 0.7,
        sourceSignalIds: ['codex:session-1:stale-new'],
        mergeInto: first.id,
      },
      {
        projectDir: 'C:/work/alpha',
        projectName: 'alpha',
        firstSeen: '2026-11-08T09:49:56.566Z',
        lastSeen: '2026-11-08T09:49:56.566Z',
      },
    ).loop;

    expect(merged.id).toBe(first.id);
    expect(merged.title).toBe('三项真机回签未完成');
    expect(merged.nextAction).toBe('逐项完成全屏、语义搜索和稳定性回签');
    expect(merged.why).toBe('新包已经加载，剩余的是真机验证');
    expect(merged.confidence).toBe(0.9);
    expect(merged.lastSeen).toBe('2026-11-08T09:49:56.566Z');
  });

  it('keeps the existing description when an old session is replayed without newer evidence', () => {
    const store = openStore();
    store.saveSignal(makeSignal({
      id: 'codex:session-1:replay',
      messageId: 'replay',
      capturedAt: '2026-11-06T16:40:45.647Z',
    }));
    const first = store.saveLoop(
      {
        title: '旧的准确描述',
        nextAction: '按旧描述处理',
        why: '旧证据',
        confidence: 0.8,
        sourceSignalIds: ['codex:session-1:replay'],
      },
      {
        projectDir: 'C:/work/alpha',
        projectName: 'alpha',
        firstSeen: '2026-11-06T16:40:45.647Z',
        lastSeen: '2026-11-06T16:40:45.647Z',
      },
    ).loop;

    const replayed = store.saveLoop(
      {
        title: '重放旧会话得到的标题',
        nextAction: '不应覆盖',
        why: '没有新证据',
        confidence: 0.95,
        sourceSignalIds: ['codex:session-1:replay'],
        mergeInto: first.id,
      },
      {
        projectDir: 'C:/work/alpha',
        projectName: 'alpha',
        firstSeen: '2026-11-06T16:40:45.647Z',
        lastSeen: '2026-11-06T16:40:45.647Z',
      },
    ).loop;

    expect(replayed.title).toBe('旧的准确描述');
    expect(replayed.nextAction).toBe('按旧描述处理');
    expect(replayed.why).toBe('旧证据');
    expect(replayed.confidence).toBe(0.8);
  });

  it('merges a refreshed title back into the same loop without creating a duplicate', () => {
    const store = openStore();
    store.saveSignal(makeSignal({
      id: 'codex:session-1:title-old',
      messageId: 'title-old',
      capturedAt: '2026-11-06T08:00:00.000Z',
    }));
    const original = store.saveLoop(
      {
        title: '旧标题：旧进程未退出',
        nextAction: '重启旧进程',
        why: '旧证据',
        confidence: 0.8,
        sourceSignalIds: ['codex:session-1:title-old'],
      },
      {
        projectDir: 'C:/work/alpha',
        projectName: 'alpha',
        firstSeen: '2026-11-06T08:00:00.000Z',
        lastSeen: '2026-11-06T08:00:00.000Z',
      },
    ).loop;

    store.saveSignal(makeSignal({
      id: 'codex:session-1:title-new',
      messageId: 'title-new',
      capturedAt: '2026-11-07T08:00:00.000Z',
    }));
    const refreshed = store.saveLoop(
      {
        title: '新标题：三项真机回签未完成',
        nextAction: '逐项回签',
        why: '新证据',
        confidence: 0.75,
        sourceSignalIds: ['codex:session-1:title-new'],
        mergeInto: original.id,
      },
      {
        projectDir: 'C:/work/alpha',
        projectName: 'alpha',
        firstSeen: '2026-11-07T08:00:00.000Z',
        lastSeen: '2026-11-07T08:00:00.000Z',
      },
    ).loop;
    expect(refreshed.title).toBe('新标题：三项真机回签未完成');

    store.saveSignal(makeSignal({
      id: 'codex:session-1:title-again',
      messageId: 'title-again',
      capturedAt: '2026-11-08T08:00:00.000Z',
    }));
    const replayed = store.saveLoop(
      {
        title: '新标题：三项真机回签未完成',
        nextAction: '逐项回签',
        why: '同一循环的再次出现',
        confidence: 0.8,
        sourceSignalIds: ['codex:session-1:title-again'],
      },
      {
        projectDir: 'C:/work/alpha',
        projectName: 'alpha',
        firstSeen: '2026-11-08T08:00:00.000Z',
        lastSeen: '2026-11-08T08:00:00.000Z',
      },
    );

    expect(replayed.created).toBe(false);
    expect(replayed.loop.id).toBe(original.id);
    expect(store.listLoops({ projectDir: 'C:/work/alpha' })).toHaveLength(1);
  });

  it('does not let a low-confidence candidate overwrite an open loop description', () => {
    const store = openStore();
    store.saveSignal(makeSignal({
      id: 'codex:session-1:strong-old',
      messageId: 'strong-old',
      capturedAt: '2026-11-06T16:40:45.647Z',
    }));
    const first = store.saveLoop(
      {
        title: '高置信旧描述',
        nextAction: '按旧描述处理',
        why: '旧证据',
        confidence: 0.9,
        sourceSignalIds: ['codex:session-1:strong-old'],
      },
      {
        projectDir: 'C:/work/alpha',
        projectName: 'alpha',
        firstSeen: '2026-11-06T16:40:45.647Z',
        lastSeen: '2026-11-06T16:40:45.647Z',
      },
    ).loop;

    store.saveSignal(makeSignal({
      id: 'codex:session-1:weak-new',
      messageId: 'weak-new',
      capturedAt: '2026-11-08T09:49:56.566Z',
    }));
    const merged = store.saveLoop(
      {
        title: '低置信新描述',
        nextAction: '不应覆盖',
        why: '候选本身不确定',
        confidence: 0.55,
        sourceSignalIds: ['codex:session-1:weak-new'],
        mergeInto: first.id,
      },
      {
        projectDir: 'C:/work/alpha',
        projectName: 'alpha',
        firstSeen: '2026-11-08T09:49:56.566Z',
        lastSeen: '2026-11-08T09:49:56.566Z',
      },
    ).loop;

    expect(merged.title).toBe('高置信旧描述');
    expect(merged.nextAction).toBe('按旧描述处理');
    expect(merged.confidence).toBe(0.9);
    expect(merged.lastSeen).toBe('2026-11-08T09:49:56.566Z');
  });

  it('filters by project and updates status with a resolution note', () => {
    const store = openStore();
    const alpha = store.saveLoop(
      {
        title: 'Alpha task',
        nextAction: 'Do alpha',
        why: 'Alpha why',
        confidence: 0.9,
        sourceSignalIds: ['codex:session-1:a1'],
      },
      { projectDir: 'C:/work/alpha', projectName: 'alpha' },
    ).loop;
    store.saveLoop(
      {
        title: 'Beta task',
        nextAction: 'Do beta',
        why: 'Beta why',
        confidence: 0.9,
        sourceSignalIds: ['codex:session-1:b1'],
      },
      { projectDir: 'C:/work/beta', projectName: 'beta' },
    );

    expect(store.listLoops({ projectDir: 'C:/work/alpha' })).toHaveLength(1);
    expect(store.listLoops({ projectDir: 'C:/work/alpha' })[0].id).toBe(alpha.id);

    const updated = store.updateLoop(alpha.id, {
      status: 'resolved',
      note: '已补错误提示',
    });
    expect(updated?.status).toBe('resolved');
    expect(updated?.resolutionNote).toBe('已补错误提示');
    expect(updated?.resolvedAt).toBeTruthy();
    expect(store.listLoops({ status: 'open' })).toHaveLength(1);
    expect(store.listLoops({ includeAll: true })).toHaveLength(2);
  });

  it('merges by an explicit semantic target even when titles are different', () => {
    const store = openStore();
    const target = store.saveLoop(
      {
        title: '首页加载慢',
        nextAction: '定位首屏请求',
        why: '用户体感卡顿',
        confidence: 0.8,
        sourceSignalIds: ['s1'],
      },
      { projectDir: 'C:/work/alpha', projectName: 'alpha' },
    ).loop;

    const merged = store.saveLoop(
      {
        title: '首屏性能回归未修',
        nextAction: '抓一次 trace 对比上一版',
        why: '同一交付目标的不同说法',
        confidence: 0.9,
        sourceSignalIds: ['s2'],
        mergeInto: target.id,
      },
      { projectDir: 'C:/work/alpha', projectName: 'alpha' },
    );

    expect(merged.created).toBe(false);
    expect(merged.loop.id).toBe(target.id);
    expect(merged.loop.sourceSignalIds).toEqual(['s1', 's2']);

    expect(() => store.saveLoop(
      {
        title: '跨项目误合并',
        nextAction: '不应发生',
        why: '测试',
        confidence: 0.9,
        sourceSignalIds: ['s3'],
        mergeInto: target.id,
      },
      { projectDir: 'C:/work/beta', projectName: 'beta' },
    )).toThrow(/invalid merge target/);
  });

  it('records project activity without double-counting the same session', () => {
    const store = openStore();
    store.recordProjectActivity('C:/work/alpha', 'alpha', '2026-11-10T10:00:00.000Z', 's1');
    store.recordProjectActivity('C:/work/alpha', 'alpha', '2026-11-11T10:00:00.000Z', 's1');
    store.recordProjectActivity('C:/work/alpha', 'alpha', '2026-11-11T11:00:00.000Z', 's2');
    store.recordProjectActivity('C:/work/alpha', 'alpha', '2026-11-10T10:00:00.000Z', 's1');

    const activity = store.listProjectActivity('2026-11-01T00:00:00.000Z');
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      projectName: 'alpha',
      lastActive: '2026-11-11T11:00:00.000Z',
      sessionCount: 2,
    });
  });

  it('keeps the newest project name when an older session is replayed', () => {
    const store = openStore();
    store.recordProjectActivity('C:/work/alpha', 'Claude · 新标题', '2026-11-11T11:00:00.000Z', 's2');
    store.recordProjectActivity('C:/work/alpha', 'ZCode · 旧标题', '2026-11-10T11:00:00.000Z', 's1');

    expect(store.getProjectActivity('C:/work/alpha')?.projectName).toBe('Claude · 新标题');
    expect(store.listProjectActivity()[0].sessionCount).toBe(2);
  });

  it('runs the project session backfill only once across reopens', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-store-'));
    const file = path.join(dir, 'loops.db');
    try {
      const first = new LoopStore(file);
      first.saveSignal(makeSignal());
      first.recordProjectActivity('C:/work/alpha', 'alpha', '2026-11-10T10:00:00.000Z', 's1');
      first.close();

      const second = new LoopStore(file);
      expect(second.listProjectActivity()[0].sessionCount).toBe(1);
      second.close();

      const third = new LoopStore(file);
      expect(third.listProjectActivity()[0].sessionCount).toBe(1);
      third.close();

      const req = createRequire(import.meta.url);
      const { DatabaseSync } = req('node:sqlite') as { DatabaseSync: new (file: string, options?: any) => any };
      const db = new DatabaseSync(file, { readOnly: true });
      const rows = db.prepare('SELECT key FROM schema_meta ORDER BY key').all() as Array<{ key: string }>;
      db.close();
      expect(rows.map((row) => row.key)).toEqual([
        'm11_project_sessions',
        'm135_presentation_fatigue',
        'm146_loop_origin',
        'm21_loop_evidence_range',
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('backfills the current review cycle from legacy review presentations', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-review-cycle-'));
    const file = path.join(dir, 'loops.db');
    try {
      const first = new LoopStore(file);
      const alpha = makeLoop(first, 'A');
      const beta = makeLoop(first, 'B');
      const gamma = makeLoop(first, 'C');
      first.recordPresentation(
        [alpha.id, beta.id],
        '2026-11-11T10:00:00.000Z',
        'review',
        'review',
      );
      first.recordPresentation(
        [beta.id, gamma.id],
        '2026-11-11T10:10:00.000Z',
        'review',
        'review',
      );
      (first as any).db.prepare('DELETE FROM schema_meta WHERE key = ?')
        .run('review_cycle');
      first.close();

      const reopened = new LoopStore(file);
      expect([...reopened.getReviewCycleSeen([alpha.id, beta.id, gamma.id])])
        .toEqual([beta.id, gamma.id]);
      const meta = (reopened as any).db.prepare(
        "SELECT value FROM schema_meta WHERE key = 'review_cycle'",
      ).get();
      expect(JSON.parse(meta.value)).toMatchObject({
        startedAt: '2026-11-11T10:10:00.000Z',
        seen: [beta.id, gamma.id],
      });
      reopened.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not treat a replayed review batch as a new cycle', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-review-replay-'));
    const file = path.join(dir, 'loops.db');
    try {
      const first = new LoopStore(file);
      const alpha = makeLoop(first, 'A');
      const beta = makeLoop(first, 'B');
      const gamma = makeLoop(first, 'C');
      const delta = makeLoop(first, 'D');
      first.recordPresentation(
        [alpha.id, beta.id],
        '2026-11-11T10:00:00.000Z',
        'review',
        'review',
      );
      first.recordPresentation(
        [gamma.id, delta.id],
        '2026-11-11T10:10:00.000Z',
        'review',
        'review',
      );
      first.recordPresentation(
        [gamma.id, delta.id],
        '2026-11-11T10:20:00.000Z',
        'review',
        'review',
      );
      (first as any).db.prepare('DELETE FROM schema_meta WHERE key = ?')
        .run('review_cycle');
      first.close();

      const reopened = new LoopStore(file);
      expect([...reopened.getReviewCycleSeen([alpha.id, beta.id, gamma.id, delta.id])])
        .toEqual([alpha.id, beta.id, gamma.id, delta.id]);
      const meta = (reopened as any).db.prepare(
        "SELECT value FROM schema_meta WHERE key = 'review_cycle'",
      ).get();
      expect(JSON.parse(meta.value)).toMatchObject({
        startedAt: '2026-11-11T10:00:00.000Z',
        seen: [alpha.id, beta.id, gamma.id, delta.id],
      });
      reopened.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the review cycle start time when the same batch is recorded twice', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-review-repeat-'));
    const file = path.join(dir, 'loops.db');
    try {
      const store = new LoopStore(file);
      const alpha = makeLoop(store, 'A');
      const beta = makeLoop(store, 'B');
      store.recordPresentation(
        [alpha.id, beta.id],
        '2026-11-11T10:00:00.000Z',
        'review',
        'review',
      );
      store.recordPresentation(
        [alpha.id, beta.id],
        '2026-11-11T10:10:00.000Z',
        'review',
        'review',
      );
      const meta = (store as any).db.prepare(
        "SELECT value FROM schema_meta WHERE key = 'review_cycle'",
      ).get();
      expect(JSON.parse(meta.value)).toMatchObject({
        startedAt: '2026-11-11T10:00:00.000Z',
        seen: [alpha.id, beta.id],
      });
      store.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the file database readable without WAL sidecars', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-store-ro-'));
    const file = path.join(dir, 'loops.db');
    try {
      const store = new LoopStore(file);
      store.saveSignal(makeSignal());
      store.close();

      expect(fs.existsSync(`${file}-wal`)).toBe(false);
      expect(fs.existsSync(`${file}-shm`)).toBe(false);

      const req = createRequire(import.meta.url);
      const { DatabaseSync } = req('node:sqlite') as { DatabaseSync: new (file: string, options?: any) => any };
      const db = new DatabaseSync(file, { readOnly: true });
      expect(db.prepare('PRAGMA journal_mode').get().journal_mode).toBe('delete');
      expect(db.prepare('SELECT COUNT(*) AS n FROM loops').get().n).toBe(0);
      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('renames the denormalized project name for every loop in a project', () => {
    const store = openStore();
    store.saveLoop(
      {
        title: '旧项目名下的循环',
        nextAction: 'rename',
        why: 'test',
        confidence: 0.9,
        sourceSignalIds: ['s1'],
      },
      { projectDir: 'C:/work/2026-11-07-19-09-00', projectName: '2026-11-07-19-09-00' },
    );

    expect(store.renameProject('C:/work/2026-11-07-19-09-00', 'WorkBuddy · 离线导出'))
      .toBe(1);
    expect(store.listLoops({ status: 'open' })[0].projectName).toBe('WorkBuddy · 离线导出');
  });

  it('finds active loops by title text and surfaces ambiguous matches', () => {
    const store = openStore();
    store.saveLoop(
      {
        title: '补齐登录页错误提示',
        nextAction: '补错误提示',
        why: 'test',
        confidence: 0.9,
        sourceSignalIds: ['s1'],
      },
      { projectDir: 'C:/work/alpha', projectName: 'alpha' },
    );
    store.saveLoop(
      {
        title: '登录页样式错位',
        nextAction: '修样式',
        why: 'test',
        confidence: 0.9,
        sourceSignalIds: ['s2'],
      },
      { projectDir: 'C:/work/alpha', projectName: 'alpha' },
    );
    store.saveLoop(
      {
        title: '导出失败重试',
        nextAction: '补重试',
        why: 'test',
        confidence: 0.9,
        sourceSignalIds: ['s3'],
      },
      { projectDir: 'C:/work/beta', projectName: 'beta' },
    );

    expect(store.findLoopsByText('错误提示').map((loop) => loop.title))
      .toEqual(['补齐登录页错误提示']);
    expect(store.findLoopsByText('登录页')).toHaveLength(2);
    expect(store.findLoopsByText('登录页', { projectDir: 'C:/work/alpha' })).toHaveLength(2);
    expect(store.findLoopsByText('不存在的标题')).toHaveLength(0);
  });

  it('searches and lists beyond the previous 500-row cap', () => {
    const store = openStore();
    const filler = Array.from({ length: 600 }, (_, index) => `Bulk ${index}`);
    insertBulkLoops(store, [...filler, 'Target A', 'Target B']);

    expect(store.listLoops({ includeAll: true, limit: 1_000 })).toHaveLength(602);
    expect(store.listActiveLoops()).toHaveLength(602);
    expect(store.findLoopsByText('target').map((loop) => loop.title).sort())
      .toEqual(['Target A', 'Target B']);
  });

  it('downgrades a loop after three repeated surfaces', () => {
    const store = openStore();
    const loop = store.saveLoop(
      {
        title: '重复展示项',
        nextAction: '处理它',
        why: '测试忽略降级',
        confidence: 0.9,
        sourceSignalIds: ['s1'],
      },
      {
        projectDir: 'C:/work/alpha',
        projectName: 'alpha',
        lastSeen: '2026-11-09T00:00:00.000Z',
      },
    ).loop;

    store.recordSurfaced([loop.id], '2026-11-10T00:00:00.000Z');
    store.recordSurfaced([loop.id], '2026-11-11T00:00:00.000Z');
    store.recordSurfaced([loop.id], '2026-11-12T00:00:00.000Z');
    const final = store.recordSurfaced([loop.id], '2026-11-13T00:00:00.000Z')[0];

    expect(final.ignoredCount).toBe(3);
    expect(final.status).toBe('snoozed');
    expect(final.snoozeUntil).toBe('2026-11-20T00:00:00.000Z');
  });

  it('treats an expired snooze as open in reads, lists, and filters', () => {
    const store = openStore();
    const expired = makeLoop(store, 'Expired snooze');
    const future = makeLoop(store, 'Future snooze');

    store.updateLoop(expired.id, {
      status: 'snoozed',
      snoozeUntil: '2020-01-01T00:00:00.000Z',
    });
    store.updateLoop(future.id, {
      status: 'snoozed',
      snoozeUntil: '2030-01-01T00:00:00.000Z',
    });

    expect(store.getLoop(expired.id)).toMatchObject({
      status: 'open',
      snoozeUntil: undefined,
    });
    expect(store.getLoop(future.id)).toMatchObject({
      status: 'snoozed',
      snoozeUntil: '2030-01-01T00:00:00.000Z',
    });
    expect(store.listLoops({ status: 'open' }).map((loop) => loop.id))
      .toContain(expired.id);
    expect(store.listLoops({ status: 'open' }).map((loop) => loop.id))
      .not.toContain(future.id);
    expect(store.listLoops({ status: 'snoozed' }).map((loop) => loop.id))
      .toEqual([future.id]);
    expect(store.listActiveLoops().find((loop) => loop.id === expired.id)?.status)
      .toBe('open');
  });

  it('clears snooze state when a paused loop is closed', () => {
    const store = openStore();
    const loop = makeLoop(store, 'Paused then closed');
    store.updateLoop(loop.id, {
      status: 'snoozed',
      snoozeUntil: '2030-01-01T00:00:00.000Z',
    });

    const resolved = store.updateLoop(loop.id, {
      status: 'resolved',
      note: 'done',
    });
    expect(resolved).toMatchObject({ status: 'resolved', snoozeUntil: undefined });

    store.updateLoop(loop.id, {
      status: 'snoozed',
      snoozeUntil: '2030-01-01T00:00:00.000Z',
    });
    const dropped = store.updateLoop(loop.id, { status: 'dropped' });
    expect(dropped).toMatchObject({ status: 'dropped', snoozeUntil: undefined });
  });

  it('keeps the first close time and clears it when a loop is reopened', () => {
    const store = openStore();
    const loop = makeLoop(store, 'Close time stability');
    (store as any).db.prepare(
      "UPDATE loops SET resolved_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
    ).run(loop.id);

    const resolved = store.updateLoop(loop.id, { status: 'resolved', note: 'again' });
    expect(resolved?.resolvedAt).toBe('2020-01-01T00:00:00.000Z');

    const reopened = store.updateLoop(loop.id, { status: 'open' });
    expect(reopened?.resolvedAt).toBeUndefined();

    const dropped = store.updateLoop(loop.id, { status: 'dropped' });
    expect(dropped?.resolvedAt).toBeTruthy();
  });

  it('resolves digest numbers against the latest presentation only', () => {
    const store = openStore();
    const first = makeLoop(store, 'First item');
    const second = makeLoop(store, 'Second item');

    const presentationId = store.recordPresentation(
      [first.id, second.id],
      '2026-11-11T10:00:00.000Z',
      'hot',
      'hot',
    );
    expect(presentationId).toBeGreaterThan(0);
    expect(store.resolvePresentationIndex(1, {
      nowMs: Date.parse('2026-11-11T11:00:00.000Z'),
    })).toMatchObject({ status: 'found', loopId: first.id });
    expect(store.resolvePresentationIndex(2, {
      nowMs: Date.parse('2026-11-11T11:00:00.000Z'),
    })).toMatchObject({ status: 'found', loopId: second.id });

    const outOfRange = store.resolvePresentationIndex(3, {
      nowMs: Date.parse('2026-11-11T11:00:00.000Z'),
    });
    expect(outOfRange.status).toBe('out_of_range');

    const expired = store.resolvePresentationIndex(1, {
      nowMs: Date.parse('2026-11-14T11:00:00.000Z'),
    });
    expect(expired.status).toBe('missing');

    store.recordPresentation(
      [second.id],
      '2026-11-11T12:00:00.000Z',
      'hot',
      'recap',
    );
    expect(store.resolvePresentationIndex(1, {
      nowMs: Date.parse('2026-11-11T13:00:00.000Z'),
    })).toMatchObject({ status: 'found', loopId: second.id });
  });

  it('ignores presentations dated in the future', () => {
    const store = openStore();
    const first = makeLoop(store, 'First valid item');
    const future = makeLoop(store, 'Future item');
    const nowMs = Date.parse('2026-11-11T11:00:00.000Z');

    store.recordPresentation([first.id], '2026-11-11T10:00:00.000Z', 'hot', 'hot');
    store.recordPresentation([future.id], '2026-11-13T10:00:00.000Z', 'hot', 'hot');

    expect(store.getLatestPresentation(48, nowMs)?.loopIds).toEqual([first.id]);
    expect(store.resolvePresentationIndex(1, { nowMs })).toMatchObject({
      status: 'found',
      loopId: first.id,
    });
    expect(store.getFirstPresentationTimes(new Date(nowMs).toISOString()).has(future.id)).toBe(false);
    expect(store.countPresentationsAfter(new Date(nowMs).toISOString())).toBe(1);
  });

  it('resolves short refs and reports ambiguous prefixes', () => {
    const store = openStore();
    const db = (store as any).db;
    const insert = db.prepare(`
      INSERT INTO loops (
        id, title, next_action, why, status, confidence, project_dir, project_name,
        source_signal_ids, first_seen, last_seen, dedupe_key, ignored_count
      ) VALUES (?, ?, ?, ?, 'open', 0.8, 'C:/work/alpha', 'alpha', '[]', ?, ?, ?, 0)
    `);
    const at = '2026-11-10T10:00:00.000Z';
    insert.run('loop_abcd111111111111', 'One', 'next', 'why', at, at, 'ref-one');
    insert.run('loop_abcd222222222222', 'Two', 'next', 'why', at, at, 'ref-two');
    insert.run('loop_beef333333333333', 'Three', 'next', 'why', at, at, 'ref-three');

    expect(store.findLoopsByRef('beef').map((loop) => loop.id))
      .toEqual(['loop_beef333333333333']);
    expect(store.findLoopsByRef('loop_abcd111111111111').map((loop) => loop.id))
      .toEqual(['loop_abcd111111111111']);
    expect(store.findLoopsByRef('abcd')).toHaveLength(2);
    expect(store.findLoopsByRef('zzzz')).toHaveLength(0);
  });

  it('keeps snooze and ignore state when a merge has no newer evidence', () => {
    const store = openStore();
    const loop = store.saveLoop(
      {
        title: '重复展示项',
        nextAction: '处理它',
        why: '测试无新证据合并',
        confidence: 0.9,
        sourceSignalIds: ['s1'],
      },
      {
        projectDir: 'C:/work/alpha',
        projectName: 'alpha',
        lastSeen: '2026-11-10T10:00:00.000Z',
      },
    ).loop;
    store.recordSurfaced([loop.id], '2026-11-11T00:00:00.000Z');
    store.recordSurfaced([loop.id], '2026-11-12T00:00:00.000Z');
    store.recordSurfaced([loop.id], '2026-11-13T00:00:00.000Z');
    const snoozed = store.recordSurfaced([loop.id], '2026-11-14T00:00:00.000Z')[0];

    const merged = store.saveLoop(
      {
        title: '重复展示项',
        nextAction: '处理它',
        why: '旧会话重放',
        confidence: 0.9,
        sourceSignalIds: ['s1'],
      },
      {
        projectDir: 'C:/work/alpha',
        projectName: 'alpha',
        lastSeen: '2026-11-10T10:00:00.000Z',
      },
    ).loop;

    expect(merged.status).toBe('snoozed');
    expect(merged.ignoredCount).toBe(snoozed.ignoredCount);
    expect(merged.snoozeUntil).toBe(snoozed.snoozeUntil);

    const resumed = store.saveLoop(
      {
        title: '重复展示项',
        nextAction: '处理它',
        why: '确实有新证据',
        confidence: 0.9,
        sourceSignalIds: ['s2'],
      },
      {
        projectDir: 'C:/work/alpha',
        projectName: 'alpha',
        lastSeen: '2026-11-14T10:00:00.000Z',
      },
    ).loop;

    expect(resumed.status).toBe('open');
    expect(resumed.ignoredCount).toBe(0);
    expect(resumed.snoozeUntil).toBeUndefined();
  });

  it('does not promote pending to open without newer evidence', () => {
    const store = openStore();
    store.recordProjectActivity(
      'C:/work/beta',
      'beta',
      '2026-11-11T11:00:00.000Z',
      's1',
    );
    store.saveLoop(
      {
        title: '待确认项',
        nextAction: '确认是否要做',
        why: '置信度低',
        confidence: 0.45,
        sourceSignalIds: ['s1'],
      },
      {
        projectDir: 'C:/work/beta',
        projectName: 'beta',
        lastSeen: '2026-11-10T10:00:00.000Z',
      },
    );
    const before = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T12:00:00.000Z'),
      markSurfaced: false,
    });
    expect(before.total).toBe(0);

    const merged = store.saveLoop(
      {
        title: '待确认项',
        nextAction: '确认是否要做',
        why: '同一批证据重新提取',
        confidence: 0.9,
        sourceSignalIds: ['s1'],
      },
      {
        projectDir: 'C:/work/beta',
        projectName: 'beta',
        lastSeen: '2026-11-10T10:00:00.000Z',
      },
    ).loop;

    expect(merged.status).toBe('pending');
    expect(merged.confidence).toBe(0.45);
    const after = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T12:00:00.000Z'),
      markSurfaced: false,
    });
    expect(after.total).toBe(0);
  });

  it('backfills evidence range from message timestamps once and skips unresolved evidence', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-loop-backfill-'));
    const dbPath = path.join(dir, 'loops.db');
    let store: LoopStore | undefined;
    try {
      store = new LoopStore(dbPath);
      store.saveSignal(makeSignal({
        id: 'codex:session-1:old',
        capturedAt: '2026-11-08T11:54:44.096Z',
        capturedAtSource: 'message',
      }));
      store.saveSignal(makeSignal({
        id: 'codex:session-1:fallback',
        messageId: 'm2',
        capturedAt: '2026-11-12T10:00:00.000Z',
        capturedAtSource: 'session',
      }));
      const loop = store.saveLoop(
        {
          title: '有历史证据的循环',
          nextAction: '按证据时间回填',
          why: '测试回填',
          confidence: 0.8,
          sourceSignalIds: ['codex:session-1:old', 'codex:session-1:fallback'],
        },
        {
          projectDir: 'C:/work/alpha',
          projectName: 'alpha',
          firstSeen: '2026-11-10T02:01:40.000Z',
          lastSeen: '2026-11-12T10:00:00.000Z',
        },
      ).loop;
      const missing = store.saveLoop(
        {
          title: '证据缺失的循环',
          nextAction: '保持原值',
          why: '测试跳过',
          confidence: 0.8,
          sourceSignalIds: ['codex:session-1:missing'],
        },
        {
          projectDir: 'C:/work/alpha',
          projectName: 'alpha',
          lastSeen: '2026-11-10T02:01:40.000Z',
        },
      ).loop;
      const closed = store.saveLoop(
        {
          title: '已关闭的历史循环',
          nextAction: '保持历史值',
          why: '测试关闭项跳过',
          confidence: 0.8,
          sourceSignalIds: ['codex:session-1:old'],
        },
        {
          projectDir: 'C:/work/alpha',
          projectName: 'alpha',
          firstSeen: '2026-11-10T02:01:40.000Z',
          lastSeen: '2026-11-10T02:01:40.000Z',
        },
      ).loop;
      store.updateLoop(closed.id, { status: 'resolved' });
      (store as any).db.prepare(
        `UPDATE loops SET
          first_seen = ?, last_seen = ?, first_seen_source = 'session', last_seen_source = 'session'
         WHERE id = ?`,
      ).run(
        '2026-11-10T02:01:40.000Z',
        '2026-11-10T02:01:40.000Z',
        closed.id,
      );
      (store as any).db.prepare(
        `UPDATE loops SET
          first_seen = ?, last_seen = ?, first_seen_source = 'message', last_seen_source = 'message'
         WHERE id = ?`,
      ).run(
        '2026-11-10T02:01:40.000Z',
        '2026-11-12T10:00:00.000Z',
        loop.id,
      );
      (store as any).db.prepare('DELETE FROM schema_meta WHERE key = ?')
        .run('m21_loop_evidence_range');
      store.close();
      store = undefined;

      store = new LoopStore(dbPath);
      expect(store.getLoop(loop.id)?.firstSeen).toBe('2026-11-08T11:54:44.096Z');
      expect(store.getLoop(loop.id)?.lastSeen).toBe('2026-11-08T11:54:44.096Z');
      expect(store.getLoop(missing.id)?.lastSeen).toBe('2026-11-10T02:01:40.000Z');
      expect(store.getLoop(closed.id)?.lastSeen).toBe('2026-11-10T02:01:40.000Z');
      const meta = (store as any).db.prepare(
        'SELECT value FROM schema_meta WHERE key = ?',
      ).get('m21_loop_evidence_range');
      expect(JSON.parse(meta.value)).toMatchObject({
        updated: 1,
        skipped: 1,
        closedSkipped: 1,
        firstSeenAdjusted: 1,
        lastSeenAdjusted: 1,
        skippedLoops: [missing.id],
      });

      (store as any).db.prepare(
        'UPDATE loops SET first_seen = ?, last_seen = ? WHERE id = ?',
      ).run('2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', loop.id);
      store.close();
      store = undefined;

      store = new LoopStore(dbPath);
      expect(store.getLoop(loop.id)?.firstSeen).toBe('2026-11-01T00:00:00.000Z');
      expect(store.getLoop(loop.id)?.lastSeen).toBe('2026-11-01T00:00:00.000Z');
    } finally {
      store?.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('snoozes a loop after three recap presentations without new evidence', () => {
    const store = openStore();
    const loop = makeLoop(store, 'Recap fatigue');

    store.recordPresentation([loop.id], '2026-11-10T10:00:00.000Z', 'hot', 'recap');
    store.recordPresentation([loop.id], '2026-11-10T11:00:00.000Z', 'hot', 'recap');
    expect(store.getLoop(loop.id)?.status).toBe('open');
    expect(store.getLoop(loop.id)?.presentationCount).toBe(2);

    store.recordPresentation([loop.id], '2026-11-10T12:00:00.000Z', 'hot', 'recap');
    const current = store.getLoop(loop.id)!;
    expect(current.status).toBe('snoozed');
    expect(current.presentationCount).toBe(3);
    expect(current.snoozeUntil).toBe('2026-11-17T12:00:00.000Z');
  });

  it('resets recap fatigue when newer evidence arrives', () => {
    const store = openStore();
    const loop = makeLoop(store, 'Recap reset');
    store.recordPresentation([loop.id], '2026-11-10T10:00:00.000Z', 'hot', 'recap');
    store.recordPresentation([loop.id], '2026-11-10T11:00:00.000Z', 'hot', 'recap');

    makeLoop(store, 'Recap reset', '2026-11-10T12:00:00.000Z');
    store.recordPresentation([loop.id], '2026-11-10T13:00:00.000Z', 'hot', 'recap');

    const current = store.getLoop(loop.id)!;
    expect(current.status).toBe('open');
    expect(current.presentationCount).toBe(1);
  });

  it('does not fatigue-snooze a user-confirmed loop', () => {
    const store = openStore();
    const loop = makeLoop(store, 'Confirmed fatigue');
    store.recordFeedback(
      loop.id,
      'forgotten',
      '确实忘了',
      '2026-11-10T09:00:00.000Z',
    );

    store.recordPresentation([loop.id], '2026-11-10T10:00:00.000Z', 'hot', 'recap');
    store.recordPresentation([loop.id], '2026-11-10T11:00:00.000Z', 'hot', 'recap');
    store.recordPresentation([loop.id], '2026-11-10T12:00:00.000Z', 'hot', 'recap');

    const current = store.getLoop(loop.id)!;
    expect(current.status).toBe('open');
    expect(current.presentationCount).toBe(3);
    expect(current.snoozeUntil).toBeUndefined();
  });

  it('does not apply recap fatigue to weekly review batches', () => {
    const store = openStore();
    const loop = makeLoop(store, 'Review only');

    store.recordPresentation([loop.id], '2026-11-10T10:00:00.000Z', 'review', 'review');
    store.recordPresentation([loop.id], '2026-11-10T11:00:00.000Z', 'review', 'review');
    store.recordPresentation([loop.id], '2026-11-10T12:00:00.000Z', 'review', 'review');

    const current = store.getLoop(loop.id)!;
    expect(current.status).toBe('open');
    expect(current.presentationCount).toBe(0);
  });

  it('backfills recap presentation counts when reopening a legacy database', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-fatigue-'));
    const file = path.join(dir, 'loops.db');
    let first: LoopStore | undefined;
    let second: LoopStore | undefined;
    try {
      first = new LoopStore(file);
      const loop = makeLoop(first, 'Legacy recap');
      const db = (first as any).db;
      const insert = db.prepare(`
        INSERT INTO loop_presentations (presented_at, mode, kind, loop_ids)
        VALUES (?, 'hot', 'recap', ?)
      `);
      insert.run('2026-11-10T10:00:00.000Z', JSON.stringify([loop.id]));
      insert.run('2026-11-10T11:00:00.000Z', JSON.stringify([loop.id]));
      insert.run('2026-11-10T12:00:00.000Z', JSON.stringify([loop.id]));
      db.exec('DELETE FROM schema_meta;');
      first.close();
      first = undefined;

      second = new LoopStore(file);
      const loaded = second.getLoop(loop.id)!;
      expect(loaded.presentationCount).toBe(3);
      expect(loaded.lastPresentedAt).toBe('2026-11-10T12:00:00.000Z');
    } finally {
      first?.close();
      second?.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records whether a loop came from user, assistant, or mixed evidence', () => {
    const store = openStore();
    store.saveSignal(makeSignal({
      id: 'codex:session-1:origin-assistant',
      messageId: 'origin-assistant',
      role: 'assistant',
      text: '登录页错误提示还没补。',
    }));
    const assistant = store.saveLoop(
      {
        title: '补齐登录页错误提示',
        nextAction: '补上错误提示',
        why: 'test',
        confidence: 0.8,
        sourceSignalIds: ['codex:session-1:origin-assistant'],
      },
      {
        projectDir: 'C:/work/alpha',
        projectName: 'alpha',
        lastSeen: '2026-11-10T10:00:00.000Z',
      },
    ).loop;
    expect(assistant.origin).toBe('assistant');

    store.saveSignal(makeSignal({
      id: 'codex:session-1:origin-user',
      messageId: 'origin-user',
      role: 'user',
      text: '导出按钮还没做。',
    }));
    const user = store.saveLoop(
      {
        title: '补导出按钮',
        nextAction: '实现导出按钮',
        why: 'test',
        confidence: 0.8,
        sourceSignalIds: ['codex:session-1:origin-user'],
      },
      {
        projectDir: 'C:/work/alpha',
        projectName: 'alpha',
        lastSeen: '2026-11-10T10:00:00.000Z',
      },
    ).loop;
    expect(user.origin).toBe('user');

    store.saveSignal(makeSignal({
      id: 'codex:session-1:origin-mixed',
      messageId: 'origin-mixed',
      role: 'user',
      text: '登录页错误提示也别忘了。',
    }));
    const mixed = store.saveLoop(
      {
        title: '补齐登录页错误提示',
        nextAction: '补上错误提示',
        why: 'test',
        confidence: 0.9,
        sourceSignalIds: [
          'codex:session-1:origin-assistant',
          'codex:session-1:origin-mixed',
        ],
      },
      {
        projectDir: 'C:/work/alpha',
        projectName: 'alpha',
        lastSeen: '2026-11-10T11:00:00.000Z',
      },
    ).loop;
    expect(mixed.id).toBe(assistant.id);
    expect(mixed.origin).toBe('mixed');
  });

  it('backfills origin when reopening a legacy database', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-origin-'));
    const file = path.join(dir, 'loops.db');
    let first: LoopStore | undefined;
    let second: LoopStore | undefined;
    try {
      first = new LoopStore(file);
      first.saveSignal(makeSignal({
        id: 'codex:session-1:legacy-origin',
        role: 'assistant',
        text: '登录页错误提示还没补。',
      }));
      const loop = first.saveLoop(
        {
          title: '补齐登录页错误提示',
          nextAction: '补上错误提示',
          why: 'test',
          confidence: 0.8,
          sourceSignalIds: ['codex:session-1:legacy-origin'],
        },
        {
          projectDir: 'C:/work/alpha',
          projectName: 'alpha',
          lastSeen: '2026-11-10T10:00:00.000Z',
        },
      ).loop;
      (first as any).db.prepare("UPDATE loops SET origin = 'mixed' WHERE id = ?").run(loop.id);
      (first as any).db.prepare(
        "DELETE FROM schema_meta WHERE key = 'm146_loop_origin'",
      ).run();
      first.close();
      first = undefined;

      second = new LoopStore(file);
      expect(second.getLoop(loop.id)?.origin).toBe('assistant');
    } finally {
      first?.close();
      second?.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
