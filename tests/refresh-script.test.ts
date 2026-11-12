import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const script = fs.readFileSync(
  path.join(process.cwd(), 'scripts', 'refresh-open-loops.ps1'),
  'utf8',
);

describe('refresh-open-loops.ps1', () => {
  it('only rebuilds when the compiled CLI is missing or sources are newer', () => {
    const guard = script.indexOf('$needsBuild = -not (Test-Path -LiteralPath $cli)');
    const build = script.indexOf('npm run build:open-loops');

    expect(guard).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(guard);
    expect(script).toContain("Join-Path $root 'src'");
    expect(script).toContain('LastWriteTimeUtc');
    expect(script).toContain('build skipped (sources unchanged)');
  });

  it('builds before ingest so a missing CLI cannot block refresh', () => {
    const ingest = script.indexOf('& $node $cli ingest');
    const build = script.indexOf('npm run build:open-loops');

    expect(ingest).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(-1);
    expect(build).toBeLessThan(ingest);
  });

  it('runs reconcile at most once per day after ingest and does not abort refresh', () => {
    const ingest = script.indexOf('& $node $cli ingest');
    const reconcile = script.indexOf('& $node $cli reconcile');
    const build = script.indexOf('npm run build:open-loops');

    expect(reconcile).toBeGreaterThan(ingest);
    expect(build).toBeLessThan(ingest);
    expect(script).toContain('reconcile-');
    expect(script).toContain('if (-not (Test-Path -LiteralPath $reconcileStamp))');
    expect(script).toContain('reconcile failed');
    expect(script).not.toContain('throw "loops:reconcile');
  });

  it('runs every refresh step through the compiled CLI instead of dev-only npm scripts', () => {
    expect(script).toContain('& $node $cli ingest');
    expect(script).toContain('--concurrency 4');
    expect(script).toContain('& $node $cli reconcile');
    expect(script).toContain('& $node $cli backup');
    expect(script).not.toContain('npm run loops:');
  });

  it('keeps logs and backups in the resolved data directory', () => {
    expect(script).toContain('$env:LOOPSTEWARD_DATA');
    expect(script).toContain("Join-Path $dataRoot 'logs'");
    expect(script).toContain("Join-Path $dataRoot ('archive\\loops-'");
  });
});
