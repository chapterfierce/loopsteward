import { describe, it, expect, afterEach } from 'vitest';
import { LoopStore } from '../src/loops/loop-store.js';
import {
  applySessionArchive,
  buildSessionArchivePlan,
  formatSessionArchivePlan,
} from '../src/loops/session-archive.js';

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
  projectName: string,
  projectDir: string,
  lastSeen: string,
) {
  return store.saveLoop(
    {
      title,
      nextAction: `next ${title}`,
      why: `why ${title}`,
      confidence: 0.8,
      sourceSignalIds: [`sig-${title}`],
    },
    { projectDir, projectName, firstSeen: lastSeen, lastSeen },
  ).loop;
}

describe('session archive', () => {
  const now = new Date('2026-11-12T00:00:00.000Z');

  it('selects only stale session-only loops', () => {
    const store = openStore();
    const stale = seed(
      store,
      'Stale session',
      'Hermes · 排查旧问题',
      'C:/hermes/a',
      '2026-10-20T00:00:00.000Z',
    );
    seed(store, 'Fresh session', 'Hermes · 新问题', 'C:/hermes/b', '2026-11-10T00:00:00.000Z');
    seed(store, 'Real project', 'sample-app', 'C:/work/sample-app', '2026-10-20T00:00:00.000Z');

    const plan = buildSessionArchivePlan({ store, now, days: 14 });

    expect(plan.total).toBe(1);
    expect(plan.items[0].id).toBe(stale.id);
    expect(plan.items[0].daysIdle).toBeGreaterThanOrEqual(14);
  });

  it('keeps loops the user explicitly said were forgotten', () => {
    const store = openStore();
    const loop = seed(
      store,
      'Remembered',
      'ZCode · 旧会话',
      'C:/zcode/a',
      '2026-10-01T00:00:00.000Z',
    );
    store.recordFeedback(loop.id, 'forgotten', 'user said forgotten', '2026-10-02T00:00:00.000Z');

    const plan = buildSessionArchivePlan({ store, now, days: 14 });

    expect(plan.total).toBe(0);
  });

  it('applies the plan as dropped and can be restored', () => {
    const store = openStore();
    const loop = seed(
      store,
      'Stale',
      'WorkBuddy · 旧会话',
      'C:/wb/a',
      '2026-10-01T00:00:00.000Z',
    );
    const plan = buildSessionArchivePlan({ store, now, days: 14 });
    expect(plan.total).toBe(1);

    expect(applySessionArchive(store, plan).archived).toBe(1);
    expect(store.getLoop(loop.id)?.status).toBe('dropped');
    expect(store.getLoop(loop.id)?.resolutionNote).toContain('session-only');
    expect(buildSessionArchivePlan({ store, now, days: 14 }).total).toBe(0);

    store.updateLoop(loop.id, { status: 'open' });
    expect(store.getLoop(loop.id)?.status).toBe('open');
  });

  it('archives only the shown batch, not everything matched', () => {
    const store = openStore();
    const first = seed(store, 'Stale A', 'Qoder · 旧会话A', 'C:/qoder/a', '2026-10-01T00:00:00.000Z');
    const second = seed(store, 'Stale B', 'Qoder · 旧会话B', 'C:/qoder/b', '2026-10-02T00:00:00.000Z');
    const third = seed(store, 'Stale C', 'Qoder · 旧会话C', 'C:/qoder/c', '2026-10-03T00:00:00.000Z');

    const plan = buildSessionArchivePlan({ store, now, days: 14, limit: 2 });
    expect(plan.total).toBe(3);
    expect(plan.shown).toBe(2);

    const result = applySessionArchive(store, plan);
    expect(result.archived).toBe(2);
    expect(result.remaining).toBe(1);
    expect(store.getLoop(first.id)?.status).toBe('dropped');
    expect(store.getLoop(second.id)?.status).toBe('dropped');
    expect(store.getLoop(third.id)?.status).toBe('open');
  });

  it('renders a preview with refs and the apply hint', () => {
    const store = openStore();
    seed(store, 'Stale', 'Qoder · 旧会话', 'C:/qoder/a', '2026-10-01T00:00:00.000Z');

    const text = formatSessionArchivePlan(buildSessionArchivePlan({ store, now, days: 14 }));

    expect(text).toContain('临时会话归档');
    expect(text).toContain('[ref ');
    expect(text).toContain('--apply');
  });
});
