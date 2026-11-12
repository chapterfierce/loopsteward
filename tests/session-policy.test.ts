import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  POLICY_BEGIN,
  buildPolicyBlock,
  inspectSessionPolicy,
  installSessionPolicy,
} from '../src/loops/session-policy.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `loops-policy-${label}-`));
  dirs.push(dir);
  return dir;
}

function fixture(label: string): { home: string; script: string; file: string } {
  const dir = tempDir(label);
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  const script = path.join(dir, 'scripts', 'open-loops.ps1');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, 'exit 0\n', 'utf8');
  return { home, script, file: path.join(home, '.codex', 'AGENTS.md') };
}

describe('session policy installer', () => {
  it('installs the session-start block and keeps existing instructions', () => {
    const { home, script, file } = fixture('install');
    fs.writeFileSync(file, '# Existing\n\nKeep me.\n', 'utf8');

    const results = installSessionPolicy({
      homeDir: home,
      scriptPath: script,
      now: new Date('2026-11-11T12:00:00.000Z'),
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ agent: 'codex', action: 'installed' });
    const content = fs.readFileSync(file, 'utf8');
    expect(content).toContain('Keep me.');
    expect(content).toContain(POLICY_BEGIN);
    expect(content).toContain(`node "${script}" digest --skill`);
  });

  it('keeps the digest as a prelude instead of replacing the answer', () => {
    const block = buildPolicyBlock('C:\\loops\\open-loops.ps1');

    expect(block).toContain('node "C:\\loops\\open-loops.ps1" digest --skill');
    expect(block).toContain('opening prelude');
    expect(block).toContain("then answer the user's actual request");
    expect(block).toContain('not the final answer');
    expect(block).not.toContain('intended final message');
  });

  it('is idempotent and never duplicates the block', () => {
    const { home, script, file } = fixture('idempotent');
    fs.writeFileSync(file, '# Existing\n', 'utf8');

    installSessionPolicy({ homeDir: home, scriptPath: script });
    const second = installSessionPolicy({ homeDir: home, scriptPath: script });

    expect(second[0].action).toBe('unchanged');
    const content = fs.readFileSync(file, 'utf8');
    expect(content.split('<!-- open-loops:begin').length - 1).toBe(1);
  });

  it('updates a stale block in place and preserves surrounding sections', () => {
    const { home, script, file } = fixture('update');
    const oldBlock = buildPolicyBlock('C:\\old\\open-loops.ps1');
    fs.writeFileSync(file, `# Top\n\n${oldBlock}\n\n# Bottom\n`, 'utf8');

    const results = installSessionPolicy({ homeDir: home, scriptPath: script });

    expect(results[0].action).toBe('updated');
    const content = fs.readFileSync(file, 'utf8');
    expect(content).not.toContain('C:\\old\\open-loops.ps1');
    expect(content).toContain(`node "${script}" digest --skill`);
    expect(content.startsWith('# Top\n\n')).toBe(true);
    expect(content.endsWith('# Bottom\n')).toBe(true);
  });

  it('uninstalls the block and restores the file', () => {
    const { home, script, file } = fixture('uninstall');
    fs.writeFileSync(file, '', 'utf8');
    installSessionPolicy({ homeDir: home, scriptPath: script });

    const results = installSessionPolicy({
      homeDir: home,
      scriptPath: script,
      uninstall: true,
    });

    expect(results[0].action).toBe('removed');
    expect(fs.readFileSync(file, 'utf8')).toBe('');
  });

  it('does not write anything in dry-run mode', () => {
    const { home, script, file } = fixture('dry-run');

    const results = installSessionPolicy({ homeDir: home, scriptPath: script, dryRun: true });

    expect(results[0].action).toBe('installed');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('rejects an explicitly selected agent whose directory is absent', () => {
    const { home, script } = fixture('explicit');

    expect(() => installSessionPolicy({
      homeDir: home,
      scriptPath: script,
      agents: ['claude'],
    })).toThrow(/not found/);
    expect(fs.existsSync(path.join(home, '.claude'))).toBe(false);
  });

  it('installs into ZCode and DSH global instruction files', () => {
    const dir = tempDir('zcode-dsh');
    const home = path.join(dir, 'home');
    fs.mkdirSync(path.join(home, '.zcode'), { recursive: true });
    fs.mkdirSync(path.join(home, '.dsh'), { recursive: true });
    const script = path.join(dir, 'scripts', 'open-loops.ps1');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, 'exit 0\n', 'utf8');

    const results = installSessionPolicy({ homeDir: home, scriptPath: script });

    expect(results.map((result) => result.agent).sort()).toEqual(['dsh', 'zcode']);
    expect(fs.readFileSync(path.join(home, '.zcode', 'AGENTS.md'), 'utf8')).toContain(POLICY_BEGIN);
    expect(fs.readFileSync(path.join(home, '.dsh', 'AGENTS.md'), 'utf8')).toContain(POLICY_BEGIN);
  });

  it('installs into the Antigravity global GEMINI.md', () => {
    const dir = tempDir('antigravity');
    const home = path.join(dir, 'home');
    fs.mkdirSync(path.join(home, '.gemini', 'config'), { recursive: true });
    const script = path.join(dir, 'scripts', 'open-loops.ps1');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, 'exit 0\n', 'utf8');

    const results = installSessionPolicy({ homeDir: home, scriptPath: script });

    expect(results.map((result) => result.agent)).toEqual(['antigravity']);
    expect(
      fs.readFileSync(path.join(home, '.gemini', 'config', 'GEMINI.md'), 'utf8'),
    ).toContain(POLICY_BEGIN);
  });

  it('installs into the Hermes global SOUL.md', () => {
    const dir = tempDir('hermes');
    const home = path.join(dir, 'home');
    const localAppData = path.join(home, 'AppData', 'Local');
    fs.mkdirSync(path.join(localAppData, 'hermes'), { recursive: true });
    const script = path.join(dir, 'scripts', 'open-loops.ps1');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, 'exit 0\n', 'utf8');

    const results = installSessionPolicy({
      homeDir: home,
      localAppData,
      scriptPath: script,
      agents: ['hermes'],
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ agent: 'hermes', action: 'installed' });
    expect(fs.readFileSync(path.join(localAppData, 'hermes', 'SOUL.md'), 'utf8'))
      .toContain(POLICY_BEGIN);
    expect(
      inspectSessionPolicy({
        homeDir: home,
        localAppData,
        scriptPath: script,
        agents: ['hermes'],
      })[0].status,
    ).toBe('ok');
  });

  it('preserves CRLF line endings', () => {
    const { home, script, file } = fixture('crlf');
    fs.writeFileSync(file, '# Top\r\n\r\n# Bottom\r\n', 'utf8');

    installSessionPolicy({ homeDir: home, scriptPath: script });

    const content = fs.readFileSync(file, 'utf8');
    expect(content).toContain('\r\n<!-- open-loops:begin');
    expect(/(?<!\r)\n/.test(content)).toBe(false);
  });

  it('reports missing, stale, and healthy policy files', () => {
    const { home, script, file } = fixture('inspect');

    expect(inspectSessionPolicy({ homeDir: home, scriptPath: script })[0]).toMatchObject({
      status: 'warn',
      detail: 'codex: 未安装',
    });

    installSessionPolicy({ homeDir: home, scriptPath: script });
    expect(inspectSessionPolicy({ homeDir: home, scriptPath: script })[0].status).toBe('ok');

    const stale = fs.readFileSync(file, 'utf8').replaceAll(script, 'C:\\old\\open-loops.ps1');
    fs.writeFileSync(file, stale, 'utf8');
    expect(inspectSessionPolicy({ homeDir: home, scriptPath: script })[0]).toMatchObject({
      status: 'warn',
      detail: 'codex: 指向旧路径',
    });
  });

  it('warns when the installed policy predates the current rule version', () => {
    const { home, script, file } = fixture('stale-version');
    installSessionPolicy({ homeDir: home, scriptPath: script });

    const oldBlock = buildPolicyBlock(script)
      .replace('<!-- open-loops-policy:v2 -->\n', '')
      .replace('opening prelude', 'intended final message');
    fs.writeFileSync(file, oldBlock, 'utf8');

    expect(inspectSessionPolicy({ homeDir: home, scriptPath: script })[0]).toMatchObject({
      status: 'warn',
      detail: 'codex: 规则过旧',
    });
  });
});
