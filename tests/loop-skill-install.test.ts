import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  installOpenLoopsSkill,
  installOpenLoopsSkillForAgents,
  skillAgentTargets,
} from '../src/loops/skill-install.js';

const dirs: string[] = [];
const PS_SCRIPTS = [
  '../scripts/open-loops.ps1',
  '../scripts/refresh-open-loops.ps1',
  '../scripts/install-refresh-task.ps1',
];
const UTF8_ENTRY = '../scripts/open-loops.cmd';

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function fixture(): { source: string; target: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-skill-'));
  dirs.push(dir);
  const source = path.join(dir, 'repo', 'SKILL.md');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, '# Open Loops\n');
  return {
    source,
    target: path.join(dir, 'home', '.codex', 'skills', 'open-loops', 'SKILL.md'),
    dir,
  };
}

describe('installOpenLoopsSkill', () => {
  it('maps every supported agent to its own skill directory', () => {
    const { dir } = fixture();
    const home = path.join(dir, 'home');
    const localAppData = path.join(dir, 'local');
    const targets = skillAgentTargets({ homeDir: home, localAppData });

    expect(targets.map((item) => item.agent)).toEqual([
      'codex',
      'claude',
      'qoder',
      'workbuddy',
      'hermes',
      'antigravity',
    ]);
    expect(targets.find((item) => item.agent === 'codex')?.target).toBe(
      path.join(home, '.codex', 'skills', 'open-loops', 'SKILL.md'),
    );
    expect(targets.find((item) => item.agent === 'hermes')?.target).toBe(
      path.join(localAppData, 'hermes', 'skills', 'open-loops', 'SKILL.md'),
    );
    expect(targets.find((item) => item.agent === 'antigravity')?.target).toBe(
      path.join(home, '.gemini', 'config', 'skills', 'open-loops', 'SKILL.md'),
    );
  });

  it('installs the same skill into every detected agent and stays idempotent', () => {
    const { source, dir } = fixture();
    const home = path.join(dir, 'home');
    const localAppData = path.join(dir, 'local');
    for (const name of ['.codex', '.claude', '.qoder', '.workbuddy', path.join('.gemini', 'config')]) {
      fs.mkdirSync(path.join(home, name), { recursive: true });
    }
    fs.mkdirSync(path.join(localAppData, 'hermes'), { recursive: true });

    const first = installOpenLoopsSkillForAgents({
      sourcePath: source,
      homeDir: home,
      localAppData,
    });
    const second = installOpenLoopsSkillForAgents({
      sourcePath: source,
      homeDir: home,
      localAppData,
    });

    expect(first.map((item) => item.agent)).toEqual([
      'codex',
      'claude',
      'qoder',
      'workbuddy',
      'hermes',
      'antigravity',
    ]);
    expect(second.every((item) => item.action === 'unchanged')).toBe(true);
    for (const item of first) {
      expect(fs.readFileSync(item.target, 'utf8')).toBe('# Open Loops\n');
      expect(item.sha256).toBe(first[0].sha256);
    }
  });

  it('installs only the explicitly requested agents', () => {
    const { source, dir } = fixture();
    const home = path.join(dir, 'home');
    const localAppData = path.join(dir, 'local');
    fs.mkdirSync(home, { recursive: true });

    const results = installOpenLoopsSkillForAgents({
      sourcePath: source,
      homeDir: home,
      localAppData,
      agents: ['claude', 'hermes'],
    });

    expect(results.map((item) => item.agent)).toEqual(['claude', 'hermes']);
    expect(results.every((item) => item.action === 'installed')).toBe(true);
    expect(fs.existsSync(path.join(home, '.codex', 'skills', 'open-loops', 'SKILL.md'))).toBe(false);
  });

  it('installs once and is idempotent on the next run', () => {
    const { source, target } = fixture();
    const first = installOpenLoopsSkill({ sourcePath: source, destinationPath: target });
    const second = installOpenLoopsSkill({ sourcePath: source, destinationPath: target });

    expect(first.action).toBe('installed');
    expect(second.action).toBe('unchanged');
    expect(second.sha256).toBe(first.sha256);
    expect(fs.readFileSync(target, 'utf8')).toBe('# Open Loops\n');
  });

  it.skipIf(process.platform !== 'win32')(
    'renders the installed package root into the skill body',
    () => {
      const { source, target, dir } = fixture();
      fs.writeFileSync(
        source,
        [
          '# Open Loops',
          'powershell -File "C:\\old\\repo\\scripts\\open-loops.ps1" digest --skill',
          'powershell -File "C:\\old\\repo\\scripts\\refresh-open-loops.ps1"',
          '',
        ].join('\n'),
        'utf8',
      );
      const packageRoot = path.join(dir, 'installed');

      const result = installOpenLoopsSkill({
        sourcePath: source,
        destinationPath: target,
        packageRoot,
      });

      const content = fs.readFileSync(target, 'utf8');
      expect(result.action).toBe('installed');
      expect(content).toContain(path.join(packageRoot, 'scripts', 'open-loops.ps1'));
      expect(content).toContain(path.join(packageRoot, 'scripts', 'refresh-open-loops.ps1'));
      expect(content).not.toContain('C:\\old\\repo');
    },
  );

  it('backs up a previous skill before replacing it', () => {
    const { source, target } = fixture();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '# Old\n');
    fs.writeFileSync(source, '# New\n');

    const result = installOpenLoopsSkill({
      sourcePath: source,
      destinationPath: target,
      now: new Date('2026-11-11T10:20:30'),
    });

    expect(result.action).toBe('updated');
    expect(result.backup).toBeTruthy();
    expect(fs.readFileSync(result.backup!, 'utf8')).toBe('# Old\n');
    expect(fs.readFileSync(target, 'utf8')).toBe('# New\n');
  });

  it('moves a nested duplicate out of the skill scan path', () => {
    const { source, target, dir } = fixture();
    const nested = path.join(dir, 'home', '.codex', 'skills', 'open-loops', 'open-loops', 'SKILL.md');
    fs.mkdirSync(path.dirname(nested), { recursive: true });
    fs.writeFileSync(nested, '# Nested\n');

    const result = installOpenLoopsSkill({ sourcePath: source, destinationPath: target });

    expect(result.nestedBackup).toContain('bak-nested-');
    expect(fs.existsSync(nested)).toBe(false);
    expect(fs.readFileSync(result.nestedBackup!, 'utf8')).toBe('# Nested\n');
  });

  it('delegates session-start copy to the skill formatter', () => {
    const skillPath = fileURLToPath(new URL('../skills/open-loops/SKILL.md', import.meta.url));
    const skill = fs.readFileSync(skillPath, 'utf8');

    expect(skill).toContain('digest --skill');
    expect(skill).toContain('digest --review --limit 15 --skill');
    expect(skill).toContain('Print the CLI output verbatim as the opening prelude');
    expect(skill).toContain('not the final answer');
    expect(skill).not.toContain('The CLI output is the final message. Print it verbatim.');
    expect(skill).toContain('Do not add, remove, reorder, rewrite, or recompute');
    expect(skill).not.toContain('K 取 `activeTotal`');
    expect(skill).not.toContain('最近活跃：A（N 个会话）');
    expect(skill).toContain('scripts\\open-loops.ps1');
    expect(skill).toContain('powershell -NoProfile -ExecutionPolicy Bypass -File');
    expect(skill).not.toContain('& "C:');
    expect(skill).not.toContain('npm --prefix');
  });

  it('runs the skill through the compiled CLI wrapper', () => {
    const wrapperPath = fileURLToPath(new URL('../scripts/open-loops.ps1', import.meta.url));
    const wrapper = fs.readFileSync(wrapperPath, 'utf8');

    expect(wrapper).toContain('dist\\src\\loops\\cli.js');
    expect(wrapper).toContain('Push-Location');
    expect(wrapper).toContain('$cliArgs = @($args)');
    expect(wrapper).toContain('@cliArgs');
    expect(wrapper).toContain('--project');
    expect(wrapper).toContain('--no-project-focus');
    expect(wrapper).toContain('[Console]::OutputEncoding');
    expect(wrapper).toContain('[System.Text.Encoding]::UTF8');
    expect(wrapper).toContain('--no-mark');
    expect(wrapper).toContain('--readonly-fallback');
    expect(wrapper).toContain('attempt to write a readonly database');
    expect(wrapper).toContain('[string]$_');
    expect(wrapper).toContain('[string] $_');
  });

  it('keeps PowerShell wrappers ASCII-only for Windows PowerShell 5.1', () => {
    for (const relative of [...PS_SCRIPTS, UTF8_ENTRY]) {
      const bytes = fs.readFileSync(fileURLToPath(new URL(relative, import.meta.url)));
      expect(bytes.every((byte) => byte < 0x80)).toBe(true);
    }
  });

  it('routes the UTF-8 cmd entry through chcp 65001', () => {
    const entry = fs.readFileSync(
      fileURLToPath(new URL(UTF8_ENTRY, import.meta.url)),
      'utf8',
    );

    expect(entry).toContain('chcp 65001');
    expect(entry).toContain('open-loops.ps1');
  });

  it('keeps the skill body ASCII-only so terminals cannot garble it', () => {
    const skillPath = fileURLToPath(new URL('../skills/open-loops/SKILL.md', import.meta.url));
    const bytes = fs.readFileSync(skillPath);

    expect(bytes.every((byte) => byte < 0x80)).toBe(true);
  });

  it('documents how to carry out a loop instead of only showing it', () => {
    const skillPath = fileURLToPath(new URL('../skills/open-loops/SKILL.md', import.meta.url));
    const text = fs.readFileSync(skillPath, 'utf8');

    expect(text).toContain('## Act on a loop');
    expect(text).toContain('do item N');
    expect(text).toContain('--status resolved --note "done in session');
    expect(text).toContain('Never mark it resolved on your own');
  });

  it('maps a digest number back to the ref printed in that digest', () => {
    const skillPath = fileURLToPath(new URL('../skills/open-loops/SKILL.md', import.meta.url));
    const text = fs.readFileSync(skillPath, 'utf8');

    expect(text).toContain('find that number in the digest you printed');
    expect(text).toContain('Do not use `--index`');
    expect(text).toContain('update --ref 7c38c598 --status resolved');
  });

  it('documents atomic batch verdicts', () => {
    const skillPath = fileURLToPath(new URL('../skills/open-loops/SKILL.md', import.meta.url));
    const text = fs.readFileSync(skillPath, 'utf8');

    expect(text).toContain('## Batch verdicts');
    expect(text).toContain('feedback --refs');
    expect(text).toContain('update --refs');
    expect(text).toContain('all-or-nothing');
    expect(text).toContain('"Useful" is feedback, not completion');
  });

  it.skipIf(process.platform !== 'win32')(
    'parses the skill wrapper with Windows PowerShell 5.1',
    () => {
      for (const relative of PS_SCRIPTS) {
        const wrapperPath = fileURLToPath(new URL(relative, import.meta.url));
        const escaped = wrapperPath.replace(/'/g, "''");
        const script = [
          '$tokens = $null',
          '$errors = $null',
          `[System.Management.Automation.Language.Parser]::ParseFile('${escaped}', [ref]$tokens, [ref]$errors) | Out-Null`,
          'if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }',
        ].join('; ');
        const result = spawnSync(
          'powershell.exe',
          ['-NoProfile', '-Command', script],
          { encoding: 'utf8' },
        );

        expect(result.status, relative).toBe(0);
      }
    },
  );
});
