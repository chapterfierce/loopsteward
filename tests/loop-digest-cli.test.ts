import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LoopStore } from '../src/loops/loop-store.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('loops:digest --skill', () => {
  it('emits the skill-ready copy without model-side formatting', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-digest-cli-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'loops.db');
    const now = new Date().toISOString();
    const store = new LoopStore(dbPath);
    store.recordProjectActivity('C:/work/alpha', 'alpha', now, 's1');
    store.saveLoop(
      {
        title: '补齐登录页错误提示',
        nextAction: '把错误码映射成用户能看懂的提示',
        why: '会话结束时还没验证提示文案',
        confidence: 0.9,
        sourceSignalIds: ['alpha:login-error'],
      },
      { projectDir: 'C:/work/alpha', projectName: 'alpha', lastSeen: now },
    );
    store.close();

    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', path.join('src', 'loops', 'cli.ts'), 'digest', '--db', dbPath, '--skill', '--no-mark'],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('# 回访 · 1 条');
    expect(result.stdout).toContain('1. **补齐登录页错误提示**');
    expect(result.stdout).toContain('下一步：把错误码映射成用户能看懂的提示');
    expect(result.stdout).toContain('为什么现在提：会话结束时还没验证提示文案');
    expect(result.stdout).toContain('哪条是你确实忘了');

    const readonly = spawnSync(
      process.execPath,
      ['--import', 'tsx', path.join('src', 'loops', 'cli.ts'), 'digest', '--db', dbPath, '--skill', '--no-mark', '--readonly-fallback'],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    expect(readonly.status).toBe(0);
    expect(readonly.stdout.startsWith('只读会话：本次回访不记入每日预算。\n\n# 回访')).toBe(true);

    const json = spawnSync(
      process.execPath,
      ['--import', 'tsx', path.join('src', 'loops', 'cli.ts'), 'digest', '--db', dbPath, '--json', '--no-mark', '--readonly-fallback'],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout).readonlyFallback).toBe(true);
  });

  it('supports --recap-cooldown-minutes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-digest-cooldown-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'loops.db');
    const now = new Date();
    const surfacedAt = now.toISOString();
    const presentedAt = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
    const store = new LoopStore(dbPath);
    const loops = [];
    for (let index = 0; index < 4; index += 1) {
      store.recordProjectActivity(
        `C:/work/p${index}`,
        `p${index}`,
        surfacedAt,
        `s${index}`,
      );
      loops.push(store.saveLoop(
        {
          title: `冷却测试 ${index}`,
          nextAction: `下一步 ${index}`,
          why: `原因 ${index}`,
          confidence: 0.9,
          sourceSignalIds: [`alpha:cooldown-${index}`],
        },
        {
          projectDir: `C:/work/p${index}`,
          projectName: `p${index}`,
          lastSeen: surfacedAt,
        },
      ).loop);
    }
    store.recordSurfaced(loops.slice(0, 3).map((loop) => loop.id), surfacedAt);
    store.recordPresentation(
      loops.slice(0, 3).map((loop) => loop.id),
      presentedAt,
      'hot',
      'recap',
    );
    store.close();

    const baseArgs = [
      '--import', 'tsx', path.join('src', 'loops', 'cli.ts'),
      'digest', '--db', dbPath, '--skill', '--no-mark',
    ];
    const throttled = spawnSync(process.execPath, baseArgs, {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(throttled.status).toBe(0);
    expect(throttled.stdout).toContain('刚刚已提过这几条');

    const disabled = spawnSync(
      process.execPath,
      [...baseArgs, '--recap-cooldown-minutes', '0'],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    expect(disabled.status).toBe(0);
    expect(disabled.stdout).toContain('这几条已经提过');
    expect(disabled.stdout).not.toContain('刚刚已提过');
  });

  it('prioritizes --project and can disable focus', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-digest-focus-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'loops.db');
    const now = new Date().toISOString();
    const store = new LoopStore(dbPath);
    store.recordProjectActivity('C:/work/alpha', 'alpha', now, 's1');
    store.recordProjectActivity('C:/work/beta', 'beta', now, 's2');
    store.saveLoop(
      {
        title: 'Alpha 待办',
        nextAction: '处理 Alpha',
        why: 'Alpha 尚未完成',
        confidence: 0.7,
        sourceSignalIds: ['alpha:focus'],
      },
      { projectDir: 'C:/work/alpha', projectName: 'alpha', lastSeen: now },
    );
    store.saveLoop(
      {
        title: 'Beta 待办',
        nextAction: '处理 Beta',
        why: 'Beta 尚未完成',
        confidence: 0.99,
        sourceSignalIds: ['beta:focus'],
      },
      { projectDir: 'C:/work/beta', projectName: 'beta', lastSeen: now },
    );
    store.close();

    const baseArgs = [
      '--import', 'tsx', path.join('src', 'loops', 'cli.ts'),
      'digest', '--db', dbPath, '--skill', '--no-mark', '--limit', '1',
    ];
    const focused = spawnSync(
      process.execPath,
      [...baseArgs, '--project', 'C:/work/alpha'],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    expect(focused.status).toBe(0);
    expect(focused.stdout).toContain('**alpha**');
    expect(focused.stdout).toContain('Alpha 待办');
    expect(focused.stdout).not.toContain('Beta 待办');

    const global = spawnSync(
      process.execPath,
      [...baseArgs, '--project', 'C:/work/alpha', '--no-project-focus'],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    expect(global.status).toBe(0);
    expect(global.stdout).toContain('**beta**');
    expect(global.stdout).toContain('Beta 待办');
    expect(global.stdout).not.toContain('Alpha 待办');
  });

  it('reports reviewDue until a weekly review is recorded', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-digest-review-due-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'loops.db');
    const now = new Date().toISOString();
    const store = new LoopStore(dbPath);
    store.recordProjectActivity('C:/work/alpha', 'alpha', now, 's1');
    const saved = store.saveLoop(
      {
        title: '回顾到期测试',
        nextAction: '验证周回顾提示',
        why: '本周还没看完整清单',
        confidence: 0.9,
        sourceSignalIds: ['alpha:review-due'],
      },
      { projectDir: 'C:/work/alpha', projectName: 'alpha', lastSeen: now },
    );
    store.close();

    const args = [
      '--import', 'tsx', path.join('src', 'loops', 'cli.ts'),
      'digest', '--db', dbPath, '--json', '--no-mark',
    ];
    const due = spawnSync(process.execPath, args, {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(due.status).toBe(0);
    expect(JSON.parse(due.stdout).reviewDue).toBe(true);

    const afterReview = new LoopStore(dbPath);
    afterReview.recordPresentation([saved.loop.id], new Date().toISOString(), 'review', 'review');
    afterReview.close();

    const notDue = spawnSync(process.execPath, args, {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(notDue.status).toBe(0);
    expect(JSON.parse(notDue.stdout).reviewDue).toBe(false);
  });

  it('keeps the recap scoped to the current project', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-digest-focus-recap-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'loops.db');
    const now = new Date().toISOString();
    const store = new LoopStore(dbPath);
    store.recordProjectActivity('C:/work/alpha', 'alpha', now, 's-a');
    store.recordProjectActivity('C:/work/beta', 'beta', now, 's-b');
    store.recordProjectActivity('C:/work/gamma', 'gamma', now, 's-g');
    const save = (project: string, title: string) => store.saveLoop(
      {
        title,
        nextAction: `next ${title}`,
        why: `why ${title}`,
        confidence: 0.9,
        sourceSignalIds: [`${project}:${title}`],
      },
      { projectDir: `C:/work/${project}`, projectName: project, lastSeen: now },
    ).loop;
    const alphaOne = save('alpha', 'Alpha one');
    const alphaTwo = save('alpha', 'Alpha two');
    const beta = save('beta', 'Beta one');
    save('gamma', 'Gamma one');
    store.recordSurfaced([alphaOne.id, alphaTwo.id, beta.id], now);
    store.close();

    const run = (project: string) => spawnSync(
      process.execPath,
      [
        '--import', 'tsx', path.join('src', 'loops', 'cli.ts'),
        'digest', '--db', dbPath, '--json', '--project', project,
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    const alpha = run('C:/work/alpha');
    expect(alpha.status).toBe(0);
    const alphaJson = JSON.parse(alpha.stdout);
    expect(alphaJson.total).toBe(0);
    expect(alphaJson.recap.map((loop: { title: string }) => loop.title).sort())
      .toEqual(['Alpha one', 'Alpha two']);
    expect(alphaJson.recapThrottled).toBe(false);
    expect(alphaJson.recapFocusEmpty).toBe(false);

    const betaResult = run('C:/work/beta');
    expect(betaResult.status).toBe(0);
    const betaJson = JSON.parse(betaResult.stdout);
    expect(betaJson.recap.map((loop: { title: string }) => loop.title))
      .toEqual(['Beta one']);
    expect(betaJson.recapThrottled).toBe(false);

    const gamma = run('C:/work/gamma');
    expect(gamma.status).toBe(0);
    const gammaJson = JSON.parse(gamma.stdout);
    expect(gammaJson.total).toBe(0);
    expect(gammaJson.recap).toEqual([]);
    expect(gammaJson.recapFocusEmpty).toBe(true);
    expect(gammaJson.focusProject.backlog).toBe(1);

    const gammaSkill = spawnSync(
      process.execPath,
      [
        '--import', 'tsx', path.join('src', 'loops', 'cli.ts'),
        'digest', '--db', dbPath, '--skill', '--project', 'C:/work/gamma',
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    expect(gammaSkill.status).toBe(0);
    expect(gammaSkill.stdout).toContain('本项目今天没有已提过的回访条目');
  });

  it('shows one cached completion candidate in a hot digest', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-digest-close-candidate-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'loops.db');
    const now = new Date().toISOString();
    const store = new LoopStore(dbPath);
    store.recordProjectActivity('C:/work/alpha', 'alpha', now, 's-a');
    const shown = store.saveLoop(
      {
        title: 'Already shown',
        nextAction: 'next shown',
        why: 'why shown',
        confidence: 0.95,
        sourceSignalIds: ['alpha:shown'],
      },
      { projectDir: 'C:/work/alpha', projectName: 'alpha', lastSeen: now },
    ).loop;
    const candidate = store.saveLoop(
      {
        title: 'Likely finished',
        nextAction: 'next candidate',
        why: 'why candidate',
        confidence: 0.7,
        sourceSignalIds: ['alpha:candidate'],
      },
      { projectDir: 'C:/work/alpha', projectName: 'alpha', lastSeen: now },
    ).loop;
    store.setReconcileCache(
      's-a',
      'hash-a',
      [{
        loopId: candidate.id,
        confidence: 0.95,
        reason: '已完成：后续会话验证通过',
        evidenceMessageIds: [],
      }],
      now,
    );
    store.close();

    const json = spawnSync(
      process.execPath,
      [
        '--import', 'tsx', path.join('src', 'loops', 'cli.ts'),
        'digest', '--db', dbPath, '--json', '--no-mark', '--limit', '1', '--project', 'C:/work/alpha',
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    expect(json.status).toBe(0);
    const parsed = JSON.parse(json.stdout);
    expect(parsed.closeCandidates).toHaveLength(1);
    expect(parsed.closeCandidates[0].loopId).toBe(candidate.id);
    expect(shown.id).not.toBe(candidate.id);

    const result = spawnSync(
      process.execPath,
      [
        '--import', 'tsx', path.join('src', 'loops', 'cli.ts'),
        'digest', '--db', dbPath, '--skill', '--limit', '1', '--project', 'C:/work/alpha',
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('**Already shown**');
    expect(result.stdout).not.toContain('1. **Likely finished**');
    expect(result.stdout).toContain('可能已完成');
    expect(result.stdout).toContain('Likely finished');
    expect(result.stdout).toContain('后续会话验证通过');
  });

  it('shows a cached completion candidate after the daily cap falls back to a recap', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-digest-recap-candidate-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'loops.db');
    const now = new Date().toISOString();
    const store = new LoopStore(dbPath);
    store.recordProjectActivity('C:/work/alpha', 'alpha', now, 's-a');
    const save = (title: string, confidence: number) => store.saveLoop(
      {
        title,
        nextAction: `next ${title}`,
        why: `why ${title}`,
        confidence,
        sourceSignalIds: [`alpha:${title}`],
      },
      { projectDir: 'C:/work/alpha', projectName: 'alpha', lastSeen: now },
    ).loop;
    const surfaced = ['Shown 1', 'Shown 2', 'Shown 3'].map((title) => save(title, 0.9));
    const candidate = save('Likely finished after cap', 0.9);
    store.recordSurfaced(surfaced.map((loop) => loop.id), now);
    store.setReconcileCache(
      's-a',
      'hash-a',
      [{
        loopId: candidate.id,
        confidence: 0.95,
        reason: '已完成：后续会话验证通过',
        evidenceMessageIds: [],
      }],
      now,
    );
    store.close();

    const result = spawnSync(
      process.execPath,
      [
        '--import', 'tsx', path.join('src', 'loops', 'cli.ts'),
        'digest', '--db', dbPath, '--skill', '--no-mark', '--project', 'C:/work/alpha',
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('# 今天提过 · 3 条');
    expect(result.stdout).toContain('可能已完成');
    expect(result.stdout).toContain('Likely finished after cap');
    expect(result.stdout).toContain('后续会话验证通过');
  });

  it('keeps a review digest brief in skill mode', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-digest-review-brief-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'loops.db');
    const now = new Date().toISOString();
    const store = new LoopStore(dbPath);
    store.recordProjectActivity('C:/work/alpha', 'alpha', now, 's-a');
    store.saveLoop(
      {
        title: '补齐登录页错误提示',
        nextAction: '把错误码映射成用户能看懂的提示',
        why: '会话结束时还没验证提示文案',
        confidence: 0.9,
        sourceSignalIds: ['alpha:review-brief-1'],
      },
      { projectDir: 'C:/work/alpha', projectName: 'alpha', lastSeen: now },
    );
    store.saveLoop(
      {
        title: '补一条回归用例',
        nextAction: '给 digest 加回归',
        why: '上次改动没有覆盖',
        confidence: 0.7,
        sourceSignalIds: ['alpha:review-brief-2'],
      },
      { projectDir: 'C:/work/alpha', projectName: 'alpha', lastSeen: now },
    );
    store.close();

    const args = [
      '--import', 'tsx', path.join('src', 'loops', 'cli.ts'),
      'digest', '--db', dbPath, '--review', '--skill', '--limit', '2', '--no-mark',
    ];
    const result = spawnSync(process.execPath, args, {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('# 每周回顾 · 2 条');
    expect(result.stdout).toMatch(/1\. \*\*补齐登录页错误提示\*\*.*\[ref [0-9a-f]{8}\]/);
    expect(result.stdout).toMatch(/2\. \*\*补一条回归用例\*\*.*\[ref [0-9a-f]{8}\]/);
    expect(result.stdout).not.toContain('下一步：');
    expect(result.stdout).not.toContain('为什么现在提：');
    expect(result.stdout).toContain('回编号或 ref 看下一步和依据');
    expect(result.stdout).toContain('做第 N 条');
    expect(result.stdout).toContain('回复示例');

    const detail = spawnSync(
      process.execPath,
      [
        '--import', 'tsx', path.join('src', 'loops', 'cli.ts'),
        'show', '--db', dbPath, '--ref', result.stdout.match(/\[ref ([0-9a-f]{8})\]/)![1],
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    expect(detail.status).toBe(0);
    expect(detail.stdout).toContain('把错误码映射成用户能看懂的提示');
    expect(detail.stdout).toContain('会话结束时还没验证提示文案');
  });

  it('reports how many review items remain and invites the next batch', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-digest-review-more-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'loops.db');
    const now = new Date().toISOString();
    const store = new LoopStore(dbPath);
    store.recordProjectActivity('C:/work/alpha', 'alpha', now, 's-a');
    for (let index = 0; index < 4; index += 1) {
      store.saveLoop(
        {
          title: `待办 ${index}`,
          nextAction: `下一步 ${index}`,
          why: `原因 ${index}`,
          confidence: 0.9,
          sourceSignalIds: [`alpha:review-more-${index}`],
        },
        { projectDir: 'C:/work/alpha', projectName: 'alpha', lastSeen: now },
      );
    }
    store.close();

    const json = spawnSync(
      process.execPath,
      [
        '--import', 'tsx', path.join('src', 'loops', 'cli.ts'),
        'digest', '--db', dbPath, '--review', '--json', '--limit', '2', '--no-mark',
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout).reviewRemaining).toBe(2);

    const skill = spawnSync(
      process.execPath,
      [
        '--import', 'tsx', path.join('src', 'loops', 'cli.ts'),
        'digest', '--db', dbPath, '--review', '--skill', '--limit', '2', '--no-mark',
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    expect(skill.status).toBe(0);
    expect(skill.stdout).toContain('本轮还有 2 条没看；说“继续看”看下一批。');
  });
});
