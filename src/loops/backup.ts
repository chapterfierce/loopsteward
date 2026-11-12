import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { resolveDefaultDbPath } from './data-path.js';

export interface BackupOptions {
  dbPath?: string;
  outPath?: string;
  now?: Date;
  keep?: number;
}

export interface BackupResult {
  source: string;
  target: string;
  bytes: number;
  integrity: string;
  loops: number;
  signals: number;
  pruned: string[];
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

export function backupLoopDatabase(options: BackupOptions = {}): BackupResult {
  const dbPath = options.dbPath ?? resolveDefaultDbPath();
  if (!fs.existsSync(dbPath)) throw new Error(`database not found: ${dbPath}`);
  if (options.keep !== undefined && (!Number.isInteger(options.keep) || options.keep < 1)) {
    throw new Error('backup retention must be a positive integer');
  }

  const target = options.outPath
    ?? path.join(path.dirname(dbPath), 'archive', `loops-${timestamp(options.now ?? new Date())}.db`);
  if (fs.existsSync(target)) throw new Error(`backup target already exists: ${target}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const req = createRequire(import.meta.url);
  const { DatabaseSync } = req('node:sqlite') as { DatabaseSync: new (file: string, options?: { readOnly?: boolean }) => any };
  const source = new DatabaseSync(dbPath, { readOnly: true });
  try {
    source.exec('PRAGMA busy_timeout = 5000;');
    const escaped = target.replace(/\\/g, '/').replace(/'/g, "''");
    source.exec(`VACUUM INTO '${escaped}'`);
  } catch (error) {
    fs.rmSync(target, { force: true });
    throw error;
  } finally {
    source.close();
  }

  const copy = new DatabaseSync(target, { readOnly: true });
  let integrity = 'unknown';
  let loops = 0;
  let signals = 0;
  try {
    const integrityRow = copy.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined;
    integrity = integrityRow?.integrity_check ?? 'unknown';
    if (integrity === 'ok') {
      loops = (copy.prepare('SELECT COUNT(*) AS count FROM loops').get() as { count: number }).count;
      signals = (copy.prepare('SELECT COUNT(*) AS count FROM loop_signals').get() as { count: number }).count;
    }
  } finally {
    copy.close();
  }

  if (integrity !== 'ok') {
    fs.rmSync(target, { force: true });
    throw new Error(`backup integrity check failed: ${integrity}`);
  }

  let pruned: string[] = [];
  if (options.keep !== undefined) {
    const archiveDir = path.dirname(target);
    const targetPath = path.resolve(target);
    const managed = fs.readdirSync(archiveDir)
      .filter((name) => /^loops-\d{8}(?:-\d{6})?\.db$/.test(name))
      .map((name) => path.resolve(archiveDir, name))
      .filter((filePath) => {
        const stat = fs.lstatSync(filePath);
        return stat.isFile() && !stat.isSymbolicLink();
      })
      .sort();
    const targetIsManaged = managed.includes(targetPath);
    const candidates = managed.filter((filePath) => filePath !== targetPath);
    const keepOthers = Math.max(0, options.keep - (targetIsManaged ? 1 : 0));
    pruned = candidates.slice(0, Math.max(0, candidates.length - keepOthers));
    for (const filePath of pruned) fs.unlinkSync(filePath);
  }

  return {
    source: dbPath,
    target,
    bytes: fs.statSync(target).size,
    integrity,
    loops,
    signals,
    pruned,
  };
}
