import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LoopStore } from '../src/loops/loop-store.js';
import {
  buildPresentationRepairReport,
  formatPresentationRepairReport,
} from '../src/loops/presentations.js';

const dirs: string[] = [];
const NOW = new Date('2026-11-11T12:00:00.000Z');

afterEach(() => {
  while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempDb(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `loops-presentations-${label}-`));
  dirs.push(dir);
  return path.join(dir, 'loops.db');
}

describe('presentation repair', () => {
  it('lists only future-dated presentations', () => {
    const store = new LoopStore(tempDb('list'));
    store.recordPresentation(['loop_past'], '2026-11-10T12:00:00.000Z');
    store.recordPresentation(['loop_future'], '2026-11-13T12:00:00.000Z');

    const report = buildPresentationRepairReport({ store, now: NOW });

    expect(report.applied).toBe(false);
    expect(report.futureCount).toBe(1);
    expect(report.deleted).toBe(0);
    expect(report.records[0]).toMatchObject({
      presentedAt: '2026-11-13T12:00:00.000Z',
      loopIds: ['loop_future'],
    });
    expect(store.listPresentationsAfter(NOW.toISOString())).toHaveLength(1);
    store.close();
  });

  it('treats presentations within the clock-skew tolerance as current', () => {
    const store = new LoopStore(tempDb('skew'));
    const nearFuture = new Date(NOW.getTime() + 2 * 60 * 1000).toISOString();
    store.recordPresentation(['loop_skew'], nearFuture);

    const report = buildPresentationRepairReport({ store, now: NOW });

    expect(report.futureCount).toBe(0);
    expect(report.deleted).toBe(0);
    expect(store.listPresentationsAfter(NOW.toISOString())).toHaveLength(1);
    store.close();
  });

  it('deletes only future-dated presentations when apply is true', () => {
    const store = new LoopStore(tempDb('apply'));
    store.recordPresentation(['loop_past'], '2026-11-10T12:00:00.000Z');
    store.recordPresentation(['loop_future'], '2026-11-13T12:00:00.000Z');

    const report = buildPresentationRepairReport({ store, now: NOW, apply: true });

    expect(report.applied).toBe(true);
    expect(report.futureCount).toBe(1);
    expect(report.deleted).toBe(1);
    expect(store.countPresentationsAfter(NOW.toISOString())).toBe(0);
    expect(store.getFirstPresentationTimes(NOW.toISOString()).has('loop_past')).toBe(true);
    store.close();
  });

  it('formats dry-run and applied reports', () => {
    const store = new LoopStore(tempDb('format'));
    store.recordPresentation(['loop_future'], '2026-11-13T12:00:00.000Z');

    const dryRun = buildPresentationRepairReport({ store, now: NOW });
    expect(formatPresentationRepairReport(dryRun)).toContain('dry-run');
    expect(formatPresentationRepairReport(dryRun)).toContain('未来展示记录：1 条');

    const applied = buildPresentationRepairReport({ store, now: NOW, apply: true });
    expect(formatPresentationRepairReport(applied)).toContain('已删除 1 条');
    expect(formatPresentationRepairReport(buildPresentationRepairReport({ store, now: NOW })))
      .toBe('没有未来展示记录。');
    store.close();
  });
});
