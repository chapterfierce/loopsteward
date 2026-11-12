import { LoopStore } from './loop-store.js';
import { resolveDefaultDbPath } from './data-path.js';
import type { LoopRecord, ProjectSummary } from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const SESSION_ONLY_NAME = /^(?:Qoder|ZCode|WorkBuddy|Claude|Codex|Hermes|DSH|Antigravity) · /;

export interface ProjectOverviewOptions {
  dbPath?: string;
  store?: LoopStore;
  now?: Date;
  days?: number;
  limit?: number;
}

function projectKey(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase();
}

function normalizedProjectDir(value: string): string {
  const normalized = projectKey(value).replace(/\/+$/, '');
  return normalized.length > 0 ? normalized : '/';
}

function isDescendantProject(projectDir: string, candidateParent: string): boolean {
  const child = normalizedProjectDir(projectDir);
  const parent = normalizedProjectDir(candidateParent);
  if (child === parent) return false;
  return child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);
}

function excludeWorkspaceContainers(projects: ProjectSummary[]): ProjectSummary[] {
  if (projects.length < 3) return projects;
  const containers = new Set<string>();
  for (const candidate of projects) {
    if (candidate.open > 0 || candidate.pending > 0) continue;
    let descendants = 0;
    for (const other of projects) {
      if (other === candidate) continue;
      if (!isDescendantProject(other.projectDir, candidate.projectDir)) continue;
      descendants += 1;
      if (descendants >= 2) break;
    }
    if (descendants >= 2) containers.add(normalizedProjectDir(candidate.projectDir));
  }
  if (containers.size === 0) return projects;
  return projects.filter(
    (project) => !containers.has(normalizedProjectDir(project.projectDir)),
  );
}

export function isSessionOnlyProject(projectName: string): boolean {
  return SESSION_ONLY_NAME.test(projectName);
}

function countLoops(loops: LoopRecord[]): Pick<ProjectSummary, 'open' | 'pending' | 'snoozed' | 'total'> {
  const open = loops.filter((loop) => loop.status === 'open').length;
  const pending = loops.filter((loop) => loop.status === 'pending').length;
  const snoozed = loops.filter((loop) => loop.status === 'snoozed').length;
  return { open, pending, snoozed, total: open + pending + snoozed };
}

export function buildProjectOverview(options: ProjectOverviewOptions = {}): ProjectSummary[] {
  const ownsStore = options.store === undefined;
  const store = options.store ?? new LoopStore(options.dbPath ?? resolveDefaultDbPath());
  const now = options.now ?? new Date();
  const days = options.days ?? 7;
  const limit = options.limit ?? 500;
  const cutoff = now.getTime() - days * DAY_MS;

  try {
    const activities = store.listProjectActivity(new Date(cutoff).toISOString(), 500);
    const sessionCounts = new Map(
      store.listProjectSessionCounts(new Date(cutoff).toISOString(), 500)
        .map((row) => [projectKey(row.projectDir), row.count]),
    );
    const loopsByProject = new Map<string, LoopRecord[]>();
    for (const loop of store.listActiveLoops()) {
      const key = projectKey(loop.projectDir);
      const bucket = loopsByProject.get(key) ?? [];
      bucket.push(loop);
      loopsByProject.set(key, bucket);
    }

    const projects: ProjectSummary[] = [];
    const seen = new Set<string>();
    for (const activity of activities) {
      const key = projectKey(activity.projectDir);
      const loops = loopsByProject.get(key) ?? [];
      const fallbackName = loops[0]?.projectName;
      const projectName = activity.projectName && activity.projectName !== 'unknown'
        ? activity.projectName
        : fallbackName ?? activity.projectName;
      projects.push({
        projectDir: activity.projectDir,
        projectName,
        lastActive: activity.lastActive,
        sessionCount: sessionCounts.get(key) ?? 0,
        ...countLoops(loops),
        sessionOnly: isSessionOnlyProject(projectName),
      });
      seen.add(key);
    }

    for (const [key, loops] of loopsByProject) {
      if (seen.has(key)) continue;
      const lastActive = loops.reduce(
        (latest, loop) => (loop.lastSeen > latest ? loop.lastSeen : latest),
        loops[0]?.lastSeen ?? '',
      );
      if (!lastActive || Date.parse(lastActive) < cutoff) continue;
      const projectName = loops[0].projectName;
      projects.push({
        projectDir: loops[0].projectDir,
        projectName,
        lastActive,
        sessionCount: 0,
        ...countLoops(loops),
        sessionOnly: isSessionOnlyProject(projectName),
      });
    }

    return excludeWorkspaceContainers(projects)
      .sort((left, right) => {
        if (left.sessionOnly !== right.sessionOnly) return left.sessionOnly ? 1 : -1;
        const activeDiff = right.lastActive.localeCompare(left.lastActive);
        return activeDiff !== 0 ? activeDiff : right.total - left.total;
      })
      .slice(0, Math.max(1, limit));
  } finally {
    if (ownsStore) store.close();
  }
}

export function formatRelativeTime(iso: string, now = new Date()): string {
  const diff = now.getTime() - Date.parse(iso);
  if (!Number.isFinite(diff) || diff < 0) return iso.slice(0, 10);
  if (diff < HOUR_MS) return `${Math.max(1, Math.round(diff / 60_000))} 分钟前`;
  if (diff < DAY_MS) return `${Math.round(diff / HOUR_MS)} 小时前`;
  return `${Math.round(diff / DAY_MS)} 天前`;
}

export function formatProjectLines(projects: ProjectSummary[], now = new Date()): string[] {
  return projects.map((project) => {
    const loops = project.total > 0
      ? `open ${project.open} / pending ${project.pending}`
      : '无未闭环';
    const sessions = project.sessionCount > 0 ? `会话 ${project.sessionCount}` : '仅循环证据';
    return `- **${project.projectName}** · ${formatRelativeTime(project.lastActive, now)} · ${sessions} · ${loops}`;
  });
}

export function formatProjectSection(
  projects: ProjectSummary[],
  now = new Date(),
  days = 7,
  level = 2,
  compactSession = false,
): string[] {
  const heading = '#'.repeat(Math.max(1, Math.min(3, level)));
  const subheading = '#'.repeat(Math.max(1, Math.min(4, level + 1)));
  const real = projects.filter((project) => !project.sessionOnly);
  const sessionOnly = projects.filter((project) => project.sessionOnly);
  const lines = [`${heading} 最近 ${days} 天活跃项目 · ${real.length}`];

  if (real.length === 0) lines.push('- 没有真实项目活动。');
  else lines.push(...formatProjectLines(real, now));

  if (sessionOnly.length > 0) {
    if (compactSession) {
      const open = sessionOnly.reduce((sum, project) => sum + project.open, 0);
      const pending = sessionOnly.reduce((sum, project) => sum + project.pending, 0);
      const without = sessionOnly.filter((project) => project.total === 0).length;
      lines.push(
        '',
        `- 另有 ${sessionOnly.length} 个临时会话工作区：open ${open} / pending ${pending}${
          without > 0 ? `；${without} 个无未闭环` : ''
        }`,
      );
      return lines;
    }
    const ranked = [...sessionOnly].sort((left, right) => {
      if (left.open !== right.open) return right.open - left.open;
      if (left.pending !== right.pending) return right.pending - left.pending;
      return right.lastActive.localeCompare(left.lastActive);
    });
    const shown = ranked.slice(0, 5);
    const hidden = ranked.slice(5);
    const hiddenWithLoops = hidden.filter((project) => project.total > 0);
    const hiddenWithoutLoops = hidden.length - hiddenWithLoops.length;

    lines.push('', `${subheading} 临时会话工作区 · ${sessionOnly.length} 个`);
    lines.push(...formatProjectLines(shown, now));
    if (hiddenWithLoops.length > 0) {
      const hiddenOpen = hiddenWithLoops.reduce((sum, project) => sum + project.open, 0);
      const hiddenPending = hiddenWithLoops.reduce((sum, project) => sum + project.pending, 0);
      lines.push(
        `- 另有 ${hiddenWithLoops.length} 个有未闭环（open ${hiddenOpen} / pending ${hiddenPending}）`,
      );
    }
    if (hiddenWithoutLoops > 0) {
      lines.push(`- 另有 ${hiddenWithoutLoops} 个无未闭环`);
    }
  }
  return lines;
}

export function formatProjectOverview(
  projects: ProjectSummary[],
  now = new Date(),
  days = 7,
): string {
  if (projects.length === 0) return '最近没有活跃项目。';
  return formatProjectSection(projects, now, days, 1).join('\n');
}
