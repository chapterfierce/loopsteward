import { formatSummary } from './format.js';
import { resolveMagpieHome, scanMagpie } from './magpie-source.js';

function usage(): string {
  return [
    'Usage: npm run magpie:scan -- [--home <path>] [--json]',
    '',
    'Reads memory.json and distill.json from the session index home.',
    'Read-only: never writes to the index.',
  ].join('\n');
}

function main(argv: string[]): number {
  let home = resolveMagpieHome();
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--home') {
      const value = argv[index + 1];
      if (!value) {
        console.error('magpie:scan: --home needs a path');
        return 1;
      }
      home = value;
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      return 0;
    } else {
      console.error(`magpie:scan: unknown argument ${arg}`);
      console.error(usage());
      return 1;
    }
  }

  try {
    const result = scanMagpie(home);
    if (json) {
      console.log(JSON.stringify({ home: result.home, summary: result.summary }, null, 2));
    } else {
      console.log(formatSummary(result.summary));
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`magpie:scan failed: ${message}`);
    return 1;
  }
}

const exitCode = main(process.argv.slice(2));
if (exitCode !== 0) process.exitCode = exitCode;
