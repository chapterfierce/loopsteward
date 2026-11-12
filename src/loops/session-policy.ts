import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findPackageRoot } from './package-root.js';

export const POLICY_BEGIN = '<!-- open-loops:begin · managed by loopsteward -->';
export const POLICY_END = '<!-- open-loops:end -->';
export const POLICY_VERSION = 'v2';

export type PolicyAgent = 'codex' | 'claude' | 'zcode' | 'dsh' | 'antigravity' | 'hermes';

export interface PolicyTargetOptions {
  homeDir?: string;
  localAppData?: string;
}

export interface PolicyTarget {
  agent: PolicyAgent;
  root: string;
  file: string;
}

export interface SessionPolicyInstallOptions extends PolicyTargetOptions {
  agents?: PolicyAgent[];
  scriptPath?: string;
  now?: Date;
  dryRun?: boolean;
  uninstall?: boolean;
}

export interface SessionPolicyResult {
  agent: PolicyAgent;
  file: string;
  action: 'installed' | 'updated' | 'unchanged' | 'removed' | 'missing';
  backup?: string;
}

export interface SessionPolicyInspection {
  agent: PolicyAgent;
  file: string;
  status: 'ok' | 'warn';
  detail: string;
}

export function policyTargets(options: PolicyTargetOptions = {}): PolicyTarget[] {
  const home = options.homeDir ?? os.homedir();
  const localAppData = options.localAppData
    ?? (options.homeDir ? path.join(home, 'AppData', 'Local') : process.env.LOCALAPPDATA)
    ?? path.join(home, 'AppData', 'Local');
  return [
    {
      agent: 'codex',
      root: path.join(home, '.codex'),
      file: path.join(home, '.codex', 'AGENTS.md'),
    },
    {
      agent: 'claude',
      root: path.join(home, '.claude'),
      file: path.join(home, '.claude', 'CLAUDE.md'),
    },
    {
      agent: 'zcode',
      root: path.join(home, '.zcode'),
      file: path.join(home, '.zcode', 'AGENTS.md'),
    },
    {
      agent: 'dsh',
      root: path.join(home, '.dsh'),
      file: path.join(home, '.dsh', 'AGENTS.md'),
    },
    {
      agent: 'antigravity',
      root: path.join(home, '.gemini', 'config'),
      file: path.join(home, '.gemini', 'config', 'GEMINI.md'),
    },
    {
      agent: 'hermes',
      root: path.join(localAppData, 'hermes'),
      file: path.join(localAppData, 'hermes', 'SOUL.md'),
    },
  ];
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

export function buildPolicyBlock(scriptPath: string, eol = '\n'): string {
  const commandPath = scriptPath.replace(/"/g, '\\"');
  return [
    POLICY_BEGIN,
    `<!-- open-loops-policy:${POLICY_VERSION} -->`,
    '# Open Loops at session start',
    '',
    'At the start of a work session, before the first substantive reply, run this once:',
    '',
    `node "${commandPath}" digest --skill`,
    '',
    'Print the command output verbatim as an opening prelude, then answer the user\'s actual request in the same turn.',
    'The digest is a reminder, not the final answer: never stop after printing it, and never replace the requested work with the digest.',
    'If the user asks a one-off question unrelated to ongoing work, skip the digest. Do not run it twice in the same session.',
    POLICY_END,
  ].join(eol);
}

function findBlock(content: string): { start: number; end: number } | null {
  const start = content.indexOf('<!-- open-loops:begin');
  if (start < 0) return null;
  const end = content.indexOf(POLICY_END, start);
  if (end < 0) return null;
  return { start, end: end + POLICY_END.length };
}

export function upsertPolicyBlock(
  content: string,
  block: string,
): { content: string; action: 'installed' | 'updated' | 'unchanged' } {
  const existing = findBlock(content);
  if (existing) {
    const next = content.slice(0, existing.start) + block + content.slice(existing.end);
    return { content: next, action: next === content ? 'unchanged' : 'updated' };
  }
  if (!content) return { content: block + detectEol(block), action: 'installed' };
  if (content.endsWith(detectEol(content) + detectEol(content))) {
    return { content: content + block + detectEol(content), action: 'installed' };
  }
  if (content.endsWith(detectEol(content))) {
    return { content: content + detectEol(content) + block + detectEol(content), action: 'installed' };
  }
  const eol = detectEol(content);
  return { content: content + eol + eol + block + eol, action: 'installed' };
}

export function removePolicyBlock(content: string): { content: string; action: 'removed' | 'unchanged' } {
  const existing = findBlock(content);
  if (!existing) return { content, action: 'unchanged' };
  let before = content.slice(0, existing.start);
  let after = content.slice(existing.end);
  const eol = detectEol(content);
  if (before.endsWith(eol)) before = before.slice(0, -eol.length);
  if (after.startsWith(eol)) after = after.slice(eol.length);
  return { content: before + after, action: 'removed' };
}

export function installSessionPolicy(
  options: SessionPolicyInstallOptions = {},
): SessionPolicyResult[] {
  const scriptPath = path.resolve(
    options.scriptPath ?? path.join(findPackageRoot(), 'scripts', 'open-loops.mjs'),
  );
  if (!options.uninstall && !fs.existsSync(scriptPath)) {
    throw new Error(`open-loops script not found: ${scriptPath}`);
  }
  const targets = policyTargets(options);
  const requested = options.agents;
  if (requested && requested.length === 0) throw new Error('no policy agents selected');
  const unknown = requested?.filter((agent) => !targets.some((item) => item.agent === agent)) ?? [];
  if (unknown.length > 0) throw new Error(`unknown policy agent: ${unknown.join(', ')}`);

  const selected = requested
    ? targets.filter((item) => requested.includes(item.agent))
    : targets.filter((item) => fs.existsSync(item.root) || fs.existsSync(item.file));
  if (requested) {
    const unavailable = selected.filter(
      (item) => !fs.existsSync(item.root) && !fs.existsSync(item.file),
    );
    if (unavailable.length > 0) {
      throw new Error(
        `agent instruction directory not found: ${unavailable.map((item) => `${item.agent} (${item.root})`).join(', ')}; start the agent once, then retry`,
      );
    }
  }
  if (selected.length === 0) {
    throw new Error(`no supported agent instruction file found under ${options.homeDir ?? os.homedir()}`);
  }

  const stamp = timestamp(options.now ?? new Date());
  return selected.map((target) => {
    const exists = fs.existsSync(target.file);
    if (!exists && options.uninstall) {
      return { agent: target.agent, file: target.file, action: 'missing' };
    }
    const content = exists ? fs.readFileSync(target.file, 'utf8') : '';
    const eol = detectEol(content);
    const next: { content: string; action: SessionPolicyResult['action'] } = options.uninstall
      ? removePolicyBlock(content)
      : upsertPolicyBlock(content, buildPolicyBlock(scriptPath, eol));
    const action = next.action;
    if (action === 'unchanged') {
      return { agent: target.agent, file: target.file, action };
    }
    if (options.dryRun) {
      return { agent: target.agent, file: target.file, action };
    }
    let backup: string | undefined;
    if (exists) {
      backup = uniqueBackupPath(target.file, `bak-${stamp}`);
      fs.copyFileSync(target.file, backup);
    }
    fs.mkdirSync(path.dirname(target.file), { recursive: true });
    fs.writeFileSync(target.file, next.content, 'utf8');
    return {
      agent: target.agent,
      file: target.file,
      action,
      ...(backup ? { backup } : {}),
    };
  });
}

export function inspectSessionPolicy(
  options: PolicyTargetOptions & { scriptPath?: string; agents?: PolicyAgent[] } = {},
): SessionPolicyInspection[] {
  const scriptPath = path.resolve(
    options.scriptPath ?? path.join(findPackageRoot(), 'scripts', 'open-loops.mjs'),
  );
  const targets = policyTargets(options).filter(
    (target) =>
      (options.agents === undefined || options.agents.includes(target.agent))
      && (fs.existsSync(target.root) || fs.existsSync(target.file)),
  );
  return targets.map((target) => {
    if (!fs.existsSync(target.file)) {
      return {
        agent: target.agent,
        file: target.file,
        status: 'warn',
        detail: `${target.agent}: 未安装`,
      };
    }
    const content = fs.readFileSync(target.file, 'utf8');
    const block = findBlock(content);
    if (!block) {
      return {
        agent: target.agent,
        file: target.file,
        status: 'warn',
        detail: `${target.agent}: 未安装`,
      };
    }
    const current = content.slice(block.start, block.end);
    if (!current.includes(scriptPath.replace(/"/g, '\\"'))) {
      return {
        agent: target.agent,
        file: target.file,
        status: 'warn',
        detail: `${target.agent}: 指向旧路径`,
      };
    }
    if (!current.includes(`<!-- open-loops-policy:${POLICY_VERSION} -->`)) {
      return {
        agent: target.agent,
        file: target.file,
        status: 'warn',
        detail: `${target.agent}: 规则过旧`,
      };
    }
    return {
      agent: target.agent,
      file: target.file,
      status: 'ok',
      detail: `${target.agent}: 已安装`,
    };
  });
}
