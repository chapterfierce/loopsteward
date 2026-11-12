import { LoopStore } from './loop-store.js';
import { loopRef } from './loop-ref.js';
import { isSessionOnlyProject } from './projects.js';
import type { LoopOrigin, LoopStatus } from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 7;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export interface SessionArchiveItem {
  id: string;
  ref: string;
  title: string;
  status: LoopStatus;
  origin?: LoopOrigin;
  projectName: string;
  lastSeen: string;
  daysIdle: number;
  presentationCount: number;
}

export interface SessionArchivePlan {
  generatedAt: string;
  days: number;
  total: number;
  shown: number;
  items: SessionArchiveItem[];
}

export interface SessionArchiveOptions {
  store: LoopStore;
  now?: Date;
  days?: number;
  limit?: number;
}

function clamp(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value as number)));
}

export function buildSessionArchivePlan(options: SessionArchiveOptions): SessionArchivePlan {
  const now = options.now ?? new Date();
  const days = clamp(options.days, DEFAULT_DAYS, 3650);
  const limit = clamp(options.limit, DEFAULT_LIMIT, MAX_LIMIT);
  const cutoff = now.getTime() - days * DAY_MS;
  const protectedIds = new Set(
    options.store.getLatestFeedback()
      .filter((feedback) => feedback.verdict === 'forgotten')
      .map((feedback) => feedback.loopId),
  );
  const items = options.store.listActiveLoops(undefined, now)
    .filter((loop) => loop.status === 'open' || loop.status === 'pending')
    .filter((loop) => isSessionOnlyProject(loop.projectName))
    .filter((loop) => !protectedIds.has(loop.id))
    .filter((loop) => {
      const lastSeen = Date.parse(loop.lastSeen);
      return Number.isFinite(lastSeen) && lastSeen < cutoff;
    })
    .sort((left, right) => left.lastSeen.localeCompare(right.lastSeen))
    .map((loop) => ({
      id: loop.id,
      ref: loopRef(loop.id),
      title: loop.title,
      status: loop.status,
      origin: loop.origin,
      projectName: loop.projectName,
      lastSeen: loop.lastSeen,
      daysIdle: Math.floor((now.getTime() - Date.parse(loop.lastSeen)) / DAY_MS),
      presentationCount: loop.presentationCount ?? 0,
    }));
  return {
    generatedAt: now.toISOString(),
    days,
    total: items.length,
    shown: Math.min(items.length, limit),
    items,
  };
}

export function applySessionArchive(
  store: LoopStore,
  plan: SessionArchivePlan,
  note = 'session-only workspace expired',
): { archived: number; remaining: number } {
  let archived = 0;
  for (const item of plan.items.slice(0, plan.shown)) {
    const updated = store.updateLoop(item.id, { status: 'dropped', note });
    if (updated) archived += 1;
  }
  return { archived, remaining: plan.total - archived };
}

export function formatSessionArchivePlan(plan: SessionArchivePlan): string {
  if (plan.total === 0) {
    return `没有闲置超过 ${plan.days} 天的临时会话循环。`;
  }
  const lines = [
    `# 临时会话归档 · ${plan.days} 天未活动 · ${plan.total} 条`,
    '这些循环来自 Hermes/ZCode/Qoder/WorkBuddy 等临时会话工作区，不是真实项目。',
    '默认只预览；确认后加 --apply 归档为 dropped（可用 update --status open 恢复）。',
  ];
  for (const [index, item] of plan.items.slice(0, plan.shown).entries()) {
    lines.push(
      '',
      `${index + 1}. **${item.title}** · ${item.projectName} · 闲置 ${item.daysIdle} 天 · 展示 ${item.presentationCount} 次 · [ref ${item.ref}]`,
      `  最近证据：${item.lastSeen.slice(0, 10)}`,
    );
  }
  if (plan.total > plan.shown) {
    lines.push('', `还有 ${plan.total - plan.shown} 条没列；用 --limit 调大预览数量。`);
  }
  return lines.join('\n');
}
