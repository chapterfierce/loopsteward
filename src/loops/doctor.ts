import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { renderOpenLoopsSkill, skillAgentTargets, type SkillAgent } from './skill-install.js';
import { inspectSessionPolicy, type PolicyAgent } from './session-policy.js';
import { findPackageRoot } from './package-root.js';
import { resolveDefaultDbPath } from './data-path.js';
import { presentationFutureCutoffIso } from './presentation-time.js';
import { isSessionOnlyProject } from './projects.js';
import type { McpClient, McpServerConfig } from './mcp-install.js';

export type DoctorStatus = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  key: string;
  label: string;
  status: DoctorStatus;
  detail: string;
}

export interface LoopDoctorReport {
  generatedAt: string;
  dbPath: string;
  checks: DoctorCheck[];
  warnings: string[];
  ok: boolean;
}

export interface LoopDoctorOptions {
  packageRoot?: string;
  dbPath?: string;
  now?: Date;
  home?: string;
  localAppData?: string;
  skillSourcePath?: string;
  archiveDir?: string;
  staleIngestHours?: number;
  staleCacheDays?: number;
  archiveWarnBytes?: number;
  allowMissingDatabase?: boolean;
  scheduledTask?: boolean;
  taskName?: string;
  taskScriptPath?: string;
  sessionPolicy?: boolean;
  buildCheck?: boolean;
  distPath?: string;
  srcDir?: string;
  scriptPath?: string;
  skillAgents?: SkillAgent[];
  policyAgents?: PolicyAgent[];
  mcpCheck?: boolean;
  mcpProjectDir?: string;
  codexConfig?: string;
  claudeConfig?: string;
  cursorConfig?: string;
}

const DEFAULT_STALE_INGEST_HOURS = 6;
const DEFAULT_STALE_CACHE_DAYS = 30;
const DEFAULT_ARCHIVE_WARN_BYTES = 1024 ** 3;

function hoursSince(value: unknown, now: Date): number | null {
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, (now.getTime() - ms) / (60 * 60 * 1000));
}

function formatHours(hours: number): string {
  return hours < 1
    ? `${Math.max(1, Math.round(hours * 60))} 分钟`
    : `${hours.toFixed(1)} 小时`;
}

function formatAgeCompact(hours: number): string {
  return hours < 24 ? formatHours(hours) : `${(hours / 24).toFixed(1)} 天`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function fileHash(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase();
}

function skillWrapperPaths(content: string): string[] {
  const matches = content.matchAll(
    /["']((?:[A-Za-z]:[\\/]|\/)[^"'\r\n]*[\\/]scripts[\\/](?:open-loops|refresh-open-loops)\.(?:ps1|mjs))["']/g,
  );
  return [...new Set(Array.from(matches, (match) => match[1]))];
}

function inspectDatabase(
  dbPath: string,
  now: Date,
  staleIngestHours: number,
  staleCacheDays: number,
  allowMissing = false,
): DoctorCheck[] {
  if (!fs.existsSync(dbPath)) {
    return [{
      key: 'database',
      label: '数据库',
      status: allowMissing ? 'warn' : 'fail',
      detail: allowMissing
        ? `尚未初始化：${dbPath}；运行 loopsteward ingest`
        : `不存在：${dbPath}`,
    }];
  }

  const req = createRequire(import.meta.url);
  const { DatabaseSync } = req('node:sqlite') as {
    DatabaseSync: new (file: string, options?: { readOnly?: boolean }) => any;
  };
  let db: any;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (error) {
    return [{
      key: 'database',
      label: '数据库',
      status: 'fail',
      detail: `无法打开：${(error as Error).message}`,
    }];
  }

  const checks: DoctorCheck[] = [];
  try {
    const integrityRow = db.prepare('PRAGMA integrity_check').get() as
      | { integrity_check?: string }
      | undefined;
    const integrity = String(integrityRow?.integrity_check ?? 'unknown');
    const loops = Number(db.prepare('SELECT COUNT(*) AS c FROM loops').get().c);
    const signals = Number(db.prepare('SELECT COUNT(*) AS c FROM loop_signals').get().c);
    const statusRows = db.prepare(
      'SELECT status, COUNT(*) AS c FROM loops GROUP BY status ORDER BY status',
    ).all() as Array<{ status: string; c: number }>;
    const statusText = statusRows.map((row) => `${row.status} ${row.c}`).join(' / ') || '无循环';
    checks.push({
      key: 'database',
      label: '数据库',
      status: integrity === 'ok' ? 'ok' : 'fail',
      detail: `integrity ${integrity} · ${loops} loops / ${signals} signals · ${statusText}`,
    });
    try {
      const hasPresentations = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'loop_presentations'",
      ).get();
      if (hasPresentations) {
        const futureCutoff = presentationFutureCutoffIso(now);
        const future = db.prepare(`
          SELECT COUNT(*) AS c, MIN(presented_at) AS first, MAX(presented_at) AS last
          FROM loop_presentations
          WHERE julianday(presented_at) > julianday(?)
        `).get(futureCutoff) as { c?: number; first?: string; last?: string } | undefined;
        const futureCount = Number(future?.c ?? 0);
        checks.push({
          key: 'presentation-integrity',
          label: '回访记录',
          status: futureCount > 0 ? 'warn' : 'ok',
          detail: futureCount > 0
            ? `${futureCount} 条未来时间记录（${future?.first} ~ ${future?.last}），未计入统计；请检查系统时钟或导入数据`
            : '时间戳正常',
        });
      }
    } catch {
      // Older databases may not have the presentations table yet.
    }
  } catch (error) {
    checks.push({
      key: 'database',
      label: '数据库',
      status: 'fail',
      detail: `读取失败：${(error as Error).message}`,
    });
    db.close();
    return checks;
  }

  try {
    const row = db.prepare(
      'SELECT started_at, finished_at FROM ingest_runs ORDER BY started_at DESC LIMIT 1',
    ).get() as { started_at?: string; finished_at?: string } | undefined;
    const age = hoursSince(row?.finished_at ?? row?.started_at, now);
    if (age === null) {
      checks.push({
        key: 'ingest',
        label: '最近摄入',
        status: 'warn',
        detail: '尚无摄入记录',
      });
    } else if (age > staleIngestHours) {
      checks.push({
        key: 'ingest',
        label: '最近摄入',
        status: 'warn',
        detail: `${formatHours(age)}前，超过 ${staleIngestHours} 小时；检查 OpenLoopsRefresh 计划任务`,
      });
    } else {
      checks.push({
        key: 'ingest',
        label: '最近摄入',
        status: 'ok',
        detail: `${formatHours(age)}前`,
      });
    }
  } catch (error) {
    checks.push({
      key: 'ingest',
      label: '最近摄入',
      status: 'warn',
      detail: `无法读取摄入记录：${(error as Error).message}`,
    });
  }

  try {
    const rows = db.prepare(`
      SELECT agent, COUNT(*) AS c, MAX(captured_at) AS latest
      FROM loop_signals
      GROUP BY agent
      ORDER BY latest DESC
    `).all() as Array<{ agent: string; c: number; latest?: string }>;
    checks.push({
      key: 'sources',
      label: '来源信号',
      status: 'ok',
      detail: rows.length === 0
        ? '暂无信号'
        : rows.map((row) => {
          const age = hoursSince(row.latest, now);
          return `${row.agent} ${age === null ? '未知' : formatAgeCompact(age)}`;
        }).join(' · '),
    });
  } catch (error) {
    checks.push({
      key: 'sources',
      label: '来源信号',
      status: 'warn',
      detail: `无法读取来源信号：${(error as Error).message}`,
    });
  }

  try {
    const feedback = Number(db.prepare('SELECT COUNT(*) AS c FROM loop_feedback').get().c);
    checks.push({
      key: 'feedback',
      label: '真实反馈',
      status: feedback > 0 ? 'ok' : 'warn',
      detail: feedback > 0 ? `${feedback} 条` : '0 条；usefulRate 无法计算，回访质量尚未验证',
    });
  } catch (error) {
    checks.push({
      key: 'feedback',
      label: '真实反馈',
      status: 'warn',
      detail: `无法读取反馈：${(error as Error).message}`,
    });
  }

  try {
    const row = db.prepare(
      "SELECT value FROM schema_meta WHERE key = 'review_cycle'",
    ).get() as { value?: string } | undefined;
    if (!row?.value) {
      checks.push({
        key: 'review-cycle',
        label: '周回顾轮次',
        status: 'ok',
        detail: '尚未开始；说“周回顾”开始第一轮',
      });
    } else {
      const parsed = JSON.parse(row.value) as { startedAt?: unknown; seen?: unknown };
      const seen = new Set(
        Array.isArray(parsed.seen)
          ? parsed.seen.filter((id): id is string => typeof id === 'string')
          : [],
      );
      const active = db.prepare(
        "SELECT id, project_name AS name FROM loops WHERE status IN ('open', 'pending')",
      ).all() as Array<{ id: string; name: string }>;
      const shown = active.filter((loop) => seen.has(loop.id)).length;
      const remaining = active.length - shown;
      const sessionOnly = active.filter((loop) => isSessionOnlyProject(loop.name)).length;
      const real = active.length - sessionOnly;
      const lastReview = db.prepare(
        "SELECT MAX(presented_at) AS last FROM loop_presentations WHERE kind = 'review'",
      ).get() as { last?: string } | undefined;
      const idleHours = hoursSince(lastReview?.last, now);
      const stalled = remaining > 0 && idleHours !== null && idleHours > 14 * 24;
      const startedAt = typeof parsed.startedAt === 'string' ? parsed.startedAt : undefined;
      const ageHours = hoursSince(startedAt, now);
      checks.push({
        key: 'review-cycle',
        label: '周回顾轮次',
        status: stalled ? 'warn' : 'ok',
        detail: `全部 open/pending 已看 ${shown}/${active.length}，剩余 ${remaining}（真实项目 ${real} / 临时会话 ${sessionOnly}）`
          + '（周回顾会另排除完成候选和已反馈遗忘项）'
          + (ageHours === null ? '' : `；本轮开始 ${formatHours(ageHours)}前`)
          + (stalled ? `；${formatHours(idleHours!)}没有继续` : ''),
      });
    }
  } catch (error) {
    checks.push({
      key: 'review-cycle',
      label: '周回顾轮次',
      status: 'warn',
      detail: `无法读取周回顾轮次：${(error as Error).message}`,
    });
  }

  try {
    const row = db.prepare(
      'SELECT COUNT(*) AS c, MIN(checked_at) AS oldest, MAX(checked_at) AS newest FROM loop_reconcile_cache',
    ).get() as { c: number; oldest?: string; newest?: string };
    const count = Number(row.c);
    if (count === 0) {
      checks.push({
        key: 'cache',
        label: '核对缓存',
        status: 'ok',
        detail: '无缓存行',
      });
    } else {
      const oldestAge = hoursSince(row.oldest, now);
      const stale = oldestAge !== null && oldestAge > staleCacheDays * 24;
      checks.push({
        key: 'cache',
        label: '核对缓存',
        status: stale ? 'warn' : 'ok',
        detail: `${count} 行，最旧 ${oldestAge === null ? '未知' : formatHours(oldestAge)}`
          + (stale ? `；超过 ${staleCacheDays} 天保留期` : ''),
      });
    }
  } catch (error) {
    checks.push({
      key: 'cache',
      label: '核对缓存',
      status: 'warn',
      detail: `无法读取缓存：${(error as Error).message}`,
    });
  }

  db.close();
  return checks;
}

function inspectArchive(archiveDir: string, warnBytes: number): DoctorCheck {
  if (!fs.existsSync(archiveDir)) {
    return {
      key: 'archive',
      label: '备份归档',
      status: 'ok',
      detail: '无归档目录',
    };
  }
  let files: string[] = [];
  try {
    files = fs.readdirSync(archiveDir).filter((name) => name.toLowerCase().endsWith('.db'));
  } catch (error) {
    return {
      key: 'archive',
      label: '备份归档',
      status: 'warn',
      detail: `无法读取：${(error as Error).message}`,
    };
  }
  let bytes = 0;
  let managed = 0;
  for (const name of files) {
    try {
      const stat = fs.statSync(path.join(archiveDir, name));
      if (!stat.isFile()) continue;
      bytes += stat.size;
      if (/^loops-\d{8}(?:-\d{6})?\.db$/.test(name)) managed += 1;
    } catch {
      continue;
    }
  }
  const tooLarge = bytes > warnBytes;
  return {
    key: 'archive',
    label: '备份归档',
    status: tooLarge ? 'warn' : 'ok',
    detail: `${files.length} 个 / ${formatBytes(bytes)}（自动 ${managed}，命名 ${files.length - managed}）`
      + (tooLarge ? `；超过 ${formatBytes(warnBytes)}` : ''),
  };
}

function inspectScheduledTask(
  taskName: string,
  now: Date,
  expectedScript: string,
  logDir?: string,
): DoctorCheck {
  if (process.platform !== 'win32') {
    return {
      key: 'scheduled-task',
      label: '后台刷新任务',
      status: 'ok',
      detail: '非 Windows 平台，跳过',
    };
  }
  const safeName = taskName.replace(/'/g, "''");
  const script = [
    `$task = Get-ScheduledTask -TaskName '${safeName}' -ErrorAction SilentlyContinue`,
    `if (-not $task) { Write-Output 'MISSING'; exit 0 }`,
    `$info = Get-ScheduledTaskInfo -TaskName '${safeName}'`,
    `[pscustomobject]@{ state = [string]$task.State; lastResult = [long]$info.LastTaskResult; lastRun = [string]$info.LastRunTime; nextRun = [string]$info.NextRunTime; action = [string]($task.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) } | ConvertTo-Json -Compress`,
  ].join('; ');
  let output: string;
  try {
    output = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', timeout: 8_000, windowsHide: true },
    ).trim();
  } catch (error) {
    return {
      key: 'scheduled-task',
      label: '后台刷新任务',
      status: 'warn',
      detail: `无法查询：${(error as Error).message}`,
    };
  }
  if (output === 'MISSING') {
    return {
      key: 'scheduled-task',
      label: '后台刷新任务',
      status: 'warn',
      detail: `未注册：${taskName}；运行 scripts\\install-refresh-task.ps1`,
    };
  }
  try {
    const parsed = JSON.parse(output) as {
      state?: string;
      lastResult?: number;
      lastRun?: string;
      nextRun?: string;
      action?: string;
    };
    return describeScheduledTask(
      String(parsed.state ?? 'unknown'),
      Number(parsed.lastResult ?? 0),
      String(parsed.lastRun ?? ''),
      now,
      logDir,
      { expectedScript, action: String(parsed.action ?? '') },
    );
  } catch (error) {
    return {
      key: 'scheduled-task',
      label: '后台刷新任务',
      status: 'warn',
      detail: `无法解析任务状态：${(error as Error).message}`,
    };
  }
}

const TASK_STILL_RUNNING_CODE = 267009;
const TASK_INTERRUPTED_CODE = 3221225786; // 0xC000013A: STATUS_CONTROL_C_EXIT

export function describeScheduledTask(
  state: string,
  lastResult: number,
  lastRun: string,
  now: Date,
  logDir?: string,
  target?: { expectedScript?: string; action?: string },
): DoctorCheck {
  if (target?.expectedScript) {
    const normalize = (value: string) => value.replace(/\//g, '\\').toLowerCase();
    if (!normalize(target.action ?? '').includes(normalize(target.expectedScript))) {
      return {
        key: 'scheduled-task',
        label: '后台刷新任务',
        status: 'warn',
        detail: `任务指向其他安装：${target.action || '无法读取任务目标'}；运行 scripts\\install-refresh-task.ps1 重新注册`,
      };
    }
  }
  const lastAge = hoursSince(lastRun, now);
  if (state !== 'Ready' && state !== 'Running') {
    return {
      key: 'scheduled-task',
      label: '后台刷新任务',
      status: 'warn',
      detail: `状态 ${state}；最近运行 ${lastRun || '未知'}`,
    };
  }
  if (state === 'Running') {
    return {
      key: 'scheduled-task',
      label: '后台刷新任务',
      status: 'ok',
      detail: `状态 Running · 上次 ${lastRun || '未知'} · 正在运行`,
    };
  }
  if (lastResult === TASK_STILL_RUNNING_CODE) {
    return {
      key: 'scheduled-task',
      label: '后台刷新任务',
      status: 'warn',
      detail: `上次结果 ${lastResult}（任务未正常退出）；最近运行 ${lastRun || '未知'}`,
    };
  }
  if (lastResult === TASK_INTERRUPTED_CODE) {
    return {
      key: 'scheduled-task',
      label: '后台刷新任务',
      status: 'warn',
      detail: `上次运行被中断（0xC000013A）；等待下次刷新或手动运行；最近运行 ${lastRun || '未知'}`,
    };
  }
  if (lastResult !== 0) {
    return {
      key: 'scheduled-task',
      label: '后台刷新任务',
      status: 'fail',
      detail: `上次运行失败，结果 ${lastResult}；查看 ${path.join(logDir ?? 'data\\logs', 'refresh-*.log')}`,
    };
  }
  if (lastAge !== null && lastAge > 6) {
    return {
      key: 'scheduled-task',
      label: '后台刷新任务',
      status: 'warn',
      detail: `${formatHours(lastAge)}前运行，超过 2 小时周期；检查任务计划`,
    };
  }
  return {
    key: 'scheduled-task',
    label: '后台刷新任务',
    status: 'ok',
    detail: `状态 ${state} · 上次 ${lastRun || '未知'} · 结果 ${lastResult}`,
  };
}

function inspectSkills(
  sourcePath: string,
  home: string | undefined,
  localAppData: string | undefined,
  packageRoot: string,
  agents?: SkillAgent[],
): DoctorCheck {
  if (!fs.existsSync(sourcePath)) {
    return {
      key: 'skills',
      label: 'skill 副本',
      status: 'fail',
      detail: `仓库 skill 不存在：${sourcePath}`,
    };
  }
  let sourceHash: string;
  try {
    const rendered = renderOpenLoopsSkill(fs.readFileSync(sourcePath, 'utf8'), packageRoot);
    sourceHash = createHash('sha256').update(rendered, 'utf8').digest('hex').toUpperCase();
  } catch (error) {
    return {
      key: 'skills',
      label: 'skill 副本',
      status: 'fail',
      detail: `仓库 skill 读取失败：${sourcePath}`,
    };
  }
  const targets = skillAgentTargets({ homeDir: home, localAppData })
    .filter((target) => agents === undefined || agents.includes(target.agent));
  if (targets.length === 0) {
    return {
      key: 'skills',
      label: 'skill 副本',
      status: 'ok',
      detail: '未检测到启用的 skill',
    };
  }
  const problems: string[] = [];
  for (const target of targets) {
    if (!fs.existsSync(target.target)) {
      problems.push(`${target.agent}: 缺失`);
      continue;
    }
    try {
      if (fileHash(target.target) !== sourceHash) {
        problems.push(`${target.agent}: 不一致`);
        continue;
      }
      const installed = fs.readFileSync(target.target, 'utf8');
      const missingWrappers = skillWrapperPaths(installed)
        .filter((wrapper) => !fs.existsSync(wrapper));
      if (missingWrappers.length > 0) {
        problems.push(`${target.agent}: wrapper 不存在`);
      }
    } catch (error) {
      problems.push(`${target.agent}: 读取失败`);
    }
  }
  if (problems.length > 0) {
    return {
      key: 'skills',
      label: 'skill 副本',
      status: 'warn',
      detail: `${targets.length - problems.length}/${targets.length} 一致；${problems.join('，')}`,
    };
  }
  return {
    key: 'skills',
    label: 'skill 副本',
    status: 'ok',
    detail: `${targets.length}/${targets.length} 与模板一致（${sourceHash.slice(0, 8)}）`,
  };
}

interface McpTarget {
  client: McpClient;
  file: string;
  format: 'toml' | 'json';
}

function parseMcpToml(content: string): McpServerConfig | null {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) =>
    /^\s*\[mcp_servers\.(?:loopsteward|"loopsteward")\]\s*$/.test(line),
  );
  if (start < 0) return null;
  let command: string | undefined;
  let args: string[] | undefined;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index])) break;
    const commandMatch = lines[index].match(/^\s*command\s*=\s*(".*")\s*$/);
    if (commandMatch) {
      try {
        command = JSON.parse(commandMatch[1]) as string;
      } catch {
        return null;
      }
    }
    const argsMatch = lines[index].match(/^\s*args\s*=\s*(\[.*\])\s*$/);
    if (argsMatch) {
      try {
        args = JSON.parse(argsMatch[1]) as string[];
      } catch {
        return null;
      }
    }
  }
  if (!command || !Array.isArray(args)) return null;
  return { command, args };
}

function parseMcpJson(content: string): McpServerConfig | null {
  try {
    const parsed = JSON.parse(content) as {
      mcpServers?: Record<string, { command?: unknown; args?: unknown }>;
    };
    const server = parsed.mcpServers?.loopsteward;
    if (!server || typeof server.command !== 'string' || !Array.isArray(server.args)) return null;
    if (server.args.some((arg) => typeof arg !== 'string')) return null;
    return { command: server.command, args: server.args as string[] };
  } catch {
    return null;
  }
}

function mcpServerProblem(server: McpServerConfig): string | null {
  if (!server.command.trim()) return '缺少 command';
  if (server.args.length === 0) return '缺少 server 路径';
  const serverPath = server.args[0];
  if (!path.isAbsolute(serverPath)) return `server 路径不是绝对路径：${serverPath}`;
  if (!fs.existsSync(serverPath)) return `server 路径不存在：${serverPath}`;
  return null;
}

function inspectMcp(options: {
  home?: string;
  projectDir: string;
  codexConfig?: string;
  claudeConfig?: string;
  cursorConfig?: string;
}): DoctorCheck {
  const home = options.home ?? os.homedir();
  const targets: McpTarget[] = [
    {
      client: 'codex',
      file: path.resolve(options.codexConfig ?? path.join(home, '.codex', 'config.toml')),
      format: 'toml',
    },
    {
      client: 'claude',
      file: path.resolve(options.claudeConfig ?? path.join(options.projectDir, '.mcp.json')),
      format: 'json',
    },
    {
      client: 'cursor',
      file: path.resolve(options.cursorConfig ?? path.join(home, '.cursor', 'mcp.json')),
      format: 'json',
    },
  ];
  const configured = targets.filter((target) => fs.existsSync(target.file));
  if (configured.length === 0) {
    return {
      key: 'mcp',
      label: 'MCP 客户端',
      status: 'ok',
      detail: '未配置 MCP 客户端（可选）；运行 loops:install-mcp 启用',
    };
  }

  const valid: McpClient[] = [];
  const problems: string[] = [];
  for (const target of configured) {
    let content: string;
    try {
      content = fs.readFileSync(target.file, 'utf8');
    } catch (error) {
      problems.push(`${target.client}: 读取失败`);
      continue;
    }
    const server = target.format === 'toml' ? parseMcpToml(content) : parseMcpJson(content);
    if (!server) {
      problems.push(`${target.client}: 未找到完整配置`);
      continue;
    }
    const issue = mcpServerProblem(server);
    if (issue) {
      problems.push(`${target.client}: ${issue}`);
      continue;
    }
    valid.push(target.client);
  }

  if (problems.length > 0) {
    return {
      key: 'mcp',
      label: 'MCP 客户端',
      status: 'warn',
      detail: `${valid.length}/${configured.length} 可用；${problems.join('，')}；运行 loops:install-mcp 修复`,
    };
  }
  return {
    key: 'mcp',
    label: 'MCP 客户端',
    status: 'ok',
    detail: `${valid.join(' / ')} 已配置；server 路径存在`,
  };
}

function newestSourceMtime(root: string): number | null {
  if (!fs.existsSync(root)) return null;
  let newest: number | null = null;
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile() || !/\.(?:ts|tsx|mts|cts)$/i.test(entry.name)) continue;
      try {
        const mtime = fs.statSync(full).mtimeMs;
        if (newest === null || mtime > newest) newest = mtime;
      } catch {
        continue;
      }
    }
  };
  walk(root);
  return newest;
}

export function inspectBuild(
  distPath: string,
  srcDir: string,
  now: Date,
): DoctorCheck {
  if (!fs.existsSync(distPath)) {
    return {
      key: 'build',
      label: '构建产物',
      status: 'warn',
      detail: `未构建：${distPath}；运行 npm run build`,
    };
  }
  let distMtime: number;
  try {
    distMtime = fs.statSync(distPath).mtimeMs;
  } catch (error) {
    return {
      key: 'build',
      label: '构建产物',
      status: 'warn',
      detail: `无法读取构建产物：${(error as Error).message}`,
    };
  }
  const newest = newestSourceMtime(srcDir);
  if (!fs.existsSync(srcDir)) {
    return {
      key: 'build',
      label: '构建产物',
      status: 'ok',
      detail: '已安装包，使用预构建产物',
    };
  }
  if (newest === null) {
    return {
      key: 'build',
      label: '构建产物',
      status: 'warn',
      detail: `源码目录不存在或没有 TypeScript 文件：${srcDir}`,
    };
  }
  if (newest > distMtime + 1000) {
    const lagHours = (newest - distMtime) / (60 * 60 * 1000);
    return {
      key: 'build',
      label: '构建产物',
      status: 'warn',
      detail: `源码比构建产物新 ${formatHours(lagHours)}；运行 npm run build`,
    };
  }
  const ageHours = Math.max(0, (now.getTime() - distMtime) / (60 * 60 * 1000));
  return {
    key: 'build',
    label: '构建产物',
    status: 'ok',
    detail: `dist 与源码一致（${formatHours(ageHours)}前构建）`,
  };
}

function inspectPolicy(
  scriptPath: string,
  home: string | undefined,
  localAppData: string | undefined,
  agents?: PolicyAgent[],
): DoctorCheck {
  const items = inspectSessionPolicy({ scriptPath, homeDir: home, localAppData, agents });
  if (items.length === 0) {
    return {
      key: 'session-policy',
      label: '会话入口策略',
      status: 'ok',
      detail: '未检测到支持 Agent 的指令文件',
    };
  }
  const problems = items.filter((item) => item.status !== 'ok');
  if (problems.length > 0) {
    return {
      key: 'session-policy',
      label: '会话入口策略',
      status: 'warn',
      detail: `${items.length - problems.length}/${items.length} 已安装；${problems.map((item) => item.detail).join('，')}；运行 loops:install-policy`,
    };
  }
  return {
    key: 'session-policy',
    label: '会话入口策略',
    status: 'ok',
    detail: `${items.length}/${items.length} 已安装`,
  };
}

export function buildLoopDoctor(options: LoopDoctorOptions = {}): LoopDoctorReport {
  const now = options.now ?? new Date();
  const packageRoot = path.resolve(options.packageRoot ?? findPackageRoot());
  const dbPath = path.resolve(
    options.dbPath ?? resolveDefaultDbPath({ packageRoot }),
  );
  const staleIngestHours = options.staleIngestHours ?? DEFAULT_STALE_INGEST_HOURS;
  const staleCacheDays = options.staleCacheDays ?? DEFAULT_STALE_CACHE_DAYS;
  const archiveDir = path.resolve(
    options.archiveDir ?? path.join(path.dirname(dbPath), 'archive'),
  );
  const skillSourcePath = path.resolve(
    options.skillSourcePath ?? path.join(packageRoot, 'skills', 'open-loops', 'SKILL.md'),
  );
  const checks: DoctorCheck[] = [
    ...inspectDatabase(
      dbPath,
      now,
      staleIngestHours,
      staleCacheDays,
      options.allowMissingDatabase === true,
    ),
  ];
  if (options.buildCheck !== false) {
    checks.push(
      inspectBuild(
        path.resolve(
          options.distPath ?? path.join(packageRoot, 'dist', 'src', 'loops', 'cli.js'),
        ),
        path.resolve(options.srcDir ?? path.join(packageRoot, 'src')),
        now,
      ),
    );
  }
  if (options.scheduledTask !== false) {
    checks.push(inspectScheduledTask(
      options.taskName ?? 'OpenLoopsRefresh',
      now,
      path.resolve(
        options.taskScriptPath ?? path.join(packageRoot, 'scripts', 'refresh-open-loops.ps1'),
      ),
      path.join(path.dirname(dbPath), 'logs'),
    ));
  }
  checks.push(
    inspectArchive(archiveDir, options.archiveWarnBytes ?? DEFAULT_ARCHIVE_WARN_BYTES),
    ...(options.mcpCheck === false
      ? []
      : [inspectMcp({
          home: options.home,
          projectDir: path.resolve(options.mcpProjectDir ?? packageRoot),
          codexConfig: options.codexConfig,
          claudeConfig: options.claudeConfig,
          cursorConfig: options.cursorConfig,
        })]),
    inspectSkills(
      skillSourcePath,
      options.home,
      options.localAppData,
      packageRoot,
      options.skillAgents,
    ),
  );
  if (options.sessionPolicy !== false) {
    checks.push(
      inspectPolicy(
        path.resolve(options.scriptPath ?? path.join(packageRoot, 'scripts', 'open-loops.mjs')),
        options.home,
        options.localAppData,
        options.policyAgents,
      ),
    );
  }
  const warnings = checks
    .filter((check) => check.status !== 'ok')
    .map((check) => `${check.label}：${check.detail}`);
  return {
    generatedAt: now.toISOString(),
    dbPath,
    checks,
    warnings,
    ok: !checks.some((check) => check.status === 'fail'),
  };
}

export function formatLoopDoctor(report: LoopDoctorReport): string {
  const lines = ['# Open Loops 健康检查', ''];
  for (const check of report.checks) {
    const mark = check.status === 'ok' ? 'OK' : check.status === 'warn' ? 'WARN' : 'FAIL';
    lines.push(`- [${mark}] ${check.label}：${check.detail}`);
  }
  lines.push('', report.ok ? '结论：没有阻塞性问题。' : '结论：存在阻塞性问题。');
  if (report.warnings.length > 0) {
    lines.push(`需要关注 ${report.warnings.length} 项。`);
  }
  return lines.join('\n');
}
