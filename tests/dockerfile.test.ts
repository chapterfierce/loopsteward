import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('Dockerfile', () => {
  it('starts the Open Loops CLI instead of the legacy HTTP service', () => {
    const dockerfile = fs.readFileSync(
      path.join(process.cwd(), 'Dockerfile'),
      'utf8',
    );

    expect(dockerfile).toContain('CMD ["node", "dist/src/loops/cli.js", "--help"]');
    expect(dockerfile).toContain('RUN npm run build:open-loops');
    expect(dockerfile).not.toContain('RUN npm run build\n');
    expect(dockerfile).not.toContain('dist/src/index.js');
    expect(dockerfile).not.toContain('EXPOSE 3000');
    expect(dockerfile).not.toContain('http://localhost:3000/health');
  });

  it('installs production dependencies with the supported omit flag', () => {
    const dockerfile = fs.readFileSync(
      path.join(process.cwd(), 'Dockerfile'),
      'utf8',
    );

    expect(dockerfile).toContain('RUN npm ci --omit=dev');
    expect(dockerfile).not.toContain('--only=production');
  });

  it('keeps express out of top-level production dependencies and the MCP SDK in them', () => {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies: Record<string, string>;
      scripts: Record<string, string>;
    };

    expect(pkg.scripts['build:open-loops']).toBe('tsc -p tsconfig.open-loops.json');
    expect(pkg.dependencies?.express).toBeUndefined();
    expect(pkg.dependencies?.['@modelcontextprotocol/sdk']).toBe('^1.32.2');
    expect(pkg.devDependencies.express).toBe('^4.22.3');
  });
});
