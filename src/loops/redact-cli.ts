import { backupLoopDatabase } from './backup.js';
import { resolveDefaultDbPath } from './data-path.js';
import { LoopStore } from './loop-store.js';
import { pathToFileURL } from 'node:url';

interface Options {
  dbPath?: string;
  apply: boolean;
  json: boolean;
  keep?: number;
}

function usage(): string {
  return [
    'Usage: loopsteward-redact [--db <path>] [--apply] [--keep <n>] [--json]',
    '',
    'Scans stored session text and loop descriptions for credentials.',
    'Default is dry-run. --apply creates a backup, then rewrites the database.',
  ].join('\n');
}

function parseArgs(argv: string[]): Options {
  const options: Options = { apply: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') {
      options.apply = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--db') {
      const value = argv[index + 1];
      if (!value) throw new Error('--db needs a path');
      options.dbPath = value;
      index += 1;
    } else if (arg === '--keep') {
      const value = Number(argv[index + 1]);
      if (!Number.isInteger(value) || value < 1) throw new Error('--keep must be a positive integer');
      options.keep = value;
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

export function runRedact(argv: string[]): number {
  let options: Options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error((error as Error).message);
    console.error(usage());
    return 1;
  }

  const dbPath = options.dbPath ?? resolveDefaultDbPath();
  let backup: string | undefined;
  if (options.apply) {
    try {
      backup = backupLoopDatabase({
        dbPath,
        keep: options.keep,
      }).target;
    } catch (error) {
      console.error(`backup failed: ${(error as Error).message}`);
      return 1;
    }
  }

  const store = new LoopStore(dbPath);
  try {
    const result = store.redactStoredText(options.apply);
    if (options.json) {
      console.log(JSON.stringify({ dbPath, backup, ...result }, null, 2));
    } else {
      const verb = options.apply ? '已脱敏' : '命中';
      console.log([
        `${verb} signals ${result.signalsChanged}/${result.signalsScanned}，loops ${result.loopsChanged}/${result.loopsScanned}`,
        options.apply ? `备份：${backup}` : '未写入。确认后加 --apply 执行。',
        result.samples.length > 0 ? `样例：${result.samples.join(', ')}` : '未发现疑似凭据。',
      ].join('\n'));
    }
    return 0;
  } finally {
    store.close();
  }
}

const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (invokedDirectly) {
  const exitCode = runRedact(process.argv.slice(2));
  if (exitCode !== 0) process.exitCode = exitCode;
}
