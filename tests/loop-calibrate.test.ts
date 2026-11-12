import { afterEach, describe, expect, it } from 'vitest';
import { LoopStore } from '../src/loops/loop-store.js';
import { buildCalibration, formatCalibration } from '../src/loops/calibrate.js';

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
  project: string,
  title: string,
  confidence: number,
  lastSeen: string,
) {
  return store.saveLoop(
    {
      title,
      nextAction: `next ${title}`,
      why: `why ${title}`,
      confidence,
      sourceSignalIds: [`${project}:${title}`],
    },
    { projectDir: `C:/work/${project}`, projectName: project, lastSeen },
  ).loop;
}

describe('buildCalibration', () => {
  it('prefers never-surfaced items, balances projects, and excludes judged or snoozed loops', () => {
    const store = openStore();
    const now = new Date('2026-11-11T12:00:00.000Z');
    const loops = [
      seed(store, 'alpha', 'A1', 0.95, '2026-11-11T11:00:00.000Z'),
      seed(store, 'alpha', 'A2', 0.94, '2026-11-11T10:00:00.000Z'),
      seed(store, 'beta', 'B1', 0.9, '2026-11-11T09:00:00.000Z'),
      seed(store, 'gamma', 'C1', 0.85, '2026-11-11T08:00:00.000Z'),
      seed(store, 'delta', 'D1', 0.8, '2026-11-11T07:00:00.000Z'),
      seed(store, 'epsilon', 'E1', 0.75, '2026-11-11T06:00:00.000Z'),
      seed(store, 'zeta', 'F1', 0.99, '2026-11-11T05:00:00.000Z'),
      seed(store, 'eta', 'G1', 0.99, '2026-11-11T04:00:00.000Z'),
    ];
    store.recordSurfaced([loops[4].id, loops[5].id], '2026-11-11T11:30:00.000Z');
    store.recordFeedback(loops[6].id, 'noise', 'already judged', '2026-11-11T11:40:00.000Z');
    store.updateLoop(loops[7].id, {
      status: 'snoozed',
      snoozeUntil: '2026-11-12T12:00:00.000Z',
    });

    const result = buildCalibration({ store, now, limit: 5 });

    expect(result.total).toBe(5);
    expect(result.items.map((item) => item.title)).toEqual(['A1', 'B1', 'C1', 'D1', 'E1']);
    expect(result.items.slice(0, 3).every((item) => item.lastSurfacedAt === undefined)).toBe(true);
    expect(result.items.map((item) => item.projectName)).not.toContain('zeta');
    expect(result.items.map((item) => item.projectName)).not.toContain('eta');
    expect(new Set(result.items.map((item) => item.ref)).size).toBe(5);
  });

  it('respects the requested limit', () => {
    const store = openStore();
    const now = new Date('2026-11-11T12:00:00.000Z');
    seed(store, 'alpha', 'A1', 0.9, now.toISOString());
    seed(store, 'beta', 'B1', 0.8, now.toISOString());
    seed(store, 'gamma', 'C1', 0.7, now.toISOString());

    expect(buildCalibration({ store, now, limit: 2 }).total).toBe(2);
  });

  it('renders refs and a clear reply format', () => {
    const store = openStore();
    const now = new Date('2026-11-11T12:00:00.000Z');
    seed(store, 'alpha', 'A1', 0.9, now.toISOString());

    const output = formatCalibration(buildCalibration({ store, now, limit: 5 }));

    expect(output).toContain('# 回访校准 · 1 条');
    expect(output).toContain('[ref ');
    expect(output).toContain('编号 + 判断');
    expect(output).toContain('「1 忘了」');
  });

  it('explains an empty calibration set', () => {
    const store = openStore();
    const output = formatCalibration(buildCalibration({ store, limit: 5 }));

    expect(output).toContain('0 条');
    expect(output).toContain('没有可校准');
  });
});
