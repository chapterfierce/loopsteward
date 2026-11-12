import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findPackageRoot } from './package-root.js';

export interface SkillInstallOptions {
  sourcePath?: string;
  destinationPath?: string;
  packageRoot?: string;
  now?: Date;
}

export interface SkillInstallResult {
  source: string;
  target: string;
  action: 'installed' | 'updated' | 'unchanged';
  sha256: string;
  backup?: string;
  nestedBackup?: string;
}

export const SKILL_AGENTS = [
  'codex',
  'claude',
  'qoder',
  'workbuddy',
  'hermes',
  'antigravity',
] as const;

export type SkillAgent = (typeof SKILL_AGENTS)[number];

export interface SkillAgentTargetOptions {
  homeDir?: string;
  localAppData?: string;
}

export interface SkillAgentTarget {
  agent: SkillAgent;
  root: string;
  target: string;
}

export interface SkillAgentInstallOptions extends SkillAgentTargetOptions {
  agents?: SkillAgent[];
  sourcePath?: string;
  packageRoot?: string;
  now?: Date;
}

export interface SkillAgentInstallResult extends SkillInstallResult {
  agent: SkillAgent;
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

function fileHash(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase();
}

function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').toUpperCase();
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

export function renderOpenLoopsSkill(source: string, packageRoot: string): string {
  const root = packageRoot;
  if (!isWindowsAbsolutePath(root)) return source;
  const scriptPath = path.win32.join(root, 'scripts', 'open-loops.ps1');
  const refreshScriptPath = path.win32.join(root, 'scripts', 'refresh-open-loops.ps1');
  return source
    .replace(/[A-Za-z]:[\\/][^"\r\n]*?[\\/]scripts[\\/]open-loops\.ps1/g, scriptPath)
    .replace(/[A-Za-z]:[\\/][^"\r\n]*?[\\/]scripts[\\/]refresh-open-loops\.ps1/g, refreshScriptPath);
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

function moveNestedSkill(target: string, stamp: string): string | undefined {
  const nested = path.join(path.dirname(target), 'open-loops', 'SKILL.md');
  if (!fs.existsSync(nested)) return undefined;
  const backup = uniqueBackupPath(nested, `bak-nested-${stamp}`);
  fs.renameSync(nested, backup);
  return backup;
}

export function installOpenLoopsSkill(options: SkillInstallOptions = {}): SkillInstallResult {
  const source = path.resolve(
    options.sourcePath ?? path.join(findPackageRoot(), 'skills', 'open-loops', 'SKILL.md'),
  );
  const target = path.resolve(
    options.destinationPath
      ?? path.join(os.homedir(), '.codex', 'skills', 'open-loops', 'SKILL.md'),
  );
  const packageRoot = path.resolve(options.packageRoot ?? findPackageRoot());

  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
    throw new Error(`skill source not found: ${source}`);
  }

  const rendered = renderOpenLoopsSkill(fs.readFileSync(source, 'utf8'), packageRoot);
  const sourceHash = contentHash(rendered);
  const targetExists = fs.existsSync(target);
  if (targetExists && !fs.statSync(target).isFile()) {
    throw new Error(`skill target is not a file: ${target}`);
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const stamp = timestamp(options.now ?? new Date());
  const nestedBackup = moveNestedSkill(target, stamp);

  if (targetExists && fileHash(target) === sourceHash) {
    return {
      source,
      target,
      action: 'unchanged',
      sha256: sourceHash,
      ...(nestedBackup ? { nestedBackup } : {}),
    };
  }

  let backup: string | undefined;
  if (targetExists) {
    backup = uniqueBackupPath(target, `bak-${stamp}`);
    fs.copyFileSync(target, backup);
  }

  fs.writeFileSync(target, rendered, 'utf8');
  const installedHash = fileHash(target);
  if (installedHash !== sourceHash) {
    throw new Error(`skill hash mismatch after install: expected ${sourceHash}, got ${installedHash}`);
  }

  return {
    source,
    target,
    action: targetExists ? 'updated' : 'installed',
    sha256: installedHash,
    ...(backup ? { backup } : {}),
    ...(nestedBackup ? { nestedBackup } : {}),
  };
}

export function skillAgentTargets(options: SkillAgentTargetOptions = {}): SkillAgentTarget[] {
  const home = options.homeDir ?? os.homedir();
  const localAppData = options.localAppData
    || process.env.LOCALAPPDATA
    || path.join(home, 'AppData', 'Local');
  const roots: Array<{ agent: SkillAgent; root: string; skillDir: string }> = [
    { agent: 'codex', root: path.join(home, '.codex'), skillDir: path.join(home, '.codex', 'skills') },
    { agent: 'claude', root: path.join(home, '.claude'), skillDir: path.join(home, '.claude', 'skills') },
    { agent: 'qoder', root: path.join(home, '.qoder'), skillDir: path.join(home, '.qoder', 'skills') },
    { agent: 'workbuddy', root: path.join(home, '.workbuddy'), skillDir: path.join(home, '.workbuddy', 'skills') },
    { agent: 'hermes', root: path.join(localAppData, 'hermes'), skillDir: path.join(localAppData, 'hermes', 'skills') },
    {
      agent: 'antigravity',
      root: path.join(home, '.gemini', 'config'),
      skillDir: path.join(home, '.gemini', 'config', 'skills'),
    },
  ];
  return roots.map(({ agent, root, skillDir }) => ({
    agent,
    root,
    target: path.join(skillDir, 'open-loops', 'SKILL.md'),
  }));
}

export function installOpenLoopsSkillForAgents(
  options: SkillAgentInstallOptions = {},
): SkillAgentInstallResult[] {
  const requested = options.agents;
  if (requested && requested.length === 0) {
    throw new Error('no skill agents selected');
  }
  const targets = skillAgentTargets(options);
  const selected = requested
    ? targets.filter((item) => requested.includes(item.agent))
    : targets.filter((item) => fs.existsSync(item.root));
  const missing = requested?.filter(
    (agent) => !targets.some((item) => item.agent === agent),
  ) ?? [];
  if (missing.length > 0) {
    throw new Error(`unknown skill agent: ${missing.join(', ')}`);
  }
  if (selected.length === 0) {
    throw new Error(`no supported skill agent found under ${options.homeDir ?? os.homedir()}`);
  }
  return selected.map((item) => ({
    agent: item.agent,
    ...installOpenLoopsSkill({
      sourcePath: options.sourcePath,
      destinationPath: item.target,
      packageRoot: options.packageRoot,
      now: options.now,
    }),
  }));
}
