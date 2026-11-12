import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LoopStore } from '../src/loops/loop-store.js';
import { backupLoopDatabase } from '../src/loops/backup.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('backupLoopDatabase', () => {
  it('creates a consistent copy and verifies its integrity', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-backup-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'loops.db');
    const store = new LoopStore(dbPath);
    store.saveSignal({
      id: 'codex:s1:m1',
      source: 'session',
      sourceId: 's1',
      messageId: 'm1',
      agent: 'codex',
      role: 'assistant',
      text: '备份测试证据',
      projectDir: 'C:/work/alpha',
      capturedAt: '2026-11-10T10:00:00.000Z',
      contentHash: 'm1',
    });
    store.saveLoop(
      {
        title: '备份测试循环',
        nextAction: '验证备份',
        why: '测试',
        confidence: 0.9,
        sourceSignalIds: ['codex:s1:m1'],
      },
      {
        projectDir: 'C:/work/alpha',
        projectName: 'alpha',
        firstSeen: '2026-11-10T10:00:00.000Z',
        lastSeen: '2026-11-10T10:00:00.000Z',
      },
    );
    store.close();

    const target = path.join(dir, 'backup.db');
    const result = backupLoopDatabase({ dbPath, outPath: target });

    expect(result.integrity).toBe('ok');
    expect(result.loops).toBe(1);
    expect(result.signals).toBe(1);
    expect(result.bytes).toBeGreaterThan(0);
    expect(fs.existsSync(target)).toBe(true);

    const copy = new LoopStore(target);
    try {
      expect(copy.listLoops({ includeAll: true })[0].title).toBe('备份测试循环');
    } finally {
      copy.close();
    }
  });

  it('refuses to overwrite an existing backup target', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-backup-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'loops.db');
    const store = new LoopStore(dbPath);
    store.close();
    const target = path.join(dir, 'backup.db');
    fs.writeFileSync(target, 'occupied');

    expect(() => backupLoopDatabase({ dbPath, outPath: target })).toThrow('already exists');
  });

  it('prunes old automatic snapshots when retention is requested', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-backup-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'loops.db');
    const store = new LoopStore(dbPath);
    store.close();

    for (const name of [
      'loops-20261101.db',
      'loops-20261102.db',
      'loops-20261103.db',
      'loops-20261104.db',
    ]) {
      fs.writeFileSync(path.join(dir, name), 'old');
    }
    const manual = path.join(dir, 'loops-before-migration.db');
    fs.writeFileSync(manual, 'manual');

    const result = backupLoopDatabase({
      dbPath,
      outPath: path.join(dir, 'loops-20261111.db'),
      keep: 3,
    });

    expect(result.integrity).toBe('ok');
    expect(result.pruned.map((filePath) => path.basename(filePath))).toEqual([
      'loops-20261101.db',
      'loops-20261102.db',
    ]);
    expect(fs.existsSync(path.join(dir, 'loops-20261103.db'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'loops-20261104.db'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'loops-20261111.db'))).toBe(true);
    expect(fs.readFileSync(manual, 'utf8')).toBe('manual');
  });

  it('counts default timestamped backups toward the same retention limit', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-backup-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'loops.db');
    const store = new LoopStore(dbPath);
    store.close();

    for (const name of [
      'loops-20261101-010101.db',
      'loops-20261102-020202.db',
      'loops-20261103-030303.db',
    ]) {
      fs.writeFileSync(path.join(dir, name), 'old');
    }
    const manual = path.join(dir, 'loops-after-migration-20261101-000000.db');
    fs.writeFileSync(manual, 'manual');

    const result = backupLoopDatabase({
      dbPath,
      outPath: path.join(dir, 'loops-20261111-111111.db'),
      keep: 2,
    });

    expect(result.integrity).toBe('ok');
    expect(result.pruned.map((filePath) => path.basename(filePath))).toEqual([
      'loops-20261101-010101.db',
      'loops-20261102-020202.db',
    ]);
    expect(fs.existsSync(path.join(dir, 'loops-20261103-030303.db'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'loops-20261111-111111.db'))).toBe(true);
    expect(fs.readFileSync(manual, 'utf8')).toBe('manual');
  });

  it('never prunes the backup target even when its filename is old', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-backup-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'loops.db');
    const store = new LoopStore(dbPath);
    store.close();
    for (const name of ['loops-20261101.db', 'loops-20261102.db', 'loops-20261103.db']) {
      fs.writeFileSync(path.join(dir, name), 'old');
    }

    const target = path.join(dir, 'loops-20260101.db');
    const result = backupLoopDatabase({ dbPath, outPath: target, keep: 2 });

    expect(fs.existsSync(target)).toBe(true);
    expect(result.pruned.map((filePath) => path.basename(filePath))).toEqual([
      'loops-20261101.db',
      'loops-20261102.db',
    ]);
    expect(fs.existsSync(path.join(dir, 'loops-20261103.db'))).toBe(true);
  });

  it('rejects a non-positive retention count', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-backup-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'loops.db');
    const store = new LoopStore(dbPath);
    store.close();

    expect(() => backupLoopDatabase({
      dbPath,
      outPath: path.join(dir, 'backup.db'),
      keep: 0,
    })).toThrow('positive integer');
  });
});
