import * as path from 'node:path';
import { LoopStore } from './loop-store.js';
import { loadProjectMap } from './project-map.js';
import {
  buildProjectOverview,
  formatProjectSection,
  formatRelativeTime,
  isSessionOnlyProject,
} from './projects.js';
import { isNoiseSuppressed } from './feedback.js';
import { resolveDefaultDbPath } from './data-path.js';
import type {
  DigestGroup,
  DigestResult,
  LoopRecord,
  ProjectActivity,
  ProjectSummary,
  ReconcileCacheCandidate,
} from './types.js';
import { loopRef } from './loop-ref.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export interface DigestOptions {
  mode?: 'hot' | 'review';
  now?: Date;
  hotDays?: number;
  activeDays?: number;
  maxProjects?: number;
  maxLoops?: number;
  projectLimit?: number;
  dbPath?: string;
  store?: LoopStore;
  markSurfaced?: boolean;
  readonlyRotation?: boolean;
  cooldownHours?: number;
  dailySurfaceLimit?: number;
  revisitDays?: number;
  force?: boolean;
  cacheWarnHours?: number;
  recapCooldownMinutes?: number;
  focusProjectDir?: string;
  magpieHome?: string;
}

interface ProjectBucket {
  activity: ProjectActivity;
  loops: LoopRecord[];
}

function activityFor(
  projectDir: string,
  activities: Map<string, ProjectActivity>,
  loops: LoopRecord[],
): ProjectActivity {
  const existing = activities.get(projectDir);
  if (existing) return existing;
  const latest = loops.reduce(
    (value, loop) => (loop.lastSeen > value ? loop.lastSeen : value),
    loops[0]?.lastSeen ?? new Date(0).toISOString(),
  );
  return {
    projectDir,
    projectName: loops[0]?.projectName ?? 'unknown',
    lastActive: latest,
    sessionCount: 0,
  };
}

function isCoolingDown(loop: LoopRecord, nowMs: number, cooldownHours: number): boolean {
  if (!loop.lastSurfacedAt) return false;
  return nowMs - Date.parse(loop.lastSurfacedAt) < cooldownHours * HOUR_MS;
}

function lastSurfacedMs(loop: LoopRecord): number {
  const parsed = Date.parse(loop.lastSurfacedAt ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function isSnoozed(loop: LoopRecord, nowMs: number): boolean {
  return loop.status === 'snoozed'
    && Boolean(loop.snoozeUntil)
    && Date.parse(loop.snoozeUntil!) > nowMs;
}

function localDayBounds(now: Date): { start: Date; end: Date } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

function usable(
  loop: LoopRecord,
  nowMs: number,
  cooldownHours: number,
  applyCooldown: boolean,
): boolean {
  if (loop.status === 'resolved' || loop.status === 'dropped') return false;
  if (isSnoozed(loop, nowMs)) return false;
  if (applyCooldown && isCoolingDown(loop, nowMs, cooldownHours)) return false;
  return true;
}

function rank(loop: LoopRecord, mode: 'hot' | 'review', nowMs: number): number {
  const statusWeight = loop.status === 'open' ? 1000 : loop.status === 'pending' ? 0 : 100;
  const base = statusWeight + loop.confidence * 100;
  const firstSeenMs = Date.parse(loop.firstSeen);
  const ageDays = Number.isFinite(firstSeenMs)
    ? Math.max(0, (nowMs - firstSeenMs) / DAY_MS)
    : 0;
  if (mode !== 'review') return base + Math.min(30, ageDays * 2);

  const unseenBonus = loop.lastSurfacedAt ? 0 : 120;
  const ageBonus = Math.min(60, ageDays * 2);
  const surfacePenalty = loop.lastSurfacedAt ? 60 : 0;
  return base + unseenBonus + ageBonus - surfacePenalty - loop.ignoredCount * 20;
}

function projectScore(bucket: ProjectBucket, mode: 'hot' | 'review', nowMs: number): number {
  const maxRank = bucket.loops.reduce(
    (value, loop) => Math.max(value, rank(loop, mode, nowMs)),
    0,
  );
  const openCount = bucket.loops.filter((loop) => loop.status === 'open').length;
  const activityAgeHours = Math.max(0, (nowMs - Date.parse(bucket.activity.lastActive)) / HOUR_MS);
  const sessionPenalty = isSessionOnlyProject(bucket.activity.projectName) ? 8 : 0;
  return maxRank
    + Math.min(10, openCount) * 4
    - Math.min(30, activityAgeHours / 4)
    - sessionPenalty;
}

function projectLastSurface(bucket: ProjectBucket, mode: 'hot' | 'review'): number {
  if (mode === 'review') {
    return bucket.loops.reduce(
      (earliest, loop) => Math.min(earliest, lastSurfacedMs(loop)),
      Number.POSITIVE_INFINITY,
    );
  }
  return bucket.loops.reduce(
    (latest, loop) => Math.max(latest, lastSurfacedMs(loop)),
    0,
  );
}

function pathKey(value: string): string {
  return value.trim().replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
}

function pickReviewTeaser(
  loops: LoopRecord[],
  displayedIds: Set<string>,
  nowMs: number,
  recent: (loop: LoopRecord) => boolean,
  focusKey?: string,
  focusKnown?: boolean,
): LoopRecord | undefined {
  const candidates = loops.filter((loop) => {
    if (displayedIds.has(loop.id)) return false;
    if (loop.status !== 'open' && loop.status !== 'pending') return false;
    if (recent(loop)) return false;
    if (focusKey !== undefined && focusKnown && pathKey(loop.projectDir) !== focusKey) {
      return false;
    }
    return true;
  });
  if (candidates.length === 0) return undefined;

  const neverSurfaced = candidates.filter((loop) => !loop.lastSurfacedAt);
  const staleSurfaced = candidates.filter((loop) => {
    const surfacedMs = Date.parse(loop.lastSurfacedAt ?? '');
    return !Number.isFinite(surfacedMs) || nowMs - surfacedMs >= 7 * DAY_MS;
  });
  const pool = neverSurfaced.length > 0
    ? neverSurfaced
    : staleSurfaced.length > 0
      ? staleSurfaced
      : candidates;

  return [...pool].sort((left, right) => {
    const leftSessionOnly = isSessionOnlyProject(left.projectName) ? 1 : 0;
    const rightSessionOnly = isSessionOnlyProject(right.projectName) ? 1 : 0;
    if (leftSessionOnly !== rightSessionOnly) return leftSessionOnly - rightSessionOnly;
    if (left.status !== right.status) return left.status === 'open' ? -1 : 1;
    const ageDiff = Date.parse(left.firstSeen) - Date.parse(right.firstSeen);
    if (Number.isFinite(ageDiff) && ageDiff !== 0) return ageDiff;
    return right.confidence - left.confidence;
  })[0];
}

function resolveFocusProject(
  projectDir: string,
  magpieHome?: string,
): { dir: string; name: string } {
  try {
    return loadProjectMap(magpieHome).resolve(projectDir);
  } catch {
    const normalized = projectDir.trim().replace(/[\\/]+$/, '');
    return {
      dir: normalized,
      name: path.basename(normalized) || 'unknown',
    };
  }
}

function matchFocusBucket(
  buckets: ProjectBucket[],
  focusDir: string,
): ProjectBucket | undefined {
  const focusKey = pathKey(focusDir);
  const exact = buckets.find(
    (bucket) => pathKey(bucket.activity.projectDir) === focusKey,
  );
  if (exact) return exact;
  return buckets
    .filter((bucket) => focusKey.startsWith(`${pathKey(bucket.activity.projectDir)}/`))
    .sort((left, right) =>
      pathKey(right.activity.projectDir).length - pathKey(left.activity.projectDir).length,
    )[0];
}

function selectWithFocus(
  projects: ProjectBucket[],
  maxProjects: number,
  maxLoops: number,
  focus?: ProjectBucket,
): { groups: DigestGroup[]; focusShown: number } {
  const slots = Math.max(0, maxLoops);
  if (!focus || slots === 0) {
    return {
      groups: roundRobin(projects.slice(0, maxProjects), slots),
      focusShown: 0,
    };
  }

  const focusGroups = roundRobin([focus], slots);
  const focusGroup = focusGroups[0];
  const focusShown = focusGroup?.loops.length ?? 0;
  const remaining = Math.max(0, slots - focusShown);
  const otherProjects = projects
    .filter((project) => project !== focus)
    .slice(0, Math.max(0, maxProjects - 1));
  const otherGroups = remaining > 0 ? roundRobin(otherProjects, remaining) : [];
  return {
    groups: [focusGroup, ...otherGroups]
      .filter((group): group is DigestGroup => Boolean(group)),
    focusShown,
  };
}

function countShown(groups: DigestGroup[]): number {
  return groups.reduce((sum, group) => sum + group.loops.length, 0);
}

function countAvailable(buckets: ProjectBucket[]): number {
  return buckets.reduce((sum, bucket) => sum + bucket.loops.length, 0);
}

function selectReview(projects: ProjectBucket[], maxLoops: number): DigestGroup[] {
  const slots = Math.max(0, maxLoops);
  if (slots === 0) return [];
  const real = projects.filter((project) => !isSessionOnlyProject(project.activity.projectName));
  const session = projects.filter((project) => isSessionOnlyProject(project.activity.projectName));
  const sessionCap = Math.min(slots, Math.min(5, Math.max(1, Math.floor(slots / 3))));
  const realAvailable = countAvailable(real);
  const sessionAvailable = countAvailable(session);
  const sessionReserved = Math.min(sessionAvailable, sessionCap, slots);
  const realSlots = Math.min(realAvailable, slots - sessionReserved);
  const sessionSlots = Math.min(sessionAvailable, slots - realSlots);
  const realGroups = roundRobin(real, realSlots);
  const sessionGroups = roundRobin(session, sessionSlots);
  return [...realGroups, ...sessionGroups];
}

function roundRobin(buckets: ProjectBucket[], maxLoops: number): DigestGroup[] {
  const groups: DigestGroup[] = buckets.map((bucket) => ({
    projectDir: bucket.activity.projectDir,
    projectName: bucket.activity.projectName,
    lastActive: bucket.activity.lastActive,
    loops: [],
  }));
  let cursor = 0;
  let taken = 0;
  while (taken < maxLoops) {
    let added = false;
    for (let index = 0; index < buckets.length && taken < maxLoops; index += 1) {
      const bucket = buckets[(cursor + index) % buckets.length];
      const group = groups[(cursor + index) % buckets.length];
      const next = bucket.loops.shift();
      if (!next) continue;
      group.loops.push(next);
      taken += 1;
      added = true;
    }
    if (!added) break;
    cursor = (cursor + 1) % Math.max(1, buckets.length);
  }
  return groups.filter((group) => group.loops.length > 0);
}

function rotateItems<T>(items: T[], offset: number): T[] {
  if (items.length < 2) return items;
  const index = ((offset % items.length) + items.length) % items.length;
  if (index === 0) return items;
  return [...items.slice(index), ...items.slice(0, index)];
}

function buildProjectBuckets(
  loops: LoopRecord[],
  activities: Map<string, ProjectActivity>,
  mode: 'hot' | 'review',
  nowMs: number,
  cutoff: number,
  requireRecent: boolean,
  readonlyRotation: boolean,
  rotationOffset: number,
  projectLastSurfaceOverride?: Map<string, number>,
): ProjectBucket[] {
  const byProject = new Map<string, LoopRecord[]>();
  for (const loop of loops) {
    const bucket = byProject.get(loop.projectDir) ?? [];
    bucket.push(loop);
    byProject.set(loop.projectDir, bucket);
  }

  const projects: ProjectBucket[] = [];
  for (const [projectDir, projectLoops] of byProject) {
    const sorted = projectLoops.sort((left, right) => {
      const surfaceDiff = lastSurfacedMs(left) - lastSurfacedMs(right);
      if (surfaceDiff !== 0) return surfaceDiff;
      const rankDiff = rank(right, mode, nowMs) - rank(left, mode, nowMs);
      return rankDiff !== 0 ? rankDiff : right.lastSeen.localeCompare(left.lastSeen);
    });
    if (sorted.length === 0) continue;
    const activity = activityFor(projectDir, activities, sorted);
    if (requireRecent && Date.parse(activity.lastActive) < cutoff) continue;
    projects.push({
      activity,
      loops: readonlyRotation ? rotateItems(sorted, rotationOffset) : sorted,
    });
  }

  projects.sort((left, right) => {
    if (mode === 'review') {
      const leftSession = isSessionOnlyProject(left.activity.projectName) ? 1 : 0;
      const rightSession = isSessionOnlyProject(right.activity.projectName) ? 1 : 0;
      if (leftSession !== rightSession) return leftSession - rightSession;
    }
    const leftSurface = projectLastSurfaceOverride?.get(left.activity.projectDir)
      ?? projectLastSurface(left, mode);
    const rightSurface = projectLastSurfaceOverride?.get(right.activity.projectDir)
      ?? projectLastSurface(right, mode);
    const surfaceDiff = leftSurface - rightSurface;
    if (surfaceDiff !== 0) return surfaceDiff;
    const scoreDiff = projectScore(right, mode, nowMs) - projectScore(left, mode, nowMs);
    return scoreDiff !== 0
      ? scoreDiff
      : right.activity.lastActive.localeCompare(left.activity.lastActive);
  });

  return readonlyRotation ? rotateItems(projects, rotationOffset) : projects;
}

function selectPool(
  pool: ProjectBucket[],
  maxProjects: number,
  quota: number,
  focusDir?: string,
): DigestGroup[] {
  if (quota <= 0 || pool.length === 0) return [];
  const focus = focusDir ? matchFocusBucket(pool, focusDir) : undefined;
  return selectWithFocus(pool, maxProjects, quota, focus).groups;
}

function takeGroups(
  groups: DigestGroup[],
  selected: LoopRecord[],
  selectedIds: Set<string>,
): number {
  let count = 0;
  for (const group of groups) {
    for (const loop of group.loops) {
      if (selectedIds.has(loop.id)) continue;
      selectedIds.add(loop.id);
      selected.push(loop);
      count += 1;
    }
  }
  return count;
}

function groupSelectedLoops(
  loops: LoopRecord[],
  activities: Map<string, ProjectActivity>,
): DigestGroup[] {
  const byProject = new Map<string, LoopRecord[]>();
  for (const loop of loops) {
    const bucket = byProject.get(loop.projectDir) ?? [];
    bucket.push(loop);
    byProject.set(loop.projectDir, bucket);
  }
  return [...byProject.entries()].map(([projectDir, projectLoops]) => {
    const activity = activityFor(projectDir, activities, projectLoops);
    return {
      projectDir,
      projectName: activity.projectName,
      lastActive: activity.lastActive,
      loops: projectLoops,
    };
  });
}

export function buildDigest(options: DigestOptions = {}): DigestResult {
  const ownsStore = options.store === undefined;
  const store = options.store ?? new LoopStore(options.dbPath ?? resolveDefaultDbPath());
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const mode = options.mode ?? 'hot';
  const hotDays = options.hotDays ?? 3;
  const activeDays = options.activeDays ?? 7;
  const cooldownHours = options.cooldownHours ?? 24;
  const maxProjects = options.maxProjects ?? (mode === 'hot' ? 3 : 20);
  const maxLoops = options.maxLoops ?? (mode === 'hot' ? 3 : 15);
  const dailySurfaceLimit = options.dailySurfaceLimit ?? 3;
  const revisitDays = Math.max(1, options.revisitDays ?? 3);
    const recapCooldownMinutes = Math.max(0, options.recapCooldownMinutes ?? 30);
  const projectLimit = options.projectLimit ?? 100;

  try {
    const activities = new Map(
      store.listProjectActivity(undefined, 300).map((item) => [item.projectDir, item]),
    );
    const activeLoops = store.listActiveLoops();
    const presentedLoops = store.getPresentationStats(now.toISOString());
    const closingTotal = activeLoops.filter((loop) =>
      (loop.status === 'open' || loop.status === 'pending') && presentedLoops.has(loop.id)).length;
    const latestFeedback = new Map(
      store.getLatestFeedback().map((feedback) => [feedback.loopId, feedback]),
    );
    const noiseSuppressedIds = new Set(
      activeLoops
        .filter((loop) => isNoiseSuppressed(loop, latestFeedback.get(loop.id)))
        .map((loop) => loop.id),
    );
    const actionableLoops = activeLoops.filter((loop) => !noiseSuppressedIds.has(loop.id));
    const reviewConfirmed = mode === 'review'
      ? actionableLoops
        .filter((loop) => latestFeedback.get(loop.id)?.verdict === 'forgotten')
        .filter((loop) => loop.status === 'open' || loop.status === 'pending')
        .filter((loop) => !isSnoozed(loop, nowMs))
        .sort((left, right) => {
          const leftLast = Math.max(
            Date.parse(left.lastSurfacedAt ?? '') || 0,
            Date.parse(left.lastPresentedAt ?? '') || 0,
          );
          const rightLast = Math.max(
            Date.parse(right.lastSurfacedAt ?? '') || 0,
            Date.parse(right.lastPresentedAt ?? '') || 0,
          );
          if (leftLast !== rightLast) return leftLast - rightLast;
          const ageDiff = Date.parse(left.firstSeen) - Date.parse(right.firstSeen);
          if (Number.isFinite(ageDiff) && ageDiff !== 0) return ageDiff;
          return right.confidence - left.confidence;
        })
        .slice(0, 10)
      : [];
    const focusProject = mode === 'hot' && options.focusProjectDir
      ? resolveFocusProject(options.focusProjectDir, options.magpieHome)
      : undefined;
    const focusKey = focusProject ? pathKey(focusProject.dir) : undefined;
    const focusKnown = focusKey !== undefined && (
      activeLoops.some((loop) => pathKey(loop.projectDir) === focusKey)
      || [...activities.keys()].some((dir) => pathKey(dir) === focusKey)
    );
    const focusBacklog = focusKey !== undefined
      ? activeLoops.filter((loop) => pathKey(loop.projectDir) === focusKey).length
      : 0;
    const focusClosingTotal = focusKey !== undefined
      ? activeLoops.filter((loop) =>
        (loop.status === 'open' || loop.status === 'pending')
        && pathKey(loop.projectDir) === focusKey
        && presentedLoops.has(loop.id)).length
      : undefined;
    const coolingCandidates = actionableLoops.filter((loop) =>
      !isSnoozed(loop, nowMs)
      && (mode === 'review' || loop.confidence >= 0.6),
    );
    const coolingDown = coolingCandidates
      .filter((loop) => isCoolingDown(loop, nowMs, cooldownHours))
      .length;
    const dailyCapConfigured = mode === 'hot' && dailySurfaceLimit > 0;
    const dailyCapActive = dailyCapConfigured && !options.force;
    const today = localDayBounds(now);
    const dailySurfacedBefore = dailyCapConfigured
      ? store.countSurfacedBetween(today.start.toISOString(), today.end.toISOString())
      : 0;
    const dailyRemaining = dailyCapActive
      ? Math.max(0, dailySurfaceLimit - dailySurfacedBefore)
      : maxLoops;
    const dailyCapReached = dailyCapActive && dailyRemaining === 0;
    const recentWeeklyReview = store.getLatestPresentationByKind(
      'review',
      7 * 24 * 60,
      nowMs,
    );
    const recentReviewTeaser = store.getLatestPresentationByKind(
      'teaser',
      24 * 60,
      nowMs,
    );
    const reviewDue = mode === 'hot'
      && dailySurfaceLimit > 0
      && dailySurfacedBefore === 0
      && activeLoops.length > 0
      && !recentWeeklyReview;
    const rotationStep = mode === 'hot'
      ? Math.max(1, Math.min(maxLoops, dailySurfaceLimit > 0 ? dailySurfaceLimit : maxLoops))
      : Math.max(1, maxLoops);
    const rotationDay = now.getFullYear() * 10_000
      + (now.getMonth() + 1) * 100
      + now.getDate();
    const rotationOffset = options.readonlyRotation
      ? rotationDay * rotationStep
      : 0;
    const recapCandidates = dailyCapReached
      ? actionableLoops
        .filter((loop) => loop.status === 'open' || loop.status === 'pending')
        .filter((loop) => {
          if (!loop.hotSurfacedAt) return false;
          const surfacedMs = Date.parse(loop.hotSurfacedAt);
          return Number.isFinite(surfacedMs)
            && surfacedMs >= today.start.getTime()
            && surfacedMs < today.end.getTime();
        })
        .filter((loop) => !isSnoozed(loop, nowMs))
        .filter((loop) => {
          const feedback = latestFeedback.get(loop.id);
          if (!feedback) return true;
          const feedbackMs = Date.parse(feedback.createdAt);
          const surfacedMs = Date.parse(loop.hotSurfacedAt!);
          return Number.isFinite(feedbackMs) && Number.isFinite(surfacedMs)
            ? feedbackMs < surfacedMs
            : true;
        })
        .sort((left, right) => {
          const timeDiff = Date.parse(right.hotSurfacedAt!)
            - Date.parse(left.hotSurfacedAt!);
          return timeDiff !== 0 ? timeDiff : right.confidence - left.confidence;
        })
      : [];
    const recapPool = focusKey !== undefined && focusKnown
      ? recapCandidates.filter((loop) => pathKey(loop.projectDir) === focusKey)
      : recapCandidates;
    const recap = recapPool.slice(0, Math.min(maxLoops, dailySurfaceLimit));
    const recapBaseLength = recap.length;
    const recapFocusEmpty = dailyCapReached
      && focusKey !== undefined
      && focusKnown
      && recapCandidates.length > 0
      && recapBaseLength === 0;
    const recentRecapIds = recap.length > 0 && recapCooldownMinutes > 0
      ? store.getPresentedLoopIdsByKind(
          'recap',
          new Date(nowMs - recapCooldownMinutes * 60_000).toISOString(),
        )
      : new Set<string>();
    const recapIds = new Set(recap.map((loop) => loop.id));
    const recapThrottled = recap.some((loop) => recentRecapIds.has(loop.id));
    const recapConfirmedIds: string[] = [];
    if (dailyCapReached) {
      const staleBeforeMs = nowMs - 24 * HOUR_MS;
      const confirmedFallback = actionableLoops
        .filter((loop) => latestFeedback.get(loop.id)?.verdict === 'forgotten')
        .filter((loop) => loop.status === 'open' || loop.status === 'pending')
        .filter((loop) => !isSnoozed(loop, nowMs))
        .filter((loop) => !noiseSuppressedIds.has(loop.id))
        .filter((loop) => !recapIds.has(loop.id))
        .filter((loop) => {
          const hotMs = loop.hotSurfacedAt ? Date.parse(loop.hotSurfacedAt) : NaN;
          if (
            Number.isFinite(hotMs)
            && hotMs >= today.start.getTime()
            && hotMs < today.end.getTime()
          ) {
            return false;
          }
          const surfacedMs = loop.lastSurfacedAt ? Date.parse(loop.lastSurfacedAt) : NaN;
          const presentedMs = loop.lastPresentedAt ? Date.parse(loop.lastPresentedAt) : NaN;
          const latestMs = Math.max(
            Number.isFinite(surfacedMs) ? surfacedMs : 0,
            Number.isFinite(presentedMs) ? presentedMs : 0,
          );
          return latestMs === 0 || latestMs <= staleBeforeMs;
        })
        .sort((left, right) => {
          const leftNever = !left.lastSurfacedAt;
          const rightNever = !right.lastSurfacedAt;
          if (leftNever !== rightNever) return leftNever ? -1 : 1;
          const leftMs = Date.parse(left.lastSurfacedAt ?? '') || 0;
          const rightMs = Date.parse(right.lastSurfacedAt ?? '') || 0;
          if (leftMs !== rightMs) return leftMs - rightMs;
          const ageDiff = Date.parse(left.firstSeen) - Date.parse(right.firstSeen);
          if (Number.isFinite(ageDiff) && ageDiff !== 0) return ageDiff;
          return right.confidence - left.confidence;
        })[0];
      if (confirmedFallback) {
        recap.push(confirmedFallback);
        recapIds.add(confirmedFallback.id);
        recapConfirmedIds.push(confirmedFallback.id);
      }
    }
    const loops = actionableLoops
      .filter((loop) => usable(loop, nowMs, cooldownHours, mode === 'hot'))
      .filter((loop) => mode === 'review' || loop.status === 'open' || loop.confidence >= 0.6);

    const projectWindowDays = mode === 'hot' ? hotDays : activeDays;
    const cutoff = nowMs - projectWindowDays * DAY_MS;
    const projectLastSurfaceMap = new Map<string, number>();
    for (const loop of loops) {
      const current = projectLastSurfaceMap.get(loop.projectDir);
      const next = lastSurfacedMs(loop);
      if (mode === 'review') {
        projectLastSurfaceMap.set(
          loop.projectDir,
          Math.min(current ?? Number.POSITIVE_INFINITY, next),
        );
      } else {
        projectLastSurfaceMap.set(loop.projectDir, Math.max(current ?? 0, next));
      }
    }
    const allProjects = buildProjectBuckets(
      loops,
      activities,
      mode,
      nowMs,
      cutoff,
      false,
      Boolean(options.readonlyRotation),
      rotationOffset,
      projectLastSurfaceMap,
    );
    let reviewCycleSeen = mode === 'review'
      ? store.getReviewCycleSeen(loops.map((loop) => loop.id))
      : undefined;
    let focusBucket: ProjectBucket | undefined;
    let selected: DigestGroup[] = [];
    let focusShown = 0;
    let revisitReady = 0;
    let revisitWaiting = 0;
    const projectRecent = new Map<string, boolean>();
    const loopsByProject = new Map<string, LoopRecord[]>();
    for (const loop of actionableLoops) {
      const bucket = loopsByProject.get(loop.projectDir) ?? [];
      bucket.push(loop);
      loopsByProject.set(loop.projectDir, bucket);
    }
    for (const [projectDir, projectLoops] of loopsByProject) {
      const activity = activityFor(projectDir, activities, projectLoops);
      projectRecent.set(projectDir, Date.parse(activity.lastActive) >= cutoff);
    }
    const recent = (loop: LoopRecord): boolean =>
      projectRecent.get(loop.projectDir) === true;
    const reviewProjects = mode === 'review'
      ? allProjects
        .map((bucket) => ({
          ...bucket,
          loops: bucket.loops.filter(
            (loop) => latestFeedback.get(loop.id)?.verdict !== 'forgotten',
          ),
        }))
        .filter((bucket) => bucket.loops.length > 0)
      : allProjects;

    if (mode === 'review') {
      const unseenProjects = reviewCycleSeen
        ? reviewProjects
          .map((bucket) => ({
            ...bucket,
            loops: bucket.loops.filter((loop) => !reviewCycleSeen!.has(loop.id)),
          }))
          .filter((bucket) => bucket.loops.length > 0)
        : reviewProjects;
      selected = selectReview(
        (unseenProjects.length > 0 ? unseenProjects : reviewProjects).slice(0, maxProjects),
        Math.min(maxLoops, dailyRemaining),
      );
    } else {
      const confirmed = (loop: LoopRecord): boolean =>
        latestFeedback.get(loop.id)?.verdict === 'forgotten';

      const freshLoops = loops.filter(
        (loop) => !loop.hotSurfacedAt && recent(loop),
      );
      const followLoops = loops.filter((loop) => {
        if (!confirmed(loop)) return false;
        if (!loop.hotSurfacedAt) return !recent(loop);
        const hotMs = Date.parse(loop.hotSurfacedAt);
        return Number.isFinite(hotMs)
          && nowMs - hotMs >= revisitDays * DAY_MS;
      });
      const revisitLoops = loops.filter((loop) => {
        if (confirmed(loop) || !loop.hotSurfacedAt || !recent(loop)) return false;
        const hotMs = Date.parse(loop.hotSurfacedAt);
        return Number.isFinite(hotMs)
          && nowMs - hotMs >= revisitDays * DAY_MS;
      });
      const dueIds = new Set(
        [...followLoops, ...revisitLoops].map((loop) => loop.id),
      );
      const oldFillLoops = loops.filter((loop) => {
        if (dueIds.has(loop.id)) return false;
        if (loop.hotSurfacedAt) {
          const hotMs = Date.parse(loop.hotSurfacedAt);
          if (!Number.isFinite(hotMs)) return false;
          if (nowMs - hotMs < cooldownHours * HOUR_MS) return false;
          return recent(loop) || confirmed(loop);
        }
        return confirmed(loop) && !recent(loop);
      });
      revisitReady = followLoops.length + revisitLoops.length;
      revisitWaiting = loops.filter((loop) => {
        if (!loop.hotSurfacedAt) return false;
        const hotMs = Date.parse(loop.hotSurfacedAt);
        if (!Number.isFinite(hotMs)) return false;
        if (nowMs - hotMs < cooldownHours * HOUR_MS) return false;
        if (nowMs - hotMs >= revisitDays * DAY_MS) return false;
        return recent(loop) || confirmed(loop);
      }).length;

      const freshProjects = buildProjectBuckets(
        freshLoops,
        activities,
        'hot',
        nowMs,
        cutoff,
        true,
        Boolean(options.readonlyRotation),
        rotationOffset,
        projectLastSurfaceMap,
      );
      const followProjects = buildProjectBuckets(
        followLoops,
        activities,
        'hot',
        nowMs,
        cutoff,
        false,
        false,
        0,
        projectLastSurfaceMap,
      );
      const confirmedPriorityLoops = [...freshLoops, ...followLoops]
        .filter((loop) => confirmed(loop));
      const confirmedPriorityProjects = buildProjectBuckets(
        confirmedPriorityLoops,
        activities,
        'hot',
        nowMs,
        cutoff,
        false,
        false,
        0,
        projectLastSurfaceMap,
      );
      const revisitProjects = buildProjectBuckets(
        revisitLoops,
        activities,
        'hot',
        nowMs,
        cutoff,
        false,
        false,
        0,
        projectLastSurfaceMap,
      );
      const oldFillProjects = buildProjectBuckets(
        oldFillLoops,
        activities,
        'hot',
        nowMs,
        cutoff,
        false,
        false,
        0,
        projectLastSurfaceMap,
      );
      if (focusProject) {
        const eligibleDirs = new Set(
          [...freshLoops, ...followLoops, ...revisitLoops, ...oldFillLoops]
            .map((loop) => loop.projectDir),
        );
        focusBucket = matchFocusBucket(
          allProjects.filter((project) => eligibleDirs.has(project.activity.projectDir)),
          focusProject.dir,
        );
      }

      const slots = Math.min(maxLoops, dailyRemaining);
      const freshAvailable = countAvailable(freshProjects);
      const followAvailable = countAvailable(followProjects);
      const revisitAvailable = countAvailable(revisitProjects);
      const selectedLoops: LoopRecord[] = [];
      const selectedIds = new Set<string>();
      const focusDir = focusBucket?.activity.projectDir;
      let remaining = slots;
      const confirmedQuota = confirmedPriorityLoops.length > 0
        ? Math.min(1, remaining)
        : 0;
      remaining -= takeGroups(
        selectPool(
          confirmedPriorityProjects,
          maxProjects,
          confirmedQuota,
          focusDir,
        ),
        selectedLoops,
        selectedIds,
      );
      let freshQuota = remaining;
      let followQuota = 0;
      let revisitQuota = 0;
      if (
        selectedLoops.length === 0
        && remaining >= 2
        && freshAvailable >= remaining
        && (followAvailable > 0 || revisitAvailable > 0)
      ) {
        if (followAvailable > 0) followQuota = 1;
        else revisitQuota = 1;
        freshQuota = remaining - 1;
      }

      remaining -= takeGroups(
        selectPool(freshProjects, maxProjects, Math.min(freshQuota, remaining), focusDir),
        selectedLoops,
        selectedIds,
      );
      remaining -= takeGroups(
        selectPool(followProjects, maxProjects, Math.min(followQuota, remaining), focusDir),
        selectedLoops,
        selectedIds,
      );
      remaining -= takeGroups(
        selectPool(revisitProjects, maxProjects, Math.min(revisitQuota, remaining), focusDir),
        selectedLoops,
        selectedIds,
      );
      if (remaining > 0) {
        remaining -= takeGroups(
          selectPool(followProjects, maxProjects, remaining, focusDir),
          selectedLoops,
          selectedIds,
        );
      }
      if (remaining > 0) {
        remaining -= takeGroups(
          selectPool(revisitProjects, maxProjects, remaining, focusDir),
          selectedLoops,
          selectedIds,
        );
      }
      if (remaining > 0) {
        takeGroups(
          selectPool(oldFillProjects, maxProjects, remaining, focusDir),
          selectedLoops,
          selectedIds,
        );
      }

      selected = groupSelectedLoops(selectedLoops, activities);
      focusShown = focusDir
        ? selectedLoops.filter(
            (loop) => pathKey(loop.projectDir) === pathKey(focusDir),
          ).length
        : 0;
    }
    const ids = selected.flatMap((group) => group.loops.map((loop) => loop.id));
    const displayedIds = new Set(ids);
    const reviewPick = mode === 'hot' && reviewDue && !recentReviewTeaser
      ? pickReviewTeaser(actionableLoops, displayedIds, nowMs, recent, focusKey, focusKnown)
      : undefined;
    const activeIds = new Set(activeLoops.map((loop) => loop.id));
    const confirmedIds = [...latestFeedback.values()]
      .filter((feedback) => feedback.verdict === 'forgotten')
      .map((feedback) => feedback.loopId)
      .filter((id) => activeIds.has(id));
    const activeProjects = buildProjectOverview({
      store,
      now,
      days: projectWindowDays,
      limit: projectLimit,
    });
    const marked = options.markSurfaced === false
      ? []
      : store.recordSurfaced(ids, now.toISOString(), mode === 'hot', mode).map((loop) => loop.id);
    if (options.markSurfaced !== false && reviewPick) {
      store.recordSurfaced([reviewPick.id], now.toISOString(), false, 'review');
      store.recordPresentation([reviewPick.id], now.toISOString(), 'hot', 'teaser');
    }
    const dailySurfaced = dailySurfacedBefore + (options.markSurfaced === false ? 0 : marked.length);
    const presentedIds = ids.length > 0
      ? ids
      : recapThrottled
        ? recap
          .filter((loop) => recapConfirmedIds.includes(loop.id))
          .map((loop) => loop.id)
        : recap.map((loop) => loop.id);
    if (
      options.markSurfaced !== false
      && presentedIds.length > 0
      && (ids.length > 0 || !recapThrottled || recapConfirmedIds.length > 0)
    ) {
      try {
        store.recordPresentation(
          presentedIds,
          now.toISOString(),
          mode,
          ids.length > 0 ? mode : 'recap',
        );
      } catch {
        // Presentation history is best-effort; a read-only cache must still render.
      }
    }
    if (mode === 'review') {
      reviewCycleSeen = store.getReviewCycleSeen(loops.map((loop) => loop.id));
    }

    const lastRun = store.getLastRun();
    const lastIngestAt = lastRun?.finishedAt ?? lastRun?.startedAt;
    const lastIngestMs = lastIngestAt ? Date.parse(lastIngestAt) : NaN;
    const cacheAgeHours = Number.isFinite(lastIngestMs)
      ? Math.max(0, (nowMs - lastIngestMs) / HOUR_MS)
      : undefined;
    const cacheStale = cacheAgeHours !== undefined
      && cacheAgeHours > (options.cacheWarnHours ?? 6);
    const feedbackCounts = store.getFeedbackCounts();
    const activeById = new Map(activeLoops.map((loop) => [loop.id, loop]));
    const reviewConfirmedIds = new Set(reviewConfirmed.map((loop) => loop.id));
    const pendingTotal = mode === 'review'
      ? actionableLoops.filter(
          (loop) => loop.status === 'pending'
            && !displayedIds.has(loop.id)
            && !reviewConfirmedIds.has(loop.id),
        ).length
      : undefined;
    const recentCandidateIds = mode === 'hot'
      ? store.getPresentedLoopIdsByKind(
          'candidate',
          new Date(nowMs - 24 * HOUR_MS).toISOString(),
        )
      : new Set<string>();
    const recapCloseEligible = dailyCapReached && !recapThrottled && recap.length > 0;
    const hotCloseCandidates = mode === 'hot' && (ids.length > 0 || recapCloseEligible)
      ? store.listRecentReconcileCandidates(now, 24, 10)
        .filter((item) => item.confidence >= 0.9)
        .filter((item) => !displayedIds.has(item.loopId))
        .filter((item) => !recapIds.has(item.loopId))
        .filter((item) => !recentCandidateIds.has(item.loopId))
        .filter((item) => !noiseSuppressedIds.has(item.loopId))
        .filter((item) => {
          const loop = activeById.get(item.loopId);
          if (!loop) return false;
          if (isSnoozed(loop, nowMs)) return false;
          if (loop.status !== 'open' && loop.status !== 'pending') return false;
          if (focusKey !== undefined && focusKnown) {
            return pathKey(loop.projectDir) === focusKey;
          }
          return true;
        })
        .slice(0, 1)
      : [];
    if (options.markSurfaced !== false && hotCloseCandidates.length > 0) {
      try {
        store.recordPresentation(
          [hotCloseCandidates[0].loopId],
          now.toISOString(),
          'hot',
          'candidate',
        );
      } catch {
        // Candidate history is best-effort; a read-only cache must still render.
      }
    }
    const reconcileCandidates = mode === 'review'
      ? store.listRecentReconcileCandidates(now, 24, 10)
        .filter((item) => !displayedIds.has(item.loopId))
        .filter((item) => !noiseSuppressedIds.has(item.loopId))
        .filter((item) => {
          const loop = activeById.get(item.loopId);
          if (!loop) return false;
          if (isSnoozed(loop, nowMs)) return false;
          return loop.status !== 'resolved' && loop.status !== 'dropped';
        })
        .slice(0, 3)
      : [];

    return {
      mode,
      generatedAt: now.toISOString(),
      groups: selected,
      reviewPick,
      focusProject: focusProject
        ? {
            dir: focusBucket?.activity.projectDir ?? focusProject.dir,
            name: focusBucket?.activity.projectName ?? focusProject.name,
            matched: Boolean(focusBucket),
            shown: focusShown,
            backlog: focusBacklog,
          }
        : undefined,
      reviewDue: reviewDue && ids.length > 0,
      reviewRemaining: mode === 'review'
        ? Math.max(
            0,
            loops.filter(
              (loop) => latestFeedback.get(loop.id)?.verdict !== 'forgotten',
            ).length - Math.max(
              [...(reviewCycleSeen ?? [])].filter(
                (id) => latestFeedback.get(id)?.verdict !== 'forgotten',
              ).length,
              ids.length,
            ),
          )
        : undefined,
      pendingTotal,
      closeCandidates: hotCloseCandidates,
      recap,
      recapConfirmedIds,
      reviewConfirmed,
      recapThrottled,
      recapFocusEmpty,
      closingTotal,
      focusClosingTotal,
      recapCooldownMinutes,
      total: ids.length,
      activeTotal: activeLoops.length,
      eligibleTotal: loops.length,
      coolingDown,
      dailySurfaced,
      dailySurfaceLimit,
      dailyCapReached,
      revisitDays,
      revisitReady,
      revisitWaiting,
      confirmedIds,
      noiseSuppressed: noiseSuppressedIds.size,
      feedbackTotal: feedbackCounts.forgotten + feedbackCounts.noise,
      surfacedTotal: store.countEverSurfaced(),
      marked,
      cacheAgeHours,
      cacheStale,
      activeDays: projectWindowDays,
      activeProjects,
      reconcileCandidates,
    };
  } finally {
    if (ownsStore) store.close();
  }
}

function confirmedTag(result: DigestResult, loop: LoopRecord): string {
  if (result.recapConfirmedIds.includes(loop.id)) return ' · 你确认忘了';
  return result.confirmedIds.includes(loop.id) ? ' · 已确认有用' : '';
}

function formatReviewPickLines(
  result: DigestResult,
  now: Date,
  itemNumber: number,
  skillMode: boolean,
  showSectionHeader = true,
): string[] {
  const loop = result.reviewPick;
  if (!loop) return [];
  const label = loop.status === 'pending'
    ? `待确认 ${Math.round(loop.confidence * 100)}%`
    : `${Math.round(loop.confidence * 100)}%`;
  const ageDays = Math.floor((now.getTime() - Date.parse(loop.firstSeen)) / DAY_MS);
  const age = ageDays >= 1 ? ` · 已挂 ${ageDays} 天` : '';
  const project = loop.projectName?.trim() || loop.projectDir;
  const lines = [''];
  if (showSectionHeader) lines.push('**本周回顾 · 先看 1 条**');
  lines.push(
    `${itemNumber}. **${loop.title}** · ${label}${age}${confirmedTag(result, loop)} · [ref ${loopRef(loop.id)}]`,
    `  项目：${project}`,
    `  下一步：${loop.nextAction}`,
    `  为什么现在提：${loop.why}`,
  );
  if (skillMode) lines.push('  若已完成，直接说“关闭这条”。');
  return lines;
}

function formatReviewPickOnly(
  result: DigestResult,
  now: Date,
  skillMode: boolean,
): string {
  const lines = ['# 本周回顾 · 1 条'];
  lines.push(...formatReviewPickLines(result, now, 1, skillMode, false));
  const nudge = formatReviewNudge(result);
  if (nudge) lines.push('', nudge);
  if (skillMode) {
    lines.push(
      '',
      '想让我现在处理，就说“做第 1 条”；我会先查证据再动手。',
      '回编号或 ref 看下一步和依据。',
    );
  }
  return lines.join('\n');
}

function formatConfirmedReviewLines(
  result: DigestResult,
  now: Date,
  startNumber: number,
  skillMode: boolean,
): string[] {
  if (result.reviewConfirmed.length === 0) return [];
  const lines = [
    '',
    `**你确认忘了 · ${result.reviewConfirmed.length} 条**`,
    '单独跟进，不占本轮周回顾名额；若已完成，直接说“关闭这条”。',
  ];
  result.reviewConfirmed.forEach((loop, offset) => {
    const label = loop.status === 'pending'
      ? `待确认 ${Math.round(loop.confidence * 100)}%`
      : `${Math.round(loop.confidence * 100)}%`;
    const ageDays = Math.floor((now.getTime() - Date.parse(loop.firstSeen)) / DAY_MS);
    const age = ageDays >= 1 ? ` · 已挂 ${ageDays} 天` : '';
    const project = loop.projectName?.trim() || loop.projectDir;
    lines.push(
      `${startNumber + offset}. **${loop.title}** · ${label}${age} · 你确认忘了 · [ref ${loopRef(loop.id)}]`,
      `  项目：${project}`,
    );
    if (!skillMode) {
      lines.push(
        `  下一步：${loop.nextAction}`,
        `  为什么现在提：${loop.why}`,
      );
    }
  });
  return lines;
}

export function formatDigest(result: DigestResult, now = new Date(result.generatedAt)): string {
  if (result.total === 0 && result.reviewPick) {
    return formatReviewPickOnly(result, now, false);
  }
  if (result.total === 0) {
    if (result.mode === 'hot') {
      if (result.dailyCapReached) {
        if (result.recap.length > 0) return formatRecap(result);
        if (result.recapFocusEmpty) {
          const backlog = result.focusProject?.backlog ?? result.activeTotal;
          return backlog > 0
            ? `本项目今天没有已提过的回访条目；本项目还有 ${backlog} 条未闭环。说“周回顾”看清单。${closingHint(result, result.focusClosingTotal ?? result.closingTotal)}`
            : '本项目今天没有已提过的回访条目；本项目暂无未闭环。';
        }
        if (result.activeTotal === 0) {
          return `今天已有 ${result.dailySurfaced} 条回访记录（每日上限 ${result.dailySurfaceLimit} 条）。`;
        }
        return `今天已有 ${result.dailySurfaced} 条回访记录（每日上限 ${result.dailySurfaceLimit} 条）；库存还有 ${result.activeTotal} 条未闭环，明天再继续；${closingHint(result)}要现在看就说“周回顾”。`;
      }
      if (result.activeTotal === 0) return '没有需要回访的循环。';
      if (result.coolingDown > 0) {
        const noise = result.noiseSuppressed > 0
          ? `，${result.noiseSuppressed} 条已标记为噪音`
          : '';
        return `今天已回访过；还有 ${result.activeTotal} 条未闭环（${result.coolingDown} 条在 24 小时冷却中${noise}），不重复提醒；${closingHint(result)}要现在看就说“周回顾”。`;
      }
      if (result.noiseSuppressed > 0) {
        return `还有 ${result.activeTotal} 条未闭环，其中 ${result.noiseSuppressed} 条已被标记为噪音且没有新证据，当前不回访。`;
      }
      return `还有 ${result.activeTotal} 条未闭环，但当前没有达到回访条件的条目。`;
    }
    if (result.activeProjects.length === 0 && result.activeTotal === 0) {
      return '本周没有需要回顾的循环。';
    }
    const reasons: string[] = [];
    if (result.coolingDown > 0) reasons.push(`${result.coolingDown} 条在 24 小时冷却中`);
    if (result.noiseSuppressed > 0) reasons.push(`${result.noiseSuppressed} 条已被标记为噪音且没有新证据`);
    const lines = [result.activeTotal > 0
      ? '# 每周回顾 · 暂无新条目'
      : '# 每周回顾 · 无未闭环'];
    if (reasons.length > 0) {
      lines.push('', `还有 ${result.activeTotal} 条未闭环（${reasons.join('，')}），当前不回访。`);
    } else if (result.activeTotal > 0) {
      lines.push('', `还有 ${result.activeTotal} 条未闭环，但当前没有达到回顾条件的条目。`);
    }
    lines.push(...formatConfirmedReviewLines(result, now, 1, false));
    if (result.activeProjects.length > 0) {
      lines.push('', ...formatProjectSection(result.activeProjects, now, result.activeDays, 2, true));
    }
    const candidates = formatReconcileCandidates(result.reconcileCandidates);
    if (candidates) lines.push('', candidates);
    return lines.join('\n');
  }
  const title = result.mode === 'hot' ? '回访' : '每周回顾';
  const count = result.mode === 'hot' && result.reviewPick
    ? `${result.total} 条 + 回顾 1 条`
    : result.mode === 'review' && result.reviewConfirmed.length > 0
      ? `${result.total} 条 + 确认 ${result.reviewConfirmed.length} 条`
      : `${result.total} 条`;
  const lines = [`# ${title} · ${count}`];
  const focusNote = focusFallbackNote(result);
  if (focusNote) lines.push('', focusNote);
  const activeByDir = new Map(
    result.activeProjects.map((project) => [project.projectDir, project]),
  );
  let itemNumber = 0;
  if (result.mode === 'review') {
    const confirmedLines = formatConfirmedReviewLines(result, now, 1, false);
    if (confirmedLines.length > 0) {
      lines.push(...confirmedLines);
      itemNumber = result.reviewConfirmed.length;
    }
  }
  for (const group of result.groups) {
    const activity = activeByDir.get(group.projectDir);
    const backlog = activity && activity.total > group.loops.length
      ? ` · 未闭环共 ${activity.total} 条（open ${activity.open} / pending ${activity.pending}）`
      : '';
    lines.push(
      '',
      `## ${group.projectName} · 最近活跃 ${formatRelativeTime(group.lastActive, now)}${backlog}`,
    );
    for (const loop of group.loops) {
      itemNumber += 1;
      const label = loop.status === 'pending'
        ? `待确认 ${Math.round(loop.confidence * 100)}%`
        : `${Math.round(loop.confidence * 100)}%`;
      const ageDays = Math.floor((now.getTime() - Date.parse(loop.firstSeen)) / DAY_MS);
      const age = ageDays >= 1 ? ` · 已挂 ${ageDays} 天` : '';
      lines.push(
        `${itemNumber}. **${loop.title}** · ${label}${age}${confirmedTag(result, loop)} · [ref ${loopRef(loop.id)}]`,
        `  下一步：${loop.nextAction}`,
        `  为什么现在提：${loop.why}`,
      );
    }
  }
  if (result.reviewPick) {
    itemNumber += 1;
    lines.push(...formatReviewPickLines(result, now, itemNumber, false));
  }
  if (result.mode === 'hot') {
    const candidates = formatReconcileCandidates(result.closeCandidates ?? []);
    if (candidates) lines.push('', candidates);
  }
  if (result.mode === 'review' && result.activeProjects.length > 0) {
    lines.push(
      '',
      ...formatProjectSection(result.activeProjects, now, result.activeDays, 2),
    );
  }
  if (result.mode === 'review') {
    const candidates = formatReconcileCandidates(result.reconcileCandidates);
    if (candidates) lines.push('', candidates);
  }
  const reviewNudge = formatReviewNudge(result);
  if (reviewNudge) lines.push('', reviewNudge);
  return lines.join('\n');
}

function formatReviewBrief(result: DigestResult, now: Date): string {
  const confirmedCount = result.reviewConfirmed.length;
  const lines = [confirmedCount > 0
    ? `# 每周回顾 · ${result.total} 条 + 确认 ${confirmedCount} 条`
    : `# 每周回顾 · ${result.total} 条`];
  const activeByDir = new Map(
    result.activeProjects.map((project) => [project.projectDir, project]),
  );
  let itemNumber = 0;
  const confirmedLines = formatConfirmedReviewLines(result, now, 1, true);
  if (confirmedLines.length > 0) {
    lines.push(...confirmedLines);
    itemNumber = confirmedCount;
  }
  for (const group of result.groups) {
    const activity = activeByDir.get(group.projectDir);
    const backlog = activity && activity.total > group.loops.length
      ? ` · 未闭环共 ${activity.total} 条（open ${activity.open} / pending ${activity.pending}）`
      : '';
    lines.push(
      '',
      `## ${group.projectName} · 最近活跃 ${formatRelativeTime(group.lastActive, now)}${backlog}`,
    );
    for (const loop of group.loops) {
      itemNumber += 1;
      const label = loop.status === 'pending'
        ? `待确认 ${Math.round(loop.confidence * 100)}%`
        : `${Math.round(loop.confidence * 100)}%`;
      const ageDays = Math.floor((now.getTime() - Date.parse(loop.firstSeen)) / DAY_MS);
      const age = ageDays >= 1 ? ` · 已挂 ${ageDays} 天` : '';
      lines.push(
        `${itemNumber}. **${loop.title}** · ${label}${age}${confirmedTag(result, loop)} · [ref ${loopRef(loop.id)}]`,
      );
    }
  }
  if (result.activeProjects.length > 0) {
    lines.push('', ...formatProjectSection(result.activeProjects, now, result.activeDays, 2, true));
  }
  const candidates = formatReconcileCandidates(result.reconcileCandidates);
  if (candidates) lines.push('', candidates);
  if (result.reviewRemaining && result.reviewRemaining > 0) {
    lines.push('', `本轮还有 ${result.reviewRemaining} 条没看；说“继续看”看下一批。`);
  } else if (result.mode === 'review') {
    lines.push('', '本轮已经看完；说“继续看”从头再看一轮。');
  }
  if (result.pendingTotal && result.pendingTotal > 0) {
    lines.push('', `其中 ${result.pendingTotal} 条把握不高；说“看待确认”单独看。`);
  }
  lines.push(
    '',
    '想让我现在处理，就说“做第 N 条”；我会先查证据再动手。',
    '回编号或 ref 看下一步和依据。',
    '确认已完成就说“关闭这条”；确实忘了或噪音，也回编号说一声。',
    '回复示例：“1 忘了”“2 噪音”“3 已完成”；要细节就回编号。',
  );
  return lines.join('\n');
}

function formatReviewNudge(result: DigestResult): string | undefined {
  if (!result.reviewDue || result.activeTotal === 0) return undefined;
  if (result.reviewPick) {
    return `**本周回顾**：今天先带 1 条旧的；还有 ${result.activeTotal} 条未闭环，说“周回顾”看完整清单。`;
  }
  return `**本周回顾**：本周还没看完整清单；还有 ${result.activeTotal} 条未闭环，说“周回顾”查看。`;
}

function focusFallbackNote(result: DigestResult): string | undefined {
  if (result.mode !== 'hot') return undefined;
  const focus = result.focusProject;
  if (!focus || focus.matched || result.groups.length === 0) return undefined;
  return `本项目（${focus.name}）暂无可回访条目，以下来自其他活跃项目。`;
}

function formatReconcileCandidates(
  candidates: ReconcileCacheCandidate[],
): string | undefined {
  if (candidates.length === 0) return undefined;
  const lines = [`**可能已完成**（${candidates.length} 条，尚未关闭）`];
  for (const candidate of candidates) {
    lines.push(
      `- [ref ${loopRef(candidate.loopId)}] **${candidate.title}** · ${Math.round(candidate.confidence * 100)}%`,
      `  依据：${candidate.reason}`,
      '  确认后再说“关闭这条”；只是讨论过就不要关。',
    );
  }
  return lines.join('\n');
}

function realActiveProjects(
  result: DigestResult,
  excludeDirs: Set<string> = new Set(),
): ProjectSummary[] {
  return result.activeProjects
    .filter((project) => !project.sessionOnly && !excludeDirs.has(project.projectDir))
    .sort((left, right) => right.lastActive.localeCompare(left.lastActive))
    .slice(0, 3);
}

function formatActiveProjects(projects: ProjectSummary[]): string | undefined {
  if (projects.length === 0) return undefined;
  const parts = projects.map((project) => project.sessionCount > 0
    ? `${project.projectName}（${project.sessionCount} 个会话）`
    : project.projectName);
  return `最近活跃：${parts.join('、')}`;
}

function closingHint(result: DigestResult, total = result.closingTotal ?? 0): string {
  return total > 0
    ? `其中 ${total} 条展示过但未关闭，说“收尾”看清单。`
    : '';
}

export function formatRecap(result: DigestResult): string {
  if (result.recapThrottled) {
    const confirmedCount = result.recapConfirmedIds.length;
    const baseCount = result.recap.length - confirmedCount;
    const lines = [
      baseCount > 0
        ? `# 今天提过 · ${baseCount} 条`
        : `# 你确认忘了 · ${confirmedCount} 条`,
      '',
      baseCount > 0
        ? '刚刚已提过这几条，仍未收到判断；回编号或 ref 说“忘了 / 噪音 / 已完成”就行。'
        : '这条是你之前明确说过“确实忘了”的，继续跟进。',
      '回复示例：“1 忘了”“2 噪音”“3 已完成”；要细节就回编号。',
      '想让我现在处理，就说“做第 N 条”；我会先查证据再动手。',
    ];
    let confirmedHeaderShown = false;
    result.recap.forEach((loop, index) => {
      if (
        baseCount > 0
        && !confirmedHeaderShown
        && result.recapConfirmedIds.includes(loop.id)
      ) {
        lines.push('', '**你确认忘了 · 跨项目**');
        confirmedHeaderShown = true;
      }
      lines.push(
        `${index + 1}. **${loop.title}** · ${loop.projectName} · [ref ${loopRef(loop.id)}]`,
      );
    });
    if (confirmedCount > 0) {
      lines.push('', '确认项来自其他项目，不按当前项目过滤。');
    }
    lines.push(
      '',
      `今天 ${result.dailySurfaceLimit} 条新回访已用完；这几条不占新预算。库存还有 ${result.activeTotal} 条未闭环。${closingHint(result)}要现在看就说“周回顾”。`,
    );
    return lines.join('\n');
  }
  const confirmedCount = result.recapConfirmedIds.length;
  const baseCount = result.recap.length - confirmedCount;
  const lines = [
    baseCount > 0
      ? `# 今天提过 · ${baseCount} 条`
      : `# 你确认忘了 · ${confirmedCount} 条`,
    '',
    baseCount > 0
      ? '这几条已经提过，还没收到你的判断；再回一次编号就行。'
      : '这些是你之前明确说过“确实忘了”的，跨项目继续跟进。',
  ];
  let confirmedHeaderShown = false;
  result.recap.forEach((loop, index) => {
    if (
      baseCount > 0
      && !confirmedHeaderShown
      && result.recapConfirmedIds.includes(loop.id)
    ) {
      lines.push('', '**你确认忘了 · 跨项目**');
      confirmedHeaderShown = true;
    }
    const label = loop.status === 'pending'
      ? `待确认 ${Math.round(loop.confidence * 100)}%`
      : `${Math.round(loop.confidence * 100)}%`;
    lines.push(
      '',
      `${index + 1}. **${loop.title}** · ${label}${confirmedTag(result, loop)} · [ref ${loopRef(loop.id)}]`,
      `  项目：${loop.projectName}`,
      `  下一步：${loop.nextAction}`,
      `  为什么现在提：${loop.why}`,
      '  若已完成，直接说“关闭这条”。',
    );
  });
  const closeCandidates = formatReconcileCandidates(result.closeCandidates ?? []);
  if (closeCandidates) lines.push('', closeCandidates);
  const active = formatActiveProjects(realActiveProjects(result));
  if (active) lines.push('', active);
  if (confirmedCount > 0) {
    lines.push(
      '',
      '确认项来自其他项目：你之前明确说过“确实忘了”，所以不按当前项目过滤。',
    );
  }
  lines.push(
    '',
    `今天 ${result.dailySurfaceLimit} 条新回访已用完；这几条不占新预算。库存还有 ${result.activeTotal} 条未闭环。${closingHint(result)}要现在看就说“周回顾”。`,
    '',
    '哪条已经完成、哪条是你确实忘了、哪条是噪音？回编号或 ref 就行。',
    '回复示例：“1 忘了”“2 噪音”“3 已完成”；要细节就回编号。',
    '想让我现在处理，就说“做第 N 条”；我会先查证据再动手。',
  );
  return lines.join('\n');
}

function formatCacheWarning(result: DigestResult): string {
  if (!result.cacheStale || result.cacheAgeHours === undefined) return '';
  return `> 注意：本地缓存已 ${result.cacheAgeHours.toFixed(1)} 小时未更新，回访内容可能不是最新。运行 scripts\\refresh-open-loops.ps1 或检查 OpenLoopsRefresh 计划任务。`;
}

export function formatSkillDigest(
  result: DigestResult,
  now = new Date(result.generatedAt),
): string {
  const warning = formatCacheWarning(result);
  const body = formatSkillDigestBody(result, now);
  const nudge = calibrationNudge(result);
  return [warning, body, nudge].filter(Boolean).join('\n\n');
}

const CALIBRATION_MIN_SURFACED = 10;

function calibrationNudge(result: DigestResult): string | undefined {
  if (result.feedbackTotal > 0) return undefined;
  if (result.recapThrottled) return undefined;
  if (result.surfacedTotal < CALIBRATION_MIN_SURFACED) return undefined;
  if (result.activeTotal === 0) return undefined;
  if (!result.dailyCapReached && result.mode !== 'review') return undefined;
  return `**校准提示**：已经回访 ${result.surfacedTotal} 条，还没有一条“忘了/噪音”的判断。花 1 分钟校准 5 条，后面的排序会更准；说“校准回访”即可。`;
}

function formatSkillDigestBody(
  result: DigestResult,
  now = new Date(result.generatedAt),
): string {
  if (result.total === 0 && result.reviewPick) {
    return formatReviewPickOnly(result, now, true);
  }
  if (result.total === 0) {
    if (result.mode === 'hot' && result.dailyCapReached && result.recap.length > 0) {
      return formatRecap(result);
    }
    if (result.mode === 'hot' && result.dailyCapReached && result.recapFocusEmpty) {
      return formatDigest(result, now);
    }
    const base = formatDigest(result, now);
    if (result.mode !== 'hot') return base;
    const active = formatActiveProjects(realActiveProjects(result));
    return active ? `${base}\n\n${active}` : base;
  }

  if (result.mode === 'review') {
    return formatReviewBrief(result, now);
  }

  const count = result.reviewPick
    ? `${result.total} 条 + 回顾 1 条`
    : `${result.total} 条`;
  const lines = [`# 回访 · ${count}`];
  const focusNote = focusFallbackNote(result);
  if (focusNote) lines.push('', focusNote);
  const activeByDir = new Map(
    result.activeProjects.map((project) => [project.projectDir, project]),
  );
  const groupedDirs = new Set(result.groups.map((group) => group.projectDir));
  let itemNumber = 0;

  for (const group of result.groups) {
    const activity = activeByDir.get(group.projectDir);
    const backlog = activity && activity.total > group.loops.length
      ? ` · 未闭环共 ${activity.total} 条（open ${activity.open} / pending ${activity.pending}）`
      : '';
    lines.push(
      '',
      `**${group.projectName}** · 最近活跃 ${formatRelativeTime(group.lastActive, now)}${backlog}`,
    );
    for (const loop of group.loops) {
      itemNumber += 1;
      const label = loop.status === 'pending'
        ? `待确认 ${Math.round(loop.confidence * 100)}%`
        : `${Math.round(loop.confidence * 100)}%`;
      const ageDays = Math.floor((now.getTime() - Date.parse(loop.firstSeen)) / DAY_MS);
      const age = ageDays >= 1 ? ` · 已挂 ${ageDays} 天` : '';
      lines.push(
        `${itemNumber}. **${loop.title}** · ${label}${age}${confirmedTag(result, loop)} · [ref ${loopRef(loop.id)}]`,
        `  下一步：${loop.nextAction}`,
        `  为什么现在提：${loop.why}`,
      );
      lines.push('  若已完成，直接说“关闭这条”。');
    }
  }
  if (result.reviewPick) {
    itemNumber += 1;
    lines.push(...formatReviewPickLines(result, now, itemNumber, true));
  }

  const closeCandidates = formatReconcileCandidates(result.closeCandidates ?? []);
  if (closeCandidates) lines.push('', closeCandidates);
  const active = formatActiveProjects(realActiveProjects(result, groupedDirs));
  if (active) lines.push('', active);
  const reviewNudge = formatReviewNudge(result);
  if (reviewNudge) lines.push('', reviewNudge);
  lines.push(
    '',
    '这几条里，哪条已经完成、哪条是你确实忘了、哪条是噪音？回编号或 ref 就行。',
    '回复示例：“1 忘了”“2 噪音”“3 已完成”；要细节就回编号。',
    '想让我现在处理，就说“做第 N 条”；我会先查证据再动手。',
  );
  return lines.join('\n');
}
