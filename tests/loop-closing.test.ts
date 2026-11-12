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
    expect(text).toContain('没说的一律保持原状');
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
