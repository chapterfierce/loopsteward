import { LoopStore, titleTokens } from './loop-store.js';
import { isTrackerOutputMessage, isWeakEvidenceMessage } from './evidence.js';
import { isSessionOnlyProject } from './projects.js';
import { isPlaceholderSessionTitle, isWeakSessionTitle } from './session-source.js';
import { resolveDefaultDbPath } from './data-path.js';
import type { LoopOrigin, LoopRecord, LoopStatus } from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DUPLICATE_THRESHOLD = 0.55;
const SUSPICIOUS_PROJECT_NAME = /^(?:\d{4}[-_]\d{2}[-_]\d{2}(?:[-_]\d{2}[-_]\d{2}[-_]\d{2})?|[0-9a-f]{8,}|draft-[0-9a-f-]{8,}|\d{10,}-[0-9a-f-]{8,})$/i;
const STATUS_SNAPSHOT = /(?:仍为|还是|只有|仅为)\s*(?:0|零)|未提交|尚未提交|只到\s*M\d+|只写到\s*M\d+|测试全绿|全部通过|已收口/;

export interface AuditLoopRef {
  id: string;
  title: string;
  projectName: string;
  status: LoopStatus;
  origin?: LoopOrigin;
  firstSeen: string;
  lastSeen: string;
  daysOpen: number;
}

export interface AuditDuplicate {
  projectName: string;
  leftId: string;
  leftTitle: string;
  rightId: string;
  rightTitle: string;
  similarity: number;
}

export interface LoopAudit {
  generatedAt: string;
  staleDays: number;
  totals: {
    active: number;
    open: number;
    pending: number;
    snoozed: number;
    lowConfidence: number;
    weakEvidence: number;
    weakEvidenceOpen: number;
    weakEvidencePending: number;
    selfGenerated: number;
    userSourced: number;
    assistantSourced: number;
    mixedSourced: number;
    statusSnapshots: number;
    missingEvidence: number;
    stale: number;
    duplicates: number;
    suspiciousProjectNames: number;
    sessionOnlyProjects: number;
  };
  weakEvidence: AuditLoopRef[];
  selfGenerated: AuditLoopRef[];
  assistantSourced: AuditLoopRef[];
  statusSnapshots: AuditLoopRef[];
  missingEvidence: AuditLoopRef[];
  stale: AuditLoopRef[];
  duplicates: AuditDuplicate[];
  suspiciousProjects: string[];
  sessionOnlyProjects: string[];
}

export interface AuditOptions {
  dbPath?: string;
  store?: LoopStore;
  now?: Date;
  staleDays?: number;
}

function loopRef(loop: LoopRecord, nowMs: number): AuditLoopRef {
  const firstSeenMs = Date.parse(loop.firstSeen);
  return {
    id: loop.id,
    title: loop.title,
    projectName: loop.projectName,
    status: loop.status,
    origin: loop.origin ?? 'mixed',
    firstSeen: loop.firstSeen,
    lastSeen: loop.lastSeen,
    daysOpen: Number.isFinite(firstSeenMs)
      ? Math.max(0, Math.floor((nowMs - firstSeenMs) / DAY_MS))
      : 0,
  };
}

function normalizedTitle(title: string): string {
  return title.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function projectKey(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase();
}

function projectNameBody(value: string): string {
  const separator = value.indexOf(' · ');
  return separator >= 0 ? value.slice(separator + 3) : value;
}

function isSuspiciousProjectName(value: string): boolean {
  if (SUSPICIOUS_PROJECT_NAME.test(value)) return true;
  const body = projectNameBody(value);
  return isWeakSessionTitle(body) && !isPlaceholderSessionTitle(body);
}

function pairKey(leftIndex: number, rightIndex: number): string {
  return `${leftIndex}:${rightIndex}`;
}

function groupDuplicatePairs(loops: LoopRecord[], add: (pair: AuditDuplicate) => void): void {
  const items = loops.map((loop) => ({
    loop,
    exact: normalizedTitle(loop.title),
    tokens: titleTokens(loop.title),
  }));
  const exactBuckets = new Map<string, number[]>();
  for (const [index, item] of items.entries()) {
    const bucket = exactBuckets.get(item.exact) ?? [];
    bucket.push(index);
    exactBuckets.set(item.exact, bucket);
  }

  const seen = new Set<string>();
  for (const bucket of exactBuckets.values()) {
    for (let left = 0; left < bucket.length; left += 1) {
      for (let right = left + 1; right < bucket.length; right += 1) {
        const leftIndex = bucket[left];
        const rightIndex = bucket[right];
        const key = pairKey(leftIndex, rightIndex);
        if (seen.has(key)) continue;
        seen.add(key);
        const leftItem = items[leftIndex];
        const rightItem = items[rightIndex];
        add({
          projectName: leftItem.loop.projectName,
          leftId: leftItem.loop.id,
          leftTitle: leftItem.loop.title,
          rightId: rightItem.loop.id,
          rightTitle: rightItem.loop.title,
          similarity: 1,
        });
      }
    }
  }

  const postings = new Map<string, number[]>();
  for (const [index, item] of items.entries()) {
    for (const token of item.tokens) {
      const bucket = postings.get(token) ?? [];
      bucket.push(index);
      postings.set(token, bucket);
    }
  }

  const overlaps = new Map<string, number>();
  for (const bucket of postings.values()) {
    for (let left = 0; left < bucket.length; left += 1) {
      for (let right = left + 1; right < bucket.length; right += 1) {
        const key = pairKey(bucket[left], bucket[right]);
        overlaps.set(key, (overlaps.get(key) ?? 0) + 1);
      }
    }
  }

  for (const [key, overlap] of overlaps) {
    if (seen.has(key)) continue;
    const [leftIndex, rightIndex] = key.split(':').map(Number);
    const leftItem = items[leftIndex];
    const rightItem = items[rightIndex];
    const leftSize = leftItem.tokens.size;
    const rightSize = rightItem.tokens.size;
    if (leftSize < 4 || rightSize < 4) continue;
    const minimumOverlap = Math.ceil(
      (DUPLICATE_THRESHOLD * (leftSize + rightSize)) / (1 + DUPLICATE_THRESHOLD) - 1e-9,
    );
    if (overlap < minimumOverlap) continue;
    const similarity = overlap / (leftSize + rightSize - overlap);
    if (similarity < DUPLICATE_THRESHOLD) continue;
    add({
      projectName: leftItem.loop.projectName,
      leftId: leftItem.loop.id,
      leftTitle: leftItem.loop.title,
      rightId: rightItem.loop.id,
      rightTitle: rightItem.loop.title,
      similarity: Number(similarity.toFixed(2)),
    });
  }
}

export function buildLoopAudit(options: AuditOptions = {}): LoopAudit {
  const ownsStore = options.store === undefined;
  const store = options.store ?? new LoopStore(options.dbPath ?? resolveDefaultDbPath());
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const staleDays = options.staleDays ?? 14;

  try {
    const active = store.listActiveLoops();
    const weakEvidence: AuditLoopRef[] = [];
    const selfGenerated: AuditLoopRef[] = [];
    const assistantSourced: AuditLoopRef[] = [];
    const statusSnapshots: AuditLoopRef[] = [];
    const missingEvidence: AuditLoopRef[] = [];
    const stale: AuditLoopRef[] = [];
    const duplicatePairs: AuditDuplicate[] = [];

    for (const loop of active) {
      const signals = store.getSignals(loop.sourceSignalIds);
      if (signals.length === 0) {
        missingEvidence.push(loopRef(loop, nowMs));
      } else if (signals.every((signal) => isTrackerOutputMessage(signal))) {
        selfGenerated.push(loopRef(loop, nowMs));
      } else if (signals.every((signal) => isWeakEvidenceMessage(signal))) {
        weakEvidence.push(loopRef(loop, nowMs));
      }
      if (loop.origin === 'assistant') {
        assistantSourced.push(loopRef(loop, nowMs));
        if (STATUS_SNAPSHOT.test(loop.title)) {
          statusSnapshots.push(loopRef(loop, nowMs));
        }
      }
      const firstSeenMs = Date.parse(loop.firstSeen);
      if (Number.isFinite(firstSeenMs) && firstSeenMs < nowMs - staleDays * DAY_MS) {
        stale.push(loopRef(loop, nowMs));
      }
    }

    const byProject = new Map<string, LoopRecord[]>();
    for (const loop of active) {
      const key = projectKey(loop.projectDir);
      const bucket = byProject.get(key) ?? [];
      bucket.push(loop);
      byProject.set(key, bucket);
    }
    for (const bucket of byProject.values()) {
      if (bucket.length < 2) continue;
      groupDuplicatePairs(bucket, (pair) => duplicatePairs.push(pair));
    }

    const suspiciousProjects = [...new Set(
      active
        .map((loop) => loop.projectName)
        .filter(isSuspiciousProjectName),
    )].sort();
    const sessionOnlyProjects = [...new Set(
      active
        .map((loop) => loop.projectName)
        .filter((name) => isSessionOnlyProject(name)),
    )].sort();

    const byOldest = (left: AuditLoopRef, right: AuditLoopRef) => right.daysOpen - left.daysOpen;
    weakEvidence.sort(byOldest);
    selfGenerated.sort(byOldest);
    assistantSourced.sort(byOldest);
    statusSnapshots.sort(byOldest);
    missingEvidence.sort(byOldest);
    stale.sort(byOldest);

    return {
      generatedAt: now.toISOString(),
      staleDays,
      totals: {
        active: active.length,
        open: active.filter((loop) => loop.status === 'open').length,
        pending: active.filter((loop) => loop.status === 'pending').length,
        snoozed: active.filter((loop) => loop.status === 'snoozed').length,
        lowConfidence: active.filter((loop) => loop.confidence < 0.7).length,
        weakEvidence: weakEvidence.length,
        weakEvidenceOpen: weakEvidence.filter((item) => item.status === 'open').length,
        weakEvidencePending: weakEvidence.filter((item) => item.status !== 'open').length,
        selfGenerated: selfGenerated.length,
        userSourced: active.filter((loop) => loop.origin === 'user').length,
        assistantSourced: assistantSourced.length,
        mixedSourced: active.filter((loop) => (loop.origin ?? 'mixed') === 'mixed').length,
        statusSnapshots: statusSnapshots.length,
        missingEvidence: missingEvidence.length,
        stale: stale.length,
        duplicates: duplicatePairs.length,
        suspiciousProjectNames: suspiciousProjects.length,
        sessionOnlyProjects: sessionOnlyProjects.length,
      },
      weakEvidence,
      selfGenerated,
      assistantSourced,
      statusSnapshots,
      missingEvidence,
      stale,
      duplicates: duplicatePairs,
      suspiciousProjects,
      sessionOnlyProjects,
    };
  } finally {
    if (ownsStore) store.close();
  }
}

export function downgradeWeakEvidence(
  store: LoopStore,
  audit: LoopAudit,
  note = '弱证据：来源仅为确认语，已降级待确认',
): string[] {
  const applied: string[] = [];
  for (const ref of audit.weakEvidence) {
    const loop = store.getLoop(ref.id);
    if (!loop || loop.status !== 'open') continue;
    store.updateLoop(ref.id, { status: 'pending', note });
    applied.push(ref.id);
  }
  return applied;
}

export function dropSelfGeneratedLoops(
  store: LoopStore,
  audit: LoopAudit,
  note = '来源是追踪器自己的回访摘要，已按自摄入污染丢弃',
): string[] {
  const applied: string[] = [];
  for (const ref of audit.selfGenerated) {
    const loop = store.getLoop(ref.id);
    if (!loop || (loop.status !== 'open' && loop.status !== 'pending')) continue;
    store.updateLoop(ref.id, { status: 'dropped', note });
    applied.push(ref.id);
  }
  return applied;
}

function formatItems(items: AuditLoopRef[], limit: number): string[] {
  return items.slice(0, limit).map(
    (item) => `- [${item.status}] ${item.projectName} · ${item.title} · 已挂 ${item.daysOpen} 天 · ${item.id}`,
  );
}

export function formatLoopAudit(audit: LoopAudit, limit = 20): string {
  const { totals } = audit;
  const lines = [
    '# 开放循环审计',
    '',
    `- 活跃 ${totals.active} 条：open ${totals.open} / pending ${totals.pending} / snoozed ${totals.snoozed}`,
    `- 弱证据 ${totals.weakEvidence}（open ${totals.weakEvidenceOpen} / pending ${totals.weakEvidencePending}）/ 自摄入 ${totals.selfGenerated} / 缺少来源 ${totals.missingEvidence} / 置信度低于 70% ${totals.lowConfidence}`,
    `- 来源：用户 ${totals.userSourced} / 助手 ${totals.assistantSourced} / 混合 ${totals.mixedSourced}；助手来源表示证据只有助手消息，未经用户确认`,
    `- 可能过期的状态快照 ${totals.statusSnapshots}（仅助手来源标题命中“仍为 0/未提交/只到 Mxx”等模式，不自动关闭）`,
    `- 挂超过 ${audit.staleDays} 天 ${totals.stale} / 重复候选 ${totals.duplicates} / 不稳定项目名 ${totals.suspiciousProjectNames} / 会话工作区 ${totals.sessionOnlyProjects}`,
  ];

  if (audit.weakEvidence.length > 0) {
    lines.push('', `## 弱证据 (${audit.weakEvidence.length})`, ...formatItems(audit.weakEvidence, limit));
  }
  if (audit.selfGenerated.length > 0) {
    lines.push('', `## 自摄入 (${audit.selfGenerated.length})`, ...formatItems(audit.selfGenerated, limit));
  }
  if (audit.assistantSourced.length > 0) {
    lines.push('', `## 助手来源 (${audit.assistantSourced.length})`, ...formatItems(audit.assistantSourced, limit));
  }
  if (audit.statusSnapshots.length > 0) {
    lines.push('', `## 可能过期的状态快照 (${audit.statusSnapshots.length})`, ...formatItems(audit.statusSnapshots, limit));
  }
  if (audit.missingEvidence.length > 0) {
    lines.push('', `## 缺少来源 (${audit.missingEvidence.length})`, ...formatItems(audit.missingEvidence, limit));
  }
  if (audit.stale.length > 0) {
    lines.push('', `## 久挂 (${audit.stale.length})`, ...formatItems(audit.stale, limit));
  }
  if (audit.duplicates.length > 0) {
    lines.push('', `## 重复候选 (${audit.duplicates.length})`);
    for (const item of audit.duplicates.slice(0, limit)) {
      lines.push(
        `- ${item.projectName} · ${item.leftTitle} <> ${item.rightTitle} · ${Math.round(item.similarity * 100)}%`,
      );
    }
  }
  if (audit.suspiciousProjects.length > 0) {
    lines.push('', `## 不稳定项目名 (${audit.suspiciousProjects.length})`);
    for (const name of audit.suspiciousProjects.slice(0, limit)) lines.push(`- ${name}`);
  }
  if (audit.sessionOnlyProjects.length > 0) {
    lines.push('', `## 会话工作区 (${audit.sessionOnlyProjects.length})`);
    for (const name of audit.sessionOnlyProjects.slice(0, limit)) lines.push(`- ${name}`);
  }
  return lines.join('\n');
}
