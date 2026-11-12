import { LoopStore } from './loop-store.js';
import { loopRef } from './loop-ref.js';
import { resolveDefaultDbPath } from './data-path.js';
import type { LoopRecord } from './types.js';

export interface CalibrationOptions {
  store?: LoopStore;
  dbPath?: string;
  now?: Date;
  limit?: number;
}

export interface CalibrationItem {
  id: string;
  ref: string;
  title: string;
  projectName: string;
  confidence: number;
  status: LoopRecord['status'];
  nextAction: string;
  why: string;
  lastSurfacedAt?: string;
}

export interface CalibrationResult {
  generatedAt: string;
  items: CalibrationItem[];
  total: number;
}

function isSnoozed(loop: LoopRecord, nowMs: number): boolean {
  const until = Date.parse(loop.snoozeUntil ?? '');
  return Number.isFinite(until) && until > nowMs;
}

function pickDiverse(
  candidates: LoopRecord[],
  count: number,
  picked: LoopRecord[],
  projects: Set<string>,
): void {
  for (const loop of candidates) {
    if (picked.length >= count) break;
    if (projects.has(loop.projectDir)) continue;
    picked.push(loop);
    projects.add(loop.projectDir);
  }
}

export function buildCalibration(options: CalibrationOptions = {}): CalibrationResult {
  const ownsStore = options.store === undefined;
  const store = options.store ?? new LoopStore(options.dbPath ?? resolveDefaultDbPath());
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const limit = Math.max(1, Math.min(20, options.limit ?? 5));

  try {
    const latestFeedback = new Set(store.getLatestFeedback().map((feedback) => feedback.loopId));
    const candidates = store.listActiveLoops()
      .filter((loop) => loop.status !== 'snoozed' && !isSnoozed(loop, nowMs))
      .filter((loop) => !latestFeedback.has(loop.id))
      .sort((left, right) => {
        const confidenceDiff = right.confidence - left.confidence;
        return confidenceDiff !== 0
          ? confidenceDiff
          : left.lastSeen.localeCompare(right.lastSeen);
      });

    const neverSurfaced = candidates.filter((loop) => !loop.lastSurfacedAt);
    const surfaced = candidates.filter((loop) => loop.lastSurfacedAt);
    const neverQuota = Math.min(neverSurfaced.length, Math.ceil(limit * 0.6));
    const picked: LoopRecord[] = [];
    const projects = new Set<string>();
    pickDiverse(neverSurfaced, neverQuota, picked, projects);
    pickDiverse(surfaced, limit, picked, projects);

    if (picked.length < limit) {
      const chosen = new Set(picked.map((loop) => loop.id));
      for (const loop of candidates) {
        if (picked.length >= limit) break;
        if (chosen.has(loop.id)) continue;
        picked.push(loop);
        chosen.add(loop.id);
      }
    }

    return {
      generatedAt: now.toISOString(),
      total: picked.length,
      items: picked.map((loop) => ({
        id: loop.id,
        ref: loopRef(loop.id),
        title: loop.title,
        projectName: loop.projectName,
        confidence: loop.confidence,
        status: loop.status,
        nextAction: loop.nextAction,
        why: loop.why,
        ...(loop.lastSurfacedAt ? { lastSurfacedAt: loop.lastSurfacedAt } : {}),
      })),
    };
  } finally {
    if (ownsStore) store.close();
  }
}

export function formatCalibration(result: CalibrationResult): string {
  if (result.total === 0) {
    return '# 回访校准 · 0 条\n\n没有可校准的未闭环条目；先运行 `loops:ingest`。';
  }
  const lines = [
    `# 回访校准 · ${result.total} 条`,
    '',
    '这几条用于判断提取准不准；不写回访时间，不影响每日预算。',
  ];
  result.items.forEach((item, index) => {
    lines.push(
      '',
      `${index + 1}. **${item.title}** · ${Math.round(item.confidence * 100)}% · [ref ${item.ref}]`,
      `   项目：${item.projectName}`,
      `   下一步：${item.nextAction}`,
      `   为什么提：${item.why}`,
    );
  });
  lines.push(
    '',
    '回复格式：编号 + 判断，例如「1 忘了」「2 噪音」「3 跳过」。只记“忘了/噪音”，跳过不算样本。',
  );
  return lines.join('\n');
}
