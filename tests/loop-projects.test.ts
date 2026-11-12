import { describe, it, expect, afterEach } from 'vitest';
import { LoopStore } from '../src/loops/loop-store.js';
import {
  buildProjectOverview,
  formatProjectOverview,
} from '../src/loops/projects.js';

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
  status: 'open' | 'pending',
) {
  const loop = store.saveLoop(
    {
      title,
      nextAction: `next ${title}`,
      why: `why ${title}`,
      confidence: status === 'open' ? 0.9 : 0.4,
      sourceSignalIds: [`${project}:${title}`],
    },
    {
      projectDir: `C:/work/${project}`,
      projectName: project,
      lastSeen: '2026-11-10T10:00:00.000Z',
    },
  ).loop;
  if (loop.status !== status) store.updateLoop(loop.id, { status });
  return loop;
}

function seedAt(
  store: LoopStore,
  projectDir: string,
  projectName: string,
  title: string,
  status: 'open' | 'pending',
) {
  const loop = store.saveLoop(
    {
      title,
      nextAction: `next ${title}`,
      why: `why ${title}`,
      confidence: status === 'open' ? 0.9 : 0.4,
      sourceSignalIds: [`${projectDir}:${title}`],
    },
    {
      projectDir,
      projectName,
      lastSeen: '2026-11-10T10:00:00.000Z',
    },
  ).loop;
  if (loop.status !== status) store.updateLoop(loop.id, { status });
  return loop;
}

describe('buildProjectOverview', () => {
  it('lists recently active projects even when they have no loops', () => {
    const store = openStore();
    store.recordProjectActivity('C:/work/alpha', 'alpha', '2026-11-11T11:00:00.000Z', 's1');
    store.recordProjectActivity('C:/work/gamma', 'gamma', '2026-11-10T11:00:00.000Z', 's2');
    store.recordProjectActivity('C:/work/eta', 'ZCode · eta', '2026-11-11T11:30:00.000Z', 's4');
    store.recordProjectActivity('C:/work/beta', 'beta', '2026-10-01T11:00:00.000Z', 's3');
    seed(store, 'alpha', 'A1', 'open');
    seed(store, 'alpha', 'A2', 'pending');

    const projects = buildProjectOverview({
      store,
      now: new Date('2026-11-11T12:00:00.000Z'),
      days: 7,
    });

    expect(projects.map((project) => project.projectName)).toEqual(['alpha', 'gamma', 'ZCode · eta']);
    expect(projects[0]).toMatchObject({ open: 1, pending: 1, total: 2, sessionCount: 1 });
    expect(projects[1]).toMatchObject({ open: 0, pending: 0, total: 0, sessionCount: 1 });
    expect(formatProjectOverview(projects, new Date('2026-11-11T12:00:00.000Z')))
      .toContain('**gamma** · 1 天前 · 会话 1 · 无未闭环');
  });

  it('keeps a project that only has recent loop evidence', () => {
    const store = openStore();
    seed(store, 'delta', 'D1', 'open');

    const projects = buildProjectOverview({
      store,
      now: new Date('2026-11-11T12:00:00.000Z'),
      days: 7,
    });

    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      projectName: 'delta',
      sessionCount: 0,
      open: 1,
      lastActive: '2026-11-10T10:00:00.000Z',
    });
  });

  it('excludes a workspace container that has multiple active child projects and no loops', () => {
    const store = openStore();
    store.recordProjectActivity('C:\\Work', 'Work', '2026-11-11T11:45:00.000Z', 'container');
    store.recordProjectActivity('c:/work/alpha', 'alpha', '2026-11-11T11:00:00.000Z', 's1');
    store.recordProjectActivity('C:/work/beta', 'beta', '2026-11-11T10:00:00.000Z', 's2');
    store.recordProjectActivity('C:/work/gamma', 'gamma', '2026-11-11T09:00:00.000Z', 's3');

    const projects = buildProjectOverview({
      store,
      now: new Date('2026-11-11T12:00:00.000Z'),
      days: 7,
    });

    expect(projects.map((project) => project.projectName)).toEqual(['alpha', 'beta', 'gamma']);
    expect(formatProjectOverview(projects, new Date('2026-11-11T12:00:00.000Z')))
      .toContain('# 最近 7 天活跃项目 · 3');
  });

  it('keeps a workspace root that has its own unfinished loops', () => {
    const store = openStore();
    store.recordProjectActivity('C:/work', 'work', '2026-11-11T11:45:00.000Z', 'container');
    store.recordProjectActivity('C:/work/alpha', 'alpha', '2026-11-11T11:00:00.000Z', 's1');
    store.recordProjectActivity('C:/work/beta', 'beta', '2026-11-11T10:00:00.000Z', 's2');
    seedAt(store, 'C:/work', 'work', 'Root task', 'open');

    const projects = buildProjectOverview({
      store,
      now: new Date('2026-11-11T12:00:00.000Z'),
      days: 7,
    });

    expect(projects.map((project) => project.projectName)).toEqual(['work', 'alpha', 'beta']);
    expect(projects[0].open).toBe(1);
  });

  it('keeps a directory that contains only one active project', () => {
    const store = openStore();
    store.recordProjectActivity('C:/work', 'work', '2026-11-11T11:45:00.000Z', 'parent');
    store.recordProjectActivity('C:/work/alpha', 'alpha', '2026-11-11T11:00:00.000Z', 's1');

    const projects = buildProjectOverview({
      store,
      now: new Date('2026-11-11T12:00:00.000Z'),
      days: 7,
    });

    expect(projects.map((project) => project.projectName)).toEqual(['work', 'alpha']);
  });

  it('does not treat a sibling path sharing the same prefix as a child project', () => {
    const store = openStore();
    store.recordProjectActivity('C:/work/project', 'project', '2026-11-11T11:45:00.000Z', 'parent');
    store.recordProjectActivity('C:/work/project2', 'project2', '2026-11-11T11:00:00.000Z', 's2');
    store.recordProjectActivity('C:/work/project/alpha', 'alpha', '2026-11-11T10:00:00.000Z', 's1');

    const projects = buildProjectOverview({
      store,
      now: new Date('2026-11-11T12:00:00.000Z'),
      days: 7,
    });

    expect(projects.map((project) => project.projectName)).toEqual([
      'project',
      'project2',
      'alpha',
    ]);
  });

  it('counts only sessions inside the activity window', () => {
    const store = openStore();
    store.recordProjectActivity('C:/work/alpha', 'alpha', '2026-09-01T10:00:00.000Z', 'old');
    store.recordProjectActivity('C:/work/alpha', 'alpha', '2026-11-11T11:00:00.000Z', 'new');

    const projects = buildProjectOverview({
      store,
      now: new Date('2026-11-11T12:00:00.000Z'),
      days: 7,
    });

    expect(projects[0]).toMatchObject({ projectName: 'alpha', sessionCount: 1 });
    expect(store.getProjectActivity('C:/work/alpha')?.sessionCount).toBe(2);
  });

  it('separates real projects from session-only workspaces', () => {
    const store = openStore();
    store.recordProjectActivity('C:/work/alpha', 'alpha', '2026-11-11T11:00:00.000Z', 's1');
    store.recordProjectActivity('C:/work/beta', 'beta', '2026-11-11T10:00:00.000Z', 's2');
    for (let index = 0; index < 7; index += 1) {
      store.recordProjectActivity(
        `C:/work/temp-${index}`,
        `ZCode · 会话 ${index}`,
        '2026-11-11T09:00:00.000Z',
        `temp-${index}`,
      );
    }

    const projects = buildProjectOverview({
      store,
      now: new Date('2026-11-11T12:00:00.000Z'),
      days: 7,
    });
    const output = formatProjectOverview(projects, new Date('2026-11-11T12:00:00.000Z'));

    expect(output).toContain('# 最近 7 天活跃项目 · 2');
    expect(output).toContain('## 临时会话工作区 · 7 个');
    expect(output).toContain('另有 2 个无未闭环');
  });

  it('marks DSH home workspaces as session-only', () => {
    const store = openStore();
    store.recordProjectActivity(
      'C:/Users/me/.dsh-sessions/session-1',
      'DSH · 排查 zstd 多帧',
      '2026-11-11T11:00:00.000Z',
      's1',
    );
    store.recordProjectActivity('C:/work/alpha', 'alpha', '2026-11-11T10:00:00.000Z', 's2');

    const projects = buildProjectOverview({
      store,
      now: new Date('2026-11-11T12:00:00.000Z'),
      days: 7,
    });
    const output = formatProjectOverview(projects, new Date('2026-11-11T12:00:00.000Z'));

    expect(projects.find((project) => project.projectName === 'DSH · 排查 zstd 多帧'))
      .toMatchObject({ sessionOnly: true });
    expect(output).toContain('# 最近 7 天活跃项目 · 1');
    expect(output).toContain('## 临时会话工作区 · 1 个');
  });

  it('marks Antigravity home workspaces as session-only', () => {
    const store = openStore();
    store.recordProjectActivity(
      'C:/Users/me/.gemini/antigravity-cli/sessions/one',
      'Antigravity · 用一句话说明你是什么模型',
      '2026-11-11T11:00:00.000Z',
      's1',
    );
    store.recordProjectActivity('C:/work/alpha', 'alpha', '2026-11-11T10:00:00.000Z', 's2');

    const projects = buildProjectOverview({
      store,
      now: new Date('2026-11-11T12:00:00.000Z'),
      days: 7,
    });
    const output = formatProjectOverview(projects, new Date('2026-11-11T12:00:00.000Z'));

    expect(projects.find((project) => project.projectName === 'Antigravity · 用一句话说明你是什么模型'))
      .toMatchObject({ sessionOnly: true });
    expect(output).toContain('# 最近 7 天活跃项目 · 1');
    expect(output).toContain('## 临时会话工作区 · 1 个');
  });

  it('collapses hidden session-only workspaces and keeps their backlog count', () => {
    const store = openStore();
    for (let index = 0; index < 7; index += 1) {
      const project = `temp-${index}`;
      store.recordProjectActivity(
        `C:/work/${project}`,
        `ZCode · 会话 ${index}`,
        `2026-11-11T0${index}:00:00.000Z`,
        `temp-${index}`,
      );
      seed(store, project, `T${index}`, 'open');
    }

    const projects = buildProjectOverview({
      store,
      now: new Date('2026-11-11T12:00:00.000Z'),
      days: 7,
    });
    const output = formatProjectOverview(projects, new Date('2026-11-11T12:00:00.000Z'));

    expect(output).toContain('## 临时会话工作区 · 7 个');
    expect(output).toContain('另有 2 个有未闭环（open 2 / pending 0）');
  });

  it('counts all session-only workspaces beyond the old default project limit', () => {
    const store = openStore();
    store.recordProjectActivity('C:/work/alpha', 'alpha', '2026-11-11T11:00:00.000Z', 's0');
    store.recordProjectActivity('C:/work/beta', 'beta', '2026-11-11T10:00:00.000Z', 's1');
    for (let index = 0; index < 25; index += 1) {
      store.recordProjectActivity(
        `C:/work/temp-${index}`,
        `ZCode · 会话 ${index}`,
        `2026-11-11T09:${String(index).padStart(2, '0')}:00.000Z`,
        `temp-${index}`,
      );
    }

    const projects = buildProjectOverview({
      store,
      now: new Date('2026-11-11T12:00:00.000Z'),
      days: 7,
    });
    const output = formatProjectOverview(projects, new Date('2026-11-11T12:00:00.000Z'));

    expect(output).toContain('## 临时会话工作区 · 25 个');
    expect(output).toContain('另有 20 个无未闭环');
  });
});
