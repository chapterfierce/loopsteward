import { describe, it, expect, afterEach } from 'vitest';
import { LoopStore } from '../src/loops/loop-store.js';
import {
  buildLoopAudit,
  downgradeWeakEvidence,
  dropSelfGeneratedLoops,
  formatLoopAudit,
} from '../src/loops/audit.js';
import type { LoopSignal } from '../src/loops/types.js';

const stores: LoopStore[] = [];

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
});

function makeSignal(
  id: string,
  text: string,
  role: 'user' | 'assistant' = 'user',
  capturedAt = '2026-11-10T10:00:00.000Z',
): LoopSignal {
  return {
    id,
    source: 'session',
    sourceId: 's1',
    messageId: id,
    agent: 'codex',
    role,
    text,
    projectDir: 'C:/work/alpha',
    capturedAt,
    contentHash: id,
  };
}

function seedLoop(
  store: LoopStore,
  title: string,
  sourceSignalIds: string[],
  options: { confidence?: number; firstSeen?: string; projectName?: string } = {},
) {
  return store.saveLoop(
    {
      title,
      nextAction: `next: ${title}`,
      why: 'test',
      confidence: options.confidence ?? 0.8,
      sourceSignalIds,
    },
    {
      projectDir: 'C:/work/alpha',
      projectName: options.projectName ?? 'alpha',
      firstSeen: options.firstSeen ?? '2026-11-10T10:00:00.000Z',
      lastSeen: '2026-11-10T10:00:00.000Z',
    },
  ).loop;
}

describe('buildLoopAudit', () => {
  it('finds weak evidence, missing sources, stale loops, duplicates, and unstable project names', () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    const now = new Date('2026-11-11T12:00:00.000Z');

    store.saveSignal(makeSignal('codex:s1:weak', '继续'));
    seedLoop(store, 'weak evidence loop', ['codex:s1:weak'], { confidence: 0.9 });

    store.saveSignal(makeSignal('codex:s1:strong', 'clean_packages.ps1 还没提交', 'assistant'));
    const strong = seedLoop(store, '补齐登录页错误提示', ['codex:s1:strong']);

    seedLoop(store, 'missing evidence loop', ['codex:s1:missing']);
    store.saveSignal(makeSignal(
      'codex:s1:stale',
      '登录页 404 兜底还没补',
      'assistant',
      '2026-10-01T10:00:00.000Z',
    ));
    seedLoop(store, 'stale loop', ['codex:s1:stale'], {
      firstSeen: '2026-10-01T10:00:00.000Z',
      projectName: '2026-11-07-12-43-46',
    });

    const db = (store as any).db;
    db.prepare(`
      INSERT INTO loops (
        id, title, next_action, why, status, confidence, project_dir, project_name,
        source_signal_ids, first_seen, last_seen, dedupe_key, ignored_count
      ) SELECT ?, ?, next_action, why, status, confidence, project_dir, project_name,
        source_signal_ids, first_seen, last_seen, ?, ignored_count
      FROM loops WHERE id = ?
    `).run('loop_duplicate', '补齐登录页错误提示！', 'duplicate-key', strong.id);

    const audit = buildLoopAudit({ store, now, staleDays: 14 });

    expect(audit.totals.active).toBe(5);
    expect(audit.totals.weakEvidence).toBe(1);
    expect(audit.totals.weakEvidenceOpen).toBe(1);
    expect(audit.totals.weakEvidencePending).toBe(0);
    expect(audit.totals.missingEvidence).toBe(1);
    expect(audit.totals.stale).toBe(1);
    expect(audit.totals.duplicates).toBe(1);
    expect(audit.totals.suspiciousProjectNames).toBe(1);
    expect(audit.weakEvidence[0].title).toBe('weak evidence loop');
    expect(audit.stale[0].title).toBe('stale loop');
    expect(audit.duplicates[0].similarity).toBe(1);
  });

  it('flags assistant replies used as session project names', () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    const projectName = 'ZCode · 你指的是哪个插件？我无法直接操作你的电脑，但可以指导你启用';

    store.saveSignal(makeSignal('codex:s1:title', '需要把配置补上', 'assistant'));
    seedLoop(store, '补配置', ['codex:s1:title'], { projectName });
    store.saveSignal(makeSignal('codex:s1:unnamed', '还差一个导出包', 'assistant'));
    seedLoop(store, '补导出包', ['codex:s1:unnamed'], {
      projectName: 'WorkBuddy · 未命名会话',
    });

    const audit = buildLoopAudit({ store });
    expect(audit.totals.suspiciousProjectNames).toBe(1);
    expect(audit.suspiciousProjects).toEqual([projectName]);
  });

  it('formats the audit without dumping every item', () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    for (let index = 0; index < 25; index += 1) {
      store.saveSignal(makeSignal(`codex:s1:w${index}`, '好'));
      seedLoop(store, `weak ${index}`, [`codex:s1:w${index}`]);
    }

    const text = formatLoopAudit(buildLoopAudit({ store }), 5);
    expect(text).toContain('# 开放循环审计');
    expect(text).toContain('弱证据 (25)');
    expect(text.split('\n').filter((line) => line.startsWith('- [open] alpha · weak ')))
      .toHaveLength(5);
  });

  it('finds non-exact duplicates through the token index', () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    store.saveSignal(makeSignal('codex:s1:a', '登录页错误提示还没补', 'assistant'));
    const first = seedLoop(store, '补齐登录页错误提示', ['codex:s1:a']);
    const db = (store as any).db;
    db.prepare(`
      INSERT INTO loops (
        id, title, next_action, why, status, confidence, project_dir, project_name,
        source_signal_ids, first_seen, last_seen, dedupe_key, ignored_count
      ) SELECT ?, ?, next_action, why, status, confidence, project_dir, project_name,
        source_signal_ids, first_seen, last_seen, ?, ignored_count
      FROM loops WHERE id = ?
    `).run('loop_reordered', '登录页错误提示补齐', 'reordered-key', first.id);

    const audit = buildLoopAudit({ store });
    expect(audit.totals.duplicates).toBe(1);
    expect(audit.duplicates[0].similarity).toBe(0.78);
  });

  it('downgrades open weak-evidence loops but leaves pending ones untouched', () => {
    const store = new LoopStore(':memory:');
    stores.push(store);

    store.saveSignal(makeSignal('codex:s1:weak-open', '继续'));
    const open = seedLoop(store, 'open weak loop', ['codex:s1:weak-open']);

    store.saveSignal(makeSignal('codex:s1:weak-pending', '你看着办'));
    const pending = seedLoop(store, 'pending weak loop', ['codex:s1:weak-pending']);
    store.updateLoop(pending.id, { status: 'pending' });

    const audit = buildLoopAudit({ store });
    const applied = downgradeWeakEvidence(store, audit);

    expect(applied).toEqual([open.id]);
    expect(store.getLoop(open.id)?.status).toBe('pending');
    expect(store.getLoop(open.id)?.resolutionNote).toContain('弱证据');
    expect(store.getLoop(pending.id)?.status).toBe('pending');

    const after = buildLoopAudit({ store });
    expect(after.totals.weakEvidence).toBe(2);
    expect(after.totals.weakEvidenceOpen).toBe(0);
    expect(after.totals.weakEvidencePending).toBe(2);
    expect(after.weakEvidence.map((item) => item.status)).toEqual(['pending', 'pending']);
  });

  it('detects and drops loops sourced only from tracker digests', () => {
    const store = new LoopStore(':memory:');
    stores.push(store);

    store.saveSignal(makeSignal(
      'codex:s1:digest',
      '# 今天提过 · 3 条\n\n1. **focusflow 冷启动**\n\n回编号或 ref 看下一步和依据。',
      'assistant',
    ));
    const artifact = seedLoop(store, 'focusflow 冷启动重复项', ['codex:s1:digest']);

    store.saveSignal(makeSignal(
      'codex:s1:real',
      '登录错误提示还没补，下一步补上。',
      'assistant',
    ));
    const real = seedLoop(store, '登录错误提示', ['codex:s1:real']);

    const audit = buildLoopAudit({ store });
    expect(audit.totals.selfGenerated).toBe(1);
    expect(audit.selfGenerated[0].id).toBe(artifact.id);

    const applied = dropSelfGeneratedLoops(store, audit);
    expect(applied).toEqual([artifact.id]);
    expect(store.getLoop(artifact.id)?.status).toBe('dropped');
    expect(store.getLoop(artifact.id)?.resolutionNote).toContain('自摄入');
    expect(store.getLoop(real.id)?.status).toBe('open');
  });

  it('audits every active loop beyond the old 1000-row window', () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
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
      for (let index = 0; index < 1_005; index += 1) {
        insert.run(`loop_bulk_${index}`, `B${index}`, `next ${index}`, 'bulk', at, at, `dedupe_bulk_${index}`);
      }
      db.exec('COMMIT;');
    } catch (error) {
      db.exec('ROLLBACK;');
      throw error;
    }

    const audit = buildLoopAudit({ store, now: new Date('2026-11-11T12:00:00.000Z') });
    expect(audit.totals.active).toBe(1_005);
    expect(audit.totals.missingEvidence).toBe(1_005);
  });

  it('counts loops by evidence origin and lists assistant-sourced loops', () => {
    const store = new LoopStore(':memory:');
    stores.push(store);

    store.saveSignal(makeSignal(
      'codex:s1:assistant',
      '登录页错误提示还没补。',
      'assistant',
    ));
    seedLoop(store, 'assistant loop', ['codex:s1:assistant']);

    store.saveSignal(makeSignal(
      'codex:s1:user',
      '导出按钮还没做。',
      'user',
    ));
    seedLoop(store, 'user loop', ['codex:s1:user']);

    store.saveSignal(makeSignal(
      'codex:s1:mixed-assistant',
      '登录页错误提示还没补。',
      'assistant',
    ));
    store.saveSignal(makeSignal(
      'codex:s1:mixed-user',
      '导出按钮还没做。',
      'user',
    ));
    seedLoop(store, 'mixed loop', [
      'codex:s1:mixed-assistant',
      'codex:s1:mixed-user',
    ]);

    const audit = buildLoopAudit({ store });
    expect(audit.totals.userSourced).toBe(1);
    expect(audit.totals.assistantSourced).toBe(1);
    expect(audit.totals.mixedSourced).toBe(1);
    expect(audit.assistantSourced.map((item) => item.title)).toEqual(['assistant loop']);

    const text = formatLoopAudit(audit);
    expect(text).toContain('来源：用户 1 / 助手 1 / 混合 1');
    expect(text).toContain('## 助手来源 (1)');
  });

  it('flags assistant status snapshots without closing them', () => {
    const store = new LoopStore(':memory:');
    stores.push(store);

    store.saveSignal(makeSignal(
      'codex:s1:snapshot',
      '真实反馈仍为 0，待你判定。',
      'assistant',
    ));
    const snapshot = seedLoop(store, '真实反馈仍为 0，待你判定', ['codex:s1:snapshot']);

    store.saveSignal(makeSignal(
      'codex:s1:real-task',
      '登录页错误提示还没补。',
      'assistant',
    ));
    seedLoop(store, '补齐登录页错误提示', ['codex:s1:real-task']);

    const audit = buildLoopAudit({ store });
    expect(audit.totals.statusSnapshots).toBe(1);
    expect(audit.statusSnapshots.map((item) => item.title))
      .toEqual(['真实反馈仍为 0，待你判定']);
    expect(store.getLoop(snapshot.id)?.status).toBe('open');
    expect(formatLoopAudit(audit)).toContain('## 可能过期的状态快照 (1)');
  });
});
