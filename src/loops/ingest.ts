import { createHash } from 'node:crypto';
import { LoopStore } from './loop-store.js';
import { extractLoops, type ChatFn, type ExtractInput } from './extractor.js';
import { redactSecrets } from './redact.js';
import { loadProjectMap, type ProjectMap } from './project-map.js';
import {
  discoverRecentSessions,
  displayProjectName,
  projectNameFromDir,
  type DiscoverSessionsOptions,
} from './session-source.js';
import { resolveDefaultDbPath } from './data-path.js';
import type {
  ExtractedLoop,
  IngestSummary,
  LoopSignal,
  RecentSession,
} from './types.js';

export interface IngestOptions {
  days?: number;
  settleMinutes?: number;
  maxSessions?: number;
  concurrency?: number;
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
  magpieHome?: string;
  chat?: ChatFn;
  store?: LoopStore;
  discover?: (options: DiscoverSessionsOptions) => RecentSession[];
  extract?: (input: ExtractInput, options?: { chat?: ChatFn; model?: string; baseUrl?: string }) => Promise<ExtractedLoop[]>;
}

function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function toIsoTimestamp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function signalId(session: RecentSession, messageId: string): string {
  return `${session.agent}:${session.sessionId}:${messageId}`;
}

const RECENT_QUESTION_HOLD_MS = 5 * 60 * 1000;

function isRecentQuestion(session: RecentSession, now: Date): boolean {
  const last = session.messages[session.messages.length - 1];
  if (!last || last.role !== 'user') return false;
  const text = last.text.trim();
  if (!text.endsWith('?') && !text.endsWith('？')) return false;
  const timestamp = Date.parse(last.timestamp ?? session.lastActive);
  if (!Number.isFinite(timestamp)) return false;
  return now.getTime() - timestamp < RECENT_QUESTION_HOLD_MS;
}

function emptySummary(): IngestSummary {
  return {
    sessionsSeen: 0,
    sessionsProcessed: 0,
    sessionsSkipped: 0,
    signalsSeen: 0,
    loopsCreated: 0,
    loopsMerged: 0,
    errors: [],
  };
}

export async function ingestRecentSessions(options: IngestOptions = {}): Promise<IngestSummary> {
  const summary = emptySummary();
  const now = options.now ?? new Date();
  const ownsStore = options.store === undefined;
  const store = options.store ?? new LoopStore(options.dbPath ?? resolveDefaultDbPath());
  const runId = store.startRun('session');
  const discover = options.discover ?? discoverRecentSessions;
  const extract = options.extract ?? extractLoops;
  const projectMap: ProjectMap = loadProjectMap(options.magpieHome);

  try {
    const sessions = discover({
      home: options.home,
      days: options.days ?? 7,
      settleMinutes: options.settleMinutes ?? 30,
      maxSessions: options.maxSessions ?? 120,
      now,
      codexRoot: options.codexRoot,
      claudeRoot: options.claudeRoot,
      claudeDesktopRoot: options.claudeDesktopRoot,
      qoderDbPath: options.qoderDbPath,
      zcodeDbPath: options.zcodeDbPath,
      workbuddyRoot: options.workbuddyRoot,
      hermesDbPath: options.hermesDbPath,
      dshRoot: options.dshRoot,
    });
    summary.sessionsSeen = sessions.length;

    const processSession = async (session: RecentSession): Promise<void> => {
      try {
        if (session.messages.length === 0) return;
        if ((options.settleMinutes ?? 30) === 0 && isRecentQuestion(session, now)) {
          summary.sessionsSkipped += 1;
          return;
        }
        const identity = projectMap.resolve(session.projectDir);
        const projectName = displayProjectName(identity.name, session, options.home)
          || projectNameFromDir(identity.dir);
        const sessionLastActive = toIsoTimestamp(session.lastActive) ?? session.lastActive;
        const effectiveProjectName = store.recordProjectActivity(
          identity.dir,
          projectName,
          sessionLastActive,
          session.sessionId,
        );
        store.renameProject(identity.dir, effectiveProjectName);
        const signals: LoopSignal[] = session.messages.map((message) => {
          const capturedAt = toIsoTimestamp(message.timestamp);
          const text = redactSecrets(message.text);
          return {
            id: signalId(session, message.id),
            source: 'session',
            sourceId: session.sessionId,
            messageId: message.id,
            agent: session.agent,
            role: message.role,
            text,
            projectDir: identity.dir,
            capturedAt: capturedAt ?? sessionLastActive,
            capturedAtSource: capturedAt ? 'message' : 'session',
            contentHash: contentHash(text),
          };
        });
        summary.signalsSeen += signals.length;
        for (const signal of signals) store.saveSignal(signal);

        const hasUnprocessed = store
          .getSignals(signals.map((signal) => signal.id))
          .some((signal) => !signal.processedAt);
        if (!hasUnprocessed) {
          summary.sessionsSkipped += 1;
          return;
        }

        const existingLoops = store.listActiveLoops(identity.dir).map((loop) => ({
          id: loop.id,
          title: loop.title,
          nextAction: loop.nextAction,
          status: loop.status,
          confidence: loop.confidence,
          lastSeen: loop.lastSeen,
        }));
        const llmMessages = session.messages.map((message) => ({
          ...message,
          text: redactSecrets(message.text),
        }));

        const extracted = await extract(
          {
            session: {
              agent: session.agent,
              sessionId: session.sessionId,
              title: session.title,
              projectDir: identity.dir,
            },
            messages: llmMessages,
            existingLoops,
          },
          {
            chat: options.chat,
            model: options.model,
            baseUrl: options.baseUrl,
          },
        );

        const knownSignalIds = new Set(signals.map((signal) => signal.id));
        const capturedAtById = new Map<string, string>();
        for (const message of session.messages) {
          const capturedAt = toIsoTimestamp(message.timestamp);
          if (!capturedAt) continue;
          const id = signalId(session, message.id);
          const existing = capturedAtById.get(id);
          if (!existing || Date.parse(capturedAt) > Date.parse(existing)) {
            capturedAtById.set(id, capturedAt);
          }
        }
        for (const candidate of extracted) {
          const sourceSignalIds = candidate.sourceMessageIds
            .map((messageId) => signalId(session, messageId))
            .filter((id) => knownSignalIds.has(id));
          if (sourceSignalIds.length === 0) {
            summary.errors.push(
              `${session.agent}/${session.sessionId}: loop "${candidate.title}" has no valid source messages`,
            );
            continue;
          }
          let candidateFirstSeen: string | undefined;
          let candidateLastSeen = sessionLastActive;
          let earliestCapturedMs = Number.POSITIVE_INFINITY;
          let latestCapturedMs = Number.NEGATIVE_INFINITY;
          for (const sourceId of sourceSignalIds) {
            const capturedAt = capturedAtById.get(sourceId);
            const capturedMs = capturedAt ? Date.parse(capturedAt) : Number.NaN;
            if (Number.isFinite(capturedMs) && capturedMs < earliestCapturedMs) {
              earliestCapturedMs = capturedMs;
              candidateFirstSeen = capturedAt!;
            }
            if (Number.isFinite(capturedMs) && capturedMs > latestCapturedMs) {
              latestCapturedMs = capturedMs;
              candidateLastSeen = capturedAt!;
            }
          }
          const result = store.saveLoop(
            {
              title: candidate.title,
              nextAction: candidate.nextAction,
              why: candidate.why,
              confidence: candidate.confidence,
              sourceSignalIds,
              mergeInto: candidate.mergeInto,
            },
            {
              projectDir: identity.dir,
              projectName: effectiveProjectName,
              firstSeen: candidateFirstSeen ?? sessionLastActive,
              firstSeenIsFallback: candidateFirstSeen === undefined,
              lastSeen: candidateLastSeen,
              lastSeenIsFallback: latestCapturedMs === Number.NEGATIVE_INFINITY,
            },
          );
          if (result.created) summary.loopsCreated += 1;
          else summary.loopsMerged += 1;
        }

        store.markSignalsProcessed(signals.map((signal) => signal.id));
        summary.sessionsProcessed += 1;
      } catch (error) {
        summary.errors.push(
          `${session.agent}/${session.sessionId}: ${(error as Error).message}`,
        );
      }
    };

    const concurrency = Math.max(
      1,
      Math.min(options.concurrency ?? 4, sessions.length || 1),
    );
    let nextSession = 0;
    await Promise.all(Array.from({ length: concurrency }, async () => {
      for (;;) {
        const index = nextSession;
        nextSession += 1;
        if (index >= sessions.length) return;
        await processSession(sessions[index]);
      }
    }));
  } catch (error) {
    summary.errors.push(`discover: ${(error as Error).message}`);
  } finally {
    store.finishRun(runId, summary);
    if (ownsStore) store.close();
  }

  return summary;
}
