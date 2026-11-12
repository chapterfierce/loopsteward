import { describe, it, expect, afterEach } from 'vitest';
import { LoopStore } from '../src/loops/loop-store.js';
import { buildDigest } from '../src/loops/digest.js';
import { buildClosingReview } from '../src/loops/closing.js';
import { buildLoopStats } from '../src/loops/stats.js';

const stores: LoopStore[] = [];

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
});

describe('loop lifecycle', () => {
  it('counts a loop as resolved after it was presented and then closed', () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    const now = new Date();
    const firstSeen = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    store.recordProjectActivity('C:/work/alpha', 'alpha', now.toISOString(), 's1');
    const loop = store.saveLoop(
      {
        title: 'Finish the migration',
        nextAction: 'Run the migration and verify the result',
        why: 'The last session stopped halfway',
        confidence: 0.9,
        sourceSignalIds: ['sig-1'],
      },
      {
        projectDir: 'C:/work/alpha',
        projectName: 'alpha',
        firstSeen,
        lastSeen: firstSeen,
      },
    ).loop;

    const digest = buildDigest({
      store,
      mode: 'hot',
      now,
      maxLoops: 3,
      dailySurfaceLimit: 3,
    });
    expect(digest.total).toBe(1);
    expect(digest.groups[0].loops[0].id).toBe(loop.id);

    const closing = buildClosingReview({
      store,
      now: new Date(now.getTime() + 60 * 1000),
    });
    expect(closing.total).toBe(1);
    expect(closing.items[0].id).toBe(loop.id);
    expect(closing.items[0].presentationCount).toBe(1);

    store.updateLoop(loop.id, {
      status: 'resolved',
      note: 'user confirmed done in closing review',
    });

    const stats = buildLoopStats({
      store,
      now: new Date(now.getTime() + 2 * 60 * 1000),
      windowDays: 30,
    });
    expect(stats.surfacing.presented).toBe(1);
    expect(stats.surfacing.resolvedAfterPresentation).toBe(1);
    expect(stats.surfacing.resolvedAfterPresentationInWindow).toBe(1);
    expect(stats.resolution.resolvedInWindow).toBe(1);

    const afterClose = buildClosingReview({
      store,
      now: new Date(now.getTime() + 2 * 60 * 1000),
    });
    expect(afterClose.total).toBe(0);
  });
});
