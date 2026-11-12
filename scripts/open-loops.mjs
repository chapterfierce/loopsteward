#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(root, 'dist', 'src', 'loops', 'cli.js');

if (!fs.existsSync(cliPath)) {
  console.error(`loopsteward CLI not found: ${cliPath}`);
  console.error('Run "npm run build" in the source checkout, or reinstall the package.');
  process.exit(1);
}

const result = spawnSync(process.execPath, [cliPath, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  stdio: 'inherit',
  env: process.env,
});

if (result.error) {
  console.error(`failed to start loopsteward: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 0);
