import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { LoopStore } from '../src/loops/loop-store.js';
import { backupLoopDatabase } from '../src/loops/backup.js';
import { restoreLoopDatabase } from '../src/loops/restore.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-restore-'));
  dirs.push(dir);
  return dir;
}

function addLoop(dbPath: string, title: string): void {
  const store = new LoopStore(dbPath);
  const signalId = `codex:${title}:m1`;
  try {
    store.saveSignal({
      id: signalId,
      source: 'session',
      sourceId: title,
      messageId: 'm1',
      agent: 'codex',
      role: 'assistant',
      text: `${title} evidence`,
      projectDir: `C:/work/${title}`,
      capturedAt: '2026-11-10T10:00:00.000Z',
      contentHash: title,
    });
    store.saveLoop(
      {
        title,
        nextAction: `finish ${title}`,
        why: 'test',
        confidence: 0.9,
        sourceSignalIds: [signalId],
      },
      {
        projectDir: `C:/work/${title}`,
        projectName: title,
        firstSeen: '2026-11-10T10:00:00.000Z',
        lastSeen: '2026-11-10T10:00:00.000Z',
      },
    );
  } finally {
    store.close();
  }
}

function titles(dbPath: string): string[] {
  const store = new LoopStore(dbPath);
  try {
    return store.listLoops({ includeAll: true }).map((loop) => loop.title).sort();
  } finally {
    store.close();
  }
}

describe('restoreLoopDatabase', () => {
  it('restores a backup and keeps the replaced database as a safety copy', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'loops.db');
    addLoop(dbPath, 'original');
    const backup = backupLoopDatabase({
      dbPath,
      outPath: path.join(dir, 'backup.db'),
    }).target;
    addLoop(dbPath, 'later');

    const result = restoreLoopDatabase({ backupPath: backup, dbPath });

    expect(result.replaced).toBe(true);
    expect(result.targetExisted).toBe(true);
    expect(result.targetState).toBe('open-loops');
    expect(result.loops).toBe(1);
    expect(titles(dbPath)).toEqual(['original']);
    expect(result.safetyBackup).toBeTruthy();
    expect(fs.existsSync(result.safetyBackup!)).toBe(true);
    expect(titles(result.safetyBackup!)).toEqual(['later', 'original']);
  });

  it('does not change files during a dry run', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'loops.db');
    addLoop(dbPath, 'original');
    const backup = backupLoopDatabase({
      dbPath,
      outPath: path.join(dir, 'backup.db'),
    }).target;
    addLoop(dbPath, 'later');

    const result = restoreLoopDatabase({ backupPath: backup, dbPath, dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.replaced).toBe(false);
    expect(result.targetState).toBe('open-loops');
    expect(result.loops).toBe(1);
    expect(titles(dbPath)).toEqual(['later', 'original']);
    expect(result.safetyBackup).toBeTruthy();
    expect(fs.existsSync(result.safetyBackup!)).toBe(false);
  });

  it('creates a missing target database', () => {
    const dir = tempDir();
    const source = path.join(dir, 'source.db');
    addLoop(source, 'original');
    const backup = backupLoopDatabase({
      dbPath: source,
      outPath: path.join(dir, 'backup.db'),
    }).target;
    const target = path.join(dir, 'new', 'loops.db');

    const result = restoreLoopDatabase({ backupPath: backup, dbPath: target });

    expect(result.targetExisted).toBe(false);
    expect(result.targetState).toBe('missing');
    expect(result.safetyBackup).toBeUndefined();
    expect(titles(target)).toEqual(['original']);
  });

  it('rejects a SQLite file that is not an Open Loops database', () => {
    const dir = tempDir();
    const foreign = path.join(dir, 'foreign.db');
    const req = createRequire(import.meta.url);
    const { DatabaseSync } = req('node:sqlite') as {
      DatabaseSync: new (file: string) => { exec(sql: string): void; close(): void };
    };
    const db = new DatabaseSync(foreign);
    db.exec('CREATE TABLE other (value TEXT);');
    db.close();

    const target = path.join(dir, 'loops.db');
    addLoop(target, 'original');

    expect(() => restoreLoopDatabase({ backupPath: foreign, dbPath: target })).toThrow(
      'not an Open Loops database',
    );
    expect(titles(target)).toEqual(['original']);
  });

  it('rejects restoring a database onto itself', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'loops.db');
    addLoop(dbPath, 'original');

    expect(() => restoreLoopDatabase({ backupPath: dbPath, dbPath })).toThrow(
      'must be different files',
    );
  });

  it('preserves a corrupt target instead of overwriting it silently', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'loops.db');
    addLoop(dbPath, 'original');
    const backup = backupLoopDatabase({
      dbPath,
      outPath: path.join(dir, 'backup.db'),
    }).target;
    fs.writeFileSync(dbPath, 'not a sqlite database');

    const result = restoreLoopDatabase({ backupPath: backup, dbPath });

    expect(result.replaced).toBe(true);
    expect(result.targetState).toBe('corrupt');
    expect(result.safetyBackup).toContain('.corrupt-');
    expect(fs.readFileSync(result.safetyBackup!, 'utf8')).toBe('not a sqlite database');
    expect(titles(dbPath)).toEqual(['original']);
  });
});
