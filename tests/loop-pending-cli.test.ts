import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LoopStore } from '../src/loops/loop-store.js';
import { loopRef } from '../src/loops/loop-ref.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('loops:pending', () => {
  it('reports the total and a compact first page', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-pending-cli-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'loops.db');
    const now = new Date().toISOString();
    const store = new LoopStore(dbPath);
    const saved = [];
    for (const [index, confidence] of [0.5, 0.45, 0.4].entries()) {
      saved.push(store.saveLoop(
        {
          title: `待确认 ${index}`,
          nextAction: `处理 ${index}`,
          why: `原因 ${index}`,
          confidence,
          sourceSignalIds: [`alpha:pending-${index}`],
        },
        { projectDir: 'C:/work/alpha', projectName: 'alpha', lastSeen: now },
      ).loop);
    }
    store.saveLoop(
      {
        title: '正式待办',
        nextAction: '正常回访',
        why: '置信度足够',
        confidence: 0.9,
        sourceSignalIds: ['alpha:open'],
      },
      { projectDir: 'C:/work/alpha', projectName: 'alpha', lastSeen: now },
    );
    store.close();

    const baseArgs = [
      '--import', 'tsx', path.join('src', 'loops', 'cli.ts'),
      'pending', '--db', dbPath, '--limit', '2',
    ];
    const json = spawnSync(process.execPath, [...baseArgs, '--json'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(json.status).toBe(0);
    const parsed = JSON.parse(json.stdout);
    expect(parsed.total).toBe(3);
    expect(parsed.shown).toBe(2);
    expect(parsed.loops[0].ref).toBe(loopRef(saved[0].id));
    expect(parsed.loops[1].ref).toBe(loopRef(saved[1].id));
    expect(parsed.loops.map((loop: { title: string }) => loop.title))
      .not.toContain('正式待办');
    expect(Object.keys(parsed.loops[0]).sort()).toEqual([
      'confidence',
      'projectName',
      'ref',
      'title',
    ]);

    const text = spawnSync(process.execPath, baseArgs, {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(text.status).toBe(0);
    expect(text.stdout).toContain('# 待确认 · 3 条');
    expect(text.stdout).toContain('[ref ');
    expect(text.stdout).toContain('还有 1 条没列出');
  });

  it('hides a noise-marked item until newer evidence arrives', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-pending-noise-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'loops.db');
    const now = new Date().toISOString();
    const store = new LoopStore(dbPath);
    const saved = [];
    for (const [index, confidence] of [0.5, 0.45, 0.4].entries()) {
      saved.push(store.saveLoop(
        {
          title: `噪音 ${index}`,
          nextAction: `处理 ${index}`,
          why: `原因 ${index}`,
          confidence,
          sourceSignalIds: [`alpha:noise-${index}`],
        },
        { projectDir: 'C:/work/alpha', projectName: 'alpha', lastSeen: now },
      ).loop);
    }
    store.recordFeedback(
      saved[0].id,
      'noise',
      'not worth tracking',
      new Date(Date.now() + 1000).toISOString(),
    );
    store.close();

    const result = spawnSync(process.execPath, [
      '--import', 'tsx', path.join('src', 'loops', 'cli.ts'),
      'pending', '--db', dbPath, '--limit', '10', '--json',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.total).toBe(2);
    expect(parsed.shown).toBe(2);
    expect(parsed.noiseSuppressed).toBe(1);
    expect(parsed.loops.map((loop: { title: string }) => loop.title))
      .not.toContain('噪音 0');
  });
});
