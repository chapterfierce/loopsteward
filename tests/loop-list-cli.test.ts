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

describe('loops:list', () => {
  it('prints a stable ref in JSON and text output', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-list-cli-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'loops.db');
    const now = new Date().toISOString();
    const store = new LoopStore(dbPath);
    const saved = store.saveLoop(
      {
        title: '待确认的提取',
        nextAction: '确认这条要不要跟',
        why: '模型把握不高',
        confidence: 0.45,
        sourceSignalIds: ['alpha:pending-ref'],
      },
      { projectDir: 'C:/work/alpha', projectName: 'alpha', lastSeen: now },
    );
    store.close();

    const baseArgs = [
      '--import', 'tsx', path.join('src', 'loops', 'cli.ts'),
      'list', '--db', dbPath, '--status', 'pending', '--limit', '5',
    ];
    const json = spawnSync(process.execPath, [...baseArgs, '--json'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout)[0].ref).toBe(loopRef(saved.loop.id));

    const text = spawnSync(process.execPath, baseArgs, {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(text.status).toBe(0);
    expect(text.stdout).toContain(`[ref ${loopRef(saved.loop.id)}]`);
  });
});
