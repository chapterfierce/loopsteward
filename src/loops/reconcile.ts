import { createHash } from 'node:crypto';
import { LoopStore } from './loop-store.js';
import {
  extractResolutions,
  LoopExtractionError,
  type ChatFn,
  type ResolveInput,
} from './extractor.js';
import { loadProjectMap } from './project-map.js';
import { resolveDefaultDbPath } from './data-path.js';
import { loopRef } from './loop-ref.js';
import { resolveLlmConfig } from './llm-config.js';
import { redactSecrets } from './redact.js';
import {
  discoverRecentSessions,
  displayProjectName,
  MAX_HISTORY_MESSAGES,
  type DiscoverSessionsOptions,
} from './session-source.js';
import type {
  LoopRecord,
  RecentSession,
  ReconcileSummary,
  ResolvedLoop,
  ResolutionCandidate,
  SessionMessage,
} from './types.js';

export interface ReconcileOptions {
  days?: number;
  settleMinutes?: number;
  maxSessions?: number;
  dbPath?: string;
  model?: string;
  baseUrl?: string;
  now?: Date;
  home?: string;
  codexRoot?: string;
  claudeRoot?: string;
  claudeDesktopRoot?: string;
  qoderDbPath?: string;
  zcodeDbPath?: string;
  workbuddyRoot?: string;
  hermesDbPath?: string;
  dshRoot?: string;
  agyRoot?: string;
  agyDbPath?: string;
  magpieHome?: string;
  minConfidence?: number;
  concurrency?: number;
  refresh?: boolean;
  secondLook?: boolean;
  cacheRetentionDays?: number;
  apply?: boolean;
  store?: LoopStore;
  discover?: (options: DiscoverSessionsOptions) => RecentSession[];
  resolve?: (
    input: ResolveInput,
    options?: {
      chat?: ChatFn;
      model?: string;
      baseUrl?: string;
      minConfidence?: number;
      tolerateUnknownEvidence?: boolean;
    },
  ) => Promise<ResolvedLoop[]>;
  chat?: ChatFn;
}

const RECONCILE_CACHE_VERSION = 5;
const DEFAULT_CACHE_RETENTION_DAYS = 30;
const RECONCILE_TAIL_MESSAGES = 20;
const RECONCILE_EVIDENCE_LIMIT = 16;
const RECONCILE_MESSAGE_LIMIT = 40;
const RECONCILE_PROMPT_MESSAGES = 36;
const RECONCILE_LOOPS_PER_CALL = RECONCILE_EVIDENCE_LIMIT;
const RECONCILE_SECOND_LOOK_LIMIT = RECONCILE_LOOPS_PER_CALL;
const RECONCILE_SECOND_LOOK_BATCH = 1;
const RECONCILE_SECOND_LOOK_CONTEXT = 6;
const RECONCILE_SECOND_LOOK_MESSAGES = 30;
const RECONCILE_HISTORY_MESSAGES = MAX_HISTORY_MESSAGES;
const STATUS_UPDATE_HINT = /已完成|已修复|已补|已更新|已记录|已写入|已通过|已解决|已关闭|已提交|已合并|已发布|已实现|已落地|已收口|已补完|收口|补完|全绿|测试通过|不再|已过期|反馈已|已按|done|fixed|resolved|completed|passed|merged|released|updated/i;
const STRONG_COMPLETION_HINT = /已完成|已实现|已修复|已补完|已补上|已通过|已解决|已关闭|已提交|已合并|已发布|已落地|已收口|补完|全绿|测试通过|验证通过/i;
const BLOCKED_COMPLETION_HINT = /blocked|阻塞|卡住|未验证|无法验证|待验证|尚未完成|未完成|还没完成|等待你的判断|等你判断/i;

export interface ReconcileSelectionOptions {
  /**
   * Source evidence message ids for each active loop. At least one message
   * per loop is reserved so a long session cannot crowd a loop's own
   * evidence out of the prompt.
   */
  evidenceByLoop?: ReadonlyMap<string, readonly string[]>;
}

function loopSearchTermsForLoop(loop: LoopRecord): string[] {
  const terms = new Set<string>();
  const text = `${loop.title} ${loop.nextAction}`.toLowerCase();
  for (const raw of text.split(/[^\p{L}\p{N}._-]+/u)) {
    const token = raw.trim();
    if (!token) continue;
    if (/^[a-z0-9][a-z0-9._-]*$/u.test(token)) {
      if (token.length >= 3) terms.add(token);
      continue;
    }
    const chars = [...token];
    if (chars.length >= 2 && chars.length <= 8) terms.add(token);
    if (chars.length >= 4) {
      for (let index = 0; index <= chars.length - 2; index += 1) {
        terms.add(chars.slice(index, index + 2).join(''));
      }
    }
  }
  return [...terms].filter((term) => term.length >= 2);
}

function loopSearchTerms(loops: LoopRecord[]): string[] {
  const terms = new Set<string>();
  for (const loop of loops) {
    for (const term of loopSearchTermsForLoop(loop)) terms.add(term);
  }
  return [...terms].slice(0, 160);
}

interface LoopEvidenceState {
  terms: string[];
  lastSeenMs: number;
  completion?: SessionMessage;
  completions: SessionMessage[];
  fallback?: { message: SessionMessage; score: number };
}

function hasZeroCountBeforeTerm(sentence: string, terms: string[]): boolean {
  return terms.some((term) => {
    let from = 0;
    while (true) {
      const index = sentence.indexOf(term, from);
      if (index < 0) return false;
      const before = sentence.slice(Math.max(0, index - 16), index);
      if (/(?:0|零)\s*(?:条|个|次)?\s*$/u.test(before)) return true;
      from = index + term.length;
    }
  });
}

function scanLoopEvidence(
  history: SessionMessage[],
  loops: LoopRecord[],
  skipIds: ReadonlySet<string> = new Set(),
): Map<string, LoopEvidenceState> {
  const termsByLoop = loops.map((loop) => ({
    loop,
    terms: loopSearchTermsForLoop(loop),
  }));
  const states = new Map<string, LoopEvidenceState>();
  for (const { loop, terms } of termsByLoop) {
    states.set(loop.id, {
      terms,
      lastSeenMs: Date.parse(loop.lastSeen),
      completions: [],
    });
  }

  for (const message of history) {
    if (skipIds.has(message.id)) continue;
    const text = message.text.toLowerCase();
    const messageMs = Date.parse(message.timestamp);
    const completionSentences = message.text
      .split(/[。！？!?；;\n]+/)
      .map((sentence) => sentence.toLowerCase())
      .filter((sentence) => STRONG_COMPLETION_HINT.test(sentence));
    const statusBonus = STATUS_UPDATE_HINT.test(text) ? 1 : 0;
    const negativeMessage = BLOCKED_COMPLETION_HINT.test(message.text)
      || /repeated\s*=\s*0/iu.test(message.text);
    for (const { loop, terms } of termsByLoop) {
      const state = states.get(loop.id);
      if (!state) continue;
      if (
        Number.isFinite(state.lastSeenMs)
        && Number.isFinite(messageMs)
        && messageMs < state.lastSeenMs
      ) {
        continue;
      }
      let score = 0;
      for (const term of terms) {
        if (text.includes(term)) score += 2;
      }
      if (score === 0) continue;
      score += statusBonus;
      const negativeCompletion = negativeMessage || hasZeroCountBeforeTerm(text, terms);
      const hasCompletionEvidence = !negativeCompletion && completionSentences.some((sentence) => (
        terms.some((term) => sentence.includes(term))
        && !hasZeroCountBeforeTerm(sentence, terms)
        && !BLOCKED_COMPLETION_HINT.test(sentence)
      ));
      if (
        hasCompletionEvidence
      ) {
        state.completions.push(message);
      }
      if (
        hasCompletionEvidence
        && (
          !state.completion
          || message.timestamp < state.completion.timestamp
        )
      ) {
        state.completion = message;
      }
      const current = state.fallback;
      if (
        !current
        || score > current.score
        || (score === current.score && message.timestamp > current.message.timestamp)
      ) {
        state.fallback = { message, score };
      }
    }
  }
  return states;
}

/**
 * Reconcile must not rely only on the last few messages: a long session can
 * resolve an old loop hours before its tail changes. Keep the tail but add
 * older messages that mention the loop or an explicit status update.
 */
export function selectReconcileMessages(
  session: RecentSession,
  loops: LoopRecord[],
  options: ReconcileSelectionOptions = {},
): SessionMessage[] {
  const history = session.history?.length ? session.history : session.messages;
  if (history.length <= RECONCILE_TAIL_MESSAGES) return history;

  const tail = history.slice(-RECONCILE_TAIL_MESSAGES);
  const tailIds = new Set(tail.map((message) => message.id));
  const historyById = new Map(history.map((message) => [message.id, message]));
  const reserved: SessionMessage[] = [];
  const reservedIds = new Set<string>();
  const evidenceByLoopState = scanLoopEvidence(history, loops, tailIds);

  for (const loop of loops) {
    if (reserved.length >= RECONCILE_EVIDENCE_LIMIT) break;
    const state = evidenceByLoopState.get(loop.id);
    const best = state?.completion ?? state?.fallback?.message;
    if (best) {
      if (tailIds.has(best.id) || reservedIds.has(best.id)) continue;
      reserved.push(best);
      reservedIds.add(best.id);
      continue;
    }
    const messageIds = options.evidenceByLoop?.get(loop.id) ?? [];
    const candidates = messageIds
      .map((id) => historyById.get(id))
      .filter((message): message is SessionMessage => message !== undefined);
    if (candidates.some((message) => tailIds.has(message.id) || reservedIds.has(message.id))) {
      continue;
    }
    const latest = [...candidates].sort((left, right) => (
      right.timestamp.localeCompare(left.timestamp)
    ))[0];
    if (!latest) continue;
    reserved.push(latest);
    reservedIds.add(latest.id);
  }

  const terms = loopSearchTerms(loops);
  const scored: Array<{ message: SessionMessage; score: number }> = [];

  for (const message of history) {
    if (tailIds.has(message.id) || reservedIds.has(message.id)) continue;
    const text = message.text.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (text.includes(term)) score += 2;
    }
    if (STATUS_UPDATE_HINT.test(text)) score += 1;
    if (score > 0) scored.push({ message, score });
  }

  scored.sort((left, right) => (
    right.score - left.score
    || right.message.timestamp.localeCompare(left.message.timestamp)
  ));
  const picked = scored
    .slice(0, Math.max(0, RECONCILE_EVIDENCE_LIMIT - reserved.length))
    .map((entry) => entry.message);
  const byId = new Map<string, SessionMessage>();
  for (const message of [...reserved, ...picked, ...tail]) byId.set(message.id, message);
  return [...byId.values()]
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
    .slice(-RECONCILE_MESSAGE_LIMIT);
}

export function findCompletionEvidence(
  session: RecentSession,
  loops: LoopRecord[],
): Map<string, SessionMessage[]> {
  const history = session.history?.length ? session.history : session.messages;
  const states = scanLoopEvidence(history, loops);
  const evidence = new Map<string, SessionMessage[]>();
  for (const loop of loops) {
    const messages = states.get(loop.id)?.completions ?? [];
    if (messages.length > 0) {
      evidence.set(
        loop.id,
        [...messages]
          .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
          .slice(0, 8),
      );
    }
  }
  return evidence;
}

function secondLookMessages(
  session: RecentSession,
  loops: LoopRecord[],
  evidence: ReadonlyMap<string, SessionMessage[]>,
): SessionMessage[] {
  const history = session.history?.length ? session.history : session.messages;
  const indexById = new Map(history.map((message, index) => [message.id, index]));
  const radius = Math.floor(RECONCILE_SECOND_LOOK_CONTEXT / 2);
  const indexes = new Set<number>();
  const candidateIndexes: number[] = [];
  for (const loop of loops) {
    for (const message of evidence.get(loop.id) ?? []) {
      const index = indexById.get(message.id);
      if (index === undefined || indexes.has(index)) continue;
      indexes.add(index);
      candidateIndexes.push(index);
    }
  }
  for (const index of candidateIndexes) {
    if (indexes.size >= RECONCILE_SECOND_LOOK_MESSAGES) break;
    const start = Math.max(0, index - radius);
    const end = Math.min(history.length - 1, index + radius);
    for (let cursor = start; cursor <= end; cursor += 1) {
      if (indexes.size >= RECONCILE_SECOND_LOOK_MESSAGES) break;
      indexes.add(cursor);
    }
  }
  return [...indexes]
    .sort((left, right) => left - right)
    .map((index) => history[index]);
}

function sourceEvidenceByLoop(
  store: LoopStore,
  loops: LoopRecord[],
): Map<string, string[]> {
  const signalIds = [...new Set(loops.flatMap((loop) => loop.sourceSignalIds))];
  const signalById = new Map(store.getSignals(signalIds).map((signal) => [signal.id, signal]));
  const evidenceByLoop = new Map<string, string[]>();
  for (const loop of loops) {
    const messageIds = [...new Set(loop.sourceSignalIds
      .map((id) => signalById.get(id)?.messageId)
      .filter((id): id is string => Boolean(id)))];
    if (messageIds.length > 0) evidenceByLoop.set(loop.id, messageIds);
  }
  return evidenceByLoop;
}

function reconcileCacheHash(input: {
  session: RecentSession;
  projectDir: string;
  projectName: string;
  loops: LoopRecord[];
  model: string;
  baseUrl: string;
  minConfidence: number;
  secondLook: boolean;
}): string {
  const historyHash = createHash('sha256');
  for (const message of input.session.history ?? []) {
    historyHash.update(message.id);
    historyHash.update('\0');
    historyHash.update(message.role);
    historyHash.update('\0');
    historyHash.update(message.timestamp);
    historyHash.update('\0');
    historyHash.update(message.text);
    historyHash.update('\n');
  }
  return createHash('sha256').update(JSON.stringify({
    version: RECONCILE_CACHE_VERSION,
    model: input.model,
    baseUrl: input.baseUrl,
    minConfidence: input.minConfidence,
    secondLook: input.secondLook,
    session: {
      agent: input.session.agent,
      sessionId: input.session.sessionId,
      title: input.session.title,
      projectDir: input.projectDir,
      messages: input.session.messages.map((message) => [
        message.id,
        message.role,
        message.timestamp,
        message.text,
      ]),
      history: historyHash.digest('hex'),
    },
    loops: input.loops.map((loop) => [
      loop.id,
      loop.title,
      loop.nextAction,
      loop.status,
      loop.confidence,
      loop.lastSeen,
    ]),
    projectName: input.projectName,
  })).digest('hex');
}

export async function reconcileRecentSessions(
  options: ReconcileOptions = {},
): Promise<ReconcileSummary> {
  const cacheRetentionDays = options.cacheRetentionDays ?? DEFAULT_CACHE_RETENTION_DAYS;
  if (!Number.isFinite(cacheRetentionDays) || cacheRetentionDays <= 0) {
    throw new Error('cacheRetentionDays must be a positive number');
  }
  const summary: ReconcileSummary = {
    sessionsSeen: 0,
    sessionsChecked: 0,
    sessionsCached: 0,
    cachePruned: 0,
    candidates: [],
    applied: [],
    errors: [],
  };
  const ownsStore = options.store === undefined;
  const store = options.store ?? new LoopStore(options.dbPath ?? resolveDefaultDbPath());
  const discover = options.discover ?? discoverRecentSessions;
  const resolve = options.resolve ?? extractResolutions;
  const projectMap = loadProjectMap(options.magpieHome);
  const minConfidence = options.minConfidence ?? 0.9;
  const llm = resolveLlmConfig({ baseUrl: options.baseUrl, model: options.model });
  const model = llm.model;
  const baseUrl = llm.baseUrl;

  const callResolve = (
    session: RecentSession,
    projectDir: string,
    loops: LoopRecord[],
    messages: SessionMessage[],
    maxMessages: number,
  ): Promise<ResolvedLoop[]> => {
    const safeMessages = messages.map((message) => ({
      ...message,
      text: redactSecrets(message.text),
    }));
    return resolve(
      {
        session: {
          agent: session.agent,
          sessionId: session.sessionId,
          title: session.title,
          projectDir,
        },
        loops: loops.map((loop) => ({
          id: loop.id,
          title: loop.title,
          nextAction: loop.nextAction,
          status: loop.status,
          confidence: loop.confidence,
          lastSeen: loop.lastSeen,
        })),
        messages: safeMessages,
        maxMessages,
      },
      {
        chat: options.chat,
        model,
        baseUrl,
        minConfidence,
        tolerateUnknownEvidence: true,
      },
    );
  };

  const resolveWithSplit = async (
    session: RecentSession,
    projectDir: string,
    loops: LoopRecord[],
    messages: SessionMessage[],
    maxMessages: number,
  ): Promise<ResolvedLoop[]> => {
    try {
      return await callResolve(session, projectDir, loops, messages, maxMessages);
    } catch (error) {
      const kind = error instanceof LoopExtractionError ? error.kind : undefined;
      if (
        loops.length <= 1
        || (kind !== 'parse' && kind !== 'validation')
      ) {
        throw error;
      }
      const middle = Math.ceil(loops.length / 2);
      const left = await resolveWithSplit(
        session,
        projectDir,
        loops.slice(0, middle),
        messages,
        maxMessages,
      );
      const right = await resolveWithSplit(
        session,
        projectDir,
        loops.slice(middle),
        messages,
        maxMessages,
      );
      const merged = new Map<string, ResolvedLoop>();
      for (const item of [...left, ...right]) {
        const previous = merged.get(item.loopId);
        if (!previous || item.confidence > previous.confidence) {
          merged.set(item.loopId, item);
        }
      }
      return [...merged.values()];
    }
  };

  try {
    const sessions = discover({
      home: options.home,
      days: options.days ?? 7,
      settleMinutes: options.settleMinutes ?? 0,
      maxSessions: options.maxSessions ?? 120,
      historyMessages: RECONCILE_HISTORY_MESSAGES,
      now: options.now,
      codexRoot: options.codexRoot,
      claudeRoot: options.claudeRoot,
      claudeDesktopRoot: options.claudeDesktopRoot,
      qoderDbPath: options.qoderDbPath,
      zcodeDbPath: options.zcodeDbPath,
      workbuddyRoot: options.workbuddyRoot,
      hermesDbPath: options.hermesDbPath,
      dshRoot: options.dshRoot,
      agyRoot: options.agyRoot,
      agyDbPath: options.agyDbPath,
    });
    summary.sessionsSeen = sessions.length;

    interface ReconcileJob {
      session: RecentSession;
      identity: { dir: string; name: string };
      loops: LoopRecord[];
      messages: SessionMessage[];
      sessionKey: string;
      batchIndex: number;
      batchTotal: number;
    }
    interface ReconcileJobResult {
      job: ReconcileJob;
      resolved?: ResolvedLoop[];
      cached?: boolean;
      error?: string;
      secondLookErrors?: string[];
    }

    const jobs: ReconcileJob[] = [];
    for (const session of sessions) {
      if (session.messages.length < 2) continue;
      const identity = projectMap.resolve(session.projectDir);
      const loops = store.listActiveLoops(identity.dir);
      if (loops.length === 0) continue;
      const sessionKey = `${session.agent}:${session.sessionId}`;
      const batchTotal = Math.max(
        1,
        Math.ceil(loops.length / RECONCILE_LOOPS_PER_CALL),
      );
      for (let batchIndex = 0; batchIndex < batchTotal; batchIndex += 1) {
        const batchLoops = loops.slice(
          batchIndex * RECONCILE_LOOPS_PER_CALL,
          (batchIndex + 1) * RECONCILE_LOOPS_PER_CALL,
        );
        jobs.push({
          session,
          identity,
          loops: batchLoops,
          messages: selectReconcileMessages(session, batchLoops, {
            evidenceByLoop: sourceEvidenceByLoop(store, batchLoops),
          }),
          sessionKey,
          batchIndex,
          batchTotal,
        });
      }
    }

    const requestedConcurrency = options.concurrency ?? 4;
    const concurrency = Math.max(
      1,
      Math.min(
        Number.isFinite(requestedConcurrency) ? Math.floor(requestedConcurrency) : 4,
        16,
        Math.max(1, jobs.length),
      ),
    );
    const results: Array<ReconcileJobResult | undefined> = new Array(jobs.length);
    const cacheEnabled = !options.chat;
    const useCache = cacheEnabled && !options.refresh;
    let nextJob = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const index = nextJob;
        nextJob += 1;
        if (index >= jobs.length) return;
        const job = jobs[index];
        const sessionKey = job.batchTotal > 1
          ? `${job.sessionKey}#batch-${job.batchIndex + 1}`
          : job.sessionKey;
        const contentHash = reconcileCacheHash({
          session: job.session,
          projectDir: job.identity.dir,
          projectName: job.identity.name,
          loops: job.loops,
          model: model ?? '',
          baseUrl: baseUrl ?? '',
          minConfidence,
          secondLook: options.secondLook !== false,
        });
        if (useCache) {
          const cached = store.getReconcileCache(sessionKey);
          if (cached && cached.contentHash === contentHash) {
            results[index] = { job, resolved: cached.candidates, cached: true };
            continue;
          }
        }
        try {
          const firstPass = await resolveWithSplit(
            job.session,
            job.identity.dir,
            job.loops,
            job.messages,
            RECONCILE_PROMPT_MESSAGES,
          );
          let resolved = firstPass;
          const secondLookErrors: string[] = [];
          if (options.secondLook !== false) {
            const settledIds = new Set(
              firstPass
                .filter((item) => item.confidence >= minConfidence)
                .map((item) => item.loopId),
            );
            const completionEvidence = findCompletionEvidence(job.session, job.loops);
            const pending = job.loops
              .filter((loop) => (
                !settledIds.has(loop.id)
                && (completionEvidence.get(loop.id)?.length ?? 0) > 0
              ))
              .slice(0, RECONCILE_SECOND_LOOK_LIMIT);
            if (pending.length > 0) {
              const merged = new Map(firstPass.map((item) => [item.loopId, item]));
              for (
                let offset = 0;
                offset < pending.length;
                offset += RECONCILE_SECOND_LOOK_BATCH
              ) {
                const batch = pending.slice(offset, offset + RECONCILE_SECOND_LOOK_BATCH);
                const messages = secondLookMessages(job.session, batch, completionEvidence);
                if (messages.length === 0) continue;
                try {
                  const extra = await callResolve(
                    job.session,
                    job.identity.dir,
                    batch,
                    messages,
                    RECONCILE_PROMPT_MESSAGES,
                  );
                  const batchIds = new Set(batch.map((loop) => loop.id));
                  for (const item of extra) {
                    if (!batchIds.has(item.loopId)) continue;
                    const previous = merged.get(item.loopId);
                    if (!previous || item.confidence > previous.confidence) {
                      merged.set(item.loopId, item);
                    }
                  }
                } catch (error) {
                  secondLookErrors.push((error as Error).message);
                }
              }
              resolved = [...merged.values()];
            }
          }
          if (cacheEnabled && secondLookErrors.length === 0) {
            store.setReconcileCache(sessionKey, contentHash, resolved);
          }
          results[index] = { job, resolved };
          if (secondLookErrors.length > 0) {
            results[index] = { job, resolved, secondLookErrors };
          }
        } catch (error) {
          results[index] = { job, error: (error as Error).message };
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    const sessionStats = new Map<string, {
      total: number;
      completed: number;
      cached: number;
      failed: number;
    }>();
    for (const job of jobs) {
      if (sessionStats.has(job.sessionKey)) continue;
      sessionStats.set(job.sessionKey, {
        total: job.batchTotal,
        completed: 0,
        cached: 0,
        failed: 0,
      });
    }

    for (const result of results) {
      if (!result) continue;
      const { job } = result;
      const stats = sessionStats.get(job.sessionKey);
      if (result.error) {
        if (stats) stats.failed += 1;
        const suffix = job.batchTotal > 1
          ? `#${job.batchIndex + 1}/${job.batchTotal}`
          : '';
        summary.errors.push(
          `${job.session.agent}/${job.session.sessionId}${suffix}: ${result.error}`,
        );
        continue;
      }
      for (const error of result.secondLookErrors ?? []) {
        const suffix = job.batchTotal > 1
          ? `#${job.batchIndex + 1}/${job.batchTotal}`
          : '';
        summary.errors.push(
          `${job.session.agent}/${job.session.sessionId}${suffix} second-look: ${error}`,
        );
      }
      if (stats) {
        stats.completed += 1;
        if (result.cached) stats.cached += 1;
      }
      for (const item of result.resolved ?? []) {
        if (item.confidence < minConfidence) continue;
        const loop = job.loops.find((candidate) => candidate.id === item.loopId);
        if (!loop) continue;
        const candidate: ResolutionCandidate = {
          ...item,
          ref: loopRef(item.loopId),
          title: loop.title,
          projectDir: job.identity.dir,
          projectName: displayProjectName(job.identity.name, job.session, options.home),
          agent: job.session.agent,
          sessionId: job.session.sessionId,
        };
        const duplicate = summary.candidates.find((entry) => entry.loopId === item.loopId);
        if (duplicate) {
          if (item.confidence > duplicate.confidence) Object.assign(duplicate, candidate);
          continue;
        }
        summary.candidates.push(candidate);
        if (!options.apply) continue;
        store.updateLoop(item.loopId, {
          status: 'resolved',
          note: `核对完成：${item.reason}（${job.session.agent}/${job.session.sessionId}）`,
        });
        summary.applied.push(item.loopId);
      }
    }
    for (const stats of sessionStats.values()) {
      if (stats.completed > 0) summary.sessionsChecked += 1;
      if (
        stats.completed === stats.total
        && stats.failed === 0
        && stats.cached === stats.total
      ) {
        summary.sessionsCached += 1;
      }
    }
    if (cacheEnabled) {
      try {
        summary.cachePruned = store.pruneReconcileCache(cacheRetentionDays, options.now);
      } catch (error) {
        summary.errors.push(`cache: ${(error as Error).message}`);
      }
    }
  } catch (error) {
    summary.errors.push(`discover: ${(error as Error).message}`);
  } finally {
    if (ownsStore) store.close();
  }

  summary.candidates.sort((left, right) => right.confidence - left.confidence);
  return summary;
}
