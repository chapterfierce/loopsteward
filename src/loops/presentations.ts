import { LoopStore } from './loop-store.js';
import { resolveDefaultDbPath } from './data-path.js';
import { presentationFutureCutoffIso } from './presentation-time.js';
import type { LoopPresentation } from './types.js';

export interface PresentationRepairOptions {
  dbPath?: string;
  store?: LoopStore;
  now?: Date;
  apply?: boolean;
}

export interface PresentationRepairReport {
  generatedAt: string;
  applied: boolean;
  futureCount: number;
  deleted: number;
  records: LoopPresentation[];
}

export function buildPresentationRepairReport(
  options: PresentationRepairOptions = {},
): PresentationRepairReport {
  const ownsStore = options.store === undefined;
  const store = options.store ?? new LoopStore(options.dbPath ?? resolveDefaultDbPath());
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const futureCutoff = presentationFutureCutoffIso(now);

  try {
    const records = store.listPresentationsAfter(futureCutoff);
    const deleted = options.apply
      ? store.deletePresentations(records.map((record) => record.id))
      : 0;
    return {
      generatedAt: nowIso,
      applied: Boolean(options.apply),
      futureCount: records.length,
      deleted,
      records,
    };
  } finally {
    if (ownsStore) store.close();
  }
}

export function formatPresentationRepairReport(report: PresentationRepairReport): string {
  if (report.futureCount === 0) return '没有未来展示记录。';

  const lines = [`未来展示记录：${report.futureCount} 条（未计入统计）`];
  for (const record of report.records) {
    lines.push(
      `- #${record.id} ${record.presentedAt} · ${record.kind} · ${record.loopIds.length} 条循环`,
    );
  }
  lines.push(
    '',
    report.applied
      ? `已删除 ${report.deleted} 条。`
      : 'dry-run：加 `--apply` 才会删除。',
  );
  return lines.join('\n');
}
