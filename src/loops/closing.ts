import path from 'node:path';
import { LoopStore } from './loop-store.js';
import { loopRef } from './loop-ref.js';
import type { LoopOrigin, LoopStatus, ReconcileCacheCandidate } from './types.js';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;
const COMPLETION_CACHE_HOURS = 30 * 24;
const COMPLETION_MIN_CONFIDENCE = 0.9;
const COMPLETION_REASON_MAX = 160;

const ORIGIN_LABELS: Record<LoopOrigin, string> = {
  user: '用户来源',
  assistant: '助手来源',
  mixed: '混合来源',
};

const ORIGIN_ORDER: Record<LoopOrigin, number> = {
  user: 0,
  mixed: 1,
  assistant: 2,
};

export interface ClosingItem {
  id: string;
  ref: string;
  title: string;
  status: LoopStatus;
  origin?: LoopOrigin;
  confidence: number;
  projectName: string;
  projectDir: string;
  firstSeen: string;
  lastSeen: string;
  presentationCount: number;
  firstPresentedAt: string;
  lastPresentedAt: string;
  nextAction: string;
  why: string;
  completion?: {
    confidence: number;
    reason: string;
    checkedAt: string;
  };
}

export interface ClosingReview {
  generatedAt: string;
  total: number;
  shown: number;
  completionTotal: number;
  completionOnly?: boolean;
  origin?: LoopOrigin;
  originTotals: Record<LoopOrigin, number>;
  items: ClosingItem[];
}

export interface ClosingOptions {
  store: LoopStore;
  now?: Date;
  limit?: number;
  projectDir?: string;
  origin?: LoopOrigin;
  completionOnly?: boolean;
}

function clampLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(value as number)));
}

function projectKey(value: string): string {
  const trimmed = value.trim().replace(/[\\/]+$/, '');
  if (!trimmed) return '';
  const absolute = /^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('/');
  const normalized = absolute ? trimmed : path.resolve(trimmed);
  return normalized.replace(/\\/g, '/').toLowerCase();
}

function completionFor(
  candidate: ReconcileCacheCandidate | undefined,
): ClosingItem['completion'] | undefined {
  if (!candidate || candidate.confidence < COMPLETION_MIN_CONFIDENCE) return undefined;
  return {
    confidence: candidate.confidence,
    reason: candidate.reason,
    checkedAt: candidate.checkedAt,
  };
}

export function buildClosingReview(options: ClosingOptions): ClosingReview {
  const now = options.now ?? new Date();
  const stats = options.store.getPresentationStats(now.toISOString());
  const completions = new Map(
    options.store
      .listRecentReconcileCandidates(now, COMPLETION_CACHE_HOURS, 500)
      .map((candidate) => [candidate.loopId, candidate]),
  );
  const project = options.projectDir ? projectKey(options.projectDir) : undefined;
  const items: ClosingItem[] = [];

  for (const loop of options.store.listActiveLoops()) {
    if (loop.status !== 'open' && loop.status !== 'pending') continue;
    if (project && projectKey(loop.projectDir) !== project) continue;
    const presentation = stats.get(loop.id);
    if (!presentation) continue;
    items.push({
      id: loop.id,
      ref: loopRef(loop.id),
      title: loop.title,
      status: loop.status,
      origin: loop.origin,
      confidence: loop.confidence,
      projectName: loop.projectName,
      projectDir: loop.projectDir,
      firstSeen: loop.firstSeen,
      lastSeen: loop.lastSeen,
      presentationCount: presentation.count,
      firstPresentedAt: presentation.firstPresentedAt,
      lastPresentedAt: presentation.lastPresentedAt,
      nextAction: loop.nextAction,
      why: loop.why,
      completion: completionFor(completions.get(loop.id)),
    });
  }

  items.sort((left, right) => (
    Number(Boolean(right.completion)) - Number(Boolean(left.completion))
    || ORIGIN_ORDER[left.origin ?? 'mixed'] - ORIGIN_ORDER[right.origin ?? 'mixed']
    || right.presentationCount - left.presentationCount
    || left.lastPresentedAt.localeCompare(right.lastPresentedAt)
    || left.firstSeen.localeCompare(right.firstSeen)
  ));

  const completionOnly = options.completionOnly === true;
  const scoped = completionOnly
    ? items.filter((item) => Boolean(item.completion))
    : items;
  const originTotals: Record<LoopOrigin, number> = { user: 0, assistant: 0, mixed: 0 };
  for (const item of scoped) {
    originTotals[item.origin ?? 'mixed'] += 1;
  }

  const selectedOrigin = options.origin;
  const filtered = selectedOrigin
    ? scoped.filter((item) => (item.origin ?? 'mixed') === selectedOrigin)
    : scoped;
  const limit = clampLimit(options.limit);
  return {
    generatedAt: now.toISOString(),
    total: filtered.length,
    shown: Math.min(filtered.length, limit),
    completionTotal: filtered.filter((item) => item.completion).length,
    completionOnly: completionOnly || undefined,
    origin: selectedOrigin,
    originTotals,
    items: filtered.slice(0, limit),
  };
}

function shortDate(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms).toISOString().slice(5, 10);
}

export function formatClosingReview(review: ClosingReview): string {
  if (review.total === 0) {
    if (review.completionOnly) {
      return '没有带完成证据的已展示未关闭循环；说“收尾”看全部清单。';
    }
    if (review.origin) {
      const others = (Object.keys(review.originTotals) as LoopOrigin[])
        .filter((origin) => origin !== review.origin)
        .reduce((sum, origin) => sum + review.originTotals[origin], 0);
      return others > 0
        ? `没有来源为「${ORIGIN_LABELS[review.origin]}」的已展示未关闭循环；其他来源还有 ${others} 条。`
        : `没有来源为「${ORIGIN_LABELS[review.origin]}」的已展示未关闭循环。`;
    }
    return '没有“已展示但未关闭”的循环。';
  }
  const scope = [
    review.completionOnly ? '只看完成证据' : '',
    review.origin ? ORIGIN_LABELS[review.origin] : '',
  ].filter(Boolean).map((part) => ` · ${part}`).join('');
  const counts = `用户 ${review.originTotals.user} · 助手 ${review.originTotals.assistant} · 混合 ${review.originTotals.mixed}`;
  const sourceLine = review.origin
    ? `当前范围来源：${counts}；下面只列${ORIGIN_LABELS[review.origin]}。`
    : `来源构成：${counts}。`;
  const lines = [
    `# 收尾清单${scope} · ${review.total} 条已展示未关闭`,
    '这些条目已经给你看过，但还没关闭。逐条回：完成 / 稍后 / 不要了。',
    sourceLine,
  ];
  if (review.completionTotal > 0 && !review.completionOnly) {
    lines.push(
      `其中 ${review.completionTotal} 条已有完成证据，先列在前面；确认后回编号 + 完成，仍不会自动关闭。只想先看这批就说“只看完成证据”。`,
    );
  } else if (review.completionOnly) {
    lines.push('这些条目都已有完成证据；确认后回编号 + 完成，仍不会自动关闭。这批都确认无误可回“全部完成”。');
  }
  for (const [index, item] of review.items.entries()) {
    const confidence = Math.round(item.confidence * 100);
    const origin = item.origin === 'assistant'
      ? ' · 助手来源'
      : item.origin === 'mixed'
        ? ' · 混合来源'
        : '';
    const rows = [
      '',
      `${index + 1}. **${item.title}** · ${item.projectName}${origin} · 展示 ${item.presentationCount} 次 · 最近 ${shortDate(item.lastPresentedAt)} · ${confidence}% · [ref ${item.ref}]`,
    ];
    if (item.completion) {
      const normalized = item.completion.reason.replace(/\s+/g, ' ').trim();
      const reason = normalized.length > COMPLETION_REASON_MAX
        ? `${normalized.slice(0, COMPLETION_REASON_MAX - 3)}...`
        : normalized;
      rows.push(
        `   可能已完成（${Math.round(item.completion.confidence * 100)}%）：${reason}`,
        `   若证据不成立，再按原下一步：${item.nextAction}`,
      );
    } else {
      rows.push(`   下一步：${item.nextAction}`);
    }
    lines.push(...rows);
  }
  if (review.total > review.shown) {
    lines.push('', `还有 ${review.total - review.shown} 条没列；处理完这批再说“继续收尾”。`);
  }
  lines.push(
    '',
    '回复示例：“1 完成”“2 稍后”“3 不要了”；一次说多条也行。',
    '没说的一律保持原状；不会因为展示次数多就自动关闭。',
  );
  return lines.join('\n');
}
