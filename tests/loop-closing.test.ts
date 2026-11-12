import { describe, it, expect, afterEach } from 'vitest';
import { LoopStore } from '../src/loops/loop-store.js';
import { buildClosingReview, formatClosingReview } from '../src/loops/closing.js';
import { loopRef } from '../src/loops/loop-ref.js';

const stores: LoopStore[] = [];

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
});

function openStore(): LoopStore {
  const store = new LoopStore(':memory:');
  stores.push(store);
  return store;
}

function seed(
  store: LoopStore,
  title: string,
  overrides: Partial<{ projectDir: string; projectName: string; firstSeen: string }> = {},
) {
  const projectDir = overrides.projectDir ?? 'C:/work/alpha';
  return store.saveLoop(
    {
      title,
      nextAction: `next ${title}`,
      why: `why ${title}`,
      confidence: 0.9,
      sourceSignalIds: [`sig-${title}`],
    },
    {
      projectDir,
      projectName: overrides.projectName ?? 'alpha',
      firstSeen: overrides.firstSeen ?? '2026-11-10T10:00:00.000Z',
      lastSeen: overrides.firstSeen ?? '2026-11-10T10:00:00.000Z',
    },
  ).loop;
}

function seedWithRoles(store: LoopStore, title: string, roles: Array<'user' | 'assistant'>) {
  const signalIds = roles.map((role, index) => {
    const signalId = `sig-${title}:${role}:${index}`;
    store.saveSignal({
      id: signalId,
      source: 'session',
      sourceId: 'session-alpha',
      messageId: `msg-${title}:${index}`,
      agent: 'codex',
      role,
      text: `${role} message ${title}`,
      projectDir: 'C:/work/alpha',
      capturedAt: '2026-11-10T10:00:00.000Z',
      contentHash: `hash-${signalId}`,
    });
    return signalId;
  });
  return store.saveLoop(
    {
      title,
      nextAction: `next ${title}`,
      why: `why ${title}`,
      confidence: 0.9,
      sourceSignalIds: signalIds,
    },
    {
      projectDir: 'C:/work/alpha',
      projectName: 'alpha',
      firstSeen: '2026-11-10T10:00:00.000Z',
      lastSeen: '2026-11-10T10:00:00.000Z',
    },
  ).loop;
}

function seedAssistant(store: LoopStore, title: string) {
  return seedWithRoles(store, title, ['assistant']);
}

function seedUser(store: LoopStore, title: string) {
  return seedWithRoles(store, title, ['user']);
}

function seedMixed(store: LoopStore, title: string) {
  return seedWithRoles(store, title, ['user', 'assistant']);
}

describe('buildClosingReview', () => {
  it('lists presented-but-open loops by repeat count and oldest last show', () => {
    const store = openStore();
    const a = seed(store, 'A');
    const b = seed(store, 'B');
    const c = seed(store, 'C');
    store.recordPresentation([a.id], '2026-11-10T11:00:00.000Z', 'hot', 'hot');
    store.recordPresentation([a.id], '2026-11-10T12:00:00.000Z', 'hot', 'recap');
    store.recordPresentation([b.id], '2026-11-10T13:00:00.000Z', 'hot', 'hot');
    store.recordPresentation([c.id], '2026-11-10T12:30:00.000Z', 'review', 'review');

    const review = buildClosingReview({
      store,
      now: new Date('2026-11-10T14:00:00.000Z'),
    });

    expect(review.total).toBe(3);
    expect(review.shown).toBe(3);
    expect(review.items.map((item) => item.id)).toEqual([a.id, c.id, b.id]);
    expect(review.items[0].ref).toBe(loopRef(a.id));
    expect(review.items[0].presentationCount).toBe(2);
    expect(review.items[0].firstPresentedAt).toBe('2026-11-10T11:00:00.000Z');
    expect(review.items[0].lastPresentedAt).toBe('2026-11-10T12:00:00.000Z');

    const text = formatClosingReview(review);
    expect(text).toContain('# 收尾清单 · 3 条已展示未关闭');
    expect(text).toContain('展示 2 次');
    expect(text).toContain(`[ref ${loopRef(a.id)}]`);
    expect(text).toContain('下一步：next A');
    expect(text).toContain('来源构成：用户 0 · 助手 0 · 混合 3。');
    expect(text).toContain('没说的一律保持原状');
  });

  it('labels assistant-sourced items in the closing list', () => {
    const store = openStore();
    const assistant = seedAssistant(store, 'Assistant idea');
    store.recordPresentation([assistant.id], '2026-11-10T11:00:00.000Z', 'hot', 'hot');

    const review = buildClosingReview({
      store,
      now: new Date('2026-11-10T14:00:00.000Z'),
    });

    expect(review.items[0].origin).toBe('assistant');
    expect(formatClosingReview(review)).toContain('助手来源');
  });

  it('puts user-sourced items before assistant ones at equal completion status', () => {
    const store = openStore();
    const user = seedUser(store, 'User task');
    const assistant = seedAssistant(store, 'Assistant idea');
    store.recordPresentation([user.id], '2026-11-10T11:00:00.000Z', 'hot', 'hot');
    store.recordPresentation([assistant.id], '2026-11-10T11:30:00.000Z', 'hot', 'hot');
    store.recordPresentation([assistant.id], '2026-11-10T11:40:00.000Z', 'hot', 'hot');

    const review = buildClosingReview({
      store,
      now: new Date('2026-11-10T14:00:00.000Z'),
    });

    expect(review.items.map((item) => item.id)).toEqual([user.id, assistant.id]);
  });

  it('puts completion evidence first and shows the reason', () => {
    const store = openStore();
    const completed = seed(store, 'Completed candidate');
    const plain = seed(store, 'Plain task');
    store.recordPresentation([plain.id], '2026-11-10T11:30:00.000Z', 'hot', 'hot');
    store.recordPresentation([completed.id], '2026-11-10T11:00:00.000Z', 'hot', 'hot');
    store.setReconcileCache(
      'session-alpha',
      'hash-alpha',
      [{
        loopId: completed.id,
        confidence: 0.98,
        reason: '后续提交已包含修复\n并复跑通过',
        evidenceMessageIds: [],
      }],
      '2026-11-10T12:00:00.000Z',
    );

    const review = buildClosingReview({
      store,
      now: new Date('2026-11-10T14:00:00.000Z'),
    });

    expect(review.completionTotal).toBe(1);
    expect(review.items.map((item) => item.id)).toEqual([completed.id, plain.id]);
    expect(review.items[0].completion?.confidence).toBe(0.98);

    const text = formatClosingReview(review);
    expect(text).toContain('其中 1 条已有完成证据');
    expect(text).toContain('可能已完成（98%）：后续提交已包含修复 并复跑通过');
  });

  it('does not label low-confidence completion candidates', () => {
    const store = openStore();
    const loop = seed(store, 'Weak completion');
    store.recordPresentation([loop.id], '2026-11-10T11:00:00.000Z', 'hot', 'hot');
    store.setReconcileCache(
      'session-alpha',
      'hash-alpha',
      [{
        loopId: loop.id,
        confidence: 0.89,
        reason: '只是讨论过，不能确认完成',
        evidenceMessageIds: [],
      }],
      '2026-11-10T12:00:00.000Z',
    );

    const review = buildClosingReview({
      store,
      now: new Date('2026-11-10T14:00:00.000Z'),
    });

    expect(review.completionTotal).toBe(0);
    expect(review.items[0].completion).toBeUndefined();
    expect(formatClosingReview(review)).not.toContain('可能已完成');
  });

  it('can show only items with completion evidence', () => {
    const store = openStore();
    const completed = seed(store, 'Completed candidate');
    const plain = seed(store, 'Plain task');
    store.recordPresentation([plain.id], '2026-11-10T11:30:00.000Z', 'hot', 'hot');
    store.recordPresentation([completed.id], '2026-11-10T11:00:00.000Z', 'hot', 'hot');
    store.setReconcileCache(
      'session-alpha',
      'hash-alpha',
      [{
        loopId: completed.id,
        confidence: 0.98,
        reason: '后续提交已包含修复',
        evidenceMessageIds: [],
      }],
      '2026-11-10T12:00:00.000Z',
    );

    const review = buildClosingReview({
      store,
      now: new Date('2026-11-10T14:00:00.000Z'),
      completionOnly: true,
    });

    expect(review.completionOnly).toBe(true);
    expect(review.total).toBe(1);
    expect(review.completionTotal).toBe(1);
    expect(review.items.map((item) => item.id)).toEqual([completed.id]);
    const text = formatClosingReview(review);
    expect(text).toContain('只看完成证据');
    expect(text).toContain('这些条目都已有完成证据');
    expect(text).toContain('全部完成');
    expect(text).not.toContain('Plain task');
  });

  it('explains an empty completion-only closing review', () => {
    const store = openStore();
    const plain = seed(store, 'Plain task');
    store.recordPresentation([plain.id], '2026-11-10T11:30:00.000Z', 'hot', 'hot');

    const review = buildClosingReview({
      store,
      now: new Date('2026-11-10T14:00:00.000Z'),
      completionOnly: true,
    });

    expect(review.total).toBe(0);
    expect(formatClosingReview(review)).toContain('没有带完成证据');
  });

  it('filters by origin while keeping totals for every source', () => {
    const store = openStore();
    const user = seedUser(store, 'User task');
    const assistant = seedAssistant(store, 'Assistant idea');
    const mixed = seedMixed(store, 'Mixed task');
    for (const loop of [user, assistant, mixed]) {
      store.recordPresentation([loop.id], '2026-11-10T11:00:00.000Z', 'hot', 'hot');
    }

    const all = buildClosingReview({
      store,
      now: new Date('2026-11-10T14:00:00.000Z'),
    });
    expect(all.total).toBe(3);
    expect(all.originTotals).toEqual({ user: 1, assistant: 1, mixed: 1 });

    const assistantOnly = buildClosingReview({
      store,
      now: new Date('2026-11-10T14:00:00.000Z'),
      origin: 'assistant',
    });
    expect(assistantOnly.origin).toBe('assistant');
    expect(assistantOnly.total).toBe(1);
    expect(assistantOnly.items[0].id).toBe(assistant.id);
    expect(assistantOnly.originTotals).toEqual({ user: 1, assistant: 1, mixed: 1 });
    expect(formatClosingReview(assistantOnly)).toContain('# 收尾清单 · 助手来源 · 1 条');
    expect(formatClosingReview(assistantOnly)).toContain(
      '当前范围来源：用户 1 · 助手 1 · 混合 1；下面只列助手来源。',
    );

    const userOnly = buildClosingReview({
      store,
      now: new Date('2026-11-10T14:00:00.000Z'),
      origin: 'user',
    });
    expect(userOnly.total).toBe(1);
    expect(userOnly.items[0].id).toBe(user.id);

    const mixedOnly = buildClosingReview({
      store,
      now: new Date('2026-11-10T14:00:00.000Z'),
      origin: 'mixed',
    });
    expect(mixedOnly.total).toBe(1);
    expect(mixedOnly.items[0].id).toBe(mixed.id);
    expect(formatClosingReview(mixedOnly)).toContain('混合来源');
  });

  it('reports the other sources when an origin filter has no matches', () => {
    const store = openStore();
    const user = seedUser(store, 'User task');
    store.recordPresentation([user.id], '2026-11-10T11:00:00.000Z', 'hot', 'hot');

    const review = buildClosingReview({
      store,
      now: new Date('2026-11-10T14:00:00.000Z'),
      origin: 'assistant',
    });

    expect(review.total).toBe(0);
    expect(review.originTotals).toEqual({ user: 1, assistant: 0, mixed: 0 });
    expect(formatClosingReview(review)).toBe(
      '没有来源为「助手来源」的已展示未关闭循环；其他来源还有 1 条。',
    );
  });

  it('caps shown items while keeping the full total', () => {
    const store = openStore();
    const loops = ['A', 'B', 'C'].map((title) => seed(store, title));
    loops.forEach((loop, index) => {
      store.recordPresentation([loop.id], `2026-11-10T1${index}:00:00.000Z`, 'hot', 'hot');
    });

    const review = buildClosingReview({
      store,
      now: new Date('2026-11-10T14:00:00.000Z'),
      limit: 2,
    });

    expect(review.total).toBe(3);
    expect(review.shown).toBe(2);
    expect(review.items).toHaveLength(2);
    expect(formatClosingReview(review)).toContain('还有 1 条没列');
  });

  it('filters the closing list by project directory', () => {
    const store = openStore();
    const alpha = seed(store, 'A');
    const beta = seed(store, 'B', {
      projectDir: 'C:/work/beta',
      projectName: 'beta',
    });
    store.recordPresentation([alpha.id], '2026-11-10T11:00:00.000Z', 'hot', 'hot');
    store.recordPresentation([beta.id], '2026-11-10T12:00:00.000Z', 'hot', 'hot');

    const review = buildClosingReview({
      store,
      now: new Date('2026-11-10T14:00:00.000Z'),
      projectDir: 'C:\\work\\beta\\',
    });

    expect(review.total).toBe(1);
    expect(review.items[0].id).toBe(beta.id);
  });

  it('resolves a relative project filter against the current directory', () => {
    const store = openStore();
    const current = seed(store, 'Current', {
      projectDir: process.cwd(),
      projectName: 'current',
    });
    store.recordPresentation([current.id], '2026-11-10T11:00:00.000Z', 'hot', 'hot');

    const review = buildClosingReview({
      store,
      now: new Date('2026-11-10T14:00:00.000Z'),
      projectDir: '.',
    });

    expect(review.total).toBe(1);
    expect(review.items[0].id).toBe(current.id);
  });

  it('excludes never-presented, resolved, and snoozed loops', () => {
    const store = openStore();
    const presented = seed(store, 'A');
    const resolved = seed(store, 'B');
    const snoozed = seed(store, 'C');
    seed(store, 'D');
    for (const loop of [presented, resolved, snoozed]) {
      store.recordPresentation([loop.id], '2026-11-10T11:00:00.000Z', 'hot', 'hot');
    }
    store.updateLoop(resolved.id, { status: 'resolved' });
    store.updateLoop(snoozed.id, {
      status: 'snoozed',
      snoozeUntil: '2099-01-01T00:00:00.000Z',
    });

    const review = buildClosingReview({
      store,
      now: new Date('2026-11-10T14:00:00.000Z'),
    });

    expect(review.total).toBe(1);
    expect(review.items[0].id).toBe(presented.id);
  });

  it('reports an empty state', () => {
    const store = openStore();
    seed(store, 'never shown');

    const review = buildClosingReview({
      store,
      now: new Date('2026-11-10T14:00:00.000Z'),
    });

    expect(review.total).toBe(0);
    expect(formatClosingReview(review)).toBe('没有“已展示但未关闭”的循环。');
  });
});
