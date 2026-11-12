import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import {
  discoverRecentSessions,
  type DiscoverSessionsOptions,
} from './session-source.js';
import type { RecentSession, SessionAgent } from './types.js';

const SUPPORTED_AGENTS: SessionAgent[] = [
  'codex',
  'claude',
  'qoder-cn',
  'zcode',
  'workbuddy',
  'hermes',
  'dsh',
  'agy',
];

const COMPARABLE_AGENTS: SessionAgent[] = [
  'codex',
  'claude',
  'qoder-cn',
  'zcode',
  'workbuddy',
  'dsh',
  'agy',
];

const AGENT_ALIASES: Record<string, SessionAgent> = {
  codex: 'codex',
  claude: 'claude',
  'claude-desktop': 'claude',
  'qoder-cn': 'qoder-cn',
  qoder: 'qoder-cn',
  zcode: 'zcode',
  workbuddy: 'workbuddy',
  hermes: 'hermes',
  dsh: 'dsh',
  agy: 'agy',
  antigravity: 'agy',
};

export interface MagpieIndexSession {
  agent: string;
  sessionId: string;
  title: string;
  projectDir: string;
  lastActive: string;
  sourcePath?: string;
  policyExcluded?: boolean;
  policyReason?: string;
}

export interface CoverageAgentRow {
  agent: string;
  magpieSessions: number;
  localSessions: number;
  matched: number;
  missingLocal: number;
  localOnly: number;
  comparable: boolean;
  ignoredByPolicy: number;
  note?: string;
}

export interface CoverageUnsupportedAgent {
  agent: string;
  sessions: number;
  lastActive: string;
  samples: Array<{
    sessionId: string;
    title: string;
    projectDir: string;
  }>;
}

export interface CoverageResult {
  generatedAt: string;
  windowDays: number;
  magpieIndexPath: string;
  magpieEntries: number;
  magpieSessions: number;
  localSessions: number;
  agents: CoverageAgentRow[];
  missingLocally: MagpieIndexSession[];
  unsupported: CoverageUnsupportedAgent[];
  errors: string[];
}

export interface CoverageOptions {
  days?: number;
  now?: Date;
  maxSessions?: number;
  home?: string;
  magpieCachePath?: string;
  hermesDbPath?: string;
  zcodeDbPath?: string;
  dshRoot?: string;
  discover?: (options: DiscoverSessionsOptions) => RecentSession[];
}

function markZcodeSideChats(
  entries: MagpieIndexSession[],
  dbPath: string,
): void {
  if (!fs.existsSync(dbPath)) return;
  const req = createRequire(import.meta.url);
  const { DatabaseSync } = req('node:sqlite') as { DatabaseSync: new (file: string, options?: any) => any };
  let db: any;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return;
  }
  try {
    const stmt = db.prepare('SELECT parent_id, time_archived FROM session WHERE id = ?');
    for (const entry of entries) {
      if (entry.agent !== 'zcode' || entry.policyExcluded) continue;
      const row = stmt.get(entry.sessionId);
      if (row && (row.parent_id || row.time_archived)) {
        entry.policyExcluded = true;
        entry.policyReason = 'ZCode side chat';
      }
    }
  } catch {
    // Coverage is diagnostic; a schema mismatch should not hide the rest of the report.
  } finally {
    db.close();
  }
}

function markWorkbuddyErrorShells(entries: MagpieIndexSession[]): void {
  for (const entry of entries) {
    if (entry.agent !== 'workbuddy' || entry.policyExcluded || !entry.sourcePath) continue;
    if (!fs.existsSync(entry.sourcePath)) continue;
    let usable = 0;
    try {
      for (const line of fs.readFileSync(entry.sourcePath, 'utf8').split(/\r?\n/)) {
        if (!line) continue;
        let record: any;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        if (record.type !== 'message') continue;
        if (record.providerData?.skipRun === true) continue;
        if (record.role !== 'user' && record.role !== 'assistant') continue;
        const text = Array.isArray(record.content)
          ? record.content
            .filter((part: any) => part && typeof part.text === 'string')
            .map((part: any) => part.text)
            .join(' ')
          : '';
        if (text.trim()) usable += 1;
        if (usable >= 2) break;
      }
    } catch {
      continue;
    }
    if (usable < 2) {
      entry.policyExcluded = true;
      entry.policyReason = 'WorkBuddy provider error';
    }
  }
}

function markAgyIncompleteSessions(entries: MagpieIndexSession[]): void {
  for (const entry of entries) {
    if (entry.agent !== 'agy' || entry.policyExcluded || !entry.sourcePath) continue;
    if (!fs.existsSync(entry.sourcePath)) continue;
    let usable = 0;
    try {
      for (const line of fs.readFileSync(entry.sourcePath, 'utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        let record: any;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        if (record.type !== 'USER_INPUT' && record.type !== 'PLANNER_RESPONSE') continue;
        if (typeof record.content === 'string' && record.content.trim()) {
          usable += 1;
        }
      }
    } catch {
      continue;
    }
    if (usable < 2) {
      entry.policyExcluded = true;
      entry.policyReason = 'Antigravity incomplete session';
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeAgent(value: unknown): string {
  const agent = String(value ?? '').toLowerCase();
  return AGENT_ALIASES[agent] ?? agent;
}

function sessionKey(agent: string, sessionId: string): string {
  return `${agent}:${sessionId}`;
}

function fallbackSessionId(key: string, record: Record<string, unknown>): string {
  const id = typeof record['id'] === 'string' ? record['id'] : '';
  if (id) return id;
  if (String(record['agent'] ?? '').toLowerCase() === 'agy') {
    const brain = key.replace(/\\/g, '/').match(/\/antigravity-cli\/brain\/([^/]+)\//i);
    if (brain) return brain[1];
  }
  const hash = key.lastIndexOf('#');
  if (hash >= 0 && hash < key.length - 1) return key.slice(hash + 1);
  return path.basename(key).replace(/\.jsonl$/i, '');
}

export function readMagpieSessionIndex(
  indexPath: string,
  cutoffMs: number,
): { entries: MagpieIndexSession[]; rawEntries: number; errors: string[] } {
  if (!fs.existsSync(indexPath)) {
    return {
      entries: [],
      rawEntries: 0,
      errors: [`会话索引不存在：${indexPath}`],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  } catch (error) {
    return {
      entries: [],
      rawEntries: 0,
      errors: [`会话索引无法解析：${(error as Error).message}`],
    };
  }

  const root = asRecord(parsed);
  const files = root ? asRecord(root['files']) : null;
  if (!root || !files) {
    return {
      entries: [],
      rawEntries: 0,
      errors: [`会话索引格式不正确：${indexPath}`],
    };
  }

  const bySession = new Map<string, MagpieIndexSession>();
  let rawEntries = 0;
  for (const [key, value] of Object.entries(files)) {
    const record = asRecord(value);
    if (!record) continue;
    const lastActive = String(record['last'] ?? record['start'] ?? '');
    const lastMs = Date.parse(lastActive);
    if (!Number.isFinite(lastMs) || lastMs < cutoffMs) continue;
    const agent = normalizeAgent(record['agent']);
    if (!agent) continue;
    const sessionId = fallbackSessionId(key, record);
    if (!sessionId) continue;
    rawEntries += 1;

    const codexIdentity = asRecord(record['codex_identity']);
    const codexRole = String(codexIdentity?.['role'] ?? '');
    const dshHead = asRecord(asRecord(record['dsh'])?.['head']);
    const dshChild = agent === 'dsh'
      && (String(dshHead?.['parentSession'] ?? '') !== ''
        || Number(dshHead?.['delegationDepth'] ?? 0) > 0);
    const dshSize = Number(record['size'] ?? 0);
    const dshEmpty = agent === 'dsh'
      && Number.isFinite(dshSize)
      && dshSize > 0
      && dshSize < 1024
      && String(record['title'] ?? '').trim() === ''
      && String(record['named'] ?? '').trim() === '';
    const title = String(record['title'] ?? '');
    const zcodeSideChat = agent === 'zcode'
      && (sessionId.startsWith('sess_subagent_') || title === 'Selection side chat');
    const entry: MagpieIndexSession = {
      agent,
      sessionId,
      title,
      projectDir: String(record['cwd'] ?? ''),
      lastActive,
      ...((agent === 'workbuddy' || agent === 'agy') && path.isAbsolute(key)
        ? { sourcePath: key }
        : {}),
      ...(codexRole === 'subagent' || zcodeSideChat || dshChild || dshEmpty
        ? {
          policyExcluded: true,
          policyReason: codexRole === 'subagent'
            ? 'Codex subagent'
            : zcodeSideChat
              ? 'ZCode side chat'
              : dshChild
                ? 'DSH subagent'
                : 'DSH empty session',
        }
        : {}),
    };
    const mapKey = sessionKey(agent, sessionId);
    const existing = bySession.get(mapKey);
    if (!existing || entry.lastActive > existing.lastActive) {
      bySession.set(mapKey, existing ? {
        ...entry,
        title: entry.title || existing.title,
        projectDir: entry.projectDir || existing.projectDir,
        ...(existing.policyExcluded ? {
          policyExcluded: true,
          policyReason: existing.policyReason,
        } : {}),
      } : entry);
    }
  }

  return {
    entries: [...bySession.values()],
    rawEntries,
    errors: [],
  };
}

function buildAgentRows(
  entries: MagpieIndexSession[],
  local: RecentSession[],
): CoverageAgentRow[] {
  const localKeys = new Set(local.map((session) => sessionKey(session.agent, session.sessionId)));
  const localByAgent = new Map<string, number>();
  for (const session of local) {
    localByAgent.set(session.agent, (localByAgent.get(session.agent) ?? 0) + 1);
  }
  const magpieByAgent = new Map<string, MagpieIndexSession[]>();
  for (const entry of entries) {
    const bucket = magpieByAgent.get(entry.agent) ?? [];
    bucket.push(entry);
    magpieByAgent.set(entry.agent, bucket);
  }

  const agents = new Set<string>([
    ...COMPARABLE_AGENTS,
    ...magpieByAgent.keys(),
    ...localByAgent.keys(),
  ]);

  const rows: CoverageAgentRow[] = [];
  for (const agent of [...agents].sort()) {
    const magpie = magpieByAgent.get(agent) ?? [];
    const localCount = localByAgent.get(agent) ?? 0;
    const matched = magpie.filter((entry) => localKeys.has(sessionKey(agent, entry.sessionId))).length;
    const comparable = COMPARABLE_AGENTS.includes(agent as SessionAgent);
    const policyExcluded = magpie.filter((entry) => entry.policyExcluded).length;
    const ignoredByPolicy = comparable
      ? policyExcluded
      : agent === 'hermes'
        ? Math.max(0, magpie.length - matched)
        : 0;
    rows.push({
      agent,
      magpieSessions: magpie.length,
      localSessions: localCount,
      matched,
      missingLocal: comparable ? Math.max(0, magpie.length - matched - policyExcluded) : 0,
      localOnly: comparable ? Math.max(0, localCount - matched) : 0,
      comparable,
      ignoredByPolicy,
      ...(agent === 'hermes'
        ? { note: '本地只取 Hermes 顶层用户会话；会话索引还包含 cron/subagent' }
        : {}),
    });
  }
  return rows;
}

export function buildCoverageReport(options: CoverageOptions = {}): CoverageResult {
  const now = options.now ?? new Date();
  const days = options.days ?? 7;
  const maxSessions = options.maxSessions ?? 500;
  const home = options.home ?? os.homedir();
  const cutoffMs = now.getTime() - days * 24 * 60 * 60 * 1000;
  const indexPath = options.magpieCachePath
    ?? path.join(home, '.cache', 'magpie', 'sessions.json');
  const index = readMagpieSessionIndex(indexPath, cutoffMs);
  markZcodeSideChats(
    index.entries,
    options.zcodeDbPath ?? path.join(home, '.zcode', 'cli', 'db', 'db.sqlite'),
  );
  markWorkbuddyErrorShells(index.entries);
  markAgyIncompleteSessions(index.entries);
  const discover = options.discover ?? discoverRecentSessions;
  const local = discover({
    home,
    days,
    settleMinutes: 0,
    maxSessions,
    now,
    hermesDbPath: options.hermesDbPath,
    zcodeDbPath: options.zcodeDbPath,
    dshRoot: options.dshRoot,
  });

  const agents = buildAgentRows(index.entries, local);
  const localKeys = new Set(local.map((session) => sessionKey(session.agent, session.sessionId)));
  const missingLocally = index.entries
    .filter((entry) => COMPARABLE_AGENTS.includes(entry.agent as SessionAgent))
    .filter((entry) => !entry.policyExcluded)
    .filter((entry) => !localKeys.has(sessionKey(entry.agent, entry.sessionId)))
    .sort((left, right) => right.lastActive.localeCompare(left.lastActive));

  const unsupportedMap = new Map<string, MagpieIndexSession[]>();
  for (const entry of index.entries) {
    if (SUPPORTED_AGENTS.includes(entry.agent as SessionAgent)) continue;
    const bucket = unsupportedMap.get(entry.agent) ?? [];
    bucket.push(entry);
    unsupportedMap.set(entry.agent, bucket);
  }
  const unsupported: CoverageUnsupportedAgent[] = [...unsupportedMap.entries()]
    .map(([agent, sessions]) => {
      const ordered = [...sessions].sort((left, right) => right.lastActive.localeCompare(left.lastActive));
      return {
        agent,
        sessions: ordered.length,
        lastActive: ordered[0]?.lastActive ?? '',
        samples: ordered.slice(0, 3).map((entry) => ({
          sessionId: entry.sessionId,
          title: entry.title,
          projectDir: entry.projectDir,
        })),
      };
    })
    .sort((left, right) => right.sessions - left.sessions || right.lastActive.localeCompare(left.lastActive));

  return {
    generatedAt: now.toISOString(),
    windowDays: days,
    magpieIndexPath: indexPath,
    magpieEntries: index.rawEntries,
    magpieSessions: index.entries.length,
    localSessions: local.length,
    agents,
    missingLocally,
    unsupported,
    errors: index.errors,
  };
}

export function formatCoverageReport(result: CoverageResult): string {
  const lines = [
    `# 会话覆盖 · 最近 ${result.windowDays} 天`,
    '',
    `会话索引 ${result.magpieEntries} 条记录 / ${result.magpieSessions} 个会话；本地读到 ${result.localSessions} 个。`,
  ];

  if (result.agents.length > 0) {
    lines.push('', '## 已支持 Agent');
    for (const row of result.agents) {
      if (!row.comparable && row.agent !== 'hermes') continue;
      const policy = row.ignoredByPolicy > 0 ? ` / 策略过滤 ${row.ignoredByPolicy}` : '';
      const suffix = row.comparable
        ? `漏读 ${row.missingLocal} / 本地独有 ${row.localOnly}${policy}`
        : `策略过滤 ${row.ignoredByPolicy}`;
      lines.push(
        `- **${row.agent}** · 索引 ${row.magpieSessions} / 本地 ${row.localSessions} / 匹配 ${row.matched} · ${suffix}`,
      );
      if (row.note) lines.push(`  ${row.note}`);
    }
  }

  if (result.missingLocally.length > 0) {
    lines.push('', `## 已支持但本地漏读（${result.missingLocally.length}）`);
    for (const entry of result.missingLocally.slice(0, 20)) {
      const project = entry.projectDir ? ` · ${entry.projectDir}` : '';
      lines.push(`- **${entry.agent}** · ${entry.title || entry.sessionId}${project}`);
    }
    if (result.missingLocally.length > 20) {
      lines.push(`- 其余 ${result.missingLocally.length - 20} 条见 --json`);
    }
  }

  if (result.unsupported.length > 0) {
    lines.push('', '## 尚未接入的 Agent');
    for (const item of result.unsupported) {
      lines.push(
        `- **${item.agent}** · ${item.sessions} 个会话 · 最近 ${item.lastActive.slice(0, 16).replace('T', ' ')}`,
      );
      for (const sample of item.samples) {
        lines.push(`  ${sample.title || sample.sessionId}${sample.projectDir ? ` · ${sample.projectDir}` : ''}`);
      }
    }
  }

  if (result.errors.length > 0) {
    lines.push('', '## 错误');
    for (const error of result.errors) lines.push(`- ${error}`);
  }

  return lines.join('\n');
}
