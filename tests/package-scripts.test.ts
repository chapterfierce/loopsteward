import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as {
  name: string;
  main?: string;
  bin?: Record<string, string>;
  files?: string[];
  scripts: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies: Record<string, string>;
};

describe('package entrypoints', () => {
  it('publishes the LoopSteward package and CLI entrypoint', () => {
    expect(pkg.name).toBe('loopsteward');
    expect(pkg.main).toBe('dist/src/loops/cli.js');
    expect(pkg.bin?.loopsteward).toBe('dist/src/loops/cli.js');
  });

  it('points dev and start at Open Loops, keeping legacy service explicit', () => {
    expect(pkg.scripts.dev).toBe('tsx src/loops/cli.ts');
    expect(pkg.scripts.start).toBe('node dist/src/loops/cli.js');
    expect(pkg.scripts['legacy:dev']).toBe('tsx src/index.ts');
    expect(pkg.scripts['legacy:start']).toBe('node dist/src/index.js');
    expect(pkg.scripts['build:open-loops']).toBe('tsc -p tsconfig.open-loops.json');
    expect(pkg.scripts['loops:install-policy']).toBe('tsx src/loops/cli.ts install-policy');
    expect(pkg.scripts['loops:setup']).toBe('tsx src/loops/cli.ts setup');
    expect(pkg.scripts['loops:calibrate']).toBe('tsx src/loops/cli.ts calibrate');
  });

  it('runs Open Loops tests by default and keeps the legacy suite explicit', () => {
    expect(pkg.scripts.test).toBe('vitest run');
    expect(pkg.scripts['test:legacy']).toBe('tsx intent-engine/test.ts');
  });

  it('keeps express available for the legacy service but out of production', () => {
    expect(pkg.dependencies?.express).toBeUndefined();
    expect(pkg.devDependencies.express).toBe('^4.22.3');
  });

  it('ships only runtime assets and rebuilds before packing', () => {
    expect(pkg.files).toEqual(['dist', 'skills', 'scripts', 'docs/MCP.md', 'README.md']);
    expect(pkg.scripts.clean).toContain("rmSync('dist'");
    expect(pkg.scripts.prepack).toBe('npm run clean && npm run build:open-loops');
    expect(pkg.scripts['verify:package']).toBe('node scripts/verify-package.mjs');
  });

  it('exposes one release gate that runs every pre-publish check', () => {
    expect(pkg.scripts['release:check']).toBe(
      'npm run check && npm test && npm run build && npm run verify:package && npm run test:legacy',
    );
  });
});
