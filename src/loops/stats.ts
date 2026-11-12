import { LoopStore } from './loop-store.js';
import { resolveDefaultDbPath } from './data-path.js';
import { isSessionOnlyProject } from './projects.js';
import {
  presentationFutureCutoffIso,
  PRESENTATION_FUTURE_TOLERANCE_MS,
} from './presentation-time.js';
import type { LoopStats, LoopStatsProject } from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export interface StatsOptions {
  dbPath?: string;
  store?: LoopStore;
  now?: Date;
  windowDays?: number;
  staleDays?: number;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function hoursBetween(start: string, end: string): number | null {
  const value = (Date.parse(end) - Date.parse(start)) / HOUR_MS;
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function projectKey(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase();
}

export function buildLoopStats(options: StatsOptions = {}): LoopStats {
  const ownsStore = options.store === undefined;
  const store = options.store ?? new LoopStore(options.dbPath ?? resolveDefaultDbPath());
  const now = options.now ?? new Date();
  const windowDays = options.windowDays ?? 30;
  const staleDays = options.staleDays ?? 14;
  const windowStart = now.getTime() - windowDays * DAY_MS;
  const presentationCutoff = presentationFutureCutoffIso(now);
  const presentationCutoffMs = now.getTime() + PRESENTATION_FUTURE_TOLERANCE_MS;

  try {
    const loops = store.listAllLoops();
    const totals = {
      all: loops.length,
      open: loops.filter((loop) => loop.status === 'open').length,
      pending: loops.filter((loop) => loop.status === 'pending').length,
      snoozed: loops.filter((loop) => loop.status === 'snoozed').length,
      resolved: loops.filter((loop) => loop.status === 'resolved').length,
      dropped: loops.filter((loop) => loop.status === 'dropped').length,
      origins: {
        user: loops.filter((loop) => loop.origin === 'user').length,
        assistant: loops.filter((loop) => loop.origin === 'assistant').length,
        mixed: loops.filter((loop) => (loop.origin ?? 'mixed') === 'mixed').length,
      },
    };

    const resolved = loops.filter((loop) => loop.status === 'resolved');
    const resolvedInWindow = resolved.filter(
      (loop) => loop.resolvedAt && Date.parse(loop.resolvedAt) >= windowStart,
    );
    const firstPresentation = store.getFirstPresentationTimes(presentationCutoff);
    const futurePresentations = store.countPresentationsAfter(presentationCutoff);
    const surfacedAt = (loop: (typeof loops)[number]): string | undefined => {
      if (!loop.lastSurfacedAt) return undefined;
      return Date.parse(loop.lastSurfacedAt) <= presentationCutoffMs
        ? loop.lastSurfacedAt
        : undefined;
    };
    const firstPresentedAt = (loop: (typeof loops)[number]): string | undefined =>
      firstPresentation.get(loop.id) ?? surfacedAt(loop);
    const presentedIds = new Set(firstPresentation.keys());
    for (const loop of loops) {
      if (surfacedAt(loop)) presentedIds.add(loop.id);
    }
    const firstPresentationDurations = loops
      .map((loop) => {
        const presentedAt = firstPresentedAt(loop);
        return presentedAt ? hoursBetween(loop.firstSeen, presentedAt) : null;
      })
      .filter((value): value is number => value !== null);
    const firstPresentedInWindow = loops.filter((loop) => {
      const presentedAt = firstPresentedAt(loop);
      return presentedAt ? Date.parse(presentedAt) >= windowStart : false;
    }).length;
    const resolvedAfterPresentation = resolved.filter((loop) => {
      const presentedAt = firstPresentedAt(loop);
      return Boolean(presentedAt && loop.resolvedAt && loop.resolvedAt >= presentedAt);
    }).length;
    const resolvedAfterPresentationInWindow = resolved.filter((loop) => {
      const presentedAt = firstPresentedAt(loop);
      if (!presentedAt || !loop.resolvedAt) return false;
      const resolvedMs = Date.parse(loop.resolvedAt);
      return resolvedMs >= windowStart && resolvedMs >= Date.parse(presentedAt);
    }).length;
    const resolutionDurations = resolved
      .map((loop) => loop.resolvedAt ? hoursBetween(loop.firstSeen, loop.resolvedAt) : null)
      .filter((value): value is number => value !== null);
    const selfGeneratedDropped = loops.filter(
      (loop) => loop.status === 'dropped'
        && /自摄入/.test(loop.resolutionNote ?? ''),
    ).length;
    const closed = totals.resolved + totals.dropped - selfGeneratedDropped;

    const staleOpen = loops
      .filter((loop) => loop.status === 'open' || loop.status === 'pending')
      .filter((loop) => Date.parse(loop.lastSeen) < now.getTime() - staleDays * DAY_MS)
      .map((loop) => ({
        id: loop.id,
        title: loop.title,
        projectName: loop.projectName,
        lastSeen: loop.lastSeen,
        daysStale: Math.floor((now.getTime() - Date.parse(loop.lastSeen)) / DAY_MS),
      }))
      .sort((left, right) => right.daysStale - left.daysStale);

    const feedbackCounts = store.getFeedbackCounts();
    const feedbackCountsInWindow = store.getFeedbackCounts(
      new Date(windowStart).toISOString(),
    );
    const feedbackTotal = feedbackCounts.forgotten + feedbackCounts.noise;
    const feedbackWindowTotal = feedbackCountsInWindow.forgotten + feedbackCountsInWindow.noise;

    const projectMap = new Map<string, LoopStatsProject>();
    for (const loop of loops) {
      const key = projectKey(loop.projectDir || loop.projectName);
      const project = projectMap.get(key) ?? {
        projectDir: loop.projectDir,
        projectName: loop.projectName,
        lastActive: loop.lastSeen,
        sessionOnly: isSessionOnlyProject(loop.projectName),
        open: 0,
        pending: 0,
        resolved: 0,
        dropped: 0,
      };
      if (loop.lastSeen >= project.lastActive) {
        project.lastActive = loop.lastSeen;
        project.projectName = loop.projectName;
        project.sessionOnly = isSessionOnlyProject(loop.projectName);
      }
      if (loop.status === 'open') project.open += 1;
      if (loop.status === 'pending') project.pending += 1;
      if (loop.status === 'resolved') project.resolved += 1;
      if (loop.status === 'dropped') project.dropped += 1;
      projectMap.set(key, project);
    }
    const projects = [...projectMap.values()].sort((left, right) => {
      if (left.sessionOnly !== right.sessionOnly) return left.sessionOnly ? 1 : -1;
      const leftActive = left.open + left.pending;
      const rightActive = right.open + right.pending;
      if (leftActive !== rightActive) return rightActive - leftActive;
      return right.lastActive.localeCompare(left.lastActive);
    });
    const sessionOnlyProjects = projects.filter((project) => project.sessionOnly);
    const projectSummary = {
      real: projects.length - sessionOnlyProjects.length,
      sessionOnly: sessionOnlyProjects.length,
      sessionOnlyOpen: sessionOnlyProjects.reduce((sum, project) => sum + project.open, 0),
      sessionOnlyPending: sessionOnlyProjects.reduce((sum, project) => sum + project.pending, 0),
    };

    return {
      generatedAt: now.toISOString(),
      windowDays,
      totals,
      resolution: {
        resolvedInWindow: resolvedInWindow.length,
        closureRate: totals.all > 0 ? closed / totals.all : null,
        resolutionRate: closed > 0 ? totals.resolved / closed : null,
        selfGeneratedDropped,
        medianResolutionHours: median(resolutionDurations),
      },
      surfacing: {
        surfaced: loops.filter((loop) => Boolean(surfacedAt(loop))).length,
        presented: presentedIds.size,
        neverPresented: loops.length - presentedIds.size,
        neverSurfaced: loops.filter((loop) => !surfacedAt(loop)).length,
        resolvedAfterSurface: resolved.filter((loop) => {
          const at = surfacedAt(loop);
          return Boolean(at && loop.resolvedAt && loop.resolvedAt >= at);
        }).length,
        resolvedAfterPresentation,
        repeated: loops.filter((loop) => loop.ignoredCount >= 2).length,
        firstPresentedInWindow,
        resolvedAfterPresentationInWindow,
        medianHoursToFirstPresentation: median(firstPresentationDurations),
        futurePresentations,
        presentationsByKind: store.getPresentationCountsByKind(presentationCutoff),
      },
      feedback: {
        ...feedbackCounts,
        usefulRate: feedbackTotal > 0
          ? feedbackCounts.forgotten / feedbackTotal
          : null,
        forgottenInWindow: feedbackCountsInWindow.forgotten,
        noiseInWindow: feedbackCountsInWindow.noise,
        usefulRateInWindow: feedbackWindowTotal > 0
          ? feedbackCountsInWindow.forgotten / feedbackWindowTotal
          : null,
      },
      staleOpen,
      projects,
      projectSummary,
      lastIngest: store.getLastRun(),
    };
  } finally {
    if (ownsStore) store.close();
  }
}

export function formatLoopStats(stats: LoopStats): string {
  const closurePercent = stats.resolution.closureRate === null
    ? 'n/a'
    : `${Math.round(stats.resolution.closureRate * 100)}%`;
  const median = stats.resolution.medianResolutionHours === null
    ? 'n/a'
    : `${Math.round(stats.resolution.medianResolutionHours)} 小时`;
  const closed = stats.totals.resolved + stats.totals.dropped
    - stats.resolution.selfGeneratedDropped;
  const droppedByUser = stats.totals.dropped - stats.resolution.selfGeneratedDropped;
  const usefulRate = stats.feedback.usefulRate === null
    ? 'n/a（暂无反馈样本）'
    : `${Math.round(stats.feedback.usefulRate * 100)}%`;
  const firstPresentationMedian = stats.surfacing.medianHoursToFirstPresentation === null
    ? 'n/a'
    : `${Math.round(stats.surfacing.medianHoursToFirstPresentation)} 小时`;
  const usefulRateInWindow = stats.feedback.usefulRateInWindow === null
    ? 'n/a'
    : `${Math.round(stats.feedback.usefulRateInWindow * 100)}%`;
  const feedbackSample = stats.feedback.forgotten + stats.feedback.noise;
  const feedbackWindowSample = stats.feedback.forgottenInWindow
    + stats.feedback.noiseInWindow;
  const feedbackSampleNote = feedbackSample < 20
    ? `（样本不足 n=${feedbackSample}）`
    : `（n=${feedbackSample}）`;
  const feedbackWindowNote = feedbackWindowSample < 20
    ? `（样本不足 n=${feedbackWindowSample}）`
    : `（n=${feedbackWindowSample}）`;
  const lines = [
    '# 开放循环统计',
    '',
    `- 全部 ${stats.totals.all} 条：open ${stats.totals.open}（真实 ${stats.totals.open - stats.projectSummary.sessionOnlyOpen} / 临时 ${stats.projectSummary.sessionOnlyOpen}）/ pending ${stats.totals.pending}（真实 ${stats.totals.pending - stats.projectSummary.sessionOnlyPending} / 临时 ${stats.projectSummary.sessionOnlyPending}）/ snoozed ${stats.totals.snoozed} / resolved ${stats.totals.resolved} / dropped ${stats.totals.dropped}`,
    `- 来源：用户 ${stats.totals.origins.user} / 助手 ${stats.totals.origins.assistant} / 混合 ${stats.totals.origins.mixed}`,
    `- 已关闭 ${closed} / ${stats.totals.all}（${closurePercent}）；其中完成 ${stats.totals.resolved}、放弃 ${droppedByUser}；自摄入清理 ${stats.resolution.selfGeneratedDropped} 条不计入`,
    `- 中位关闭耗时 ${median}`,
    `- 近 ${stats.windowDays} 天关闭 ${stats.resolution.resolvedInWindow} 条；首次展示 ${stats.surfacing.firstPresentedInWindow} 条，展示后关闭 ${stats.surfacing.resolvedAfterPresentationInWindow} 条`,
    `- 累计展示 ${stats.surfacing.presented} 条（成功标记回访 ${stats.surfacing.surfaced} 条），展示后关闭 ${stats.surfacing.resolvedAfterPresentation} 条；首次展示中位 ${firstPresentationMedian}`,
    `- 展示类型（按批次）：hot ${stats.surfacing.presentationsByKind.hot} 次 / recap ${stats.surfacing.presentationsByKind.recap} 次 / review ${stats.surfacing.presentationsByKind.review} 次 / teaser ${stats.surfacing.presentationsByKind.teaser} 次 / candidate ${stats.surfacing.presentationsByKind.candidate} 次`,
    `- 历史反馈：确实忘了 ${stats.feedback.forgotten} 条 / 噪音 ${stats.feedback.noise} 条；有效率 ${usefulRate}${feedbackSampleNote}`,
    `- 近 ${stats.windowDays} 天反馈：确实忘了 ${stats.feedback.forgottenInWindow} 条 / 噪音 ${stats.feedback.noiseInWindow} 条；有效率 ${usefulRateInWindow}${feedbackWindowNote}`,
  ];
  if (stats.surfacing.futurePresentations > 0) {
    lines.push(
      `- 已忽略 ${stats.surfacing.futurePresentations} 条未来时间的展示记录；请检查系统时钟或导入数据`,
    );
  }
  if (stats.lastIngest) {
    const errors = stats.lastIngest.errors.length > 0
      ? `，错误 ${stats.lastIngest.errors.length}`
      : '';
    lines.push(
      `- 最近摄入 ${stats.lastIngest.startedAt}：新增 ${stats.lastIngest.loopsCreated}、合并 ${stats.lastIngest.loopsMerged}${errors}`,
    );
  }
  const realProjects = stats.projects.filter((project) => !project.sessionOnly);
  if (realProjects.length > 0 || stats.projectSummary.sessionOnly > 0) {
    lines.push('', `## 项目分布（真实 ${stats.projectSummary.real} / 临时 ${stats.projectSummary.sessionOnly}）`);
    for (const project of realProjects.slice(0, 8)) {
      lines.push(
        `- **${project.projectName}** · open ${project.open} / pending ${project.pending}`,
      );
    }
    if (realProjects.length > 8) {
      lines.push(`- 另有 ${realProjects.length - 8} 个真实项目`);
    }
    if (stats.projectSummary.sessionOnly > 0) {
      lines.push(
        `- 另有 ${stats.projectSummary.sessionOnly} 个临时会话工作区：open ${stats.projectSummary.sessionOnlyOpen} / pending ${stats.projectSummary.sessionOnlyPending}`,
      );
    }
  }
  if (stats.staleOpen.length > 0) {
    lines.push('', `## 陈旧未闭环 (${stats.staleOpen.length})`);
    for (const item of stats.staleOpen.slice(0, 10)) {
      lines.push(`- ${item.projectName} · ${item.title} · ${item.daysStale} 天未动`);
    }
  }
  return lines.join('\n');
}
