import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findPackageRoot } from './package-root.js';

export const MCP_CLIENTS = ['codex', 'claude', 'cursor'] as const;
export type McpClient = (typeof MCP_CLIENTS)[number];

export interface McpInstallOptions {
  homeDir?: string;
  projectDir?: string;
  codexConfig?: string;
  claudeConfig?: string;
  cursorConfig?: string;
  clients?: McpClient[];
  serverPath?: string;
  nodeCommand?: string;
  dbPath?: string;
  dryRun?: boolean;
  uninstall?: boolean;
  now?: Date;
}

export interface McpInstallResult {
  client: McpClient;
  file: string;
  action: 'installed' | 'updated' | 'unchanged' | 'removed' | 'missing' | 'error';
  backup?: string;
  error?: string;
}

interface McpTarget {
  client: McpClient;
  file: string;
}

interface JsonMergeResult {
  content: string;
  action: McpInstallResult['action'];
}

interface TomlMergeResult {
  content: string;
  action: McpInstallResult['action'];
}

export interface McpServerConfig {
  command: string;
  args: string[];
}

function timestamp(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('');
}

function uniqueBackupPath(target: string, label: string): string {
  let candidate = `${target}.${label}`;
  let suffix = 1;
  while (fs.existsSync(candidate)) {
    candidate = `${target}.${label}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function detectEol(content: string): string {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

function mcpTargets(options: McpInstallOptions): McpTarget[] {
  const home = options.homeDir ?? os.homedir();
  const project = path.resolve(options.projectDir ?? process.cwd());
  const all: McpTarget[] = [
    {
      client: 'codex',
      file: options.codexConfig ?? path.join(home, '.codex', 'config.toml'),
    },
    {
      client: 'claude',
      file: options.claudeConfig ?? path.join(project, '.mcp.json'),
    },
    {
      client: 'cursor',
      file: options.cursorConfig ?? path.join(home, '.cursor', 'mcp.json'),
    },
  ];
  const requested = options.clients;
  if (!requested) return all;
  const unique = [...new Set(requested)];
  const unknown = unique.filter((client) => !MCP_CLIENTS.includes(client));
  if (unknown.length > 0) throw new Error(`unknown mcp client: ${unknown.join(', ')}`);
  return all.filter((target) => unique.includes(target.client));
}

export function resolveMcpServerPath(packageRoot?: string): string {
  return path.join(packageRoot ?? findPackageRoot(), 'dist', 'src', 'mcp', 'server.js');
}

export function buildMcpServerConfig(options: {
  serverPath: string;
  nodeCommand?: string;
  dbPath?: string;
}): McpServerConfig {
  const args = [options.serverPath];
  if (options.dbPath) args.push('--db', options.dbPath);
  return {
    command: options.nodeCommand ?? 'node',
    args,
  };
}

function mergeJsonConfig(
  content: string,
  server: McpServerConfig,
  uninstall: boolean,
): JsonMergeResult {
  const eol = detectEol(content);
  const text = content.replace(/^\uFEFF/, '').trim();
  let parsed: Record<string, unknown>;
  try {
    parsed = text ? JSON.parse(text) as Record<string, unknown> : {};
  } catch (error) {
    throw new Error(`invalid JSON: ${(error as Error).message}; refusing to overwrite`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('top-level JSON value must be an object; refusing to overwrite');
  }
  const current = parsed.mcpServers;
  if (current !== undefined && (typeof current !== 'object' || current === null || Array.isArray(current))) {
    throw new Error('mcpServers must be an object; refusing to overwrite');
  }
  const servers = { ...((current ?? {}) as Record<string, unknown>) };

  if (uninstall) {
    if (!Object.prototype.hasOwnProperty.call(servers, 'loopsteward')) {
      return { content, action: 'unchanged' };
    }
    delete servers.loopsteward;
    parsed.mcpServers = servers;
    return { content: JSON.stringify(parsed, null, 2) + eol, action: 'removed' };
  }

  const previous = servers.loopsteward;
  const same = JSON.stringify(previous) === JSON.stringify(server);
  if (same) return { content, action: 'unchanged' };
  servers.loopsteward = server;
  parsed.mcpServers = servers;
  return {
    content: JSON.stringify(parsed, null, 2) + eol,
    action: previous === undefined ? 'installed' : 'updated',
  };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function buildTomlBlock(server: McpServerConfig): string[] {
  const args = server.args.map(tomlString).join(', ');
  return [
    '[mcp_servers.loopsteward]',
    `command = ${tomlString(server.command)}`,
    `args = [${args}]`,
  ];
}

function isLoopstewardTable(line: string): boolean {
  return /^\s*\[mcp_servers\.(?:loopsteward|"loopsteward")\]\s*$/.test(line);
}

function mergeTomlConfig(
  content: string,
  server: McpServerConfig,
  uninstall: boolean,
): TomlMergeResult {
  const eol = detectEol(content);
  const lines = content.length > 0 ? content.split(/\r?\n/) : [];
  if (content.endsWith('\n')) lines.pop();

  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (isLoopstewardTable(lines[index])) {
      start = index;
      break;
    }
  }

  if (uninstall) {
    if (start < 0) return { content, action: 'unchanged' };
    let end = start + 1;
    while (end < lines.length && !/^\s*\[/.test(lines[end])) end += 1;
    let removeStart = start;
    if (removeStart > 0 && lines[removeStart - 1].trim() === '') removeStart -= 1;
    lines.splice(removeStart, end - removeStart);
    return {
      content: lines.length > 0 ? lines.join(eol) + eol : '',
      action: 'removed',
    };
  }

  const block = buildTomlBlock(server);
  if (start >= 0) {
    let end = start + 1;
    while (end < lines.length && !/^\s*\[/.test(lines[end])) end += 1;
    const currentBlock = lines.slice(start, end);
    if (JSON.stringify(currentBlock) === JSON.stringify(block)) {
      return { content, action: 'unchanged' };
    }
    lines.splice(start, end - start, ...block);
    return { content: lines.join(eol) + eol, action: 'updated' };
  }

  const next = lines.length > 0
    ? [...lines, '', ...block]
    : block;
  return { content: next.join(eol) + eol, action: 'installed' };
}

function writeWithBackup(
  file: string,
  content: string,
  stamp: string,
  dryRun: boolean,
): string | undefined {
  if (dryRun) return undefined;
  let backup: string | undefined;
  if (fs.existsSync(file)) {
    backup = uniqueBackupPath(file, `bak-${stamp}`);
    fs.copyFileSync(file, backup);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return backup;
}

export function installMcpConfigs(options: McpInstallOptions = {}): McpInstallResult[] {
  const serverPath = path.resolve(options.serverPath ?? resolveMcpServerPath());
  if (!options.uninstall && !fs.existsSync(serverPath)) {
    throw new Error(`MCP server build not found: ${serverPath}; run npm run build first`);
  }
  const server = buildMcpServerConfig({
    serverPath,
    nodeCommand: options.nodeCommand,
    dbPath: options.dbPath,
  });
  const stamp = timestamp(options.now ?? new Date());

  return mcpTargets(options).map((target) => {
    const exists = fs.existsSync(target.file);
    if (!exists && options.uninstall) {
      return { client: target.client, file: target.file, action: 'missing' };
    }
    const content = exists ? fs.readFileSync(target.file, 'utf8') : '';
    try {
      const merged = target.client === 'codex'
        ? mergeTomlConfig(content, server, Boolean(options.uninstall))
        : mergeJsonConfig(content, server, Boolean(options.uninstall));
      if (merged.action === 'unchanged') {
        return { client: target.client, file: target.file, action: merged.action };
      }
      const backup = writeWithBackup(
        target.file,
        merged.content,
        stamp,
        Boolean(options.dryRun),
      );
      return {
        client: target.client,
        file: target.file,
        action: merged.action,
        ...(backup ? { backup } : {}),
      };
    } catch (error) {
      return {
        client: target.client,
        file: target.file,
        action: 'error',
        error: (error as Error).message,
      };
    }
  });
}
