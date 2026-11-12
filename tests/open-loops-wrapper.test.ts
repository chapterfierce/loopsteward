import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createWrapperFixture(): { root: string; wrapper: string; caller: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'open-loops-wrapper-'));
  const caller = fs.mkdtempSync(path.join(os.tmpdir(), 'open-loops-caller-'));
  dirs.push(root, caller);
  fs.mkdirSync(path.join(root, 'dist', 'src', 'loops'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.copyFileSync(
    path.join(process.cwd(), 'scripts', 'open-loops.ps1'),
    path.join(root, 'scripts', 'open-loops.ps1'),
  );
  fs.writeFileSync(
    path.join(root, 'dist', 'src', 'loops', 'cli.js'),
    'console.log(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\n',
    'utf8',
  );
  return {
    root,
    wrapper: path.join(root, 'scripts', 'open-loops.ps1'),
    caller,
  };
}

function runWrapper(
  wrapper: string,
  caller: string,
  args: string[],
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapper, ...args],
    { cwd: caller, encoding: 'utf8' },
  );
  return {
    status: result.status,
    stdout: result.stdout.replace(/^\uFEFF/, '').trim(),
    stderr: result.stderr,
  };
}

describe.skipIf(process.platform !== 'win32')('open-loops.ps1', () => {
  it('forwards the caller cwd to digest, and lets explicit flags win', () => {
    const { root, wrapper, caller } = createWrapperFixture();

    const focused = runWrapper(wrapper, caller, ['digest', '--skill']);
    expect(focused.status).toBe(0);
    const focusedPayload = JSON.parse(focused.stdout) as { argv: string[]; cwd: string };
    const projectIndex = focusedPayload.argv.indexOf('--project');
    expect(projectIndex).toBeGreaterThanOrEqual(0);
    const forwarded = focusedPayload.argv[projectIndex + 1];
    expect(fs.statSync(forwarded).ino).toBe(fs.statSync(caller).ino);
    expect(fs.statSync(focusedPayload.cwd).ino).toBe(fs.statSync(root).ino);

    const disabled = runWrapper(wrapper, caller, ['digest', '--no-project-focus']);
    expect(disabled.status).toBe(0);
    expect((JSON.parse(disabled.stdout) as { argv: string[] }).argv)
      .not.toContain('--project');

    const explicit = runWrapper(wrapper, caller, ['digest', '--project', 'C:/work/custom']);
    expect(explicit.status).toBe(0);
    const explicitArgv = (JSON.parse(explicit.stdout) as { argv: string[] }).argv;
    expect(explicitArgv.filter((arg) => arg === '--project')).toHaveLength(1);
    expect(explicitArgv[explicitArgv.indexOf('--project') + 1]).toBe('C:/work/custom');
  });

  it('does not add project focus to non-digest commands', () => {
    const { wrapper, caller } = createWrapperFixture();
    const result = runWrapper(wrapper, caller, ['list', '--status', 'open']);
    expect(result.status).toBe(0);
    expect((JSON.parse(result.stdout) as { argv: string[] }).argv)
      .not.toContain('--project');
  });
});
