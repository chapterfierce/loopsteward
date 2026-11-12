import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { installMcpConfigs } from '../src/loops/mcp-install.js';

const dirs: string[] = [];

function tempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `loops-mcp-install-${label}-`));
  dirs.push(dir);
  return dir;
}

function makeFixture(label: string) {
  const dir = tempDir(label);
  const serverPath = path.join(dir, 'dist', 'src', 'mcp', 'server.js');
  fs.mkdirSync(path.dirname(serverPath), { recursive: true });
  fs.writeFileSync(serverPath, '// fake server\n', 'utf8');
  return {
    dir,
    serverPath,
    codexConfig: path.join(dir, 'codex', 'config.toml'),
    claudeConfig: path.join(dir, 'project', '.mcp.json'),
    cursorConfig: path.join(dir, 'cursor', 'mcp.json'),
  };
}

function install(fixture: ReturnType<typeof makeFixture>, extra: Record<string, unknown> = {}) {
  return installMcpConfigs({
    serverPath: fixture.serverPath,
    codexConfig: fixture.codexConfig,
    claudeConfig: fixture.claudeConfig,
    cursorConfig: fixture.cursorConfig,
    ...extra,
  });
}

afterEach(() => {
  while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('installMcpConfigs', () => {
  it('installs into Codex TOML, Claude .mcp.json, and Cursor mcp.json', () => {
    const f = makeFixture('install');
    const results = install(f);
    expect(results.map((result) => result.action)).toEqual(['installed', 'installed', 'installed']);

    const codex = fs.readFileSync(f.codexConfig, 'utf8');
    expect(codex).toContain('[mcp_servers.loopsteward]');
    expect(codex).toContain('command = "node"');
    expect(codex).toContain(JSON.stringify(f.serverPath));

    for (const file of [f.claudeConfig, f.cursorConfig]) {
      const config = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(config.mcpServers.loopsteward).toEqual({
        command: 'node',
        args: [f.serverPath],
      });
    }
  });

  it('preserves other Codex tables and unrelated JSON keys', () => {
    const f = makeFixture('preserve');
    fs.mkdirSync(path.dirname(f.codexConfig), { recursive: true });
    fs.writeFileSync(f.codexConfig, [
      '# keep this comment',
      '[mcp_servers.other]',
      'command = "other"',
      '',
      '[profiles.default]',
      'model = "gpt-5"',
      '',
    ].join('\n'), 'utf8');
    fs.mkdirSync(path.dirname(f.claudeConfig), { recursive: true });
    fs.writeFileSync(f.claudeConfig, JSON.stringify({
      theme: 'dark',
      mcpServers: { other: { command: 'other-node', args: ['other.js'] } },
    }, null, 2) + '\n', 'utf8');

    install(f);

    const codex = fs.readFileSync(f.codexConfig, 'utf8');
    expect(codex).toContain('# keep this comment');
    expect(codex).toContain('[mcp_servers.other]');
    expect(codex).toContain('command = "other"');
    expect(codex).toContain('[profiles.default]');
    expect(codex).toContain('model = "gpt-5"');

    const claude = JSON.parse(fs.readFileSync(f.claudeConfig, 'utf8'));
    expect(claude.theme).toBe('dark');
    expect(claude.mcpServers.other).toEqual({ command: 'other-node', args: ['other.js'] });
    expect(claude.mcpServers.loopsteward.command).toBe('node');
  });

  it('is idempotent on a second run', () => {
    const f = makeFixture('idempotent');
    install(f);
    const second = install(f);
    expect(second.map((result) => result.action)).toEqual(['unchanged', 'unchanged', 'unchanged']);
  });

  it('passes a custom database path to the server command', () => {
    const f = makeFixture('db-path');
    const dbPath = path.join(f.dir, 'data', 'loops.db');
    install(f, { dbPath });
    const config = JSON.parse(fs.readFileSync(f.claudeConfig, 'utf8'));
    expect(config.mcpServers.loopsteward.args).toEqual([f.serverPath, '--db', dbPath]);
  });

  it('backs up and removes only the loopsteward entry on uninstall', () => {
    const f = makeFixture('uninstall');
    fs.mkdirSync(path.dirname(f.codexConfig), { recursive: true });
    fs.writeFileSync(f.codexConfig, '[mcp_servers.other]\ncommand = "other"\n', 'utf8');
    install(f);

    const results = install(f, { uninstall: true, now: new Date('2026-11-12T10:00:00Z') });
    expect(results.map((result) => result.action)).toEqual(['removed', 'removed', 'removed']);
    for (const result of results) expect(result.backup).toBeTruthy();

    const codex = fs.readFileSync(f.codexConfig, 'utf8');
    expect(codex).not.toContain('loopsteward');
    expect(codex).toContain('[mcp_servers.other]');
    const claude = JSON.parse(fs.readFileSync(f.claudeConfig, 'utf8'));
    expect(claude.mcpServers).toEqual({});
  });

  it('does not write anything on a dry run', () => {
    const f = makeFixture('dry-run');
    const results = install(f, { dryRun: true });
    expect(results.map((result) => result.action)).toEqual(['installed', 'installed', 'installed']);
    expect(fs.existsSync(f.codexConfig)).toBe(false);
    expect(fs.existsSync(f.claudeConfig)).toBe(false);
    expect(fs.existsSync(f.cursorConfig)).toBe(false);
  });

  it('refuses to overwrite invalid JSON', () => {
    const f = makeFixture('invalid');
    fs.mkdirSync(path.dirname(f.claudeConfig), { recursive: true });
    fs.writeFileSync(f.claudeConfig, '{ invalid', 'utf8');
    const before = fs.readFileSync(f.claudeConfig, 'utf8');

    const results = install(f);
    const claude = results.find((result) => result.client === 'claude')!;
    expect(claude.action).toBe('error');
    expect(claude.error).toContain('invalid JSON');
    expect(fs.readFileSync(f.claudeConfig, 'utf8')).toBe(before);
  });

  it('throws when the server build is missing', () => {
    const f = makeFixture('missing-build');
    fs.rmSync(f.serverPath);
    expect(() => install(f)).toThrow(/run npm run build/);
  });

  it('supports limiting clients', () => {
    const f = makeFixture('clients');
    const results = install(f, { clients: ['claude'] });
    expect(results).toHaveLength(1);
    expect(results[0].client).toBe('claude');
    expect(fs.existsSync(f.codexConfig)).toBe(false);
    expect(fs.existsSync(f.cursorConfig)).toBe(false);
  });

  it('wires the install-mcp CLI command', () => {
    const f = makeFixture('cli');
    const tsx = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const cli = path.join(process.cwd(), 'src', 'loops', 'cli.ts');
    const result = spawnSync(process.execPath, [
      tsx,
      cli,
      'install-mcp',
      '--server-path', f.serverPath,
      '--codex-config', f.codexConfig,
      '--claude-config', f.claudeConfig,
      '--cursor-config', f.cursorConfig,
      '--dry-run',
      '--json',
    ], { cwd: process.cwd(), encoding: 'utf8' });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.results).toHaveLength(3);
    expect(parsed.results.every((entry: any) => entry.action === 'installed')).toBe(true);
  });
});
