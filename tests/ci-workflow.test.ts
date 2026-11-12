import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('CI workflow', () => {
  it('audits all dependency scopes against the public npm registry', () => {
    const workflow = fs.readFileSync(
      path.join(process.cwd(), '.github', 'workflows', 'ci.yml'),
      'utf8',
    );
    const auditJob = workflow.slice(
      workflow.indexOf('  audit:'),
      workflow.indexOf('  lint:'),
    );

    expect(auditJob).toContain('runs-on: ubuntu-latest');
    expect(auditJob).toContain(
      'npm audit --registry=https://registry.npmjs.org --audit-level=moderate',
    );
  });

  it('runs the Open Loops suite on a Windows runner', () => {
    const workflow = fs.readFileSync(
      path.join(process.cwd(), '.github', 'workflows', 'ci.yml'),
      'utf8',
    );
    const windowsJob = workflow.slice(workflow.indexOf('  windows:'));

    expect(windowsJob).toContain('runs-on: windows-latest');
    expect(windowsJob).toContain('npm ci');
    expect(windowsJob).toContain('npm run build');
    expect(windowsJob).toContain('npx vitest run');
  });

  it('runs only the Open Loops suite in the blocking test job', () => {
    const workflow = fs.readFileSync(
      path.join(process.cwd(), '.github', 'workflows', 'ci.yml'),
      'utf8',
    );
    const testJob = workflow.slice(
      workflow.indexOf('  test:'),
      workflow.indexOf('  legacy:'),
    );

    expect(testJob).toContain('run: npm test');
    expect(testJob).not.toContain('test:legacy');
    expect(testJob).not.toContain('test:m4');
  });

  it('keeps the legacy HTTP suites in a separate non-blocking job', () => {
    const workflow = fs.readFileSync(
      path.join(process.cwd(), '.github', 'workflows', 'ci.yml'),
      'utf8',
    );
    const legacyJob = workflow.slice(
      workflow.indexOf('  legacy:'),
      workflow.indexOf('  package:'),
    );

    expect(legacyJob).toContain('continue-on-error: true');
    expect(legacyJob).toContain('run: npm run test:legacy');
    for (const script of ['test:m4', 'test:m5', 'test:m7', 'test:m10', 'test:m11']) {
      expect(legacyJob).toContain(`npm run ${script}`);
    }
  });

  it('verifies the packed npm artifact in CI', () => {
    const workflow = fs.readFileSync(
      path.join(process.cwd(), '.github', 'workflows', 'ci.yml'),
      'utf8',
    );
    const packageJob = workflow.slice(
      workflow.indexOf('  package:'),
      workflow.indexOf('  build:'),
    );

    expect(packageJob).toContain('npm ci');
    expect(packageJob).toContain('run: npm run verify:package');
  });

  it('loads and runs the built Docker image', () => {
    const workflow = fs.readFileSync(
      path.join(process.cwd(), '.github', 'workflows', 'ci.yml'),
      'utf8',
    );
    const dockerJob = workflow.slice(
      workflow.indexOf('  docker:'),
      workflow.indexOf('  windows:'),
    );

    expect(dockerJob).toContain('load: true');
    expect(dockerJob).toContain('docker run --rm claw-task-service:${{ github.sha }}');
  });
});
