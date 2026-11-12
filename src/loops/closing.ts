import { LoopStore } from './loop-store.js';
import { loopRef } from './loop-ref.js';
import type { LoopStatus } from './types.js';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;

export interface ClosingItem {
  id: string;
  title: string;
  status: LoopStatus;
  confidence: number;
  projectName: string;
  projectDir: string;
  firstSeen: string;
  lastSeen: string;
  presentationCount: number;
  firstPresentedAt: string;
  lastPresentedAt: string;
  nextAction: string;
}

export interface ClosingReview {
  generatedAt: string;
  total: number;
  shown: number;
  items: ClosingItem[];
}

export interface ClosingOptions {
  store: LoopStore;
  now?: Date;
  limit?: number;
}

function clampLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(value as number)));
}

export function buildClosingReview(options: ClosingOptions): ClosingReview {
  const now = options.now ?? new Date();
  const stats = options.store.getPresentationStats(now.toISOString());
  const items: ClosingItem[] = [];

  for (const loop of options.store.listActiveLoops()) {
    if (loop.status !== 'open' && loop.status !== 'pending') continue;
    const presentation = stats.get(loop.id);
    if (!presentation) continue;
    items.push({
      id: loop.id,
      title: loop.title,
      status: loop.status,
      confidence: loop.confidence,
      projectName: loop.projectName,
      projectDir: loop.projectDir,
      firstSeen: loop.firstSeen,
      lastSeen: loop.lastSeen,
      presentationCount: presentation.count,
      firstPresentedAt: presentation.firstPresentedAt,
      lastPresentedAt: presentation.lastPresentedAt,
      nextAction: loop.nextAction,
    });
  }

  items.sort((left, right) => (
    right.presentationCount - left.presentationCount
    || left.lastPresentedAt.localeCompare(right.lastPresentedAt)
    || left.firstSeen.localeCompare(right.firstSeen)
  ));

  const limit = clampLimit(options.limit);
  return {
    generatedAt: now.toISOString(),
    total: items.length,
    shown: Math.min(items.length, limit),
    items: items.slice(0, limit),
  };
}

function shortDate(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms).toISOString().slice(5, 10);
}

export function formatClosingReview(review: ClosingReview): string {
  if (review.total === 0) {
    return '没有“已展示但未关闭”的循环。';
  }
  const lines = [
    `# 收尾清单 · ${review.total} 条已展示未关闭`,
    '这些条目已经给你看过，但还没关闭。逐条回：完成 / 稍后 / 不要了。',
  ];
  for (const [index, item] of review.items.entries()) {
    const confidence = Math.round(item.confidence * 100);
    lines.push(
      '',
      `${index + 1}. **${item.title}** · ${item.projectName} · 展示 ${item.presentationCount} 次 · 最近 ${shortDate(item.lastPresentedAt)} · ${confidence}% · [ref ${loopRef(item.id)}]`,
      `   下一步：${item.nextAction}`,
    );
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
