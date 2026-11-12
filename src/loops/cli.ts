#!/usr/bin/env node

import { LoopStore } from './loop-store.js';
import { ingestRecentSessions } from './ingest.js';
import { reconcileRecentSessions } from './reconcile.js';
import { discoverRecentSessions } from './session-source.js';
import { buildDigest, formatDigest, formatSkillDigest } from './digest.js';
import { buildLoopStats, formatLoopStats } from './stats.js';
import {
  buildLoopAudit,
  downgradeWeakEvidence,
  dropSelfGeneratedLoops,
  formatLoopAudit,
} from './audit.js';
import { buildProjectOverview, formatProjectOverview } from './projects.js';
import { buildLoopDetail, formatLoopDetail } from './detail.js';
import { buildClosingReview, formatClosingReview } from './closing.js';
import {
  isNoiseSuppressed,
  recordLoopFeedback,
  recordLoopFeedbackBatch,
} from './feedback.js';
import { loopRef } from './loop-ref.js';
import { backupLoopDatabase } from './backup.js';
import { restoreLoopDatabase } from './restore.js';
import {
  installOpenLoopsSkill,
  installOpenLoopsSkillForAgents,
  type SkillAgent,
} from './skill-install.js';
import {
  installSessionPolicy,
  type PolicyAgent,
} from './session-policy.js';
import { installMcpConfigs, type McpClient } from './mcp-install.js';
import { runRedact } from './redact-cli.js';
import { formatSetup, runSetup } from './setup.js';
import { buildCalibration, formatCalibration } from './calibrate.js';
import { buildCoverageReport, formatCoverageReport } from './coverage.js';
import { buildLoopDoctor, formatLoopDoctor } from './doctor.js';
import {
  buildPresentationRepairReport,
  formatPresentationRepairReport,
} from './presentations.js';
import { resolveDefaultDbPath } from './data-path.js';
import type { LoopRecord, LoopStatus, ReconcileSummary } from './types.js';

const STATUSES: LoopStatus[] = ['open', 'pending', 'snoozed', 'resolved', 'dropped'];

interface ParsedArgs {
  command: string;
  flags: Map<string, string | true>;
}

function usage(): string {
  return [
    'LoopSteward (守环) — Open Loops tracker for parallel AI sessions',
    '',
    'Usage:',
    '  loopsteward ingest [--days 7] [--settle-minutes 30] [--limit 120] [--concurrency 4] [--db <path>] [--json]',
    '  loopsteward sessions [--days 7] [--settle-minutes 30] [--limit 120] [--json]',
    '  loopsteward list [--status open|pending|all] [--project <dir>] [--limit 100] [--json]',
    '  loopsteward pending [--limit 10] [--project <dir>] [--json]',
    '  loopsteward digest [--review] [--limit 15] [--hot-days 3] [--active-days 7] [--daily-limit 3] [--revisit-days 3] [--recap-cooldown-minutes 30] [--project <dir>] [--no-project-focus] [--force] [--no-mark] [--skill|--json]',
    '  loopsteward reconcile [--days 7] [--limit 120] [--min-confidence 0.9] [--concurrency 4] [--cache-days 30] [--refresh] [--no-second-look] [--apply] [--json]',
    '  loopsteward stats [--days 30] [--stale-days 14] [--json]',
    '  loopsteward doctor [--db <path>] [--all] [--json]',
    '  loopsteward presentations [--db <path>] [--apply] [--json]',
    '  loopsteward projects [--days 7] [--limit 500] [--json]',
    '  loopsteward coverage [--days 7] [--limit 500] [--magpie-cache <path>] [--json]',
    '  loopsteward audit [--stale-days 14] [--limit 20] [--apply-weak] [--apply-self-generated] [--json]',
    '  loopsteward show --id <loop_id> | --ref <code> | --match <text> | --index <n> [--project <dir>] [--limit 12] [--json]',
    '  loopsteward update --id <loop_id> | --ref <code> | --refs <code,code> | --match <text> | --index <n> | --shown [--project <dir>] [--status open|pending|snoozed|resolved|dropped] [--note <text>] [--snooze-until <iso> | --snooze-hours <n>]',
    '  loopsteward feedback --id <loop_id> | --ref <code> | --refs <code,code> | --match <text> | --index <n> [--project <dir>] --verdict forgotten|noise [--note <text>] [--json]',
    '  loopsteward backup [--db <path>] [--out <path>] [--keep 30] [--json]',
    '  loopsteward redact [--db <path>] [--apply] [--keep <n>] [--json]',
    '  loopsteward restore --backup <path> [--db <path>] [--dry-run] [--json]',
    '  loopsteward install-skill [--source <path>] [--target <path> | --agents codex,claude,qoder,workbuddy,hermes,antigravity | --all] [--json]',
    '  loopsteward install-policy [--agents codex,claude,zcode,dsh,antigravity,hermes] [--dry-run] [--uninstall] [--json]',
    '  loopsteward install-mcp [--agents codex,claude,cursor] [--project-dir <dir>] [--dry-run] [--uninstall] [--json]',
    '  loopsteward setup [--agents codex,claude,qoder,workbuddy,hermes,antigravity] [--schedule] [--ingest] [--import-db <path>] [--dry-run] [--json]',
    '  loopsteward calibrate [--limit 5] [--db <path>] [--json]',
    '  loopsteward closing [--limit 10] [--db <path>] [--json]',
  ].join('\n');
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv;
  const flags = new Map<string, string | true>();
  const valueFlags = new Set([
    '--days', '--settle-minutes', '--limit', '--db', '--model', '--status', '--project',
    '--id', '--ref', '--refs', '--match', '--index', '--note', '--snooze-until', '--snooze-hours', '--home', '--codex-root', '--claude-root',
    '--claude-desktop-root', '--qoder-db',
    '--zcode-db', '--workbuddy-root', '--hermes-db', '--dsh-root', '--magpie-cache',
    '--hot-days', '--active-days', '--max-projects', '--cooldown-hours', '--daily-limit',
    '--revisit-days',
    '--recap-cooldown-minutes',
    '--magpie-home',
    '--min-confidence', '--concurrency', '--cache-days', '--stale-days', '--verdict', '--out', '--keep', '--backup', '--source', '--target', '--import-db',
    '--agents',
    '--project-dir', '--codex-config', '--claude-config', '--cursor-config',
    '--server-path', '--node-command',
  ]);

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--json' || arg === '--skill' || arg === '--help' || arg === '-h' || arg === '--review' || arg === '--no-mark' || arg === '--force' || arg === '--apply' || arg === '--apply-weak' || arg === '--apply-self-generated' || arg === '--readonly-fallback' || arg === '--shown' || arg === '--all' || arg === '--refresh' || arg === '--no-second-look' || arg === '--dry-run' || arg === '--uninstall' || arg === '--schedule' || arg === '--ingest' || arg === '--no-project-focus') {
      flags.set(arg, true);
      continue;
    }
    if (!valueFlags.has(arg)) throw new Error(`unknown argument: ${arg}`);
    const value = rest[index + 1];
    if (!value) throw new Error(`${arg} needs a value`);
    flags.set(arg, value);
    index += 1;
  }

  return { command, flags };
}

function flagString(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

function flagNumber(flags: Map<string, string | true>, name: string): number | undefined {
  const value = flagString(flags, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number`);
  return parsed;
}

export function formatLoops(loops: LoopRecord[]): string {
  if (loops.length === 0) return '没有开放的循环。';
  const lines = [`# 开放循环 (${loops.length})`];
  const groups = new Map<string, LoopRecord[]>();
  for (const loop of loops) {
    const key = loop.projectName || loop.projectDir || 'unknown';
    const group = groups.get(key) ?? [];
    group.push(loop);
    groups.set(key, group);
  }
  for (const [project, group] of groups) {
    lines.push('', `## ${project}`);
    for (const loop of group) {
      lines.push(
        `- **${loop.title}** · ${loop.status} · ${Math.round(loop.confidence * 100)}% · [ref ${loopRef(loop.id)}]`,
        `  next: ${loop.nextAction}`,
        `  why: ${loop.why}`,
      );
    }
  }
  return lines.join('\n');
}

export function formatReconcile(summary: ReconcileSummary): string {
  if (summary.candidates.length === 0) {
    let base = summary.errors.length > 0
      ? `没有发现可关闭的循环；${summary.errors.length} 个会话核对失败。`
      : '没有发现已完成或已放弃的循环。';
    if (summary.sessionsCached > 0) base = `${base}（${summary.sessionsCached} 个会话命中缓存）`;
    if (summary.cachePruned > 0) base = `${base} 清理了 ${summary.cachePruned} 条过期核对缓存。`;
    return base;
  }
  const lines = [`# 可关闭的循环 · ${summary.candidates.length} 条`];
  for (const candidate of summary.candidates) {
    lines.push(
      `- **${candidate.title}** · ${Math.round(candidate.confidence * 100)}% · ref ${candidate.ref}`,
      `  project: ${candidate.projectName}`,
      `  evidence: ${candidate.reason}`,
      `  source: ${candidate.agent}/${candidate.sessionId}`,
    );
  }
  if (summary.applied.length > 0) {
    lines.push('', `已关闭 ${summary.applied.length} 条。`);
  } else {
    lines.push('', '未改动；确认无误后加 `--apply` 关闭。');
  }
  if (summary.sessionsCached > 0) {
    lines.push('', `命中缓存 ${summary.sessionsCached} 个会话；加 \`--refresh\` 可强制重查。`);
  }
  if (summary.cachePruned > 0) {
    lines.push('', `清理了 ${summary.cachePruned} 条过期核对缓存。`);
  }
  if (summary.errors.length > 0) {
    lines.push('', `核对失败 ${summary.errors.length} 个会话：`);
    for (const error of summary.errors) lines.push(`- ${error}`);
  }
  return lines.join('\n');
}

async function runIngest(flags: Map<string, string | true>): Promise<number> {
  const summary = await ingestRecentSessions({
    days: flagNumber(flags, '--days'),
    settleMinutes: flagNumber(flags, '--settle-minutes'),
    maxSessions: flagNumber(flags, '--limit'),
    concurrency: flagNumber(flags, '--concurrency'),
    dbPath: flagString(flags, '--db'),
    model: flagString(flags, '--model'),
    home: flagString(flags, '--home'),
    codexRoot: flagString(flags, '--codex-root'),
    claudeRoot: flagString(flags, '--claude-root'),
    claudeDesktopRoot: flagString(flags, '--claude-desktop-root'),
    qoderDbPath: flagString(flags, '--qoder-db'),
    zcodeDbPath: flagString(flags, '--zcode-db'),
    workbuddyRoot: flagString(flags, '--workbuddy-root'),
    hermesDbPath: flagString(flags, '--hermes-db'),
    dshRoot: flagString(flags, '--dsh-root'),
    magpieHome: flagString(flags, '--magpie-home'),
  });

  if (flags.has('--json')) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`Sessions: ${summary.sessionsSeen} seen, ${summary.sessionsProcessed} processed`);
    console.log(`Signals: ${summary.signalsSeen}`);
    console.log(`Loops: ${summary.loopsCreated} created, ${summary.loopsMerged} merged`);
    if (summary.errors.length > 0) {
      console.log(`Errors: ${summary.errors.length}`);
      for (const error of summary.errors) console.log(`- ${error}`);
    }
  }
  return summary.errors.length > 0 && summary.sessionsProcessed === 0 ? 1 : 0;
}

function runDigest(flags: Map<string, string | true>): number {
  const review = flags.has('--review');
  const focusProjectDir = flags.has('--no-project-focus')
    ? undefined
    : (flagString(flags, '--project') ?? process.cwd());
  const recapCooldownMinutes = flagNumber(flags, '--recap-cooldown-minutes');
  if (recapCooldownMinutes !== undefined && recapCooldownMinutes < 0) {
    throw new Error('--recap-cooldown-minutes must be zero or positive');
  }
  const result = buildDigest({
    mode: review ? 'review' : 'hot',
    dbPath: flagString(flags, '--db'),
    maxLoops: flagNumber(flags, '--limit'),
    maxProjects: flagNumber(flags, '--max-projects'),
    hotDays: flagNumber(flags, '--hot-days'),
    activeDays: flagNumber(flags, '--active-days'),
    cooldownHours: flagNumber(flags, '--cooldown-hours'),
    dailySurfaceLimit: flagNumber(flags, '--daily-limit'),
    revisitDays: flagNumber(flags, '--revisit-days'),
    recapCooldownMinutes,
    focusProjectDir,
    force: flags.has('--force'),
    markSurfaced: !flags.has('--no-mark'),
    readonlyRotation: flags.has('--readonly-fallback'),
  });
  const readonlyFallback = flags.has('--readonly-fallback')
    ? '只读会话：本次回访不记入每日预算。'
    : undefined;
  if (flags.has('--skill')) {
    const text = formatSkillDigest(result);
    console.log(readonlyFallback ? `${readonlyFallback}\n\n${text}` : text);
  } else if (flags.has('--json')) {
    console.log(JSON.stringify(
      readonlyFallback ? { ...result, readonlyFallback: true } : result,
      null,
      2,
    ));
  } else {
    const text = formatDigest(result);
    console.log(readonlyFallback ? `${readonlyFallback}\n\n${text}` : text);
  }
  return 0;
}

function runCalibrate(flags: Map<string, string | true>): number {
  const result = buildCalibration({
    dbPath: flagString(flags, '--db'),
    limit: flagNumber(flags, '--limit'),
  });
  if (flags.has('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatCalibration(result));
  }
  return 0;
}

function runClosing(flags: Map<string, string | true>): number {
  const store = new LoopStore(flagString(flags, '--db') ?? resolveDefaultDbPath());
  try {
    const review = buildClosingReview({
      store,
      limit: flagNumber(flags, '--limit'),
    });
    if (flags.has('--json')) {
      console.log(JSON.stringify(review, null, 2));
    } else {
      console.log(formatClosingReview(review));
    }
    return 0;
  } finally {
    store.close();
  }
}

async function runReconcile(flags: Map<string, string | true>): Promise<number> {
  const summary = await reconcileRecentSessions({
    days: flagNumber(flags, '--days'),
    maxSessions: flagNumber(flags, '--limit'),
    dbPath: flagString(flags, '--db'),
    model: flagString(flags, '--model'),
    home: flagString(flags, '--home'),
    codexRoot: flagString(flags, '--codex-root'),
    claudeRoot: flagString(flags, '--claude-root'),
    claudeDesktopRoot: flagString(flags, '--claude-desktop-root'),
    qoderDbPath: flagString(flags, '--qoder-db'),
    zcodeDbPath: flagString(flags, '--zcode-db'),
    workbuddyRoot: flagString(flags, '--workbuddy-root'),
    hermesDbPath: flagString(flags, '--hermes-db'),
    dshRoot: flagString(flags, '--dsh-root'),
    magpieHome: flagString(flags, '--magpie-home'),
    minConfidence: flagNumber(flags, '--min-confidence'),
    concurrency: flagNumber(flags, '--concurrency'),
    cacheRetentionDays: flagNumber(flags, '--cache-days'),
    refresh: flags.has('--refresh'),
    secondLook: flags.has('--no-second-look') ? false : undefined,
    apply: flags.has('--apply'),
  });
  if (flags.has('--json')) console.log(JSON.stringify(summary, null, 2));
  else console.log(formatReconcile(summary));
  return summary.errors.length > 0 && summary.sessionsChecked === 0 ? 1 : 0;
}

function runStats(flags: Map<string, string | true>): number {
  const stats = buildLoopStats({
    dbPath: flagString(flags, '--db'),
    windowDays: flagNumber(flags, '--days'),
    staleDays: flagNumber(flags, '--stale-days'),
  });
  if (flags.has('--json')) console.log(JSON.stringify(stats, null, 2));
  else console.log(formatLoopStats(stats));
  return 0;
}

function runDoctor(flags: Map<string, string | true>): number {
  const all = flags.has('--all');
  const report = buildLoopDoctor({
    dbPath: flagString(flags, '--db'),
    home: flagString(flags, '--home'),
    skillAgents: all ? undefined : ['hermes'],
    policyAgents: all ? undefined : ['hermes'],
  });
  if (flags.has('--json')) console.log(JSON.stringify(report, null, 2));
  else console.log(formatLoopDoctor(report));
  return report.ok ? 0 : 1;
}

function runPresentations(flags: Map<string, string | true>): number {
  const report = buildPresentationRepairReport({
    dbPath: flagString(flags, '--db'),
    apply: flags.has('--apply'),
  });
  if (flags.has('--json')) console.log(JSON.stringify(report, null, 2));
  else console.log(formatPresentationRepairReport(report));
  return 0;
}

function runProjects(flags: Map<string, string | true>): number {
  const projects = buildProjectOverview({
    dbPath: flagString(flags, '--db'),
    days: flagNumber(flags, '--days'),
    limit: flagNumber(flags, '--limit'),
  });
  if (flags.has('--json')) console.log(JSON.stringify(projects, null, 2));
  else console.log(formatProjectOverview(projects, new Date(), flagNumber(flags, '--days') ?? 7));
  return 0;
}

function runAudit(flags: Map<string, string | true>): number {
  const store = new LoopStore(flagString(flags, '--db') ?? resolveDefaultDbPath());
  try {
    const audit = buildLoopAudit({
      store,
      staleDays: flagNumber(flags, '--stale-days'),
    });
    const applied = flags.has('--apply-weak')
      ? downgradeWeakEvidence(store, audit)
      : [];
    const appliedSelfGenerated = flags.has('--apply-self-generated')
      ? dropSelfGeneratedLoops(store, audit)
      : [];
    if (flags.has('--json')) {
      const payload: Record<string, unknown> = { ...audit };
      if (flags.has('--apply-weak')) payload['appliedWeakEvidence'] = applied;
      if (flags.has('--apply-self-generated')) {
        payload['appliedSelfGenerated'] = appliedSelfGenerated;
      }
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(formatLoopAudit(audit, flagNumber(flags, '--limit') ?? 20));
      if (flags.has('--apply-weak')) {
        console.log(`\n已降级 ${applied.length} 条弱证据循环为 pending。`);
      }
      if (flags.has('--apply-self-generated')) {
        console.log(`\n已丢弃 ${appliedSelfGenerated.length} 条自摄入循环。`);
      }
    }
    return 0;
  } finally {
    store.close();
  }
}

function runSessions(flags: Map<string, string | true>): number {
  const sessions = discoverRecentSessions({
    days: flagNumber(flags, '--days'),
    settleMinutes: flagNumber(flags, '--settle-minutes'),
    maxSessions: flagNumber(flags, '--limit'),
    home: flagString(flags, '--home'),
    codexRoot: flagString(flags, '--codex-root'),
    claudeRoot: flagString(flags, '--claude-root'),
    claudeDesktopRoot: flagString(flags, '--claude-desktop-root'),
    qoderDbPath: flagString(flags, '--qoder-db'),
    zcodeDbPath: flagString(flags, '--zcode-db'),
    workbuddyRoot: flagString(flags, '--workbuddy-root'),
    hermesDbPath: flagString(flags, '--hermes-db'),
    dshRoot: flagString(flags, '--dsh-root'),
  });

  if (flags.has('--json')) {
    console.log(JSON.stringify(sessions, null, 2));
    return 0;
  }
  console.log(`Sessions: ${sessions.length}`);
  for (const session of sessions) {
    console.log(
      `- ${session.agent}/${session.sessionId} | ${session.lastActive} | ${session.projectDir} | ${session.title} | messages=${session.messages.length}`,
    );
  }
  return 0;
}

function runList(flags: Map<string, string | true>): number {
  const store = new LoopStore(flagString(flags, '--db') ?? resolveDefaultDbPath());
  try {
    const statusFlag = flagString(flags, '--status') ?? 'open';
    if (statusFlag !== 'all' && !STATUSES.includes(statusFlag as LoopStatus)) {
      throw new Error(`--status must be one of ${[...STATUSES, 'all'].join(', ')}`);
    }
    const loops = store.listLoops({
      status: statusFlag === 'all' ? undefined : statusFlag as LoopStatus,
      includeAll: statusFlag === 'all',
      projectDir: flagString(flags, '--project'),
      limit: flagNumber(flags, '--limit'),
    });
    if (flags.has('--json')) {
      console.log(JSON.stringify(
        loops.map((loop) => ({ ...loop, ref: loopRef(loop.id) })),
        null,
        2,
      ));
    } else console.log(formatLoops(loops));
    return 0;
  } finally {
    store.close();
  }
}

function runPending(flags: Map<string, string | true>): number {
  const store = new LoopStore(flagString(flags, '--db') ?? resolveDefaultDbPath());
  try {
    const limit = Math.max(1, Math.min(100, flagNumber(flags, '--limit') ?? 10));
    const pendingLoops = store.listLoops({
      status: 'pending',
      includeAll: true,
      projectDir: flagString(flags, '--project'),
      limit: 10_000,
    });
    const latestFeedback = new Map(
      store.getLatestFeedback().map((feedback) => [feedback.loopId, feedback]),
    );
    const loops = pendingLoops.filter(
      (loop) => !isNoiseSuppressed(loop, latestFeedback.get(loop.id)),
    ).sort((left, right) =>
      right.confidence - left.confidence
      || left.firstSeen.localeCompare(right.firstSeen)
    );
    const noiseSuppressed = pendingLoops.length - loops.length;
    const shown = loops.slice(0, limit).map((loop) => ({
      title: loop.title,
      confidence: loop.confidence,
      projectName: loop.projectName,
      ref: loopRef(loop.id),
    }));
    if (flags.has('--json')) {
      console.log(JSON.stringify({
        total: loops.length,
        shown: shown.length,
        noiseSuppressed,
        loops: shown,
      }, null, 2));
      return 0;
    }
    const lines = [`# 待确认 · ${loops.length} 条`];
    if (shown.length === 0) {
      lines.push('', '- 没有待确认项。');
    } else {
      for (const loop of shown) {
        lines.push(
          `- **${loop.title}** · ${Math.round(loop.confidence * 100)}% · ${loop.projectName} · [ref ${loop.ref}]`,
        );
      }
      if (loops.length > shown.length) {
        lines.push(
          '',
          `还有 ${loops.length - shown.length} 条没列出；处理完这 ${shown.length} 条再跑一次。`,
        );
      }
    }
    if (noiseSuppressed > 0) {
      lines.push('', `另有 ${noiseSuppressed} 条已标为噪音，有新证据才会重新出现。`);
    }
    console.log(lines.join('\n'));
    return 0;
  } finally {
    store.close();
  }
}

function runCoverage(flags: Map<string, string | true>): number {
  const result = buildCoverageReport({
    days: flagNumber(flags, '--days'),
    maxSessions: flagNumber(flags, '--limit'),
    home: flagString(flags, '--home'),
    magpieCachePath: flagString(flags, '--magpie-cache'),
    hermesDbPath: flagString(flags, '--hermes-db'),
    zcodeDbPath: flagString(flags, '--zcode-db'),
    dshRoot: flagString(flags, '--dsh-root'),
  });
  if (flags.has('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(formatCoverageReport(result));
  return result.errors.length > 0 ? 1 : 0;
}

function resolveTargetFromFlags(
  store: LoopStore,
  flags: Map<string, string | true>,
): { status: 'ok'; id: string } | { status: 'exit'; code: number } {
  const id = flagString(flags, '--id');
  const ref = flagString(flags, '--ref');
  const match = flagString(flags, '--match');
  const indexRaw = flagString(flags, '--index');
  const provided = [id, ref, match, indexRaw].filter((value) => value !== undefined).length;
  if (provided !== 1) {
    throw new Error('use exactly one of --id, --ref, --match, or --index');
  }

  if (indexRaw !== undefined) {
    const index = Number(indexRaw);
    if (!Number.isInteger(index) || index < 1) {
      throw new Error('--index must be a positive integer');
    }
    const resolved = store.resolvePresentationIndex(index);
    if (resolved.status !== 'found') {
      console.error(resolved.message);
      return { status: 'exit', code: 1 };
    }
    return { status: 'ok', id: resolved.loopId };
  }

  if (match) {
    const matches = store.findLoopsByText(match, {
      projectDir: flagString(flags, '--project'),
    });
    if (matches.length === 0) {
      console.error(`no active loop matches: ${match}`);
      return { status: 'exit', code: 1 };
    }
    if (matches.length > 1) {
      console.error(`ambiguous match: ${match}`);
      for (const candidate of matches) {
        console.error(`- ${candidate.id} | ${candidate.projectName} | ${candidate.status} | ${candidate.title}`);
      }
      return { status: 'exit', code: 2 };
    }
    return { status: 'ok', id: matches[0].id };
  }

  if (ref) {
    const matches = store.findLoopsByRef(ref);
    if (matches.length === 0) {
      console.error(`no loop matches ref: ${ref}`);
      return { status: 'exit', code: 1 };
    }
    if (matches.length > 1) {
      console.error(`ambiguous ref: ${ref}`);
      for (const candidate of matches) {
        console.error(`- ${candidate.id} | ${candidate.projectName} | ${candidate.status} | ${candidate.title}`);
      }
      return { status: 'exit', code: 2 };
    }
    return { status: 'ok', id: matches[0].id };
  }

  return { status: 'ok', id: id! };
}

function updateLoopsBatch(
  store: LoopStore,
  loopIds: string[],
  status: LoopStatus,
  note: string | undefined,
  snoozeUntil: string | undefined,
  json: boolean,
): number {
  const updated: LoopRecord[] = [];
  store.runInWriteTransaction(() => {
    for (const id of loopIds) {
      const loop = store.getLoop(id);
      if (!loop) throw new Error(`loop not found: ${id}`);
      const next = store.updateLoop(id, { status, note, snoozeUntil });
      if (!next) throw new Error(`loop not found: ${id}`);
      updated.push(next);
    }
  });
  if (updated.length === 0) {
    console.error('没有可更新的条目。');
    return 1;
  }
  if (json) {
    console.log(JSON.stringify(
      status === 'snoozed' ? { status, snoozeUntil, updated } : { status, updated },
      null,
      2,
    ));
    return 0;
  }

  const label = status === 'resolved'
    ? '已关闭'
    : status === 'dropped'
      ? '已丢弃'
      : status === 'snoozed'
        ? '已暂停回访'
        : status === 'open'
          ? '已重新打开'
          : '已标记待确认';
  console.log(`# ${label} · ${updated.length} 条`);
  console.log('');
  for (const loop of updated) {
    console.log(`- **${loop.title}** · ${loop.projectName}`);
  }
  console.log('');
  if (status === 'snoozed') {
    console.log(`暂停到 ${snoozeUntil}；不记作噪音，也不影响反馈统计。`);
  } else if (status === 'resolved') {
    console.log('已关闭；不会再出现在回访里。');
  } else if (status === 'dropped') {
    console.log('已丢弃；不会再出现在回访里。');
  } else if (status === 'open') {
    console.log('已重新打开；会重新进入回访候选。');
  } else {
    console.log('已标记为待确认；不会进入热区，但会保留在待确认清单。');
  }
  return 0;
}

function runUpdate(flags: Map<string, string | true>): number {
  const statusFlag = flagString(flags, '--status');
  if (statusFlag && !STATUSES.includes(statusFlag as LoopStatus)) {
    throw new Error(`--status must be one of ${STATUSES.join(', ')}`);
  }
  const snoozeUntilFlag = flagString(flags, '--snooze-until');
  const snoozeHours = flagNumber(flags, '--snooze-hours');
  if (snoozeUntilFlag && snoozeHours !== undefined) {
    throw new Error('use either --snooze-until or --snooze-hours, not both');
  }
  if (snoozeHours !== undefined && (!Number.isFinite(snoozeHours) || snoozeHours <= 0)) {
    throw new Error('--snooze-hours must be a positive number');
  }
  const computedSnoozeUntil = snoozeHours !== undefined
    ? new Date(Date.now() + snoozeHours * 60 * 60 * 1000).toISOString()
    : snoozeUntilFlag;

  const store = new LoopStore(flagString(flags, '--db') ?? resolveDefaultDbPath());
  try {
    const refsRaw = flagString(flags, '--refs');
    if (refsRaw !== undefined) {
      if (
        flags.has('--shown')
        || flagString(flags, '--id')
        || flagString(flags, '--ref')
        || flagString(flags, '--match')
        || flagString(flags, '--index')
      ) {
        throw new Error('--refs cannot be combined with --id, --ref, --match, --index, or --shown');
      }
      if (!statusFlag) {
        throw new Error('--refs requires --status');
      }
      if (statusFlag !== 'snoozed' && computedSnoozeUntil) {
        throw new Error('--snooze-until and --snooze-hours only apply to --status snoozed');
      }
      const refs = refsRaw.split(/[,\s]+/).filter((value) => value.length > 0);
      if (refs.length === 0) {
        throw new Error('--refs must contain at least one ref');
      }
      const loopIds: string[] = [];
      for (const ref of refs) {
        const matches = store.findLoopsByRef(ref);
        if (matches.length === 0) {
          console.error(`no loop matches ref: ${ref}`);
          return 1;
        }
        if (matches.length > 1) {
          console.error(`ambiguous ref: ${ref}`);
          for (const candidate of matches) {
            console.error(`- ${candidate.id} | ${candidate.projectName} | ${candidate.status} | ${candidate.title}`);
          }
          return 2;
        }
        loopIds.push(matches[0].id);
      }
      const snoozeUntil = statusFlag === 'snoozed'
        ? computedSnoozeUntil ?? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
        : undefined;
      return updateLoopsBatch(
        store,
        [...new Set(loopIds)],
        statusFlag as LoopStatus,
        flagString(flags, '--note'),
        snoozeUntil,
        flags.has('--json'),
      );
    }

    if (flags.has('--shown')) {
      if (flagString(flags, '--id') || flagString(flags, '--ref') || flagString(flags, '--match') || flagString(flags, '--index')) {
        throw new Error('--shown cannot be combined with --id, --ref, --match, or --index');
      }
      if (statusFlag !== 'snoozed') {
        throw new Error('--shown only supports --status snoozed');
      }
      const presentation = store.getLatestPresentation();
      if (!presentation) {
        console.error('没有可用的最近回访；请先运行 digest，或编号已超过 48 小时。');
        return 1;
      }
      const snoozeUntil = computedSnoozeUntil
        ?? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      return updateLoopsBatch(
        store,
        presentation.loopIds,
        'snoozed',
        flagString(flags, '--note'),
        snoozeUntil,
        flags.has('--json'),
      );
    }

    if (statusFlag === 'snoozed' && !computedSnoozeUntil) {
      throw new Error('--status snoozed requires --snooze-until or --snooze-hours');
    }

    const target = resolveTargetFromFlags(store, flags);
    if (target.status === 'exit') return target.code;

    const loop = store.updateLoop(target.id, {
      status: statusFlag as LoopStatus | undefined,
      note: flagString(flags, '--note'),
      snoozeUntil: computedSnoozeUntil,
    });
    if (!loop) {
      console.error(`loop not found: ${target.id}`);
      return 1;
    }
    console.log(JSON.stringify(loop, null, 2));
    return 0;
  } finally {
    store.close();
  }
}

function runShow(flags: Map<string, string | true>): number {
  const store = new LoopStore(flagString(flags, '--db') ?? resolveDefaultDbPath());
  try {
    const target = resolveTargetFromFlags(store, flags);
    if (target.status === 'exit') return target.code;

    const detail = buildLoopDetail(store, target.id, flagNumber(flags, '--limit') ?? 12);
    if (!detail) {
      console.error(`loop not found: ${target.id}`);
      return 1;
    }
    if (flags.has('--json')) console.log(JSON.stringify(detail, null, 2));
    else console.log(formatLoopDetail(detail));
    return 0;
  } finally {
    store.close();
  }
}

function runFeedback(flags: Map<string, string | true>): number {
  const id = flagString(flags, '--id');
  const ref = flagString(flags, '--ref');
  const match = flagString(flags, '--match');
  const indexRaw = flagString(flags, '--index');
  const refsRaw = flagString(flags, '--refs');
  const provided = [id, ref, match, indexRaw].filter((value) => value !== undefined).length;
  if (refsRaw === undefined && provided !== 1) {
    throw new Error('use exactly one of --id, --ref, --refs, --match, or --index');
  }
  if (refsRaw !== undefined && provided !== 0) {
    throw new Error('--refs cannot be combined with --id, --ref, --match, or --index');
  }
  const index = indexRaw === undefined ? undefined : Number(indexRaw);
  if (index !== undefined && (!Number.isInteger(index) || index < 1)) {
    throw new Error('--index must be a positive integer');
  }

  const verdict = flagString(flags, '--verdict');
  if (verdict !== 'forgotten' && verdict !== 'noise') {
    throw new Error('--verdict must be forgotten or noise');
  }

  if (refsRaw !== undefined) {
    const refs = refsRaw.split(/[,\s]+/).filter((value) => value.length > 0);
    if (refs.length === 0) {
      throw new Error('--refs must contain at least one ref');
    }
    const store = new LoopStore(flagString(flags, '--db') ?? resolveDefaultDbPath());
    try {
      const result = recordLoopFeedbackBatch(store, {
        refs,
        verdict,
        note: flagString(flags, '--note'),
      });
      if (result.status === 'not_found') {
        console.error(result.message);
        return 1;
      }
      if (result.status === 'ambiguous') {
        console.error(result.message);
        for (const candidate of result.matches) {
          console.error(`- ${candidate.id} | ${candidate.projectName} | ${candidate.status} | ${candidate.title}`);
        }
        return 2;
      }

      if (flags.has('--json')) {
        console.log(JSON.stringify({
          count: result.loops.length,
          loops: result.loops,
          feedback: result.feedback,
        }, null, 2));
        return 0;
      }

      const label = verdict === 'forgotten' ? '确实忘了' : '噪音';
      console.log(`已记录反馈：${label} · ${result.loops.length} 条`);
      for (const loop of result.loops) {
        console.log(`- **${loop.title}** · ${loop.projectName}`);
      }
      const note = flagString(flags, '--note');
      if (note) console.log(`备注：${note}`);
      if (verdict === 'noise') {
        const suppressed = result.loops.filter((loop, index) =>
          isNoiseSuppressed(loop, result.feedback[index])
        ).length;
        const visible = result.loops.length - suppressed;
        console.log(
          `循环状态未改动；${suppressed} 条在出现新证据前不再回访`
          + (visible > 0 ? `，${visible} 条已有更新证据仍会参与回访` : '')
          + '。',
        );
      } else {
        console.log('循环状态未改动。');
      }
      return 0;
    } finally {
      store.close();
    }
  }

  const store = new LoopStore(flagString(flags, '--db') ?? resolveDefaultDbPath());
  try {
    const result = recordLoopFeedback(store, {
      id,
      ref,
      match,
      index,
      projectDir: flagString(flags, '--project'),
      verdict,
      note: flagString(flags, '--note'),
    });
    if (result.status === 'not_found') {
      console.error(result.message);
      return 1;
    }
    if (result.status === 'ambiguous') {
      console.error(result.message);
      for (const candidate of result.matches) {
        console.error(`- ${candidate.id} | ${candidate.projectName} | ${candidate.status} | ${candidate.title}`);
      }
      return 2;
    }

    if (flags.has('--json')) {
      console.log(JSON.stringify({
        loop: result.loop,
        feedback: result.feedback,
      }, null, 2));
    } else {
      const label = result.feedback.verdict === 'forgotten' ? '确实忘了' : '噪音';
      console.log(`已记录反馈：${label} · ${result.loop.projectName} · ${result.loop.title}`);
      if (result.feedback.note) console.log(`备注：${result.feedback.note}`);
      if (result.feedback.verdict === 'noise' && isNoiseSuppressed(result.loop, result.feedback)) {
        console.log('循环状态未改动；在出现新证据前不再回访。');
      } else if (result.feedback.verdict === 'noise') {
        console.log('循环状态未改动；已有更新证据，这条仍会参与回访。');
      } else {
        console.log('循环状态未改动。');
      }
    }
    return 0;
  } finally {
    store.close();
  }
}

function runBackup(flags: Map<string, string | true>): number {
  const result = backupLoopDatabase({
    dbPath: flagString(flags, '--db'),
    outPath: flagString(flags, '--out'),
    keep: flagNumber(flags, '--keep'),
  });
  if (flags.has('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Backup: ${result.target}`);
    console.log(
      `Loops: ${result.loops} · Signals: ${result.signals} · ${(result.bytes / 1024).toFixed(1)} KB · integrity ${result.integrity}`,
    );
    if (result.pruned.length > 0) console.log(`Pruned: ${result.pruned.length} old daily snapshots`);
  }
  return 0;
}

function runRestore(flags: Map<string, string | true>): number {
  const backupPath = flagString(flags, '--backup');
  if (!backupPath) throw new Error('--backup is required');
  const result = restoreLoopDatabase({
    backupPath,
    dbPath: flagString(flags, '--db'),
    dryRun: flags.has('--dry-run'),
  });
  if (flags.has('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.dryRun ? 'Restore plan' : 'Restored'}: ${result.backup} -> ${result.target}`);
    console.log(
      `Loops: ${result.loops} · Signals: ${result.signals} · integrity ${result.integrity}`,
    );
    console.log(`Target state: ${result.targetState}`);
    if (result.safetyBackup) {
      console.log(`Safety backup${result.dryRun ? ' (planned)' : ''}: ${result.safetyBackup}`);
    }
    if (result.dryRun) console.log('Dry run: no files changed.');
  }
  return 0;
}

function runInstallSkill(flags: Map<string, string | true>): number {
  const agentsFlag = flagString(flags, '--agents');
  const targetFlag = flagString(flags, '--target');
  if (flags.has('--all') || agentsFlag || !targetFlag) {
    if (targetFlag && (flags.has('--all') || agentsFlag)) {
      throw new Error('--target cannot be combined with --agents or --all');
    }
    if (flags.has('--all') && agentsFlag) {
      throw new Error('--agents and --all are mutually exclusive');
    }
    const agents = agentsFlag
      ? agentsFlag.split(',').map((value) => value.trim()).filter(Boolean)
      : flags.has('--all')
        ? undefined
        : ['hermes'] as SkillAgent[];
    const results = installOpenLoopsSkillForAgents({
      sourcePath: flagString(flags, '--source'),
      agents: agents as SkillAgent[] | undefined,
    });
    if (flags.has('--json')) {
      console.log(JSON.stringify({ results }, null, 2));
    } else {
      for (const result of results) {
        console.log(`Skill[${result.agent}]: ${result.action} · ${result.target}`);
        console.log(`SHA256: ${result.sha256}`);
        if (result.backup) console.log(`Backup: ${result.backup}`);
        if (result.nestedBackup) console.log(`Nested duplicate moved: ${result.nestedBackup}`);
      }
    }
    return 0;
  }
  const result = installOpenLoopsSkill({
    sourcePath: flagString(flags, '--source'),
    destinationPath: targetFlag,
  });
  if (flags.has('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Skill: ${result.action} · ${result.target}`);
    console.log(`SHA256: ${result.sha256}`);
    if (result.backup) console.log(`Backup: ${result.backup}`);
    if (result.nestedBackup) console.log(`Nested duplicate moved: ${result.nestedBackup}`);
  }
  return 0;
}

function runInstallPolicy(flags: Map<string, string | true>): number {
  const agentsFlag = flagString(flags, '--agents');
  const agents = agentsFlag
    ? agentsFlag.split(',').map((value) => value.trim()).filter(Boolean) as PolicyAgent[]
    : ['hermes'] as PolicyAgent[];
  const results = installSessionPolicy({
    agents,
    dryRun: flags.has('--dry-run'),
    uninstall: flags.has('--uninstall'),
  });
  if (flags.has('--json')) {
    console.log(JSON.stringify({ results }, null, 2));
    return 0;
  }
  for (const result of results) {
    console.log(`Policy[${result.agent}]: ${result.action} · ${result.file}`);
    if (result.backup) console.log(`Backup: ${result.backup}`);
  }
  return 0;
}

function runInstallMcp(flags: Map<string, string | true>): number {
  const agentsFlag = flagString(flags, '--agents');
  const clients = agentsFlag
    ? agentsFlag.split(',').map((value) => value.trim()).filter(Boolean) as McpClient[]
    : undefined;
  const results = installMcpConfigs({
    clients,
    projectDir: flagString(flags, '--project-dir'),
    codexConfig: flagString(flags, '--codex-config'),
    claudeConfig: flagString(flags, '--claude-config'),
    cursorConfig: flagString(flags, '--cursor-config'),
    serverPath: flagString(flags, '--server-path'),
    nodeCommand: flagString(flags, '--node-command'),
    dbPath: flagString(flags, '--db'),
    dryRun: flags.has('--dry-run'),
    uninstall: flags.has('--uninstall'),
  });
  if (flags.has('--json')) {
    console.log(JSON.stringify({ results }, null, 2));
  } else {
    for (const result of results) {
      console.log(`MCP[${result.client}]: ${result.action} · ${result.file}`);
      if (result.backup) console.log(`Backup: ${result.backup}`);
      if (result.error) console.log(`Error: ${result.error}`);
    }
    if (flags.has('--dry-run')) console.log('Dry run: no files changed.');
  }
  return results.some((result) => result.action === 'error') ? 1 : 0;
}

async function runSetupCommand(flags: Map<string, string | true>): Promise<number> {
  const agentsFlag = flagString(flags, '--agents');
  const agents = agentsFlag
    ? agentsFlag.split(',').map((value) => value.trim()).filter(Boolean) as SkillAgent[]
    : undefined;
  const result = await runSetup({
    agents,
    dryRun: flags.has('--dry-run'),
    schedule: flags.has('--schedule'),
    ingest: flags.has('--ingest'),
    importDb: flagString(flags, '--import-db'),
  });
  if (flags.has('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatSetup(result));
  }
  return result.ok ? 0 : 1;
}

async function main(argv: string[]): Promise<number> {
  const { command, flags } = parseArgs(argv);
  if (command === 'help' || command === '--help' || command === '-h' || flags.has('--help') || flags.has('-h')) {
    console.log(usage());
    return 0;
  }
  if (command === 'ingest') return runIngest(flags);
  if (command === 'sessions') return runSessions(flags);
  if (command === 'list') return runList(flags);
  if (command === 'pending') return runPending(flags);
  if (command === 'digest') return runDigest(flags);
  if (command === 'calibrate') return runCalibrate(flags);
  if (command === 'closing') return runClosing(flags);
  if (command === 'reconcile') return runReconcile(flags);
  if (command === 'stats') return runStats(flags);
  if (command === 'doctor') return runDoctor(flags);
  if (command === 'presentations') return runPresentations(flags);
  if (command === 'projects') return runProjects(flags);
  if (command === 'coverage') return runCoverage(flags);
  if (command === 'audit') return runAudit(flags);
  if (command === 'show') return runShow(flags);
  if (command === 'update') return runUpdate(flags);
  if (command === 'feedback') return runFeedback(flags);
  if (command === 'backup') return runBackup(flags);
  if (command === 'redact') return runRedact(argv.slice(1));
  if (command === 'restore') return runRestore(flags);
  if (command === 'install-skill') return runInstallSkill(flags);
  if (command === 'install-policy') return runInstallPolicy(flags);
  if (command === 'install-mcp') return runInstallMcp(flags);
  if (command === 'setup') return runSetupCommand(flags);
  console.error(`unknown command: ${command}`);
  console.error(usage());
  return 1;
}

main(process.argv.slice(2))
  .then((exitCode) => {
    if (exitCode !== 0) process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(`loopsteward: ${(error as Error).message}`);
    process.exitCode = 1;
  });
