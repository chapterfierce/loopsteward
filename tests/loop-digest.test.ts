import { describe, it, expect, afterEach } from 'vitest';
import { LoopStore } from '../src/loops/loop-store.js';
import { buildDigest, formatDigest, formatRecap, formatSkillDigest } from '../src/loops/digest.js';
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
  project: string,
  title: string,
  confidence: number,
  lastSeen: string,
  status?: 'open' | 'pending',
  firstSeen?: string,
) {
  const loop = store.saveLoop(
    {
      title,
      nextAction: `next ${title}`,
      why: `why ${title}`,
      confidence,
      sourceSignalIds: [`${project}:${title}`],
    },
    { projectDir: `C:/work/${project}`, projectName: project, lastSeen, firstSeen },
  ).loop;
  if (status) store.updateLoop(loop.id, { status });
  return loop;
}

describe('buildDigest', () => {
  it('limits the hot digest to 3 loops across recently active projects', () => {
    const store = openStore();
    store.recordProjectActivity('C:/work/alpha', 'alpha', '2026-11-11T11:00:00.000Z', 's1');
    store.recordProjectActivity('C:/work/beta', 'beta', '2026-11-11T10:00:00.000Z', 's2');
    store.recordProjectActivity('C:/work/gamma', 'gamma', '2026-11-06T10:00:00.000Z', 's3');

    seed(store, 'alpha', 'A1', 0.9, '2026-11-11T11:00:00.000Z');
    seed(store, 'alpha', 'A2', 0.8, '2026-11-11T10:00:00.000Z');
    seed(store, 'beta', 'B1', 0.85, '2026-11-11T10:30:00.000Z');
    seed(store, 'beta', 'B2', 0.7, '2026-11-11T10:00:00.000Z');
    seed(store, 'gamma', 'G1', 0.95, '2026-11-06T10:00:00.000Z');
    seed(store, 'alpha', 'A3-pending', 0.5, '2026-11-11T11:00:00.000Z');

    const result = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T12:00:00.000Z'),
      markSurfaced: false,
    });

    expect(result.total).toBe(3);
    expect(result.groups).toHaveLength(2);
    expect(result.groups.map((group) => group.projectName)).toEqual(['alpha', 'beta']);
    expect(result.groups.flatMap((group) => group.loops.map((loop) => loop.title)))
      .not.toContain('G1');
    expect(result.groups.flatMap((group) => group.loops.map((loop) => loop.title)))
      .not.toContain('A3-pending');
  });

  it('prefers the focus project when it has enough eligible loops', () => {
    const store = openStore();
    store.recordProjectActivity('C:/work/alpha', 'alpha', '2026-11-11T11:00:00.000Z', 's1');
    store.recordProjectActivity('C:/work/beta', 'beta', '2026-11-11T10:00:00.000Z', 's2');
    seed(store, 'alpha', 'A1', 0.95, '2026-11-11T11:00:00.000Z');
    seed(store, 'alpha', 'A2', 0.9, '2026-11-11T11:00:00.000Z');
    seed(store, 'alpha', 'A3', 0.85, '2026-11-11T11:00:00.000Z');
    seed(store, 'beta', 'B1', 0.95, '2026-11-11T10:00:00.000Z');
    seed(store, 'beta', 'B2', 0.9, '2026-11-11T10:00:00.000Z');

    const result = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T12:00:00.000Z'),
      markSurfaced: false,
      focusProjectDir: 'C:/work/alpha',
    });

    expect(result.total).toBe(3);
    expect(result.groups.map((group) => group.projectName)).toEqual(['alpha']);
    expect(result.groups[0].loops.map((loop) => loop.title)).toEqual(['A1', 'A2', 'A3']);
    expect(result.focusProject).toMatchObject({
      dir: 'C:/work/alpha',
      name: 'alpha',
      matched: true,
      shown: 3,
    });
  });

  it('fills remaining slots from other projects when the focus project is thin', () => {
    const store = openStore();
    store.recordProjectActivity('C:/work/alpha', 'alpha', '2026-11-11T11:00:00.000Z', 's1');
    store.recordProjectActivity('C:/work/beta', 'beta', '2026-11-11T10:00:00.000Z', 's2');
    seed(store, 'alpha', 'A1', 0.9, '2026-11-11T11:00:00.000Z');
    seed(store, 'beta', 'B1', 0.95, '2026-11-11T10:00:00.000Z');
    seed(store, 'beta', 'B2', 0.9, '2026-11-11T10:00:00.000Z');

    const result = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T12:00:00.000Z'),
      markSurfaced: false,
      focusProjectDir: 'C:/work/alpha',
    });

    expect(result.total).toBe(3);
    expect(result.groups.map((group) => group.projectName)).toEqual(['alpha', 'beta']);
    expect(result.groups[0].loops.map((loop) => loop.title)).toEqual(['A1']);
    expect(result.groups[1].loops.map((loop) => loop.title)).toEqual(['B1', 'B2']);
    expect(result.focusProject?.shown).toBe(1);
  });

  it('matches a focus subdirectory to its project and ignores unmatched paths', () => {
    const store = openStore();
    store.recordProjectActivity('C:/work/alpha', 'alpha', '2026-11-11T11:00:00.000Z', 's1');
    store.recordProjectActivity('C:/work/beta', 'beta', '2026-11-11T10:00:00.000Z', 's2');
    seed(store, 'alpha', 'A1', 0.9, '2026-11-11T11:00:00.000Z');
    seed(store, 'beta', 'B1', 0.95, '2026-11-11T10:00:00.000Z');

    const nested = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T12:00:00.000Z'),
      markSurfaced: false,
      focusProjectDir: 'C:/work/alpha/packages/app',
    });
    expect(nested.groups[0].projectName).toBe('alpha');
    expect(nested.focusProject).toMatchObject({ matched: true, shown: 1 });

    const baseline = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T12:00:00.000Z'),
      markSurfaced: false,
    });
    const unmatched = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T12:00:00.000Z'),
      markSurfaced: false,
      focusProjectDir: 'C:/work/unknown',
    });
    expect(unmatched.focusProject).toMatchObject({
      name: 'unknown',
      matched: false,
      shown: 0,
    });
    expect(unmatched.groups.flatMap((group) => group.loops.map((loop) => loop.id)))
      .toEqual(baseline.groups.flatMap((group) => group.loops.map((loop) => loop.id)));
  });

  it('keeps the weekly review global even when a focus project is supplied', () => {
    const store = openStore();
    store.recordProjectActivity('C:/work/alpha', 'alpha', '2026-11-11T11:00:00.000Z', 's1');
    store.recordProjectActivity('C:/work/beta', 'beta', '2026-11-11T10:00:00.000Z', 's2');
    seed(store, 'alpha', 'A1', 0.9, '2026-11-11T11:00:00.000Z');
    seed(store, 'beta', 'B1', 0.95, '2026-11-11T10:00:00.000Z');

    const result = buildDigest({
      store,
      mode: 'review',
      now: new Date('2026-11-11T12:00:00.000Z'),
      markSurfaced: false,
      focusProjectDir: 'C:/work/alpha',
    });

    expect(result.groups.map((group) => group.projectName).sort()).toEqual(['alpha', 'beta']);
    expect(result.focusProject).toBeUndefined();
  });

  it('explains when the focus project has no eligible loops', () => {
    const store = openStore();
    store.recordProjectActivity('C:/work/alpha', 'alpha', '2026-11-11T11:00:00.000Z', 's1');
    seed(store, 'alpha', 'A1', 0.9, '2026-11-11T11:00:00.000Z');

    const result = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T12:00:00.000Z'),
      markSurfaced: false,
      focusProjectDir: 'C:/work/unknown',
    });

    expect(result.total).toBe(1);
    expect(result.focusProject).toMatchObject({ matched: false, shown: 0 });
    expect(formatSkillDigest(result)).toContain(
      '本项目（unknown）暂无可回访条目，以下来自其他活跃项目。',
    );
  });

  it('nudges the weekly review when none was shown for seven days', () => {
    const now = new Date('2026-11-11T12:00:00.000Z');
    const store = openStore();
    store.recordProjectActivity('C:/work/alpha', 'alpha', '2026-11-11T11:00:00.000Z', 's1');
    const loop = seed(store, 'alpha', 'A1', 0.9, '2026-11-11T11:00:00.000Z');

    const never = buildDigest({ store, mode: 'hot', now, markSurfaced: false });
    expect(never.reviewDue).toBe(true);
    expect(formatSkillDigest(never)).toContain('本周回顾');

    store.recordPresentation([loop.id], '2026-11-10T12:00:00.000Z', 'review', 'review');
    const recent = buildDigest({ store, mode: 'hot', now, markSurfaced: false });
    expect(recent.reviewDue).toBe(false);
    expect(formatSkillDigest(recent)).not.toContain('本周回顾');

    const oldStore = openStore();
    oldStore.recordProjectActivity('C:/work/beta', 'beta', '2026-11-11T11:00:00.000Z', 's2');
    const oldLoop = seed(oldStore, 'beta', 'B1', 0.9, '2026-11-11T11:00:00.000Z');
    oldStore.recordPresentation([oldLoop.id], '2026-11-01T12:00:00.000Z', 'review', 'review');
    const overdue = buildDigest({ store: oldStore, mode: 'hot', now, markSurfaced: false });
    expect(overdue.reviewDue).toBe(true);
    expect(formatSkillDigest(overdue)).toContain('本周回顾');

    const review = buildDigest({ store, mode: 'review', now, markSurfaced: false });
    expect(review.reviewDue).not.toBe(true);
  });

  it('surfaces one old backlog item as a weekly review teaser', () => {
    const store = openStore();
    const now = new Date('2026-11-11T12:00:00.000Z');
    store.recordProjectActivity('C:/work/alpha', 'alpha', '2026-11-11T11:00:00.000Z', 's1');
    seed(store, 'alpha', 'A1', 0.9, '2026-11-11T11:00:00.000Z');
    seed(store, 'alpha', 'A2', 0.8, '2026-11-11T11:00:00.000Z');
    seed(store, 'alpha', 'A3', 0.7, '2026-11-11T11:00:00.000Z');
    store.recordProjectActivity('C:/work/gamma', 'gamma', '2026-11-04T10:00:00.000Z', 's3');
    const old = seed(store, 'gamma', 'G1', 0.85, '2026-11-04T10:00:00.000Z');

    const result = buildDigest({ store, mode: 'hot', now, markSurfaced: false });

    expect(result.total).toBe(3);
    expect(result.groups.flatMap((group) => group.loops.map((loop) => loop.title)))
      .not.toContain('G1');
    expect(result.reviewPick?.id).toBe(old.id);
    const text = formatSkillDigest(result);
    expect(text).toContain('# 回访 · 3 条 + 回顾 1 条');
    expect(text).toContain('本周回顾 · 先看 1 条');
    expect(text).toContain('4. **G1**');
    expect(text).toContain('项目：gamma');
  });

  it('renders only the review teaser when there are no fresh hot items', () => {
    const store = openStore();
    const now = new Date('2026-11-11T12:00:00.000Z');
    store.recordProjectActivity('C:/work/gamma', 'gamma', '2026-11-04T10:00:00.000Z', 's3');
    const old = seed(store, 'gamma', 'G1', 0.85, '2026-11-04T10:00:00.000Z');

    const result = buildDigest({ store, mode: 'hot', now, markSurfaced: false });

    expect(result.total).toBe(0);
    expect(result.reviewPick?.id).toBe(old.id);
    const text = formatSkillDigest(result);
    expect(text).toContain('# 本周回顾 · 1 条');
    expect(text).toContain('1. **G1**');
    expect(text).toContain('项目：gamma');
    expect(text).not.toContain('**本周回顾 · 先看 1 条**');
  });

  it('does not repeat the review teaser within 24 hours or spend hot budget', () => {
    const store = openStore();
    const now = new Date('2026-11-11T12:00:00.000Z');
    store.recordProjectActivity('C:/work/alpha', 'alpha', '2026-11-11T11:00:00.000Z', 's1');
    seed(store, 'alpha', 'A1', 0.9, '2026-11-11T11:00:00.000Z');
    store.recordProjectActivity('C:/work/gamma', 'gamma', '2026-11-04T10:00:00.000Z', 's3');
    const old = seed(store, 'gamma', 'G1', 0.85, '2026-11-04T10:00:00.000Z');

    const first = buildDigest({ store, mode: 'hot', now, dailySurfaceLimit: 10 });
    expect(first.reviewPick?.id).toBe(old.id);
    const after = store.getLoop(old.id)!;
    expect(after.hotSurfacedAt).toBeUndefined();
    expect(after.lastSurfacedAt).toBeTruthy();
    expect(store.listPresentationsAfter('2026-11-11T00:00:00.000Z')
      .some((item) => item.kind === 'teaser' && item.loopIds.includes(old.id))).toBe(true);

    const again = buildDigest({ store, mode: 'hot', now, markSurfaced: false });
    expect(again.reviewPick).toBeUndefined();
  });

  it('offers a close path on first-time hot items and names all three outcomes', () => {
    const store = openStore();
    store.recordProjectActivity('C:/work/alpha', 'alpha', '2026-11-11T11:00:00.000Z', 's1');
    seed(store, 'alpha', 'A1', 0.9, '2026-11-11T11:00:00.000Z');

    const result = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T12:00:00.000Z'),
      markSurfaced: false,
    });
    const output = formatSkillDigest(result);

    expect(output).toContain('若已完成，直接说“关闭这条”');
    expect(output).toContain('做第 N 条');
    expect(output).toContain('回复示例');
    expect(output).toContain('哪条已经完成');
    expect(output).toContain('确实忘了');
    expect(output).toContain('噪音');
  });

  it('includes pending loops in the weekly review', () => {
    const store = openStore();
    store.recordProjectActivity('C:/work/alpha', 'alpha', '2026-11-11T11:00:00.000Z', 's1');
    store.recordProjectActivity('C:/work/gamma', 'gamma', '2026-11-10T11:00:00.000Z', 's2');
    seed(store, 'alpha', 'Open item', 0.9, '2026-11-11T11:00:00.000Z');
    seed(store, 'alpha', 'Pending item', 0.45, '2026-11-11T10:00:00.000Z');

    const result = buildDigest({
      store,
      mode: 'review',
      now: new Date('2026-11-11T12:00:00.000Z'),
      markSurfaced: false,
    });

    expect(result.total).toBe(2);
    expect(result.groups[0].loops.map((loop) => loop.status).sort()).toEqual(['open', 'pending']);
    expect(result.activeProjects.map((project) => project.projectName)).toEqual(['alpha', 'gamma']);
    expect(formatDigest(result)).toContain('待确认 45%');
    expect(formatDigest(result)).toContain('下一步：next Pending item');
    expect(formatDigest(result)).toContain('**gamma** · 1 天前 · 会话 1 · 无未闭环');
  });

  it('renders a brief weekly review in skill mode', () => {
    const store = openStore();
    store.recordProjectActivity('C:/work/alpha', 'alpha', '2026-11-11T11:00:00.000Z', 's1');
    seed(store, 'alpha', 'Brief open', 0.9, '2026-11-11T11:00:00.000Z');
    seed(store, 'alpha', 'Brief pending', 0.45, '2026-11-11T10:00:00.000Z');

    const result = buildDigest({
      store,
      mode: 'review',
      now: new Date('2026-11-11T12:00:00.000Z'),
      markSurfaced: false,
    });

    const brief = formatSkillDigest(result);
    expect(brief).toContain('# 每周回顾 · 2 条');
    expect(brief).toContain('**Brief open**');
    expect(brief).toContain('**Brief pending**');
    expect(brief).toContain('[ref ');
    expect(brief).not.toContain('下一步：');
    expect(brief).not.toContain('为什么现在提：');
    expect(brief).toContain('做第 N 条');
    expect(brief).toContain('回复示例');

    const detailed = formatDigest(result);
    expect(detailed).toContain('下一步：next Brief open');
    expect(detailed).toContain('为什么现在提：why Brief open');
  });

  it('lists confirmed forgotten loops separately from the weekly review batch', () => {
    const store = openStore();
    const now = '2026-11-11T11:00:00.000Z';
    store.recordProjectActivity('C:/work/alpha', 'alpha', now, 's-alpha');
    const confirmed = seed(
      store,
      'alpha',
      'Confirmed review',
      0.9,
      now,
      undefined,
      '2026-10-01T10:00:00.000Z',
    );
    seed(store, 'alpha', 'Normal review', 0.8, now);
    store.recordFeedback(
      confirmed.id,
      'forgotten',
      '确实忘了',
      '2026-11-11T10:00:00.000Z',
    );

    const result = buildDigest({
      store,
      mode: 'review',
      now: new Date('2026-11-11T12:00:00.000Z'),
      markSurfaced: false,
    });

    expect(result.total).toBe(1);
    expect(result.groups.flatMap((group) => group.loops.map((loop) => loop.title)))
      .toEqual(['Normal review']);
    expect(result.reviewConfirmed.map((loop) => loop.title)).toEqual(['Confirmed review']);

    const detailed = formatDigest(result);
    expect(detailed).toContain('# 每周回顾 · 1 条 + 确认 1 条');
    expect(detailed).toContain('**你确认忘了 · 1 条**');
    expect(detailed).toContain('单独跟进，不占本轮周回顾名额；若已完成，直接说“关闭这条”。');
    expect(detailed).toContain('1. **Confirmed review**');
    expect(detailed).toContain('2. **Normal review**');
    expect(detailed).toContain('下一步：next Confirmed review');

    const brief = formatSkillDigest(result);
    expect(brief).toContain('# 每周回顾 · 1 条 + 确认 1 条');
    expect(brief).toContain('**你确认忘了 · 1 条**');
    expect(brief).toContain('1. **Confirmed review**');
    expect(brief).toContain('2. **Normal review**');
    expect(brief).not.toContain('下一步：next Confirmed review');
  });

  it('shows confirmed forgotten loops when there are no regular review items', () => {
    const store = openStore();
    const now = '2026-11-11T11:00:00.000Z';
    store.recordProjectActivity('C:/work/alpha', 'alpha', now, 's-alpha');
    const confirmed = seed(
      store,
      'alpha',
      'Only confirmed',
      0.9,
      now,
      undefined,
      '2026-10-01T10:00:00.000Z',
    );
    store.recordFeedback(
      confirmed.id,
      'forgotten',
      '确实忘了',
      '2026-11-11T10:00:00.000Z',
    );

    const result = buildDigest({
      store,
      mode: 'review',
      now: new Date('2026-11-11T12:00:00.000Z'),
      markSurfaced: false,
    });

    expect(result.total).toBe(0);
    expect(result.groups).toHaveLength(0);
    expect(result.reviewConfirmed.map((loop) => loop.title)).toEqual(['Only confirmed']);

    const detailed = formatDigest(result);
    expect(detailed).toContain('# 每周回顾 · 暂无新条目');
    expect(detailed).toContain('**你确认忘了 · 1 条**');
    expect(detailed).toContain('1. **Only confirmed**');
    expect(detailed).not.toBe('# 每周回顾 · 暂无新条目');

    const brief = formatSkillDigest(result);
    expect(brief).toContain('**你确认忘了 · 1 条**');
    expect(brief).toContain('1. **Only confirmed**');
  });

  it('excludes confirmed forgotten loops from the pending footer count', () => {
    const store = openStore();
    const now = '2026-11-11T11:00:00.000Z';
    store.recordProjectActivity('C:/work/alpha', 'alpha', now, 's-alpha');
    for (let index = 0; index < 3; index += 1) {
      seed(store, 'alpha', `open ${index}`, 0.9, now);
    }
    for (let index = 0; index < 2; index += 1) {
      seed(store, 'alpha', `pending ${index}`, 0.45, now);
    }
    const confirmed = seed(store, 'alpha', 'pending confirmed', 0.45, now);
    store.recordFeedback(
      confirmed.id,
      'forgotten',
      '确实忘了',
      '2026-11-11T10:00:00.000Z',
    );

    const result = buildDigest({
      store,
      mode: 'review',
      now: new Date('2026-11-11T12:00:00.000Z'),
      maxLoops: 3,
      markSurfaced: false,
    });

    expect(result.total).toBe(3);
    expect(result.reviewConfirmed.map((loop) => loop.title)).toEqual(['pending confirmed']);
    expect(result.pendingTotal).toBe(2);
    expect(formatSkillDigest(result)).toContain('其中 2 条把握不高');
  });

  it('keeps snoozed or noise-confirmed loops out of the confirmed review section', () => {
    const store = openStore();
    const now = '2026-11-11T11:00:00.000Z';
    store.recordProjectActivity('C:/work/alpha', 'alpha', now, 's-alpha');
    const snoozed = seed(store, 'alpha', 'Snoozed confirmed', 0.9, now);
    const noise = seed(store, 'alpha', 'Noise confirmed', 0.9, now);
    store.recordFeedback(snoozed.id, 'forgotten', '确实忘了', '2026-11-11T10:00:00.000Z');
    store.recordFeedback(noise.id, 'forgotten', '确实忘了', '2026-11-11T10:00:00.000Z');
    store.updateLoop(snoozed.id, {
      status: 'snoozed',
      snoozeUntil: '2026-11-20T00:00:00.000Z',
    });
    store.recordFeedback(noise.id, 'noise', '误报', '2026-11-11T10:30:00.000Z');

    const result = buildDigest({
      store,
      mode: 'review',
      now: new Date('2026-11-11T12:00:00.000Z'),
      markSurfaced: false,
    });

    expect(result.reviewConfirmed).toHaveLength(0);
    expect(formatDigest(result)).not.toContain('**你确认忘了');
  });

  it('collapses temporary workspaces to one line in a brief review', () => {
    const store = openStore();
    const now = '2026-11-11T11:00:00.000Z';
    for (const project of ['alpha', 'beta']) {
      store.recordProjectActivity(`C:/work/${project}`, project, now, `s-${project}`);
      seed(store, project, `${project} item`, 0.8, now);
    }
    const sessions = [
      'Hermes · 微信接入',
      'Qoder · Magpie 复盘',
      'ZCode · 网关定位',
      'DSH · 会话解析',
      'Codex · 排版排查',
      'Claude · 插件清理',
    ];
    for (const [index, name] of sessions.entries()) {
      seed(store, name, `${name} item`, 0.8, now);
    }

    const result = buildDigest({
      store,
      mode: 'review',
      now: new Date('2026-11-11T12:00:00.000Z'),
      markSurfaced: false,
    });

    const brief = formatSkillDigest(result);
    expect(brief).toContain('- 另有 6 个临时会话工作区：open 6 / pending 0');
    expect(brief).not.toContain('### 临时会话工作区');

    const detailed = formatDigest(result);
    expect(detailed).toContain('### 临时会话工作区 · 6 个');
  });

  it('points to pending items that did not fit in the review batch', () => {
    const store = openStore();
    const now = '2026-11-11T11:00:00.000Z';
    store.recordProjectActivity('C:/work/alpha', 'alpha', now, 's-alpha');
    for (let index = 0; index < 3; index += 1) {
      seed(store, 'alpha', `open ${index}`, 0.9, now);
    }
    for (let index = 0; index < 2; index += 1) {
      seed(store, 'alpha', `pending ${index}`, 0.45, now);
    }

    const result = buildDigest({
      store,
      mode: 'review',
      now: new Date('2026-11-11T12:00:00.000Z'),
      maxLoops: 3,
      markSurfaced: false,
    });

    expect(result.total).toBe(3);
    expect(result.pendingTotal).toBe(2);
    expect(formatSkillDigest(result)).toContain(
      '其中 2 条把握不高；说“看待确认”单独看。',
    );
  });

  it('includes a manually promoted pending loop in the hot digest', () => {
    const store = openStore();
    const now = '2026-11-11T11:00:00.000Z';
    store.recordProjectActivity('C:/work/alpha', 'alpha', now, 's-alpha');
    const loop = seed(store, 'alpha', '保留的待确认项', 0.45, now);
    store.updateLoop(loop.id, { status: 'open' });

    const result = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T12:00:00.000Z'),
      markSurfaced: false,
    });

    expect(result.total).toBe(1);
    expect(result.groups[0].loops[0].title).toBe('保留的待确认项');
  });

  it('shows active projects in the weekly review when there are no loops', () => {
    const store = openStore();
    store.recordProjectActivity('C:/work/gamma', 'gamma', '2026-11-10T11:00:00.000Z', 's2');

    const result = buildDigest({
      store,
      mode: 'review',
      now: new Date('2026-11-11T12:00:00.000Z'),
      markSurfaced: false,
    });

    expect(result.total).toBe(0);
    expect(result.activeProjects).toHaveLength(1);
    expect(formatDigest(result)).toContain('最近 7 天活跃项目');
    expect(formatDigest(result)).toContain('gamma');
  });

  it('applies the 24 hour cooldown and counts repeated surfaces', () => {
    const store = openStore();
    store.recordProjectActivity('C:/work/alpha', 'alpha', '2026-11-11T11:00:00.000Z', 's1');
    const loop = seed(store, 'alpha', 'Repeat me', 0.9, '2026-11-11T11:00:00.000Z');

    const first = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T12:00:00.000Z'),
    });
    expect(first.total).toBe(1);
    expect(first.activeTotal).toBe(1);
    expect(first.coolingDown).toBe(0);

    const tooSoon = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T20:00:00.000Z'),
      markSurfaced: false,
    });
    expect(tooSoon.total).toBe(0);
    expect(tooSoon.activeTotal).toBe(1);
    expect(tooSoon.coolingDown).toBe(1);
    expect(formatDigest(tooSoon)).toContain('今天已回访过');
    expect(formatDigest(tooSoon)).toContain('1 条在 24 小时冷却中');

    const nextDay = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-12T13:00:00.000Z'),
      markSurfaced: false,
    });
    expect(nextDay.total).toBe(1);

    store.recordSurfaced([loop.id], '2026-11-12T13:00:00.000Z');
    expect(store.getLoop(loop.id)?.ignoredCount).toBe(1);
  });

  it('rotates weekly review toward older loops that were never surfaced', () => {
    const store = openStore();
    store.recordProjectActivity('C:/work/alpha', 'alpha', '2026-11-11T11:00:00.000Z', 's1');
    const surfaced = seed(
      store,
      'alpha',
      'High confidence surfaced',
      0.95,
      '2026-11-11T11:00:00.000Z',
      undefined,
      '2026-11-01T11:00:00.000Z',
    );
    seed(
      store,
      'alpha',
      'Older unseen',
      0.7,
      '2026-11-11T10:00:00.000Z',
      undefined,
      '2026-10-20T10:00:00.000Z',
    );
    store.recordSurfaced([surfaced.id], '2026-11-11T11:30:00.000Z');

    const result = buildDigest({
      store,
      mode: 'review',
      now: new Date('2026-11-11T12:00:00.000Z'),
      maxLoops: 2,
      cooldownHours: 0,
      markSurfaced: false,
    });

    expect(result.groups[0].loops.map((loop) => loop.title)).toEqual([
      'Older unseen',
      'High confidence surfaced',
    ]);
  });

  it('spends weekly review slots on real projects before session workspaces', () => {
    const store = openStore();
    const now = '2026-11-11T11:00:00.000Z';
    for (const project of ['alpha', 'beta', 'gamma']) {
      store.recordProjectActivity(`C:/work/${project}`, project, now, `s-${project}`);
      for (let index = 0; index < 4; index += 1) {
        seed(store, project, `${project} ${index}`, 0.8, now);
      }
    }
    for (const project of [
      'Hermes · chat one',
      'Qoder · chat two',
      'ZCode · chat three',
      'DSH · chat four',
      'Codex · chat five',
    ]) {
      store.recordProjectActivity(`C:/work/${project}`, project, now, `s-${project}`);
      seed(store, project, `${project} task`, 0.8, now);
    }

    const result = buildDigest({
      store,
      mode: 'review',
      now: new Date('2026-11-11T12:00:00.000Z'),
      maxLoops: 6,
      markSurfaced: false,
    });

    expect(result.total).toBe(6);
    const sessionShown = result.groups
      .filter((group) => group.projectName.includes(' · '))
      .reduce((sum, group) => sum + group.loops.length, 0);
    expect(sessionShown).toBe(2);
    expect(result.reviewRemaining).toBe(11);
    expect(formatSkillDigest(result)).toContain('本轮还有 11 条没看');
  });

  it('continues the weekly review with the next unseen batch', () => {
    const store = openStore();
    const now = '2026-11-11T11:00:00.000Z';
    store.recordProjectActivity('C:/work/alpha', 'alpha', now, 's-alpha');
    for (let index = 0; index < 6; index += 1) {
      seed(store, 'alpha', `alpha ${index}`, 0.8, now);
    }

    const first = buildDigest({
      store,
      mode: 'review',
      now: new Date('2026-11-11T12:00:00.000Z'),
      maxLoops: 3,
    });
    const second = buildDigest({
      store,
      mode: 'review',
      now: new Date('2026-11-11T12:00:05.000Z'),
      maxLoops: 3,
    });

    const firstRefs = new Set(first.groups.flatMap((group) => group.loops.map((loop) => loop.id)));
    const secondRefs = second.groups.flatMap((group) => group.loops.map((loop) => loop.id));
    expect(firstRefs.size).toBe(3);
    expect(first.reviewRemaining).toBe(3);
    expect(secondRefs).toHaveLength(3);
    expect(second.reviewRemaining).toBe(0);
    for (const id of secondRefs) expect(firstRefs.has(id)).toBe(false);

    const wrapped = buildDigest({
      store,
      mode: 'review',
      now: new Date('2026-11-11T12:00:10.000Z'),
      maxLoops: 3,
    });
    expect(wrapped.total).toBe(3);
    expect(wrapped.reviewRemaining).toBe(3);
    expect(formatSkillDigest(wrapped)).toContain('本轮还有 3 条没看');
  });

  it('does not replay a fully seen project before every unseen item is shown', () => {
    const store = openStore();
    const now = '2026-11-11T11:00:00.000Z';
    for (const [project, count] of [['alpha', 5], ['beta', 1], ['gamma', 1]] as const) {
      store.recordProjectActivity(`C:/work/${project}`, project, now, `s-${project}`);
      for (let index = 0; index < count; index += 1) {
        seed(store, project, `${project} ${index}`, 0.8, now);
      }
    }

    const first = buildDigest({
      store,
      mode: 'review',
      now: new Date('2026-11-11T12:00:00.000Z'),
      maxLoops: 4,
    });
    const second = buildDigest({
      store,
      mode: 'review',
      now: new Date('2026-11-11T12:00:05.000Z'),
      maxLoops: 4,
    });

    const firstIds = new Set(
      first.groups.flatMap((group) => group.loops.map((loop) => loop.id)),
    );
    const secondIds = second.groups.flatMap((group) => group.loops.map((loop) => loop.id));
    expect(first.total).toBe(4);
    expect(first.reviewRemaining).toBe(3);
    expect(second.total).toBe(3);
    expect(second.reviewRemaining).toBe(0);
    expect(secondIds.filter((id) => firstIds.has(id))).toEqual([]);
    expect(formatSkillDigest(second)).toContain('本轮已经看完');

    const wrapped = buildDigest({
      store,
      mode: 'review',
      now: new Date('2026-11-11T12:00:10.000Z'),
      maxLoops: 4,
    });
    expect(wrapped.total).toBe(4);
    expect(wrapped.reviewRemaining).toBe(3);
  });

  it('caps hot surfaces at 3 active loops per 24 hours', () => {
    const store = openStore();
    const now = new Date('2026-11-11T12:00:00.000Z');
    for (let index = 0; index < 5; index += 1) {
      store.recordProjectActivity(
        `C:/work/p${index}`,
        `p${index}`,
        '2026-11-11T11:00:00.000Z',
        `s${index}`,
      );
      seed(store, `p${index}`, `Loop ${index}`, 0.9, '2026-11-11T11:00:00.000Z');
    }

    const first = buildDigest({ store, mode: 'hot', now });
    expect(first.total).toBe(3);
    expect(first.dailySurfaced).toBe(3);
    expect(first.dailyCapReached).toBe(false);

    const second = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T13:00:00.000Z'),
    });
    expect(second.total).toBe(0);
    expect(second.dailySurfaced).toBe(3);
    expect(second.dailyCapReached).toBe(true);
    expect(formatDigest(second)).toContain('# 今天提过 · 3 条');
    expect(formatDigest(second)).not.toContain('明天再继续');

    const forced = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T13:00:00.000Z'),
      cooldownHours: 0,
      force: true,
      markSurfaced: false,
    });
    expect(forced.total).toBe(3);
    expect(forced.dailySurfaced).toBe(3);

    const review = buildDigest({
      store,
      mode: 'review',
      now: new Date('2026-11-11T13:00:00.000Z'),
      markSurfaced: false,
      cooldownHours: 0,
    });
    expect(review.total).toBe(5);

    const nextDay = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-12T13:01:00.000Z'),
    });
    expect(nextDay.total).toBe(3);
  });

  it('recaps today\'s surfaced items when the daily cap is reached', () => {
    const store = openStore();
    const now = new Date('2026-11-11T12:00:00.000Z');
    for (let index = 0; index < 5; index += 1) {
      store.recordProjectActivity(
        `C:/work/p${index}`,
        `p${index}`,
        '2026-11-11T11:00:00.000Z',
        `s${index}`,
      );
      seed(store, `p${index}`, `Loop ${index}`, 0.9, '2026-11-11T11:00:00.000Z');
    }

    const first = buildDigest({ store, mode: 'hot', now });
    const firstIds = first.groups
      .flatMap((group) => group.loops.map((loop) => loop.id))
      .sort();

    const second = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T13:00:00.000Z'),
    });

    expect(second.total).toBe(0);
    expect(second.dailyCapReached).toBe(true);
    expect(second.recap.map((loop) => loop.id).sort()).toEqual(firstIds);
    expect(second.marked).toEqual([]);
    expect(second.dailySurfaced).toBe(3);

    const text = formatSkillDigest(second);
    expect(text).toContain('# 今天提过 · 3 条');
    expect(text).toContain('还没收到你的判断');
    expect(text).toContain('不占新预算');
    expect(text).not.toContain('明天再继续');
  });

  it('recaps only the focus project after the daily cap is reached', () => {
    const store = openStore();
    const now = new Date('2026-11-11T12:00:00.000Z');
    store.recordProjectActivity('C:/work/alpha', 'alpha', now.toISOString(), 's-a');
    store.recordProjectActivity('C:/work/beta', 'beta', now.toISOString(), 's-b');
    const alphaA = seed(store, 'alpha', 'A1', 0.9, now.toISOString());
    const alphaB = seed(store, 'alpha', 'A2', 0.9, now.toISOString());
    const beta = seed(store, 'beta', 'B1', 0.9, now.toISOString());
    store.recordSurfaced([alphaA.id, alphaB.id, beta.id], now.toISOString());

    const result = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T13:00:00.000Z'),
      focusProjectDir: 'C:/work/alpha',
    });

    expect(result.total).toBe(0);
    expect(result.recap.map((loop) => loop.title).sort()).toEqual(['A1', 'A2']);
    expect(result.recapFocusEmpty).toBe(false);
    const text = formatRecap(result);
    expect(text).toContain('# 今天提过 · 2 条');
    expect(text).not.toContain('B1');
  });

  it('shows a completion candidate when the daily cap falls back to a recap', () => {
    const store = openStore();
    const now = new Date('2026-11-11T12:00:00.000Z');
    store.recordProjectActivity('C:/work/alpha', 'alpha', now.toISOString(), 's-a');
    const surfaced = ['A1', 'A2', 'A3'].map((title) =>
      seed(store, 'alpha', title, 0.9, now.toISOString()));
    const candidate = seed(store, 'alpha', 'Candidate after cap', 0.9, now.toISOString());
    store.recordSurfaced(surfaced.map((loop) => loop.id), now.toISOString());
    store.setReconcileCache(
      's-a',
      'hash-a',
      [{
        loopId: candidate.id,
        confidence: 0.95,
        reason: '已完成：后续会话明确验证通过',
        evidenceMessageIds: [],
      }],
      now.toISOString(),
    );

    const result = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T13:00:00.000Z'),
      focusProjectDir: 'C:/work/alpha',
    });

    expect(result.total).toBe(0);
    expect(result.dailyCapReached).toBe(true);
    expect(result.recap.map((loop) => loop.id).sort())
      .toEqual(surfaced.map((loop) => loop.id).sort());
    expect(result.closeCandidates?.map((item) => item.loopId)).toEqual([candidate.id]);
    const text = formatSkillDigest(result);
    expect(text).toContain('可能已完成');
    expect(text).toContain('Candidate after cap');
    expect(text).toContain(`[ref ${loopRef(candidate.id)}]`);
  });

  it('does not repeat a completion candidate already in the recap', () => {
    const store = openStore();
    const now = new Date('2026-11-11T12:00:00.000Z');
    store.recordProjectActivity('C:/work/alpha', 'alpha', now.toISOString(), 's-a');
    const surfaced = ['A1', 'A2', 'A3'].map((title) =>
      seed(store, 'alpha', title, 0.9, now.toISOString()));
    store.recordSurfaced(surfaced.map((loop) => loop.id), now.toISOString());
    store.setReconcileCache(
      's-a',
      'hash-a',
      [{
        loopId: surfaced[0].id,
        confidence: 0.95,
        reason: '已完成：recap 里已经出现',
        evidenceMessageIds: [],
      }],
      now.toISOString(),
    );

    const result = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T13:00:00.000Z'),
      focusProjectDir: 'C:/work/alpha',
    });

    expect(result.closeCandidates).toEqual([]);
    expect(formatSkillDigest(result)).not.toContain('可能已完成');
  });

  it('does not repeat a recap completion candidate during the cooldown', () => {
    const store = openStore();
    const now = new Date('2026-11-11T12:00:00.000Z');
    store.recordProjectActivity('C:/work/alpha', 'alpha', now.toISOString(), 's-a');
    const surfaced = ['A1', 'A2', 'A3'].map((title) =>
      seed(store, 'alpha', title, 0.9, now.toISOString()));
    const candidate = seed(store, 'alpha', 'Candidate after cap', 0.9, now.toISOString());
    store.recordSurfaced(surfaced.map((loop) => loop.id), now.toISOString());
    store.setReconcileCache(
      's-a',
      'hash-a',
      [{
        loopId: candidate.id,
        confidence: 0.95,
        reason: '已完成：后续会话明确验证通过',
        evidenceMessageIds: [],
      }],
      now.toISOString(),
    );

    const first = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T13:00:00.000Z'),
      focusProjectDir: 'C:/work/alpha',
    });
    expect(first.recapThrottled).toBe(false);
    expect(first.closeCandidates?.map((item) => item.loopId)).toEqual([candidate.id]);

    const second = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T13:10:00.000Z'),
      focusProjectDir: 'C:/work/alpha',
    });
    expect(second.recapThrottled).toBe(true);
    expect(second.closeCandidates).toEqual([]);
    expect(formatSkillDigest(second)).not.toContain('可能已完成');
  });

  it('does not repeat the same recap completion candidate within 24 hours', () => {
    const store = openStore();
    const now = new Date('2026-11-11T12:00:00.000Z');
    store.recordProjectActivity('C:/work/alpha', 'alpha', now.toISOString(), 's-a');
    const surfaced = ['A1', 'A2', 'A3'].map((title) =>
      seed(store, 'alpha', title, 0.9, now.toISOString()));
    const candidate = seed(store, 'alpha', 'Candidate after cap', 0.9, now.toISOString());
    store.recordSurfaced(surfaced.map((loop) => loop.id), now.toISOString());
    store.setReconcileCache(
      's-a',
      'hash-a',
      [{
        loopId: candidate.id,
        confidence: 0.95,
        reason: '已完成：后续会话明确验证通过',
        evidenceMessageIds: [],
      }],
      now.toISOString(),
    );

    const first = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T13:00:00.000Z'),
      focusProjectDir: 'C:/work/alpha',
      recapCooldownMinutes: 0,
    });
    expect(first.closeCandidates?.map((item) => item.loopId)).toEqual([candidate.id]);

    const second = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T14:00:00.000Z'),
      focusProjectDir: 'C:/work/alpha',
      recapCooldownMinutes: 0,
    });
    expect(second.recapThrottled).toBe(false);
    expect(second.closeCandidates).toEqual([]);
    expect(formatSkillDigest(second)).not.toContain('可能已完成');
  });

  it('stays quiet when the focus project has no item surfaced today', () => {
    const store = openStore();
    const now = new Date('2026-11-11T12:00:00.000Z');
    store.recordProjectActivity('C:/work/alpha', 'alpha', now.toISOString(), 's-a');
    store.recordProjectActivity('C:/work/beta', 'beta', now.toISOString(), 's-b');
    store.recordProjectActivity('C:/work/gamma', 'gamma', now.toISOString(), 's-g');
    const alpha = seed(store, 'alpha', 'A1', 0.9, now.toISOString());
    const beta = seed(store, 'beta', 'B1', 0.9, now.toISOString());
    const betaTwo = seed(store, 'beta', 'B2', 0.8, now.toISOString());
    seed(store, 'gamma', 'G1', 0.9, now.toISOString());
    store.recordSurfaced([alpha.id, beta.id, betaTwo.id], now.toISOString());

    const result = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T13:00:00.000Z'),
      focusProjectDir: 'C:/work/gamma',
    });

    expect(result.total).toBe(0);
    expect(result.recap).toEqual([]);
    expect(result.recapFocusEmpty).toBe(true);
    expect(result.focusProject?.backlog).toBe(1);
    const text = formatSkillDigest(result);
    expect(text).toContain('本项目今天没有已提过的回访条目');
    expect(text).not.toContain('今天提过 · 3 条');
  });

  it('keeps a confirmed cross-project item after the daily cap', () => {
    const store = openStore();
    const now = new Date('2026-11-11T12:00:00.000Z');
    store.recordProjectActivity('C:/work/alpha', 'alpha', now.toISOString(), 's-a');
    const surfaced = ['A1', 'A2', 'A3'].map((title) =>
      seed(store, 'alpha', title, 0.9, now.toISOString()));
    store.recordSurfaced(surfaced.map((loop) => loop.id), now.toISOString());
    const confirmed = seed(
      store,
      'quiet',
      'Confirmed across projects',
      0.9,
      '2026-10-30T12:00:00.000Z',
      undefined,
      '2026-10-01T12:00:00.000Z',
    );
    store.recordFeedback(
      confirmed.id,
      'forgotten',
      '确实忘了',
      '2026-11-11T11:00:00.000Z',
    );

    const result = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T13:00:00.000Z'),
      focusProjectDir: 'C:/work/alpha',
      markSurfaced: false,
    });

    expect(result.total).toBe(0);
    expect(result.dailyCapReached).toBe(true);
    expect(result.dailySurfaced).toBe(3);
    expect(result.marked).toEqual([]);
    expect(result.recap.map((loop) => loop.id)).toContain(confirmed.id);
    expect(result.recapConfirmedIds).toEqual([confirmed.id]);
    const text = formatRecap(result);
    expect(text).toContain('你确认忘了');
    expect(text).toContain('Confirmed across projects');
    expect(text).toContain(`[ref ${loopRef(confirmed.id)}]`);
    expect(text).toContain('不按当前项目过滤');
  });

  it('does not repeat a confirmed cross-project item within 24 hours', () => {
    const store = openStore();
    const now = new Date('2026-11-11T12:00:00.000Z');
    store.recordProjectActivity('C:/work/alpha', 'alpha', now.toISOString(), 's-a');
    const surfaced = ['A1', 'A2', 'A3'].map((title) =>
      seed(store, 'alpha', title, 0.9, now.toISOString()));
    store.recordSurfaced(surfaced.map((loop) => loop.id), now.toISOString());
    const confirmed = seed(
      store,
      'quiet',
      'Confirmed across projects',
      0.9,
      '2026-10-30T12:00:00.000Z',
      undefined,
      '2026-10-01T12:00:00.000Z',
    );
    store.recordFeedback(
      confirmed.id,
      'forgotten',
      '确实忘了',
      '2026-11-11T11:00:00.000Z',
    );

    const first = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T13:00:00.000Z'),
      focusProjectDir: 'C:/work/alpha',
      recapCooldownMinutes: 0,
    });
    expect(first.recapConfirmedIds).toEqual([confirmed.id]);

    const second = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T14:00:00.000Z'),
      focusProjectDir: 'C:/work/alpha',
      recapCooldownMinutes: 0,
      markSurfaced: false,
    });
    expect(second.recapConfirmedIds).toEqual([]);
    expect(second.recap.map((loop) => loop.id)).not.toContain(confirmed.id);
  });

  it('keeps a confirmed cross-project item during a throttled recap', () => {
    const store = openStore();
    const now = new Date('2026-11-11T12:00:00.000Z');
    store.recordProjectActivity('C:/work/alpha', 'alpha', now.toISOString(), 's-a');
    const surfaced = ['A1', 'A2', 'A3'].map((title) =>
      seed(store, 'alpha', title, 0.9, now.toISOString()));
    store.recordSurfaced(surfaced.map((loop) => loop.id), now.toISOString());
    store.recordPresentation([surfaced[0].id], '2026-11-11T12:30:00.000Z', 'hot', 'recap');
    const confirmed = seed(
      store,
      'quiet',
      'Confirmed across projects',
      0.9,
      '2026-10-30T12:00:00.000Z',
      undefined,
      '2026-10-01T12:00:00.000Z',
    );
    store.recordFeedback(
      confirmed.id,
      'forgotten',
      '确实忘了',
      '2026-11-11T11:00:00.000Z',
    );

    const result = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T13:00:00.000Z'),
      focusProjectDir: 'C:/work/alpha',
      markSurfaced: false,
    });

    expect(result.recapThrottled).toBe(true);
    expect(result.recapConfirmedIds).toEqual([confirmed.id]);
    const text = formatRecap(result);
    expect(text).toContain('刚刚已提过');
    expect(text).toContain('你确认忘了');
    expect(text).toContain('Confirmed across projects');
  });

  it('does not surface a snoozed confirmed item after the cap', () => {
    const store = openStore();
    const now = new Date('2026-11-11T12:00:00.000Z');
    store.recordProjectActivity('C:/work/alpha', 'alpha', now.toISOString(), 's-a');
    const surfaced = ['A1', 'A2', 'A3'].map((title) =>
      seed(store, 'alpha', title, 0.9, now.toISOString()));
    store.recordSurfaced(surfaced.map((loop) => loop.id), now.toISOString());
    const confirmed = seed(
      store,
      'quiet',
      'Snoozed confirmed',
      0.9,
      '2026-10-30T12:00:00.000Z',
      undefined,
      '2026-10-01T12:00:00.000Z',
    );
    store.recordFeedback(
      confirmed.id,
      'forgotten',
      '确实忘了',
      '2026-11-11T11:00:00.000Z',
    );
    store.updateLoop(confirmed.id, {
      status: 'snoozed',
      snoozeUntil: '2026-11-20T00:00:00.000Z',
    });

    const result = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T13:00:00.000Z'),
      focusProjectDir: 'C:/work/alpha',
      markSurfaced: false,
    });

    expect(result.recapConfirmedIds).toEqual([]);
    expect(result.recap.map((loop) => loop.id)).not.toContain(confirmed.id);
  });

  it('falls back to the global recap when the focus directory is unknown', () => {
    const store = openStore();
    const now = new Date('2026-11-11T12:00:00.000Z');
    store.recordProjectActivity('C:/work/alpha', 'alpha', now.toISOString(), 's-a');
    store.recordProjectActivity('C:/work/beta', 'beta', now.toISOString(), 's-b');
    const alpha = seed(store, 'alpha', 'A1', 0.9, now.toISOString());
    const beta = seed(store, 'beta', 'B1', 0.9, now.toISOString());
    const third = seed(store, 'beta', 'B2', 0.8, now.toISOString());
    store.recordSurfaced([alpha.id, beta.id, third.id], now.toISOString());

    const result = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T13:00:00.000Z'),
      focusProjectDir: 'C:/work/unknown',
    });

    expect(result.total).toBe(0);
    expect(result.recap).toHaveLength(3);
    expect(result.recapFocusEmpty).toBe(false);
  });

  it('does not throttle a recap from another project', () => {
    const store = openStore();
    const now = new Date('2026-11-11T12:00:00.000Z');
    store.recordProjectActivity('C:/work/alpha', 'alpha', now.toISOString(), 's-a');
    store.recordProjectActivity('C:/work/beta', 'beta', now.toISOString(), 's-b');
    const alphaIds = ['A1', 'A2', 'A3'].map((title, index) =>
      seed(store, 'alpha', title, 0.9 - index * 0.01, now.toISOString()).id);
    const betaIds = ['B1', 'B2', 'B3'].map((title, index) =>
      seed(store, 'beta', title, 0.9 - index * 0.01, now.toISOString()).id);
    store.recordSurfaced([...alphaIds, ...betaIds], now.toISOString());

    const first = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T12:05:00.000Z'),
      focusProjectDir: 'C:/work/alpha',
    });
    expect(first.recap.map((loop) => loop.title).sort()).toEqual(['A1', 'A2', 'A3']);
    expect(first.recapThrottled).toBe(false);

    const second = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T12:10:00.000Z'),
      focusProjectDir: 'C:/work/beta',
    });
    expect(second.recap.map((loop) => loop.title).sort()).toEqual(['B1', 'B2', 'B3']);
    expect(second.recapThrottled).toBe(false);
  });

  it('shows a cached completion candidate in the hot digest', () => {
    const store = openStore();
    const now = new Date('2026-11-11T12:00:00.000Z');
    store.recordProjectActivity('C:/work/alpha', 'alpha', now.toISOString(), 's-a');
    const shown = seed(store, 'alpha', 'Shown item', 0.95, now.toISOString());
    const candidate = seed(store, 'alpha', 'Candidate item', 0.7, now.toISOString());
    store.setReconcileCache(
      's-a',
      'hash-a',
      [{
        loopId: candidate.id,
        confidence: 0.95,
        reason: '已完成：后续会话明确验证通过',
        evidenceMessageIds: [],
      }],
      now.toISOString(),
    );

    const result = buildDigest({
      store,
      mode: 'hot',
      now,
      maxLoops: 1,
      markSurfaced: false,
      focusProjectDir: 'C:/work/alpha',
    });

    expect(result.groups[0].loops[0].id).toBe(shown.id);
    expect(result.closeCandidates?.map((item) => item.loopId)).toEqual([candidate.id]);
    const text = formatSkillDigest(result);
    expect(text).toContain('可能已完成');
    expect(text).toContain('Candidate item');
    expect(text).toContain('后续会话明确验证通过');
  });

  it('does not repeat a completion candidate already shown as a hot item', () => {
    const store = openStore();
    const now = new Date('2026-11-11T12:00:00.000Z');
    store.recordProjectActivity('C:/work/alpha', 'alpha', now.toISOString(), 's-a');
    const shown = seed(store, 'alpha', 'Shown item', 0.95, now.toISOString());
    store.setReconcileCache(
      's-a',
      'hash-a',
      [{
        loopId: shown.id,
        confidence: 0.95,
        reason: '已完成：已显示',
        evidenceMessageIds: [],
      }],
      now.toISOString(),
    );

    const result = buildDigest({
      store,
      mode: 'hot',
      now,
      maxLoops: 1,
      markSurfaced: false,
      focusProjectDir: 'C:/work/alpha',
    });

    expect(result.closeCandidates).toEqual([]);
  });

  it('keeps hot completion candidates inside the focus project', () => {
    const store = openStore();
    const now = new Date('2026-11-11T12:00:00.000Z');
    store.recordProjectActivity('C:/work/alpha', 'alpha', now.toISOString(), 's-a');
    store.recordProjectActivity('C:/work/beta', 'beta', now.toISOString(), 's-b');
    seed(store, 'alpha', 'Alpha shown', 0.95, now.toISOString());
    const beta = seed(store, 'beta', 'Beta candidate', 0.7, now.toISOString());
    store.setReconcileCache(
      's-b',
      'hash-b',
      [{
        loopId: beta.id,
        confidence: 0.95,
        reason: '已完成：beta',
        evidenceMessageIds: [],
      }],
      now.toISOString(),
    );

    const result = buildDigest({
      store,
      mode: 'hot',
      now,
      maxLoops: 1,
      markSurfaced: false,
      focusProjectDir: 'C:/work/alpha',
    });

    expect(result.closeCandidates).toEqual([]);
  });

  it('ignores weak completion candidates', () => {
    const store = openStore();
    const now = new Date('2026-11-11T12:00:00.000Z');
    store.recordProjectActivity('C:/work/alpha', 'alpha', now.toISOString(), 's-a');
    seed(store, 'alpha', 'Alpha shown', 0.95, now.toISOString());
    const weak = seed(store, 'alpha', 'Weak candidate', 0.7, now.toISOString());
    store.setReconcileCache(
      's-a',
      'hash-a',
      [{
        loopId: weak.id,
        confidence: 0.89,
        reason: '可能已完成',
        evidenceMessageIds: [],
      }],
      now.toISOString(),
    );

    const result = buildDigest({
      store,
      mode: 'hot',
      now,
      maxLoops: 1,
      markSurfaced: false,
      focusProjectDir: 'C:/work/alpha',
    });

    expect(result.closeCandidates).toEqual([]);
  });

  it('throttles repeated recaps within the cooldown window', () => {
    const store = openStore();
    const now = new Date('2026-11-11T12:00:00.000Z');
    for (let index = 0; index < 5; index += 1) {
      store.recordProjectActivity(
        `C:/work/p${index}`,
        `p${index}`,
        '2026-11-11T11:00:00.000Z',
        `s${index}`,
      );
      seed(store, `p${index}`, `Loop ${index}`, 0.9, '2026-11-11T11:00:00.000Z');
    }

    buildDigest({ store, mode: 'hot', now });
    const firstRecap = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T12:05:00.000Z'),
    });
    expect(firstRecap.recapThrottled).toBe(false);

    const throttled = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T12:15:00.000Z'),
    });
    expect(throttled.recapThrottled).toBe(true);
    expect(throttled.marked).toEqual([]);
    const text = formatSkillDigest(throttled);
    expect(text).toContain('刚刚已提过这几条');
    expect(text).not.toContain('下一步：');

    const afterCooldown = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T12:36:00.000Z'),
    });
    expect(afterCooldown.recapThrottled).toBe(false);
  });

  it('keeps each project recap throttled when another project recaps in between', () => {
    const store = openStore();
    const base = '2026-11-11T11:00:00.000Z';
    store.recordProjectActivity('C:/work/alpha', 'alpha', base, 's-a');
    store.recordProjectActivity('C:/work/beta', 'beta', base, 's-b');
    const alphaLoops = ['A1', 'A2', 'A3'].map((title) => seed(store, 'alpha', title, 0.9, base));
    const betaLoops = ['B1', 'B2', 'B3'].map((title) => seed(store, 'beta', title, 0.9, base));
    store.recordSurfaced(
      [...alphaLoops, ...betaLoops].map((loop) => loop.id),
      base,
    );

    const firstAlpha = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T12:00:00.000Z'),
      focusProjectDir: 'C:/work/alpha',
    });
    expect(firstAlpha.recap.map((loop) => loop.projectName)).toEqual(['alpha', 'alpha', 'alpha']);
    expect(firstAlpha.recapThrottled).toBe(false);

    const betaRecap = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T12:10:00.000Z'),
      focusProjectDir: 'C:/work/beta',
    });
    expect(betaRecap.recap.map((loop) => loop.projectName)).toEqual(['beta', 'beta', 'beta']);
    expect(betaRecap.recapThrottled).toBe(false);

    const secondAlpha = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T12:15:00.000Z'),
      focusProjectDir: 'C:/work/alpha',
    });
    expect(secondAlpha.recapThrottled).toBe(true);
    expect(formatSkillDigest(secondAlpha)).toContain('刚刚已提过这几条');
  });

  it('supports a custom recap cooldown window', () => {
    const store = openStore();
    const now = new Date('2026-11-11T12:00:00.000Z');
    for (let index = 0; index < 5; index += 1) {
      store.recordProjectActivity(
        `C:/work/p${index}`,
        `p${index}`,
        '2026-11-11T11:00:00.000Z',
        `s${index}`,
      );
      seed(store, `p${index}`, `Loop ${index}`, 0.9, '2026-11-11T11:00:00.000Z');
    }

    buildDigest({ store, mode: 'hot', now });
    buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T12:05:00.000Z'),
    });

    const defaultWindow = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T12:15:00.000Z'),
    });
    expect(defaultWindow.recapThrottled).toBe(true);
    expect(defaultWindow.recapCooldownMinutes).toBe(30);

    const shortWindow = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T12:15:00.000Z'),
      recapCooldownMinutes: 5,
    });
    expect(shortWindow.recapThrottled).toBe(false);
    expect(shortWindow.recapCooldownMinutes).toBe(5);
  });

  it('does not repeat the calibration nudge during a throttled recap', () => {
    const store = openStore();
    const now = new Date('2026-11-11T12:00:00.000Z');
    store.recordProjectActivity('C:/work/alpha', 'alpha', now.toISOString(), 's-alpha');
    const loops: ReturnType<typeof seed>[] = [];
    for (let index = 0; index < 10; index += 1) {
      loops.push(seed(store, 'alpha', `Loop ${index}`, 0.9, '2026-11-11T11:00:00.000Z'));
    }
    store.recordSurfaced(loops.map((loop) => loop.id), '2026-11-11T11:00:00.000Z');
    store.recordPresentation(
      loops.slice(0, 3).map((loop) => loop.id),
      '2026-11-11T11:55:00.000Z',
      'hot',
      'recap',
    );

    const result = buildDigest({
      store,
      mode: 'hot',
      now,
      dailySurfaceLimit: 3,
      markSurfaced: false,
    });
    expect(result.dailyCapReached).toBe(true);
    expect(result.recapThrottled).toBe(true);
    expect(result.surfacedTotal).toBe(10);
    const output = formatSkillDigest(result);
    expect(output).toContain('刚刚已提过这几条');
    expect(output).not.toContain('校准提示');
  });

  it('drops a recapped item after the user gives feedback on it', () => {
    const store = openStore();
    const now = new Date('2026-11-11T12:00:00.000Z');
    for (let index = 0; index < 4; index += 1) {
      store.recordProjectActivity(
        `C:/work/p${index}`,
        `p${index}`,
        '2026-11-11T11:00:00.000Z',
        `s${index}`,
      );
      seed(store, `p${index}`, `Loop ${index}`, 0.9, '2026-11-11T11:00:00.000Z');
    }

    const first = buildDigest({ store, mode: 'hot', now });
    const target = first.groups[0].loops[0];
    store.recordFeedback(target.id, 'forgotten', '确实忘了', '2026-11-11T12:30:00.000Z');

    const second = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T13:00:00.000Z'),
    });

    expect(second.dailyCapReached).toBe(true);
    expect(second.recap).toHaveLength(2);
    expect(second.recap.some((loop) => loop.id === target.id)).toBe(false);
  });

  it('recaps only items surfaced today', () => {
    const store = openStore();
    const now = new Date(2026, 10, 11, 12, 0, 0);
    store.recordProjectActivity('C:/work/alpha', 'alpha', now.toISOString(), 's1');
    const yesterday = seed(store, 'alpha', 'Yesterday item', 0.9, now.toISOString());
    const first = seed(store, 'alpha', 'Today 1', 0.9, now.toISOString());
    const second = seed(store, 'alpha', 'Today 2', 0.9, now.toISOString());
    const third = seed(store, 'alpha', 'Today 3', 0.9, now.toISOString());
    store.recordSurfaced([yesterday.id], new Date(now.getTime() - 13 * 60 * 60 * 1000).toISOString());
    store.recordSurfaced(
      [first.id, second.id, third.id],
      new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString(),
    );
    store.updateLoop(first.id, {
      status: 'snoozed',
      snoozeUntil: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    });

    const result = buildDigest({ store, mode: 'hot', now, markSurfaced: false });

    expect(result.dailyCapReached).toBe(true);
    expect(result.recap).toHaveLength(2);
    expect(result.recap.map((loop) => loop.id)).not.toContain(yesterday.id);
  });

  it('frees daily budget when a surfaced loop is resolved', () => {
    const store = openStore();
    const now = new Date('2026-11-11T12:00:00.000Z');
    for (let index = 0; index < 4; index += 1) {
      store.recordProjectActivity(
        `C:/work/p${index}`,
        `p${index}`,
        '2026-11-11T11:00:00.000Z',
        `s${index}`,
      );
      seed(store, `p${index}`, `Loop ${index}`, 0.9, '2026-11-11T11:00:00.000Z');
    }

    const first = buildDigest({ store, mode: 'hot', now });
    expect(first.total).toBe(3);
    const surfaced = first.groups.flatMap((group) => group.loops);
    store.updateLoop(surfaced[0].id, { status: 'resolved' });

    const second = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T13:00:00.000Z'),
    });
    expect(second.total).toBe(1);
    expect(second.dailySurfaced).toBe(3);
    expect(second.dailyCapReached).toBe(false);
  });

  it('does not spend the hot budget on weekly review surfaces', () => {
    const store = openStore();
    const now = new Date('2026-11-11T12:00:00.000Z');
    for (let index = 0; index < 5; index += 1) {
      store.recordProjectActivity(
        `C:/work/p${index}`,
        `p${index}`,
        '2026-11-11T11:00:00.000Z',
        `s${index}`,
      );
      seed(store, `p${index}`, `Loop ${index}`, 0.9, '2026-11-11T11:00:00.000Z');
    }

    const review = buildDigest({ store, mode: 'review', now, maxLoops: 5 });
    expect(review.total).toBe(5);

    const hot = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T13:00:00.000Z'),
      cooldownHours: 0,
    });
    expect(hot.total).toBe(3);
    expect(hot.dailySurfaced).toBe(3);
    expect(hot.dailyCapReached).toBe(false);
  });

  it('prioritizes a project with a larger open backlog over a more recently active one', () => {
    const store = openStore();
    store.recordProjectActivity('C:/work/alpha', 'alpha', '2026-11-11T11:00:00.000Z', 's1');
    store.recordProjectActivity('C:/work/beta', 'beta', '2026-11-10T15:00:00.000Z', 's2');
    store.recordProjectActivity('C:/work/gamma', 'gamma', '2026-11-11T01:00:00.000Z', 's3');
    seed(store, 'alpha', 'A1', 0.72, '2026-11-11T11:00:00.000Z', undefined, '2026-11-11T10:00:00.000Z');
    for (let index = 0; index < 5; index += 1) {
      seed(
        store,
        'beta',
        `B${index}`,
        0.85,
        '2026-11-10T15:00:00.000Z',
        undefined,
        '2026-11-07T10:00:00.000Z',
      );
    }
    seed(store, 'gamma', 'G1', 0.8, '2026-11-11T01:00:00.000Z', undefined, '2026-11-09T10:00:00.000Z');

    const result = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T12:00:00.000Z'),
      maxLoops: 2,
      markSurfaced: false,
    });

    expect(result.groups.map((group) => group.projectName)).toEqual(['beta', 'gamma']);
  });

  it('shows the full project backlog when only part of it is surfaced', () => {
    const store = openStore();
    store.recordProjectActivity('C:/work/alpha', 'alpha', '2026-11-11T11:00:00.000Z', 's1');
    for (let index = 0; index < 3; index += 1) {
      seed(
        store,
        'alpha',
        `Backlog ${index}`,
        0.8,
        '2026-11-11T11:00:00.000Z',
        undefined,
        '2026-11-10T10:00:00.000Z',
      );
    }

    const result = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T12:00:00.000Z'),
      maxLoops: 1,
      markSurfaced: false,
    });
    const output = formatDigest(result, new Date('2026-11-11T12:00:00.000Z'));

    expect(output).toContain('未闭环共 3 条（open 3 / pending 0）');
  });

  it('keeps a surfaced project in activeProjects beyond the first ten recent projects', () => {
    const store = openStore();
    store.recordProjectActivity('C:/work/target', 'target', '2026-11-09T12:00:00.000Z', 's-target');
    seed(
      store,
      'target',
      'Target loop',
      0.85,
      '2026-11-09T12:00:00.000Z',
      undefined,
      '2026-11-09T10:00:00.000Z',
    );
    for (let index = 0; index < 12; index += 1) {
      store.recordProjectActivity(
        `C:/work/recent-${index}`,
        `recent-${index}`,
        `2026-11-11T10:${String(index).padStart(2, '0')}:00.000Z`,
        `s-${index}`,
      );
    }

    const result = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T12:00:00.000Z'),
      maxLoops: 1,
      markSurfaced: false,
    });

    expect(result.groups[0].projectName).toBe('target');
    expect(result.activeProjects.some((project) => project.projectName === 'target')).toBe(true);
  });

  it('suppresses a noise loop until newer evidence arrives', () => {
    const store = openStore();
    store.recordProjectActivity('C:/work/alpha', 'alpha', '2026-11-11T10:00:00.000Z', 's1');
    const loop = seed(
      store,
      'alpha',
      'Suppress me',
      0.9,
      '2026-11-11T10:00:00.000Z',
      undefined,
      '2026-11-09T10:00:00.000Z',
    );
    store.recordFeedback(loop.id, 'noise', '不是我要跟的', '2026-11-11T11:00:00.000Z');

    const suppressed = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T12:00:00.000Z'),
      markSurfaced: false,
    });
    expect(suppressed.total).toBe(0);
    expect(suppressed.activeTotal).toBe(1);
    expect(suppressed.eligibleTotal).toBe(0);
    expect(suppressed.noiseSuppressed).toBe(1);
    expect(formatDigest(suppressed)).toContain('已被标记为噪音且没有新证据');
    const review = buildDigest({
      store,
      mode: 'review',
      now: new Date('2026-11-11T12:00:00.000Z'),
      markSurfaced: false,
    });
    expect(formatDigest(review)).toContain('# 每周回顾 · 暂无新条目');

    store.saveLoop(
      {
        title: 'Suppress me',
        nextAction: 'new evidence',
        why: 'new evidence',
        confidence: 0.9,
        sourceSignalIds: ['alpha:new'],
      },
      {
        projectDir: 'C:/work/alpha',
        projectName: 'alpha',
        lastSeen: '2026-11-11T11:30:00.000Z',
      },
    );

    const resumed = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T12:00:00.000Z'),
      markSurfaced: false,
    });
    expect(resumed.total).toBe(1);
    expect(resumed.noiseSuppressed).toBe(0);
  });

  it('does not suppress a loop whose latest feedback is forgotten', () => {
    const store = openStore();
    store.recordProjectActivity('C:/work/alpha', 'alpha', '2026-11-11T10:00:00.000Z', 's1');
    const loop = seed(store, 'alpha', 'Useful reminder', 0.9, '2026-11-11T10:00:00.000Z');
    store.recordFeedback(loop.id, 'forgotten', '确实忘了', '2026-11-11T11:00:00.000Z');

    const result = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T12:00:00.000Z'),
      markSurfaced: false,
    });

    expect(result.total).toBe(1);
    expect(result.noiseSuppressed).toBe(0);
  });

  it('mentions both cooling and noise suppression when both exist', () => {
    const store = openStore();
    store.recordProjectActivity('C:/work/alpha', 'alpha', '2026-11-11T10:00:00.000Z', 's1');
    store.recordProjectActivity('C:/work/beta', 'beta', '2026-11-11T10:00:00.000Z', 's2');
    const noisy = seed(store, 'alpha', 'Noise item', 0.9, '2026-11-11T10:00:00.000Z');
    const cooling = seed(store, 'beta', 'Cooling item', 0.9, '2026-11-11T10:00:00.000Z');
    store.recordFeedback(noisy.id, 'noise', '误报', '2026-11-11T11:00:00.000Z');
    store.recordSurfaced([cooling.id], '2026-11-11T11:30:00.000Z', false);

    const result = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T12:00:00.000Z'),
      markSurfaced: false,
    });
    const output = formatDigest(result);

    expect(result.total).toBe(0);
    expect(result.coolingDown).toBe(1);
    expect(result.noiseSuppressed).toBe(1);
    expect(output).toContain('1 条在 24 小时冷却中');
    expect(output).toContain('1 条已标记为噪音');
  });

  it('mentions suppressed loops even when no active project window matches', () => {
    const store = openStore();
    store.recordProjectActivity('C:/work/alpha', 'alpha', '2026-11-01T10:00:00.000Z', 's1');
    const loop = seed(store, 'alpha', 'Old noise item', 0.9, '2026-11-01T10:00:00.000Z');
    store.recordFeedback(loop.id, 'noise', '误报', '2026-11-02T10:00:00.000Z');

    const result = buildDigest({
      store,
      mode: 'review',
      now: new Date('2026-11-15T12:00:00.000Z'),
      markSurfaced: false,
    });
    const output = formatDigest(result);

    expect(result.total).toBe(0);
    expect(result.activeProjects).toHaveLength(0);
    expect(result.noiseSuppressed).toBe(1);
    expect(output).toContain('还有 1 条未闭环');
    expect(output).toContain('1 条已被标记为噪音且没有新证据');
    expect(output).not.toContain('本周没有需要回顾的循环');
  });

  it('renders the daily cap inventory from activeTotal in skill output', () => {
    const store = openStore();
    store.recordProjectActivity('C:/work/alpha', 'alpha', '2026-11-11T11:00:00.000Z', 's1');
    seed(store, 'alpha', 'A1', 0.9, '2026-11-11T11:00:00.000Z');
    seed(store, 'alpha', 'A2', 0.9, '2026-11-11T11:00:00.000Z');
    seed(store, 'alpha', 'A3', 0.9, '2026-11-11T11:00:00.000Z');
    seed(store, 'alpha', 'A4', 0.9, '2026-11-11T11:00:00.000Z');

    const first = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T12:00:00.000Z'),
      maxLoops: 3,
    });
    expect(first.total).toBe(3);

    const second = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T12:00:00.000Z'),
    });
    expect(second.total).toBe(0);
    expect(second.activeTotal).toBe(4);
    expect(second.eligibleTotal).toBe(1);

    const output = formatSkillDigest(second);
    expect(output).toContain('库存还有 4 条未闭环');
    expect(output).not.toContain('库存还有 1 条未闭环');
    expect(output).toContain('最近活跃：alpha');
  });

  it('renders skill-ready hot items with next action, close hint, and feedback prompt', () => {
    const store = openStore();
    store.recordProjectActivity('C:/work/alpha', 'alpha', '2026-11-11T11:00:00.000Z', 's1');
    const loop = seed(store, 'alpha', 'A1', 0.9, '2026-11-11T11:00:00.000Z');
    store.recordSurfaced([loop.id], '2026-11-11T11:00:00.000Z');

    const result = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T12:00:00.000Z'),
      cooldownHours: 0,
      markSurfaced: false,
    });
    expect(result.total).toBe(1);

    const output = formatSkillDigest(result);
    expect(output).toContain('1. **A1**');
    expect(output).toContain('下一步：next A1');
    expect(output).toContain('为什么现在提：why A1');
    expect(output).toContain('若已完成，直接说“关闭这条”');
    expect(output).toContain('做第 N 条');
    expect(output).toContain('回复示例');
    expect(output).toContain('哪条是你确实忘了');
    expect(output).toContain('哪条是噪音');
  });

  it('numbers every surfaced item so 回编号 is actionable', () => {
    const store = openStore();
    store.recordProjectActivity('C:/work/alpha', 'alpha', '2026-11-11T11:00:00.000Z', 's1');
    store.recordProjectActivity('C:/work/beta', 'beta', '2026-11-11T10:00:00.000Z', 's2');
    seed(store, 'alpha', 'A1', 0.9, '2026-11-11T11:00:00.000Z');
    seed(store, 'beta', 'B1', 0.85, '2026-11-11T10:00:00.000Z');

    const result = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T12:00:00.000Z'),
      markSurfaced: false,
    });
    const output = formatSkillDigest(result);

    expect(output).toContain('1. **A1**');
    expect(output).toContain('2. **B1**');
  });

  it('prints a stable ref on hot, review, and recap items', () => {
    const store = openStore();
    seed(store, 'alpha', 'A1', 0.9, '2026-11-11T11:00:00.000Z');
    seed(store, 'alpha', 'A2', 0.9, '2026-11-11T11:00:00.000Z');
    for (let index = 0; index < 3; index += 1) {
      store.recordProjectActivity(
        `C:/work/p${index}`,
        `p${index}`,
        '2026-11-11T11:00:00.000Z',
        `s${index}`,
      );
      seed(store, `p${index}`, `Loop ${index}`, 0.9, '2026-11-11T11:00:00.000Z');
    }

    const hot = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T12:00:00.000Z'),
    });
    const hotText = formatSkillDigest(hot);
    for (const loop of hot.groups.flatMap((group) => group.loops)) {
      expect(hotText).toContain(`[ref ${loopRef(loop.id)}]`);
    }

    const review = buildDigest({
      store,
      mode: 'review',
      now: new Date('2026-11-11T12:00:00.000Z'),
      markSurfaced: false,
    });
    const reviewText = formatDigest(review);
    for (const loop of review.groups.flatMap((group) => group.loops)) {
      expect(reviewText).toContain(`[ref ${loopRef(loop.id)}]`);
    }

    const recap = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T13:00:00.000Z'),
    });
    expect(recap.recap.length).toBeGreaterThan(0);
    const recapText = formatRecap(recap);
    for (const loop of recap.recap) {
      expect(recapText).toContain(`[ref ${loopRef(loop.id)}]`);
    }
  });

  it('keeps the active-project line to three ungrouped real projects', () => {
    const store = openStore();
    for (const [name, time] of [
      ['alpha', '2026-11-11T11:00:00.000Z'],
      ['beta', '2026-11-11T10:00:00.000Z'],
      ['gamma', '2026-11-11T09:00:00.000Z'],
      ['delta', '2026-11-11T08:00:00.000Z'],
      ['epsilon', '2026-11-11T07:00:00.000Z'],
    ]) {
      store.recordProjectActivity(`C:/work/${name}`, name, time, `s-${name}`);
    }
    seed(store, 'alpha', 'A1', 0.9, '2026-11-11T11:00:00.000Z');

    const result = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T12:00:00.000Z'),
      markSurfaced: false,
    });
    const output = formatSkillDigest(result);
    const activeLine = output.split('\n').find((line) => line.startsWith('最近活跃：'));

    expect(activeLine).toContain('beta');
    expect(activeLine).toContain('gamma');
    expect(activeLine).toContain('delta');
    expect(activeLine).not.toContain('alpha');
    expect(activeLine).not.toContain('epsilon');
  });

  it('resets the hot budget on a new local day even at exactly 24 hours', () => {
    const store = openStore();
    const start = new Date(2026, 10, 11, 12, 0, 0);
    store.recordProjectActivity('C:/work/alpha', 'alpha', start.toISOString(), 's1');
    for (let index = 0; index < 6; index += 1) {
      seed(store, 'alpha', `Loop ${index}`, 0.9, start.toISOString(), undefined, start.toISOString());
    }

    const first = buildDigest({ store, mode: 'hot', now: start, hotDays: 10 });
    const second = buildDigest({
      store,
      mode: 'hot',
      now: new Date(start.getTime() + 24 * 60 * 60 * 1000),
      hotDays: 10,
    });

    expect(first.total).toBe(3);
    expect(second.total).toBe(3);
    expect(first.dailyCapReached).toBe(false);
    expect(second.dailyCapReached).toBe(false);
  });

  it('rotates unseen hot loops before repeating surfaced ones', () => {
    const store = openStore();
    const start = new Date(2026, 10, 11, 12, 0, 0);
    store.recordProjectActivity('C:/work/alpha', 'alpha', start.toISOString(), 's1');
    for (let index = 0; index < 6; index += 1) {
      seed(store, 'alpha', `Loop ${index}`, 0.9, start.toISOString(), undefined, start.toISOString());
    }

    const first = buildDigest({ store, mode: 'hot', now: start, hotDays: 10 });
    const second = buildDigest({
      store,
      mode: 'hot',
      now: new Date(start.getTime() + 24 * 60 * 60 * 1000),
      hotDays: 10,
    });
    const firstTitles = first.groups.flatMap((group) => group.loops.map((loop) => loop.title));
    const secondTitles = second.groups.flatMap((group) => group.loops.map((loop) => loop.title));

    expect(firstTitles).toHaveLength(3);
    expect(secondTitles).toHaveLength(3);
    expect(secondTitles.filter((title) => firstTitles.includes(title))).toEqual([]);
    expect(new Set([...firstTitles, ...secondTitles]).size).toBe(6);
  });

  it('rotates projects with unseen loops before fully surfaced projects', () => {
    const store = openStore();
    const start = new Date(2026, 10, 11, 12, 0, 0);
    for (const name of ['alpha', 'beta', 'gamma', 'delta']) {
      store.recordProjectActivity(`C:/work/${name}`, name, start.toISOString(), `s-${name}`);
      seed(store, name, `${name} loop`, 0.9, start.toISOString(), undefined, start.toISOString());
    }

    const first = buildDigest({
      store,
      mode: 'hot',
      now: start,
      hotDays: 10,
      maxProjects: 2,
      maxLoops: 2,
    });
    const second = buildDigest({
      store,
      mode: 'hot',
      now: new Date(start.getTime() + 24 * 60 * 60 * 1000),
      hotDays: 10,
      maxProjects: 2,
      maxLoops: 2,
    });
    const firstNames = first.groups.map((group) => group.projectName);
    const secondNames = second.groups.map((group) => group.projectName);

    expect(first.total).toBe(2);
    expect(second.total).toBe(2);
    expect(secondNames.filter((name) => firstNames.includes(name))).toEqual([]);
    expect(new Set([...firstNames, ...secondNames]).size).toBe(4);
  });

  it('does not let large backlogs monopolize every hot slot', () => {
    const store = openStore();
    const start = new Date(2026, 10, 11, 12, 0, 0);
    for (const name of ['alpha', 'beta', 'gamma']) {
      store.recordProjectActivity(`C:/work/${name}`, name, start.toISOString(), `s-${name}`);
      for (let index = 0; index < 6; index += 1) {
        seed(
          store,
          name,
          `${name} ${index}`,
          0.9,
          start.toISOString(),
          undefined,
          start.toISOString(),
        );
      }
    }
    store.recordProjectActivity('C:/work/delta', 'delta', start.toISOString(), 's-delta');
    seed(store, 'delta', 'delta loop', 0.9, start.toISOString(), undefined, start.toISOString());

    const first = buildDigest({
      store,
      mode: 'hot',
      now: start,
      hotDays: 10,
      maxProjects: 2,
      maxLoops: 2,
    });
    const second = buildDigest({
      store,
      mode: 'hot',
      now: new Date(start.getTime() + 24 * 60 * 60 * 1000),
      hotDays: 10,
      maxProjects: 2,
      maxLoops: 2,
    });

    expect(first.total).toBe(2);
    expect(second.total).toBe(2);
    expect(second.groups.map((group) => group.projectName)).toContain('delta');
  });

  it('keeps an old open loop in the weekly review', () => {
    const store = openStore();
    const now = new Date('2026-11-11T12:00:00.000Z');
    const old = '2026-09-01T12:00:00.000Z';
    store.recordProjectActivity('C:/work/old', 'old', old, 's1');
    seed(store, 'old', 'Old open loop', 0.9, old, undefined, old);

    const review = buildDigest({ store, mode: 'review', now, markSurfaced: false });
    const output = formatDigest(review);

    expect(review.total).toBe(1);
    expect(output).toContain('Old open loop');
    expect(output).toContain('已挂');
  });

  it('surfaces an old loop in hot when its project becomes active again', () => {
    const store = openStore();
    const now = new Date('2026-11-11T12:00:00.000Z');
    const old = '2026-09-01T12:00:00.000Z';
    seed(store, 'old', 'Resumed project loop', 0.9, old, undefined, old);
    store.recordProjectActivity('C:/work/old', 'old', now.toISOString(), 's2');

    const hot = buildDigest({ store, mode: 'hot', now, markSurfaced: false });

    expect(hot.total).toBe(1);
    expect(hot.groups[0].loops[0].title).toBe('Resumed project loop');
  });

  it('includes a recently surfaced loop in the weekly review', () => {
    const store = openStore();
    const now = new Date('2026-11-11T12:00:00.000Z');
    store.recordProjectActivity('C:/work/alpha', 'alpha', now.toISOString(), 's1');
    const loop = seed(store, 'alpha', 'Recently shown', 0.9, now.toISOString());
    store.recordSurfaced([loop.id], new Date(now.getTime() - 60 * 60 * 1000).toISOString());

    const review = buildDigest({ store, mode: 'review', now, markSurfaced: false });
    const hot = buildDigest({ store, mode: 'hot', now, markSurfaced: false });

    expect(review.total).toBe(1);
    expect(hot.total).toBe(0);
    expect(hot.coolingDown).toBe(1);
  });

  it('rotates the weekly review across projects that were not reviewed recently', () => {
    const store = openStore();
    const start = new Date(2026, 10, 11, 12, 0, 0);
    for (const name of ['alpha', 'beta', 'gamma', 'delta']) {
      store.recordProjectActivity(`C:/work/${name}`, name, start.toISOString(), `s-${name}`);
      seed(store, name, `${name} loop`, 0.9, start.toISOString(), undefined, start.toISOString());
    }

    const first = buildDigest({
      store,
      mode: 'review',
      now: start,
      maxProjects: 2,
      maxLoops: 2,
    });
    const second = buildDigest({
      store,
      mode: 'review',
      now: new Date(start.getTime() + 24 * 60 * 60 * 1000),
      maxProjects: 2,
      maxLoops: 2,
    });
    const firstNames = first.groups.map((group) => group.projectName);
    const secondNames = second.groups.map((group) => group.projectName);

    expect(first.total).toBe(2);
    expect(second.total).toBe(2);
    expect(secondNames.filter((name) => firstNames.includes(name))).toEqual([]);
    expect(new Set([...firstNames, ...secondNames]).size).toBe(4);
  });

  it('rotates the read-only fallback by local day without writing', () => {
    const store = openStore();
    const start = new Date(2026, 10, 11, 12, 0, 0);
    store.recordProjectActivity('C:/work/alpha', 'alpha', start.toISOString(), 's1');
    for (let index = 0; index < 6; index += 1) {
      seed(store, 'alpha', `Loop ${index}`, 0.9, start.toISOString(), undefined, start.toISOString());
    }

    const first = buildDigest({
      store,
      mode: 'hot',
      now: start,
      hotDays: 10,
      markSurfaced: false,
      readonlyRotation: true,
    });
    const second = buildDigest({
      store,
      mode: 'hot',
      now: new Date(start.getTime() + 24 * 60 * 60 * 1000),
      hotDays: 10,
      markSurfaced: false,
      readonlyRotation: true,
    });
    const firstTitles = first.groups.flatMap((group) => group.loops.map((loop) => loop.title));
    const secondTitles = second.groups.flatMap((group) => group.loops.map((loop) => loop.title));

    expect(first.total).toBe(3);
    expect(second.total).toBe(3);
    expect(secondTitles.filter((title) => firstTitles.includes(title))).toEqual([]);
    expect(new Set([...firstTitles, ...secondTitles]).size).toBe(6);
  });

  it('gives a lower-confidence project a turn after every project has been shown', () => {
    const store = openStore();
    const now = new Date('2026-11-11T12:00:00.000Z');
    for (const [name, confidence] of [['alpha', 0.95], ['beta', 0.95], ['gamma', 0.6]] as const) {
      store.recordProjectActivity(`C:/work/${name}`, name, now.toISOString(), `s-${name}`);
      const loop = seed(store, name, `${name} loop`, confidence, now.toISOString());
      store.recordSurfaced(
        [loop.id],
        new Date(now.getTime() - (name === 'gamma' ? 3 : 1) * 24 * 60 * 60 * 1000).toISOString(),
      );
    }

    const review = buildDigest({
      store,
      mode: 'review',
      now,
      maxProjects: 2,
      maxLoops: 2,
      markSurfaced: false,
    });

    expect(review.total).toBe(2);
    expect(review.groups.map((group) => group.projectName)).toContain('gamma');
  });

  it('rotates the weekly review toward the least recently shown loop in a project', () => {
    const store = openStore();
    const now = new Date('2026-11-11T12:00:00.000Z');
    store.recordProjectActivity('C:/work/alpha', 'alpha', now.toISOString(), 's1');
    const high = seed(store, 'alpha', 'High confidence', 0.95, now.toISOString());
    const low = seed(store, 'alpha', 'Low confidence', 0.6, now.toISOString());
    store.recordSurfaced(
      [high.id],
      new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
    );
    store.recordSurfaced(
      [low.id],
      new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    );

    const review = buildDigest({
      store,
      mode: 'review',
      now,
      maxProjects: 1,
      maxLoops: 1,
      markSurfaced: false,
    });

    expect(review.total).toBe(1);
    expect(review.groups[0].loops[0].title).toBe('Low confidence');
  });

  it('prioritizes real projects over session workspaces in the weekly review', () => {
    const store = openStore();
    const now = new Date('2026-11-11T12:00:00.000Z');
    for (const name of ['alpha', 'beta', 'gamma']) {
      store.recordProjectActivity(`C:/work/${name}`, name, now.toISOString(), `s-${name}`);
      seed(store, name, `${name} loop`, 0.7, now.toISOString());
    }
    for (const name of ['Hermes · one', 'Qoder · two', 'ZCode · three']) {
      store.recordProjectActivity(
        `C:/sessions/${name}`,
        name,
        now.toISOString(),
        `s-${name}`,
      );
      seed(store, name, `${name} loop`, 0.95, now.toISOString());
    }

    const review = buildDigest({
      store,
      mode: 'review',
      now,
      maxProjects: 3,
      maxLoops: 3,
      markSurfaced: false,
    });

    expect(review.total).toBe(3);
    expect(review.groups.map((group) => group.projectName).sort())
      .toEqual(['alpha', 'beta', 'gamma']);
  });

  it('still fills the weekly review with session workspaces when real projects are short', () => {
    const store = openStore();
    const now = new Date('2026-11-11T12:00:00.000Z');
    store.recordProjectActivity('C:/work/alpha', 'alpha', now.toISOString(), 's-alpha');
    seed(store, 'alpha', 'alpha loop', 0.7, now.toISOString());
    for (const name of ['Hermes · one', 'Qoder · two']) {
      store.recordProjectActivity(
        `C:/sessions/${name}`,
        name,
        now.toISOString(),
        `s-${name}`,
      );
      seed(store, name, `${name} loop`, 0.9, now.toISOString());
    }

    const review = buildDigest({
      store,
      mode: 'review',
      now,
      maxProjects: 3,
      maxLoops: 3,
      markSurfaced: false,
    });

    expect(review.total).toBe(3);
    expect(review.groups[0].projectName).toBe('alpha');
    expect(review.groups.map((group) => group.projectName)).toContain('Hermes · one');
    expect(review.groups.map((group) => group.projectName)).toContain('Qoder · two');
  });

  it('warns when the local cache has not been refreshed for too long', () => {
    const store = openStore();
    const now = new Date();
    store.recordProjectActivity('C:/work/alpha', 'alpha', now.toISOString(), 's-alpha');
    seed(store, 'alpha', 'alpha loop', 0.8, now.toISOString());
    const runId = store.startRun('session');
    store.finishRun(runId, {
      sessionsSeen: 0,
      sessionsProcessed: 0,
      sessionsSkipped: 0,
      signalsSeen: 0,
      loopsCreated: 0,
      loopsMerged: 0,
      errors: [],
    });

    const fresh = buildDigest({ store, mode: 'hot', now, markSurfaced: false });
    expect(fresh.cacheStale).toBe(false);
    expect(formatSkillDigest(fresh)).not.toContain('本地缓存已');

    const stale = buildDigest({
      store,
      mode: 'hot',
      now: new Date(now.getTime() + 7 * 60 * 60 * 1000),
      hotDays: 10,
      markSurfaced: false,
    });
    expect(stale.cacheStale).toBe(true);
    expect(formatSkillDigest(stale)).toContain('本地缓存已');
  });

  it('nudges calibration after ten surfaced loops without feedback', () => {
    const store = openStore();
    const now = new Date('2026-11-11T12:00:00.000Z');
    store.recordProjectActivity('C:/work/alpha', 'alpha', now.toISOString(), 's-alpha');
    const loops: ReturnType<typeof seed>[] = [];
    for (let index = 0; index < 10; index += 1) {
      loops.push(seed(store, 'alpha', `Loop ${index}`, 0.9, now.toISOString()));
    }
    store.recordSurfaced(loops.map((loop) => loop.id), '2026-11-11T11:00:00.000Z');

    const result = buildDigest({
      store,
      mode: 'review',
      now,
      maxLoops: 5,
      markSurfaced: false,
    });
    const output = formatSkillDigest(result);

    expect(result.feedbackTotal).toBe(0);
    expect(result.surfacedTotal).toBe(10);
    expect(output).toContain('校准提示');
    expect(output).toContain('已经回访 10 条');
  });

  it('stops the calibration nudge after the first real verdict', () => {
    const store = openStore();
    const now = new Date('2026-11-11T12:00:00.000Z');
    store.recordProjectActivity('C:/work/alpha', 'alpha', now.toISOString(), 's-alpha');
    const loops: ReturnType<typeof seed>[] = [];
    for (let index = 0; index < 10; index += 1) {
      loops.push(seed(store, 'alpha', `Loop ${index}`, 0.9, now.toISOString()));
    }
    store.recordSurfaced(loops.map((loop) => loop.id), '2026-11-11T11:00:00.000Z');
    store.recordFeedback(loops[0].id, 'forgotten', '确实忘了', '2026-11-11T11:30:00.000Z');

    const result = buildDigest({
      store,
      mode: 'review',
      now,
      maxLoops: 5,
      markSurfaced: false,
    });

    expect(result.feedbackTotal).toBe(1);
    expect(formatSkillDigest(result)).not.toContain('校准提示');
  });

  it('shows fresh reconcile candidates in the weekly review without closing them', () => {
    const store = openStore();
    const now = new Date('2026-11-11T12:00:00.000Z');
    store.recordProjectActivity('C:/work/alpha', 'alpha', now.toISOString(), 's-alpha');
    const shown = seed(store, 'alpha', 'Still open', 0.95, now.toISOString());
    const candidate = seed(store, 'alpha', 'Looks done', 0.7, now.toISOString());
    store.setReconcileCache(
      'dsh:s-alpha',
      'hash-alpha',
      [{
        loopId: candidate.id,
        confidence: 0.95,
        reason: '已完成：后续会话明确复跑并通过验证',
        evidenceMessageIds: ['m1', 'm2'],
      }],
      now.toISOString(),
    );

    const result = buildDigest({
      store,
      mode: 'review',
      now,
      maxLoops: 1,
      markSurfaced: false,
    });
    const output = formatDigest(result);

    expect(result.groups.flatMap((group) => group.loops.map((loop) => loop.id)))
      .toEqual([shown.id]);
    expect(result.reconcileCandidates.map((item) => item.loopId)).toEqual([candidate.id]);
    expect(output).toContain('可能已完成');
    expect(output).toContain('Looks done');
    expect(output).toContain('确认后再说');
    expect(store.getLoop(candidate.id)?.status).toBe('open');
  });

  it('ignores stale reconcile candidates', () => {
    const store = openStore();
    const now = new Date('2026-11-11T12:00:00.000Z');
    store.recordProjectActivity('C:/work/alpha', 'alpha', now.toISOString(), 's-alpha');
    const candidate = seed(store, 'alpha', 'Old candidate', 0.7, '2026-11-01T12:00:00.000Z');
    store.setReconcileCache(
      'dsh:s-alpha',
      'hash-alpha',
      [{
        loopId: candidate.id,
        confidence: 0.95,
        reason: '已完成：旧核对',
        evidenceMessageIds: ['m1'],
      }],
      '2026-11-01T12:00:00.000Z',
    );

    const result = buildDigest({
      store,
      mode: 'review',
      now,
      markSurfaced: false,
    });

    expect(result.reconcileCandidates).toEqual([]);
    expect(formatDigest(result)).not.toContain('可能已完成');
  });

  it('does not show snoozed reconcile candidates', () => {
    const store = openStore();
    const now = new Date('2026-11-11T12:00:00.000Z');
    store.recordProjectActivity('C:/work/alpha', 'alpha', now.toISOString(), 's-alpha');
    const candidate = seed(store, 'alpha', 'Paused candidate', 0.7, now.toISOString());
    store.updateLoop(candidate.id, {
      status: 'snoozed',
      snoozeUntil: '2026-11-12T12:00:00.000Z',
    });
    store.setReconcileCache(
      'dsh:s-alpha',
      'hash-alpha',
      [{
        loopId: candidate.id,
        confidence: 0.95,
        reason: '已完成：后续会话已验证',
        evidenceMessageIds: ['m1'],
      }],
      now.toISOString(),
    );

    const result = buildDigest({
      store,
      mode: 'review',
      now,
      markSurfaced: false,
    });

    expect(result.reconcileCandidates).toEqual([]);
    expect(formatDigest(result)).not.toContain('可能已完成');
  });

  it('reserves one hot slot for a due revisit when fresh items can fill the day', () => {
    const store = openStore();
    const now = new Date('2026-11-11T12:00:00.000Z');
    for (const name of ['alpha', 'beta', 'gamma']) {
      store.recordProjectActivity(`C:/work/${name}`, name, now.toISOString(), `s-${name}`);
      seed(store, name, `${name} fresh`, 0.9, now.toISOString());
    }
    store.recordProjectActivity('C:/work/zeta', 'zeta', now.toISOString(), 's-zeta');
    const old = seed(
      store,
      'zeta',
      'Old revisit',
      0.9,
      '2026-11-06T12:00:00.000Z',
      undefined,
      '2026-10-01T12:00:00.000Z',
    );
    store.recordSurfaced([old.id], '2026-11-06T12:00:00.000Z');

    const result = buildDigest({
      store,
      mode: 'hot',
      now,
      markSurfaced: false,
    });
    const titles = result.groups.flatMap((group) => group.loops.map((loop) => loop.title));

    expect(result.total).toBe(3);
    expect(result.revisitReady).toBe(1);
    expect(titles).toContain('Old revisit');
    expect(titles.filter((title) => title.endsWith(' fresh'))).toHaveLength(2);
  });

  it('does not reserve a revisit slot before the follow-up interval', () => {
    const store = openStore();
    const now = new Date('2026-11-11T12:00:00.000Z');
    for (const name of ['alpha', 'beta', 'gamma']) {
      store.recordProjectActivity(`C:/work/${name}`, name, now.toISOString(), `s-${name}`);
      seed(store, name, `${name} fresh`, 0.9, now.toISOString());
    }
    store.recordProjectActivity('C:/work/zeta', 'zeta', now.toISOString(), 's-zeta');
    const recent = seed(
      store,
      'zeta',
      'Recent revisit',
      0.9,
      '2026-11-10T12:00:00.000Z',
      undefined,
      '2026-10-01T12:00:00.000Z',
    );
    store.recordSurfaced([recent.id], '2026-11-10T12:00:00.000Z');

    const result = buildDigest({
      store,
      mode: 'hot',
      now,
      markSurfaced: false,
    });
    const titles = result.groups.flatMap((group) => group.loops.map((loop) => loop.title));

    expect(result.total).toBe(3);
    expect(result.revisitReady).toBe(0);
    expect(result.revisitWaiting).toBe(1);
    expect(titles).not.toContain('Recent revisit');
    expect(titles.filter((title) => title.endsWith(' fresh'))).toHaveLength(3);
  });

  it('keeps a user-confirmed loop in hot after its project leaves the active window', () => {
    const store = openStore();
    const now = new Date('2026-11-11T12:00:00.000Z');
    const confirmed = seed(
      store,
      'quiet',
      'Confirmed useful',
      0.9,
      '2026-10-30T12:00:00.000Z',
      undefined,
      '2026-10-01T12:00:00.000Z',
    );
    store.recordFeedback(
      confirmed.id,
      'forgotten',
      '用户反馈这几条挺有用',
      '2026-11-11T11:00:00.000Z',
    );

    const result = buildDigest({
      store,
      mode: 'hot',
      now,
      markSurfaced: false,
    });

    expect(result.total).toBe(1);
    expect(result.groups[0].projectName).toBe('quiet');
    expect(result.revisitReady).toBe(1);
    expect(result.confirmedIds).toContain(confirmed.id);
    expect(formatDigest(result)).toContain('已确认有用');
  });

  it('prefers a confirmed follow item over a non-confirmed revisit', () => {
    const store = openStore();
    const now = new Date('2026-11-11T12:00:00.000Z');
    for (const name of ['alpha', 'beta', 'gamma']) {
      store.recordProjectActivity(`C:/work/${name}`, name, now.toISOString(), `s-${name}`);
      seed(store, name, `${name} fresh`, 0.9, now.toISOString());
    }
    const confirmed = seed(
      store,
      'quiet',
      'Confirmed follow',
      0.9,
      '2026-10-30T12:00:00.000Z',
      undefined,
      '2026-10-01T12:00:00.000Z',
    );
    store.recordFeedback(confirmed.id, 'forgotten', '确实有用', '2026-11-11T11:00:00.000Z');
    store.recordProjectActivity('C:/work/zeta', 'zeta', now.toISOString(), 's-zeta');
    const revisit = seed(
      store,
      'zeta',
      'Plain revisit',
      0.9,
      '2026-11-06T12:00:00.000Z',
      undefined,
      '2026-10-01T12:00:00.000Z',
    );
    store.recordSurfaced([revisit.id], '2026-11-06T12:00:00.000Z');

    const result = buildDigest({
      store,
      mode: 'hot',
      now,
      markSurfaced: false,
    });
    const titles = result.groups.flatMap((group) => group.loops.map((loop) => loop.title));

    expect(result.total).toBe(3);
    expect(result.revisitReady).toBe(2);
    expect(titles).toContain('Confirmed follow');
    expect(titles).not.toContain('Plain revisit');
  });

  it('reserves a hot slot for a confirmed fresh item before the daily cap', () => {
    const store = openStore();
    const now = new Date('2026-11-11T12:00:00.000Z');
    for (const name of ['alpha', 'beta', 'gamma']) {
      store.recordProjectActivity(
        `C:/work/${name}`,
        name,
        now.toISOString(),
        `s-${name}`,
      );
      seed(store, name, `${name} fresh`, 0.95, now.toISOString());
    }
    store.recordProjectActivity('C:/work/quiet', 'quiet', now.toISOString(), 's-q');
    const confirmed = seed(
      store,
      'quiet',
      'Confirmed fresh',
      0.6,
      now.toISOString(),
      undefined,
      '2026-10-01T12:00:00.000Z',
    );
    store.recordFeedback(
      confirmed.id,
      'forgotten',
      '确实忘了',
      '2026-11-11T11:00:00.000Z',
    );

    const result = buildDigest({
      store,
      mode: 'hot',
      now,
      markSurfaced: false,
    });
    const titles = result.groups.flatMap((group) => group.loops.map((loop) => loop.title));

    expect(result.total).toBe(3);
    expect(result.dailyCapReached).toBe(false);
    expect(titles).toContain('Confirmed fresh');
  });

  it('fills leftover hot slots with old items when fresh items are scarce', () => {
    const store = openStore();
    const now = new Date('2026-11-11T12:00:00.000Z');
    for (const name of ['alpha', 'beta']) {
      store.recordProjectActivity(`C:/work/${name}`, name, now.toISOString(), `s-${name}`);
      seed(store, name, `${name} fresh`, 0.9, now.toISOString());
    }
    for (const name of ['gamma', 'delta', 'epsilon']) {
      store.recordProjectActivity(`C:/work/${name}`, name, now.toISOString(), `s-${name}`);
      const old = seed(
        store,
        name,
        `${name} old`,
        0.9,
        '2026-11-10T11:00:00.000Z',
        undefined,
        '2026-10-01T11:00:00.000Z',
      );
      store.recordSurfaced([old.id], '2026-11-10T11:00:00.000Z');
    }

    const result = buildDigest({
      store,
      mode: 'hot',
      now,
      markSurfaced: false,
    });
    const titles = result.groups.flatMap((group) => group.loops.map((loop) => loop.title));

    expect(result.total).toBe(3);
    expect(result.revisitReady).toBe(0);
    expect(result.revisitWaiting).toBe(3);
    expect(titles.filter((title) => title.endsWith(' fresh'))).toHaveLength(2);
    expect(titles.filter((title) => title.endsWith(' old'))).toHaveLength(1);
  });

  it('keeps one follow-up slot when the focus project has enough fresh items', () => {
    const store = openStore();
    const now = new Date('2026-11-11T12:00:00.000Z');
    store.recordProjectActivity('C:/work/alpha', 'alpha', now.toISOString(), 's-alpha');
    for (let index = 0; index < 3; index += 1) {
      seed(store, 'alpha', `alpha fresh ${index}`, 0.9, now.toISOString());
    }
    store.recordProjectActivity('C:/work/zeta', 'zeta', now.toISOString(), 's-zeta');
    const old = seed(
      store,
      'zeta',
      'Focus follow-up',
      0.9,
      '2026-11-06T12:00:00.000Z',
      undefined,
      '2026-10-01T12:00:00.000Z',
    );
    store.recordSurfaced([old.id], '2026-11-06T12:00:00.000Z');

    const result = buildDigest({
      store,
      mode: 'hot',
      now,
      markSurfaced: false,
      focusProjectDir: 'C:/work/alpha',
    });
    const titles = result.groups.flatMap((group) => group.loops.map((loop) => loop.title));

    expect(result.total).toBe(3);
    expect(result.focusProject?.shown).toBe(2);
    expect(titles).toContain('Focus follow-up');
    expect(titles.filter((title) => title.startsWith('alpha fresh'))).toHaveLength(2);
  });

  it('does not let positive feedback bypass noise suppression', () => {
    const store = openStore();
    const now = new Date('2026-11-11T12:00:00.000Z');
    const noisy = seed(
      store,
      'quiet',
      'Noisy quiet item',
      0.9,
      '2026-10-30T12:00:00.000Z',
      undefined,
      '2026-10-01T12:00:00.000Z',
    );
    store.recordFeedback(noisy.id, 'noise', '不是我要跟的', '2026-11-11T11:00:00.000Z');

    const result = buildDigest({
      store,
      mode: 'hot',
      now,
      markSurfaced: false,
    });

    expect(result.total).toBe(0);
    expect(result.noiseSuppressed).toBe(1);
    expect(result.confirmedIds).not.toContain(noisy.id);
  });
});
