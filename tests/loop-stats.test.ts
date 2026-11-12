import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import { LoopStore } from '../src/loops/loop-store.js';
import { buildLoopStats, formatLoopStats } from '../src/loops/stats.js';

const stores: LoopStore[] = [];

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
});

function seed(
  store: LoopStore,
  title: string,
  options: {
    confidence?: number;
    firstSeen?: string;
    lastSeen?: string;
    projectDir?: string;
    projectName?: string;
    sourceSignalIds?: string[];
  } = {},
) {
  return store.saveLoop(
    {
      title,
      nextAction: `next: ${title}`,
      why: 'test',
      confidence: options.confidence ?? 0.8,
      sourceSignalIds: options.sourceSignalIds ?? [`codex:s1:${title}`],
    },
    {
      projectDir: options.projectDir ?? path.normalize('C:/work/alpha'),
      projectName: options.projectName ?? 'alpha',
      firstSeen: options.firstSeen ?? new Date().toISOString(),
      lastSeen: options.lastSeen ?? new Date().toISOString(),
    },
  ).loop;
}

function insertMany(store: LoopStore, count: number): void {
  const db = (store as any).db;
  const insert = db.prepare(`
    INSERT INTO loops (
      id, title, next_action, why, status, confidence, project_dir, project_name,
      source_signal_ids, first_seen, last_seen, dedupe_key, ignored_count
    ) VALUES (?, ?, ?, 'bulk', 'open', 0.8, 'C:/work/bulk', 'bulk', '[]', ?, ?, ?, 0)
  `);
  const at = '2026-11-10T10:00:00.000Z';
  db.exec('BEGIN;');
  try {
    for (let index = 0; index < count; index += 1) {
      insert.run(`loop_stats_${index}`, `Stats ${index}`, `next ${index}`, at, at, `stats_${index}`);
    }
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
}

describe('buildLoopStats', () => {
  it('counts lifecycle states, surfacing, and stale open loops', () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    const now = new Date();
    const tenHoursAgo = new Date(now.getTime() - 10 * 60 * 60 * 1000).toISOString();
    const twentyDaysAgo = new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000).toISOString();

    const resolved = seed(store, 'resolved loop', { firstSeen: tenHoursAgo });
    store.updateLoop(resolved.id, { status: 'resolved', note: 'done' });
    const dropped = seed(store, 'dropped loop');
    store.updateLoop(dropped.id, { status: 'dropped' });
    const surfaced = seed(store, 'surfaced loop');
    store.recordSurfaced([surfaced.id], now.toISOString(), false);
    seed(store, 'stale loop', { lastSeen: twentyDaysAgo });
    seed(store, 'fresh pending', { confidence: 0.5 });

    const stats = buildLoopStats({ store, now, windowDays: 30, staleDays: 14 });
    expect(stats.totals).toMatchObject({
      all: 5,
      open: 2,
      pending: 1,
      resolved: 1,
      dropped: 1,
    });
    expect(stats.resolution.resolvedInWindow).toBe(1);
    expect(stats.resolution.closureRate).toBe(0.4);
    expect(stats.resolution.resolutionRate).toBe(0.5);
    expect(stats.resolution.medianResolutionHours).toBeGreaterThanOrEqual(9.9);
    expect(stats.surfacing).toMatchObject({
      surfaced: 1,
      neverSurfaced: 4,
      resolvedAfterSurface: 0,
    });
    expect(stats.staleOpen.map((item) => item.title)).toContain('stale loop');
    expect(stats.staleOpen.find((item) => item.title === 'stale loop')?.daysStale).toBe(20);
  });

  it('reports loop origin counts', () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    const capturedAt = '2026-11-10T10:00:00.000Z';
    const base = {
      source: 'session' as const,
      sourceId: 's-origin',
      agent: 'codex' as const,
      projectDir: path.normalize('C:/work/alpha'),
      capturedAt,
    };
    store.saveSignal({
      ...base,
      id: 'codex:s-origin:user',
      messageId: 'user',
      role: 'user',
      text: '导出按钮还没做。',
      contentHash: 'user',
    });
    store.saveSignal({
      ...base,
      id: 'codex:s-origin:assistant',
      messageId: 'assistant',
      role: 'assistant',
      text: '登录页错误提示还没补。',
      contentHash: 'assistant',
    });
    seed(store, 'user origin', { sourceSignalIds: ['codex:s-origin:user'] });
    seed(store, 'assistant origin', { sourceSignalIds: ['codex:s-origin:assistant'] });

    const stats = buildLoopStats({ store });
    expect(stats.totals.origins).toEqual({ user: 1, assistant: 1, mixed: 0 });
    expect(formatLoopStats(stats)).toContain('来源：用户 1 / 助手 1 / 混合 0');
  });

  it('includes the last ingest run summary', () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    const runId = store.startRun('session');
    store.finishRun(runId, {
      sessionsSeen: 3,
      sessionsProcessed: 2,
      sessionsSkipped: 1,
      signalsSeen: 12,
      loopsCreated: 2,
      loopsMerged: 1,
      errors: ['one failure'],
    });

    const stats = buildLoopStats({ store });
    expect(stats.lastIngest).toMatchObject({
      source: 'session',
      signalsSeen: 12,
      loopsCreated: 2,
      loopsMerged: 1,
      errors: ['one failure'],
    });
  });

  it('excludes self-generated cleanup from closure metrics', () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    const now = new Date();

    const resolved = seed(store, 'real resolved loop');
    store.updateLoop(resolved.id, { status: 'resolved', note: 'done' });
    const artifact = seed(store, 'self-ingested artifact');
    store.updateLoop(artifact.id, {
      status: 'dropped',
      note: '来源是追踪器自己的回访摘要，已按自摄入污染丢弃',
    });
    seed(store, 'still open loop');

    const stats = buildLoopStats({ store, now, windowDays: 30 });
    expect(stats.totals).toMatchObject({ all: 3, resolved: 1, dropped: 1 });
    expect(stats.resolution.selfGeneratedDropped).toBe(1);
    expect(stats.resolution.closureRate).toBeCloseTo(1 / 3, 6);
    expect(stats.resolution.resolutionRate).toBe(1);
  });

  it('reports windowed success metrics from first presentation and feedback history', () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    const now = new Date();
    const hoursAgo = (hours: number) =>
      new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();
    const daysAgo = (days: number) =>
      new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

    const closedAfterSurface = seed(store, 'closed after surface', {
      firstSeen: hoursAgo(10),
    });
    store.recordSurfaced([closedAfterSurface.id], hoursAgo(4), false);
    store.recordPresentation([closedAfterSurface.id], hoursAgo(4));
    store.updateLoop(closedAfterSurface.id, { status: 'resolved', note: 'done' });

    const openSurfaced = seed(store, 'open surfaced', { firstSeen: hoursAgo(20) });
    store.recordSurfaced([openSurfaced.id], hoursAgo(2), false);
    store.recordPresentation([openSurfaced.id], hoursAgo(2));

    const neverSurfaced = seed(store, 'never surfaced', { firstSeen: hoursAgo(30) });

    store.recordFeedback(closedAfterSurface.id, 'forgotten', undefined, hoursAgo(1));
    store.recordFeedback(openSurfaced.id, 'noise', undefined, daysAgo(40));
    store.recordFeedback(neverSurfaced.id, 'forgotten', undefined, daysAgo(40));

    const stats = buildLoopStats({ store, now, windowDays: 30 });

    expect(stats.surfacing).toMatchObject({
      surfaced: 2,
      presented: 2,
      neverPresented: 1,
      neverSurfaced: 1,
      resolvedAfterPresentation: 1,
      firstPresentedInWindow: 2,
      resolvedAfterPresentationInWindow: 1,
      medianHoursToFirstPresentation: 12,
    });
    expect(stats.feedback).toMatchObject({
      forgotten: 2,
      noise: 1,
      usefulRate: 2 / 3,
      forgottenInWindow: 1,
      noiseInWindow: 0,
      usefulRateInWindow: 1,
    });
  });

  it('excludes future-dated presentations from surfacing metrics', () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    const now = new Date('2026-11-11T11:00:00.000Z');
    const valid = seed(store, 'valid presentation', {
      firstSeen: '2026-11-11T08:00:00.000Z',
    });
    const future = seed(store, 'future presentation', {
      firstSeen: '2026-11-08T08:00:00.000Z',
    });

    store.recordPresentation([valid.id], '2026-11-11T09:00:00.000Z');
    store.recordPresentation([future.id], '2026-11-13T09:00:00.000Z');

    const stats = buildLoopStats({ store, now, windowDays: 30 });

    expect(stats.surfacing).toMatchObject({
      presented: 1,
      neverPresented: 1,
      firstPresentedInWindow: 1,
      medianHoursToFirstPresentation: 1,
      futurePresentations: 1,
    });
    expect(stats.surfacing.presentationsByKind.hot).toBe(1);
  });

  it('treats near-future presentations within the clock tolerance as current', () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    const now = new Date('2026-11-11T11:00:00.000Z');
    const loop = seed(store, 'near future', {
      firstSeen: '2026-11-11T10:00:00.000Z',
    });
    store.recordPresentation([loop.id], '2026-11-11T11:02:00.000Z');

    const stats = buildLoopStats({ store, now, windowDays: 30 });

    expect(stats.surfacing).toMatchObject({
      presented: 1,
      futurePresentations: 0,
      firstPresentedInWindow: 1,
    });
  });

  it('counts every loop beyond the previous 500-row cap', () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    insertMany(store, 600);

    const stats = buildLoopStats({ store });

    expect(stats.totals.all).toBe(600);
    expect(stats.totals.open).toBe(600);
    expect(stats.projects).toHaveLength(1);
    expect(stats.projects[0]).toMatchObject({
      projectName: 'bulk',
      open: 600,
      pending: 0,
      resolved: 0,
      dropped: 0,
      sessionOnly: false,
    });
  });

  it('counts every loop beyond the previous 10,000-row cap', () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    insertMany(store, 10_005);

    const stats = buildLoopStats({ store });

    expect(stats.totals.all).toBe(10_005);
    expect(stats.totals.open).toBe(10_005);
  });

  it('groups projects by directory and collapses temporary workspaces in text', () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    seed(store, 'same name one', {
      projectDir: 'C:/work/one',
      projectName: 'workspace',
    });
    seed(store, 'same name two', {
      projectDir: 'C:/work/two',
      projectName: 'workspace',
    });
    seed(store, 'hermes temp', {
      projectDir: 'C:/Users/x/.hermes-sessions/abc',
      projectName: 'Hermes · 排查问题',
    });

    const stats = buildLoopStats({ store });

    expect(stats.projects.filter((project) => project.projectName === 'workspace')).toHaveLength(2);
    expect(stats.projectSummary).toEqual({
      real: 2,
      sessionOnly: 1,
      sessionOnlyOpen: 1,
      sessionOnlyPending: 0,
    });
    expect(stats.projects[0].sessionOnly).toBe(false);
    expect(stats.projects[stats.projects.length - 1].sessionOnly).toBe(true);

    const text = formatLoopStats(stats);
    expect(text).toContain('## 项目分布（真实 2 / 临时 1）');
    expect(text).toContain('- 另有 1 个临时会话工作区：open 1 / pending 0');
    expect(text).not.toContain('Hermes · 排查问题');
  });

  it('reports presentation batches by kind', () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    const firstSeen = '2026-11-11T08:00:00.000Z';
    const presentedAt = '2026-11-11T09:00:00.000Z';
    const hot = seed(store, 'hot loop', { firstSeen });
    const recap = seed(store, 'recap loop', { firstSeen });
    const review = seed(store, 'review loop', { firstSeen });
    const teaser = seed(store, 'teaser loop', { firstSeen });
    const candidate = seed(store, 'candidate loop', { firstSeen });

    store.recordPresentation([hot.id], presentedAt, 'hot', 'hot');
    store.recordPresentation([recap.id], presentedAt, 'hot', 'recap');
    store.recordPresentation([review.id], presentedAt, 'review', 'review');
    store.recordPresentation([teaser.id], presentedAt, 'hot', 'teaser');
    store.recordPresentation([candidate.id], presentedAt, 'hot', 'candidate');

    const stats = buildLoopStats({
      store,
      now: new Date('2026-11-11T12:00:00.000Z'),
      windowDays: 30,
    });

    expect(stats.surfacing.presentationsByKind).toEqual({
      hot: 1,
      recap: 1,
      review: 1,
      teaser: 1,
      candidate: 1,
    });
    expect(formatLoopStats(stats)).toContain(
      '展示类型（按批次）：hot 1 次 / recap 1 次 / review 1 次 / teaser 1 次 / candidate 1 次',
    );
  });
});
