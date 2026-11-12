import { LoopStore } from './loop-store.js';
import { isNoiseSuppressed } from './feedback.js';
import { loopRef } from './loop-ref.js';
import { formatRelativeTime } from './projects.js';
import type { LoopFeedbackRecord, LoopRecord, LoopSignal } from './types.js';

export interface LoopDetail {
  ref: string;
  loop: LoopRecord;
  signals: LoopSignal[];
  missingSignalIds: string[];
  omittedSignalCount: number;
  latestFeedback?: LoopFeedbackRecord;
}

export function buildLoopDetail(
  store: LoopStore,
  loopId: string,
  maxSignals = 12,
): LoopDetail | undefined {
  const loop = store.getLoop(loopId);
  if (!loop) return undefined;

  const limit = Math.max(1, Math.min(50, maxSignals));
  const queriedIds = loop.sourceSignalIds.slice(0, limit);
  const signals = store.getSignals(queriedIds);
  const byId = new Map(signals.map((signal) => [signal.id, signal]));
  const ordered = queriedIds
    .map((id) => byId.get(id))
    .filter((signal): signal is LoopSignal => Boolean(signal));
  const missingSignalIds = queriedIds.filter((id) => !byId.has(id));

  return {
    ref: loopRef(loop.id),
    loop,
    signals: ordered,
    missingSignalIds,
    omittedSignalCount: Math.max(0, loop.sourceSignalIds.length - queriedIds.length),
    latestFeedback: store.getLatestFeedbackForLoop(loop.id),
  };
}

function compactText(value: string, maxChars = 500): string {
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return '（空消息）';
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

export function formatLoopDetail(detail: LoopDetail, now = new Date()): string {
  const { loop, signals, missingSignalIds, omittedSignalCount, latestFeedback } = detail;
  const lines = [
    `# ${loop.title}`,
    '',
    `- **编号**: [ref ${detail.ref}]`,
    `- **状态**: ${loop.status} · 置信度 ${Math.round(loop.confidence * 100)}%`,
    `- **来源**: ${loop.origin === 'assistant' ? '助手消息（未经用户确认）' : loop.origin === 'user' ? '用户消息' : '用户与助手混合'}`,
    `- **项目**: ${loop.projectName} · \`${loop.projectDir}\``,
    `- **首次出现**: ${formatRelativeTime(loop.firstSeen, now)} · ${loop.firstSeen}`,
    `- **最近证据**: ${formatRelativeTime(loop.lastSeen, now)} · ${loop.lastSeen}`,
    `- **回访**: ${loop.lastSurfacedAt
      ? `${formatRelativeTime(loop.lastSurfacedAt, now)} · ${loop.lastSurfacedAt}`
      : '尚未回访'}${loop.ignoredCount > 0 ? ` · 已忽略 ${loop.ignoredCount} 次` : ''}`,
  ];
  if (loop.snoozeUntil) lines.push(`- **暂缓到**: ${loop.snoozeUntil}`);
  if (loop.resolvedAt) lines.push(`- **关闭时间**: ${loop.resolvedAt}`);
  if (loop.resolutionNote) lines.push(`- **关闭说明**: ${loop.resolutionNote}`);
  if (latestFeedback) {
    const label = latestFeedback.verdict === 'forgotten' ? '确实忘了' : '噪音';
    const suppressed = isNoiseSuppressed(loop, latestFeedback)
      ? ' · 有新证据前不回访'
      : '';
    const note = latestFeedback.note ? ` · ${compactText(latestFeedback.note, 120)}` : '';
    lines.push(
      `- **最近反馈**: ${label} · ${latestFeedback.createdAt}${note}${suppressed}`,
    );
  }

  lines.push(
    '',
    `下一步: ${loop.nextAction}`,
    `为什么提: ${loop.why}`,
    '',
    `## 来源证据 · ${signals.length}/${loop.sourceSignalIds.length}`,
  );

  if (signals.length === 0) {
    lines.push('- 本地没有可读取的源消息；可能已被清理或尚未落库。');
  } else {
    signals.forEach((signal, index) => {
      lines.push(
        `- **${signal.agent} · ${signal.role}** · ${signal.capturedAt} · session \`${signal.sourceId}\``,
        `  > ${compactText(signal.text)}`,
      );
      if (index < signals.length - 1) lines.push('');
    });
  }
  if (missingSignalIds.length > 0) {
    lines.push('', `- 另有 ${missingSignalIds.length} 条来源 id 找不到对应消息。`);
  }
  if (omittedSignalCount > 0) {
    lines.push(`- 还有 ${omittedSignalCount} 条来源未展示；需要时用 \`--limit\` 调大。`);
  }
  return lines.join('\n');
}
