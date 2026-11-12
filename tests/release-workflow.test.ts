import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('release workflow', () => {
  const workflow = read('.github/workflows/release.yml');

  it('runs on main and lets release-please manage versions and changelog', () => {
    expect(workflow).toContain('branches: [main]');
    expect(workflow).toContain('googleapis/release-please-action@v4');
    expect(workflow).toContain('config-file: release-please-config.json');
    expect(workflow).toContain('manifest-file: .release-please-manifest.json');
  });

  it('publishes only after release-please created a release', () => {
    const publishJob = workflow.slice(workflow.indexOf('  publish:'));

    expect(publishJob).toContain("needs.release-please.outputs.release_created == 'true'");
    expect(publishJob).toContain('ref: ${{ needs.release-please.outputs.tag_name }}');
  });

  it('uses OIDC trusted publishing with provenance and no long-lived token', () => {
    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain('npm install --global npm@^11.5.1');
    expect(workflow).toContain('npm publish --provenance --access public');
    expect(workflow).toContain('--registry=https://registry.npmjs.org');
    expect(workflow).not.toContain('NPM_TOKEN');
    expect(workflow).not.toContain('NODE_AUTH_TOKEN');
  });

  it('keeps the release manifest aligned with package.json', () => {
    const manifest = JSON.parse(read('.release-please-manifest.json'));
    const pkg = JSON.parse(read('package.json'));

    expect(manifest['.']).toBe(pkg.version);
  });

  it('keeps tags in the existing vX.Y.Z form', () => {
    const config = JSON.parse(read('release-please-config.json'));

    expect(config.packages['.']['package-name']).toBe('loopsteward');
    expect(config.packages['.']['include-component-in-tag']).toBe(false);
    expect(config.packages['.']['changelog-path']).toBe('CHANGELOG.md');
  });
});
