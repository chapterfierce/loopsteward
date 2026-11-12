import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { backupLoopDatabase } from './backup.js';
import { LoopStore } from './loop-store.js';
import { resolveDefaultDbPath } from './data-path.js';

export interface RestoreOptions {
  backupPath: string;
  dbPath?: string;
  dryRun?: boolean;
  now?: Date;
}

export interface RestoreResult {
  backup: string;
  target: string;
  dryRun: boolean;
  targetExisted: boolean;
  targetState: 'missing' | 'open-loops' | 'corrupt';
  replaced: boolean;
  integrity: string;
  loops: number;
  signals: number;
  safetyBackup?: string;
}

interface DatabaseInspection {
  integrity: string;
  loops: number;
  signals: number;
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    get(): unknown;
    all(): unknown[];
  };
  close(): void;
}

function timestamp(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('');
}

function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function uniquePath(candidate: string): string {
  if (!fs.existsSync(candidate)) return candidate;
  for (let index = 1; index < 1000; index += 1) {
    const next = `${candidate}-${index}`;
    if (!fs.existsSync(next)) return next;
  }
  throw new Error(`could not find a free path for ${candidate}`);
}

function openSqlite(filePath: string): SqliteDatabase {
  const req = createRequire(import.meta.url);
  const { DatabaseSync } = req('node:sqlite') as {
    DatabaseSync: new (file: string, options?: { readOnly?: boolean }) => SqliteDatabase;
  };
  return new DatabaseSync(filePath, { readOnly: true });
}

function inspectDatabase(filePath: string): DatabaseInspection {
  if (!fs.existsSync(filePath)) throw new Error(`database not found: ${filePath}`);
  let db: SqliteDatabase;
  try {
    db = openSqlite(filePath);
  } catch (error) {
    throw new Error(`not a readable SQLite database: ${filePath} (${(error as Error).message})`);
  }

  try {
    db.exec('PRAGMA busy_timeout = 5000;');
    const integrityRow = db.prepare('PRAGMA integrity_check').get() as
      | { integrity_check?: string }
      | undefined;
    const integrity = integrityRow?.integrity_check ?? 'unknown';
    if (integrity !== 'ok') throw new Error(`integrity check failed: ${integrity}`);

    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>).map((row) => row.name),
    );
    if (!tables.has('loops') || !tables.has('loop_signals')) {
      throw new Error(`not an Open Loops database: ${filePath}`);
    }

    const loops = (db.prepare('SELECT COUNT(*) AS count FROM loops').get() as { count: number })
      .count;
    const signals = (
      db.prepare('SELECT COUNT(*) AS count FROM loop_signals').get() as { count: number }
    ).count;
    return { integrity, loops, signals };
  } catch (error) {
    const message = (error as Error).message;
    if (message.startsWith('not an Open Loops database') || message.startsWith('integrity check failed')) {
      throw error;
    }
    throw new Error(`not a readable SQLite database: ${filePath} (${message})`);
  } finally {
    db.close();
  }
}

function moveSidecars(from: string, to: string): void {
  for (const suffix of ['-wal', '-shm']) {
    const source = `${from}${suffix}`;
    if (fs.existsSync(source)) fs.renameSync(source, `${to}${suffix}`);
  }
}

function removeSidecars(filePath: string): void {
  for (const suffix of ['-wal', '-shm']) {
    fs.rmSync(`${filePath}${suffix}`, { force: true });
  }
}

export function restoreLoopDatabase(options: RestoreOptions): RestoreResult {
  const backupPath = path.resolve(options.backupPath);
  const target = path.resolve(options.dbPath ?? resolveDefaultDbPath());
  if (pathKey(backupPath) === pathKey(target)) {
    throw new Error('backup path and target database must be different files');
  }

  const source = inspectDatabase(backupPath);
  const targetExisted = fs.existsSync(target);
  let targetState: RestoreResult['targetState'] = 'missing';
  if (targetExisted) {
    try {
      inspectDatabase(target);
      targetState = 'open-loops';
    } catch {
      targetState = 'corrupt';
    }
  }
  const now = options.now ?? new Date();
  let plannedSafety: string | undefined;
  if (targetState === 'open-loops') {
    plannedSafety = uniquePath(
      path.join(
        path.dirname(target),
        'archive',
        `loops-before-restore-${timestamp(now)}.db`,
      ),
    );
  } else if (targetState === 'corrupt') {
    plannedSafety = uniquePath(`${target}.corrupt-${timestamp(now)}`);
  }

  if (options.dryRun) {
    return {
      backup: backupPath,
      target,
      dryRun: true,
      targetExisted,
      targetState,
      replaced: false,
      integrity: source.integrity,
      loops: source.loops,
      signals: source.signals,
      ...(plannedSafety ? { safetyBackup: plannedSafety } : {}),
    };
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!targetExisted) removeSidecars(target);
  let safetyBackup: string | undefined;
  let oldPath: string | undefined;

  if (targetExisted) {
    if (targetState === 'open-loops') {
      safetyBackup = backupLoopDatabase({
        dbPath: target,
        outPath: plannedSafety,
        now,
      }).target;
    } else {
      const corruptPath = uniquePath(`${target}.corrupt-${timestamp(now)}`);
      fs.renameSync(target, corruptPath);
      moveSidecars(target, corruptPath);
      safetyBackup = corruptPath;
      oldPath = corruptPath;
    }
  }

  const tempPath = uniquePath(`${target}.restore-${process.pid}-${Date.now()}.tmp`);
  fs.copyFileSync(backupPath, tempPath);
  try {
    const copied = inspectDatabase(tempPath);
    if (copied.loops !== source.loops || copied.signals !== source.signals) {
      throw new Error('copied backup does not match the source counts');
    }

    if (!oldPath && targetExisted) {
      const replacePath = uniquePath(`${target}.replaced-${timestamp(now)}`);
      fs.renameSync(target, replacePath);
      moveSidecars(target, replacePath);
      oldPath = replacePath;
    }

    try {
      fs.renameSync(tempPath, target);
    } catch (error) {
      if (oldPath && !fs.existsSync(target)) {
        fs.renameSync(oldPath, target);
        moveSidecars(oldPath, target);
      }
      throw error;
    }

    try {
      const store = new LoopStore(target);
      store.close();
    } catch (error) {
      fs.rmSync(target, { force: true });
      removeSidecars(target);
      if (oldPath) {
        fs.renameSync(oldPath, target);
        moveSidecars(oldPath, target);
      }
      throw new Error(`restored database failed to open: ${(error as Error).message}`);
    }

    const restored = inspectDatabase(target);
    if (oldPath && oldPath !== safetyBackup) {
      fs.rmSync(oldPath, { force: true });
      removeSidecars(oldPath);
    }

    return {
      backup: backupPath,
      target,
      dryRun: false,
      targetExisted,
      targetState,
      replaced: true,
      integrity: restored.integrity,
      loops: restored.loops,
      signals: restored.signals,
      ...(safetyBackup ? { safetyBackup } : {}),
    };
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}
