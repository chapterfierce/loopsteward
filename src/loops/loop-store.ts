import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { normalizeLoopRef } from './loop-ref.js';
import { resolveDefaultDbPath } from './data-path.js';
import { isPresentationInFuture } from './presentation-time.js';
import { redactSecrets } from './redact.js';
import type {
  IngestRunRecord,
  IngestSummary,
  LoopCandidate,
  LoopFeedbackCounts,
  LoopFeedbackRecord,
  LoopFeedbackVerdict,
  LoopListFilter,
  LoopOrigin,
  LoopPresentation,
  LoopPresentationKind,
  LoopPresentationStats,
  LoopRecord,
  LoopSignal,
  LoopStatus,
  ProjectActivity,
  RedactionSummary,
  ReconcileCacheCandidate,
  ResolvedLoop,
} from './types.js';

interface LoopMeta {
  projectDir: string;
  projectName: string;
  firstSeen?: string;
  lastSeen?: string;
  firstSeenIsFallback?: boolean;
  lastSeenIsFallback?: boolean;
}

interface SaveLoopResult {
  loop: LoopRecord;
  created: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeTitle(title: string): string {
  return title.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function dedupeKey(projectDir: string, title: string): string {
  return createHash('sha256')
    .update(`${projectDir.replace(/\\/g, '/').toLowerCase()}|${normalizeTitle(title)}`)
    .digest('hex');
}

export function titleTokens(title: string): Set<string> {
  const normalized = title.normalize('NFKC').toLowerCase();
  const tokens = new Set<string>();
  const words = normalized.match(/[a-z0-9]+/g) ?? [];
  for (const word of words) tokens.add(word);
  const cjkRuns = normalized.match(/[\u4e00-\u9fff]+/g) ?? [];
  for (const run of cjkRuns) {
    if (run.length === 1) tokens.add(run);
    for (let index = 0; index < run.length - 1; index += 1) {
      tokens.add(run.slice(index, index + 2));
    }
  }
  return tokens;
}

export function titleSimilarity(left: string, right: string): number {
  const a = titleTokens(left);
  const b = titleTokens(right);
  if (a.size < 4 || b.size < 4) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

interface ReviewCycleState {
  startedAt?: string;
  seen: string[];
  lastBatch?: string[];
}

function parseReviewCycleState(value: string | undefined): ReviewCycleState {
  if (!value) return { seen: [] };
  try {
    const parsed = JSON.parse(value) as {
      startedAt?: unknown;
      seen?: unknown;
      lastBatch?: unknown;
    };
    return {
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : undefined,
      seen: Array.isArray(parsed.seen)
        ? parsed.seen.filter((item): item is string => typeof item === 'string')
        : [],
      lastBatch: Array.isArray(parsed.lastBatch)
        ? parsed.lastBatch.filter((item): item is string => typeof item === 'string')
        : undefined,
    };
  } catch {
    return { seen: [] };
  }
}

function sameIdSet(left: Iterable<string>, right: Iterable<string>): boolean {
  const a = new Set(left);
  const b = new Set(right);
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

function normalizeIso(value: string): string {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : value;
}

function compareIso(left: string, right: string): number {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs)) return leftMs - rightMs;
  return left.localeCompare(right);
}

function laterIso(left: string, right: string): string {
  return compareIso(left, right) >= 0 ? left : right;
}

function sameProject(left: string, right: string): boolean {
  return left.replace(/\\/g, '/').toLowerCase() === right.replace(/\\/g, '/').toLowerCase();
}

export class LoopStore {
  private db: any;
  private closed = false;

  constructor(dbPath = resolveDefaultDbPath()) {
    const req = createRequire(import.meta.url);
    const { DatabaseSync } = req('node:sqlite') as { DatabaseSync: new (file: string) => any };

    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath);
      if (dir && dir !== '.' && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA busy_timeout = 5000;');
    if (dbPath !== ':memory:') this.db.exec('PRAGMA journal_mode = DELETE;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS loop_signals (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        source_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        agent TEXT NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        project_dir TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        captured_at_source TEXT NOT NULL DEFAULT 'message',
        content_hash TEXT NOT NULL,
        processed_at TEXT,
        UNIQUE(source, source_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_loop_signals_project ON loop_signals(project_dir);
      CREATE INDEX IF NOT EXISTS idx_loop_signals_captured ON loop_signals(captured_at);

      CREATE TABLE IF NOT EXISTS loops (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        next_action TEXT NOT NULL,
        why TEXT NOT NULL,
        status TEXT NOT NULL,
        confidence REAL NOT NULL,
        project_dir TEXT NOT NULL,
        project_name TEXT NOT NULL,
        source_signal_ids TEXT NOT NULL,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        first_seen_source TEXT NOT NULL DEFAULT 'message',
        last_seen_source TEXT NOT NULL DEFAULT 'message',
        snooze_until TEXT,
        resolved_at TEXT,
        resolution_note TEXT,
        dedupe_key TEXT NOT NULL UNIQUE
      );
      CREATE INDEX IF NOT EXISTS idx_loops_status ON loops(status);
      CREATE INDEX IF NOT EXISTS idx_loops_project ON loops(project_dir);
      CREATE INDEX IF NOT EXISTS idx_loops_last_seen ON loops(last_seen);

      CREATE TABLE IF NOT EXISTS loop_feedback (
        id TEXT PRIMARY KEY,
        loop_id TEXT NOT NULL,
        verdict TEXT NOT NULL CHECK (verdict IN ('forgotten', 'noise')),
        note TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(loop_id) REFERENCES loops(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_loop_feedback_loop ON loop_feedback(loop_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_loop_feedback_created ON loop_feedback(created_at);

      CREATE TABLE IF NOT EXISTS ingest_runs (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        source TEXT NOT NULL,
        signals_seen INTEGER NOT NULL DEFAULT 0,
        loops_created INTEGER NOT NULL DEFAULT 0,
        loops_merged INTEGER NOT NULL DEFAULT 0,
        errors TEXT
      );

      CREATE TABLE IF NOT EXISTS project_activity (
        project_dir TEXT PRIMARY KEY,
        project_name TEXT NOT NULL,
        last_active TEXT NOT NULL,
        session_count INTEGER NOT NULL DEFAULT 0,
        last_session_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_project_activity_last_active ON project_activity(last_active);

      CREATE TABLE IF NOT EXISTS project_sessions (
        project_dir TEXT NOT NULL,
        session_id TEXT NOT NULL,
        last_active TEXT NOT NULL,
        PRIMARY KEY(project_dir, session_id)
      );
      CREATE INDEX IF NOT EXISTS idx_project_sessions_project ON project_sessions(project_dir);

      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS loop_presentations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        presented_at TEXT NOT NULL,
        mode TEXT NOT NULL,
        kind TEXT NOT NULL,
        loop_ids TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_loop_presentations_presented_at
        ON loop_presentations(presented_at);

      CREATE TABLE IF NOT EXISTS loop_reconcile_cache (
        session_key TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        candidates_json TEXT NOT NULL,
        checked_at TEXT NOT NULL
      );
    `);

    this.ensureColumn('loops', 'last_surfaced_at', 'last_surfaced_at TEXT');
    this.ensureColumn('loops', 'hot_surfaced_at', 'hot_surfaced_at TEXT');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_loops_hot_surfaced_at ON loops(hot_surfaced_at)');
    this.ensureColumn('loops', 'ignored_count', 'ignored_count INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn(
      'loops',
      'presentation_count',
      'presentation_count INTEGER NOT NULL DEFAULT 0',
    );
    this.ensureColumn('loops', 'last_presented_at', 'last_presented_at TEXT');
    this.ensureColumn(
      'loops',
      'origin',
      "origin TEXT NOT NULL DEFAULT 'mixed'",
    );
    this.ensureColumn(
      'loops',
      'first_seen_source',
      "first_seen_source TEXT NOT NULL DEFAULT 'message'",
    );
    this.ensureColumn(
      'loops',
      'last_seen_source',
      "last_seen_source TEXT NOT NULL DEFAULT 'message'",
    );
    this.ensureColumn(
      'loop_signals',
      'captured_at_source',
      "captured_at_source TEXT NOT NULL DEFAULT 'message'",
    );
    this.backfillProjectSessions();
    this.backfillLoopEvidenceRange();
    this.backfillReviewCycle();
    this.backfillPresentationFatigue();
    this.backfillLoopOrigin();
  }

  private backfillProjectSessions(): void {
    const key = ['m11', 'project', 'sessions'].join('_');
    const done = this.db.prepare(
      'SELECT value FROM schema_meta WHERE key = ?',
    ).get(key);
    if (done) return;

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db.exec(`
        INSERT OR IGNORE INTO project_sessions (project_dir, session_id, last_active)
        SELECT project_dir, source_id, MAX(captured_at)
        FROM loop_signals
        GROUP BY project_dir, source_id;

        UPDATE project_activity SET session_count = (
          SELECT COUNT(*) FROM project_sessions
          WHERE project_sessions.project_dir = project_activity.project_dir
        );
      `);
      this.db.prepare(
        'INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)',
      ).run(key, 'done');
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  private backfillReviewCycle(): void {
    const existing = this.db.prepare(
      "SELECT value FROM schema_meta WHERE key = 'review_cycle'",
    ).get() as { value?: string } | undefined;
    if (existing?.value) return;

    const rows = this.db.prepare(`
      SELECT presented_at, loop_ids
      FROM loop_presentations
      WHERE kind = 'review'
      ORDER BY julianday(presented_at) ASC, id ASC
    `).all() as Array<{ presented_at: string; loop_ids: string }>;
    if (rows.length === 0) return;

    let startedAt: string | undefined;
    let seen = new Set<string>();
    let lastBatch = new Set<string>();
    for (const row of rows) {
      const ids = [...new Set(parseJsonArray(row.loop_ids))];
      if (ids.length === 0) continue;
      if (sameIdSet(ids, lastBatch)) continue;
      const wrapped = ids.some((id) => seen.has(id));
      if (wrapped) {
        seen = new Set(ids);
        startedAt = row.presented_at;
      } else {
        for (const id of ids) seen.add(id);
        startedAt ??= row.presented_at;
      }
      lastBatch = new Set(ids);
    }
    if (seen.size === 0) return;

    this.db.prepare(
      'INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)',
    ).run(
      'review_cycle',
      JSON.stringify({ startedAt, seen: [...seen], lastBatch: [...lastBatch] }),
    );
  }

  private backfillPresentationFatigue(): void {
    const key = 'm135_presentation_fatigue';
    const done = this.db.prepare(
      'SELECT value FROM schema_meta WHERE key = ?',
    ).get(key);
    if (done) return;

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const rows = this.db.prepare(`
        SELECT loop_ids, presented_at
        FROM loop_presentations
        WHERE kind IN ('recap', 'candidate', 'teaser')
      `).all() as Array<{ loop_ids: string; presented_at: string }>;
      const counts = new Map<string, { count: number; last: string }>();
      for (const row of rows) {
        for (const id of parseJsonArray(row.loop_ids)) {
          const current = counts.get(id) ?? { count: 0, last: '' };
          current.count += 1;
          if (row.presented_at > current.last) current.last = row.presented_at;
          counts.set(id, current);
        }
      }
      const update = this.db.prepare(`
        UPDATE loops SET presentation_count = ?, last_presented_at = ? WHERE id = ?
      `);
      for (const [id, value] of counts) {
        update.run(value.count, value.last, id);
      }
      this.db.prepare(
        'INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)',
      ).run(key, 'done');
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  private backfillLoopOrigin(): void {
    const key = ['m146', 'loop', 'origin'].join('_');
    const done = this.db.prepare(
      'SELECT value FROM schema_meta WHERE key = ?',
    ).get(key);
    if (done) return;

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const raced = this.db.prepare(
        'SELECT value FROM schema_meta WHERE key = ?',
      ).get(key);
      if (raced) {
        this.db.exec('COMMIT;');
        return;
      }
      const rows = this.db.prepare(
        'SELECT id, source_signal_ids FROM loops',
      ).all() as Array<{ id: string; source_signal_ids: string }>;
      const update = this.db.prepare(
        'UPDATE loops SET origin = ? WHERE id = ?',
      );
      for (const row of rows) {
        update.run(
          this.originForSignalIds(parseJsonArray(row.source_signal_ids)),
          row.id,
        );
      }
      this.db.prepare(
        'INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)',
      ).run(key, 'done');
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  private originForSignalIds(ids: string[]): LoopOrigin {
    if (ids.length === 0) return 'mixed';
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.db.prepare(
      `SELECT DISTINCT role FROM loop_signals WHERE id IN (${placeholders})`,
    ).all(...ids) as Array<{ role: string }>;
    const roles = new Set(rows.map((row) => row.role));
    if (roles.size === 0) return 'mixed';
    if (roles.size === 1) {
      if (roles.has('assistant')) return 'assistant';
      if (roles.has('user')) return 'user';
    }
    return 'mixed';
  }

  private backfillLoopEvidenceRange(): void {
    const key = ['m21', 'loop', 'evidence', 'range'].join('_');
    const done = this.db.prepare(
      'SELECT value FROM schema_meta WHERE key = ?',
    ).get(key);
    if (done) return;

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const raced = this.db.prepare(
        'SELECT value FROM schema_meta WHERE key = ?',
      ).get(key);
      if (raced) {
        this.db.exec('COMMIT;');
        return;
      }
      const loops = this.db.prepare(
        'SELECT id, status, first_seen, last_seen, source_signal_ids FROM loops',
      ).all() as Array<{
        id: string;
        status: string;
        first_seen: string;
        last_seen: string;
        source_signal_ids: string;
      }>;
      const signals = new Map<string, { capturedAt: string; source: string }>();
      for (const row of this.db.prepare(
        'SELECT id, captured_at, captured_at_source FROM loop_signals',
      ).all() as Array<{
        id: string;
        captured_at: string;
        captured_at_source: string;
      }>) {
        if (typeof row.captured_at === 'string' && row.captured_at.length > 0) {
          signals.set(row.id, {
            capturedAt: row.captured_at,
            source: row.captured_at_source === 'session' ? 'session' : 'message',
          });
        }
      }

      const update = this.db.prepare(
        `UPDATE loops SET
          first_seen = ?, last_seen = ?, first_seen_source = 'message', last_seen_source = 'message'
         WHERE id = ?`,
      );
      let updated = 0;
      let skipped = 0;
      let closedSkipped = 0;
      let firstSeenAdjusted = 0;
      let lastSeenAdjusted = 0;
      let maxDriftMs = 0;
      const skippedLoops: string[] = [];
      for (const loop of loops) {
        if (loop.status === 'resolved' || loop.status === 'dropped') {
          closedSkipped += 1;
          continue;
        }
        const sourceIds = parseJsonArray(loop.source_signal_ids);
        if (sourceIds.length === 0) {
          skipped += 1;
          if (skippedLoops.length < 20) skippedLoops.push(loop.id);
          continue;
        }
        let earliestMs = Number.POSITIVE_INFINITY;
        let latestMs = Number.NEGATIVE_INFINITY;
        let missing = false;
        for (const sourceId of sourceIds) {
          const signal = signals.get(sourceId);
          if (!signal) {
            missing = true;
            break;
          }
          if (signal.source === 'session') continue;
          const capturedMs = Date.parse(signal.capturedAt);
          if (!Number.isFinite(capturedMs)) continue;
          if (capturedMs < earliestMs) earliestMs = capturedMs;
          if (capturedMs > latestMs) latestMs = capturedMs;
        }
        if (missing || latestMs === Number.NEGATIVE_INFINITY) {
          skipped += 1;
          if (skippedLoops.length < 20) skippedLoops.push(loop.id);
          continue;
        }
        const nextFirstSeen = new Date(earliestMs).toISOString();
        const nextLastSeen = new Date(latestMs).toISOString();
        const firstChanged = compareIso(nextFirstSeen, loop.first_seen) !== 0;
        const lastChanged = compareIso(nextLastSeen, loop.last_seen) !== 0;
        if (!firstChanged && !lastChanged) continue;
        update.run(nextFirstSeen, nextLastSeen, loop.id);
        updated += 1;
        if (firstChanged) firstSeenAdjusted += 1;
        if (lastChanged) {
          lastSeenAdjusted += 1;
          const currentMs = Date.parse(loop.last_seen);
          if (Number.isFinite(currentMs)) {
            maxDriftMs = Math.max(maxDriftMs, Math.abs(currentMs - latestMs));
          }
        }
      }
      this.db.prepare(
        'INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)',
      ).run(
        key,
        JSON.stringify({
          updated,
          skipped,
          closedSkipped,
          firstSeenAdjusted,
          lastSeenAdjusted,
          maxDriftHours: Math.round(maxDriftMs / 36_000) / 100,
          skippedLoops,
        }),
      );
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
    }
  }

  saveSignal(signal: LoopSignal): boolean {
    const capturedAtSource = signal.capturedAtSource ?? 'message';
    const safeText = redactSecrets(signal.text);
    const existing = this.db.prepare(
      'SELECT captured_at, captured_at_source FROM loop_signals WHERE id = ?',
    ).get(signal.id) as { captured_at: string; captured_at_source: string } | undefined;

    if (!existing) {
      this.db.prepare(`
        INSERT INTO loop_signals (
          id, source, source_id, message_id, agent, role, text,
          project_dir, captured_at, captured_at_source, content_hash, processed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        signal.id,
        signal.source,
        signal.sourceId,
        signal.messageId,
        signal.agent,
        signal.role,
        safeText,
        signal.projectDir,
        signal.capturedAt,
        capturedAtSource,
        signal.contentHash,
        signal.processedAt ?? null,
      );
      return true;
    }

    const existingSource = existing.captured_at_source === 'session' ? 'session' : 'message';
    const existingMs = Date.parse(existing.captured_at);
    const incomingMs = Date.parse(signal.capturedAt);
    const sourceUpgrade = existingSource === 'session' && capturedAtSource === 'message';
    const newerSameSource = existingSource === capturedAtSource
      && Number.isFinite(incomingMs)
      && (!Number.isFinite(existingMs) || incomingMs > existingMs);
    if (sourceUpgrade || newerSameSource) {
      this.db.prepare(`
        UPDATE loop_signals SET
          captured_at = ?, captured_at_source = ?, text = ?, content_hash = ?, processed_at = NULL
        WHERE id = ?
      `).run(
        signal.capturedAt,
        capturedAtSource,
        safeText,
        signal.contentHash,
        signal.id,
      );
    }
    return false;
  }

  redactStoredText(apply: boolean): RedactionSummary {
    const signals = this.db.prepare(
      'SELECT id, text FROM loop_signals',
    ).all() as Array<{ id: string; text: string }>;
    const loops = this.db.prepare(`
      SELECT id, title, next_action, why, resolution_note FROM loops
    `).all() as Array<{
      id: string;
      title: string;
      next_action: string;
      why: string;
      resolution_note: string | null;
    }>;

    const signalChanges: Array<{ id: string; text: string; hash: string }> = [];
    const loopChanges: Array<{
      id: string;
      title: string;
      nextAction: string;
      why: string;
      resolutionNote: string | null;
    }> = [];
    const samples: string[] = [];

    for (const row of signals) {
      const text = redactSecrets(row.text);
      if (text === row.text) continue;
      signalChanges.push({
        id: row.id,
        text,
        hash: createHash('sha256').update(text).digest('hex').slice(0, 16),
      });
      if (samples.length < 10) samples.push(`signal:${row.id}`);
    }

    for (const row of loops) {
      const title = redactSecrets(row.title);
      const nextAction = redactSecrets(row.next_action);
      const why = redactSecrets(row.why);
      const resolutionNote = row.resolution_note === null
        ? null
        : redactSecrets(row.resolution_note);
      if (
        title === row.title
        && nextAction === row.next_action
        && why === row.why
        && resolutionNote === row.resolution_note
      ) {
        continue;
      }
      loopChanges.push({
        id: row.id,
        title,
        nextAction,
        why,
        resolutionNote,
      });
      if (samples.length < 10) samples.push(`loop:${row.id}`);
    }

    if (apply && (signalChanges.length > 0 || loopChanges.length > 0)) {
      this.db.exec('BEGIN IMMEDIATE;');
      try {
        const updateSignal = this.db.prepare(
          'UPDATE loop_signals SET text = ?, content_hash = ? WHERE id = ?',
        );
        for (const change of signalChanges) {
          updateSignal.run(change.text, change.hash, change.id);
        }
        const updateLoop = this.db.prepare(`
          UPDATE loops SET title = ?, next_action = ?, why = ?, resolution_note = ?
          WHERE id = ?
        `);
        for (const change of loopChanges) {
          updateLoop.run(
            change.title,
            change.nextAction,
            change.why,
            change.resolutionNote,
            change.id,
          );
        }
        this.db.exec('COMMIT;');
      } catch (error) {
        this.db.exec('ROLLBACK;');
        throw error;
      }
    }

    return {
      applied: apply,
      signalsScanned: signals.length,
      signalsChanged: signalChanges.length,
      loopsScanned: loops.length,
      loopsChanged: loopChanges.length,
      samples,
    };
  }

  getSignals(ids: string[]): LoopSignal[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.db.prepare(`SELECT * FROM loop_signals WHERE id IN (${placeholders})`).all(...ids);
    return rows.map((row: any) => this.rowToSignal(row));
  }

  markSignalsProcessed(ids: string[], at = nowIso()): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare('UPDATE loop_signals SET processed_at = ? WHERE id = ?');
    for (const id of ids) stmt.run(at, id);
  }

  private evidenceRange(
    sourceIds: string[],
  ): { firstSeen: string; lastSeen: string } | undefined {
    if (sourceIds.length === 0) return undefined;
    const placeholders = sourceIds.map(() => '?').join(', ');
    const rows = this.db.prepare(`
      SELECT captured_at FROM loop_signals
      WHERE id IN (${placeholders}) AND captured_at_source <> 'session'
    `).all(...sourceIds) as Array<{ captured_at: string }>;
    let firstMs = Number.POSITIVE_INFINITY;
    let lastMs = Number.NEGATIVE_INFINITY;
    for (const row of rows) {
      const ms = Date.parse(row.captured_at);
      if (!Number.isFinite(ms)) continue;
      if (ms < firstMs) firstMs = ms;
      if (ms > lastMs) lastMs = ms;
    }
    if (!Number.isFinite(firstMs) || !Number.isFinite(lastMs)) return undefined;
    return {
      firstSeen: new Date(firstMs).toISOString(),
      lastSeen: new Date(lastMs).toISOString(),
    };
  }

  saveLoop(candidate: LoopCandidate, meta: LoopMeta): SaveLoopResult {
    const key = dedupeKey(meta.projectDir, candidate.title);
    const now = nowIso();
    const firstSeen = normalizeIso(meta.firstSeen ?? now);
    const lastSeen = normalizeIso(meta.lastSeen ?? now);
    let existingRow: any;

    if (candidate.mergeInto) {
      existingRow = this.db.prepare('SELECT * FROM loops WHERE id = ?').get(candidate.mergeInto);
      if (
        !existingRow
        || !sameProject(existingRow.project_dir, meta.projectDir)
        || !['open', 'pending', 'snoozed'].includes(existingRow.status)
      ) {
        throw new Error(`invalid merge target: ${candidate.mergeInto}`);
      }
    } else {
      existingRow = this.db.prepare('SELECT * FROM loops WHERE dedupe_key = ?').get(key);
    }

    if (!existingRow) {
      const candidates = this.db.prepare(`
        SELECT * FROM loops
        WHERE project_dir = ? AND status IN ('open', 'pending', 'snoozed')
        ORDER BY last_seen DESC
        LIMIT 200
      `).all(meta.projectDir);
      let bestScore = 0;
      for (const row of candidates) {
        const score = titleSimilarity(row.title, candidate.title);
        if (score > bestScore) {
          bestScore = score;
          existingRow = row;
        }
      }
      if (bestScore < 0.5) existingRow = undefined;
    }

    if (existingRow) {
      const existing = this.rowToLoop(existingRow);
      const sourceIds = [...new Set([...existing.sourceSignalIds, ...candidate.sourceSignalIds])];
      const evidence = this.evidenceRange(sourceIds);
      const existingFirstSource = existingRow.first_seen_source === 'session'
        ? 'session'
        : 'message';
      const existingLastSource = existingRow.last_seen_source === 'session'
        ? 'session'
        : 'message';
      const nextFirstSeen = evidence
        ? existingFirstSource === 'session'
          ? evidence.firstSeen
          : compareIso(evidence.firstSeen, existing.firstSeen) < 0
            ? evidence.firstSeen
            : existing.firstSeen
        : meta.firstSeenIsFallback || meta.firstSeen === undefined
          ? existing.firstSeen
          : compareIso(firstSeen, existing.firstSeen) < 0
            ? firstSeen
            : existing.firstSeen;
      const nextLastSeen = evidence
        ? existingLastSource === 'session'
          ? evidence.lastSeen
          : laterIso(existing.lastSeen, evidence.lastSeen)
        : meta.lastSeenIsFallback || meta.lastSeen === undefined
          ? existing.lastSeen
          : laterIso(existing.lastSeen, lastSeen);
      const nextFirstSource = evidence
        ? 'message'
        : meta.firstSeenIsFallback || meta.firstSeen === undefined
          ? existingFirstSource
          : 'message';
      const nextLastSource = evidence
        ? 'message'
        : meta.lastSeenIsFallback || meta.lastSeen === undefined
          ? existingLastSource
          : 'message';
      const hasNewEvidence = compareIso(nextLastSeen, existing.lastSeen) > 0;
      const refreshDescription = hasNewEvidence && candidate.confidence >= 0.6;
      let status: LoopStatus = existing.status;
      if (hasNewEvidence) {
        if (existing.status === 'snoozed') {
          status = candidate.confidence >= 0.6 ? 'open' : 'pending';
        } else if (existing.status === 'pending' && candidate.confidence >= 0.6) {
          status = 'open';
        }
      }

      this.db.prepare(`
        UPDATE loops SET
          title = ?, next_action = ?, why = ?, confidence = ?, status = ?,
          source_signal_ids = ?, first_seen = ?, last_seen = ?,
          first_seen_source = ?, last_seen_source = ?,
          origin = ?, ignored_count = ?, snooze_until = ?
        WHERE id = ?
      `).run(
        refreshDescription ? candidate.title.trim() : existing.title,
        refreshDescription ? candidate.nextAction : existing.nextAction,
        refreshDescription ? candidate.why : existing.why,
        hasNewEvidence ? Math.max(existing.confidence, candidate.confidence) : existing.confidence,
        status,
        JSON.stringify(sourceIds),
        nextFirstSeen,
        nextLastSeen,
        nextFirstSource,
        nextLastSource,
        this.originForSignalIds(sourceIds),
        hasNewEvidence ? 0 : existing.ignoredCount,
        hasNewEvidence ? null : existing.snoozeUntil ?? null,
        existing.id,
      );

      return { loop: this.getLoop(existing.id)!, created: false };
    }

    const id = `loop_${key.slice(0, 16)}`;
    const status: LoopStatus = candidate.confidence >= 0.6 ? 'open' : 'pending';
    const uniqueSourceIds = [...new Set(candidate.sourceSignalIds)];
    const evidence = this.evidenceRange(uniqueSourceIds);
    const firstSource = evidence
      ? 'message'
      : meta.firstSeenIsFallback || meta.firstSeen === undefined
        ? 'session'
        : 'message';
    const lastSource = evidence
      ? 'message'
      : meta.lastSeenIsFallback || meta.lastSeen === undefined
        ? 'session'
        : 'message';
    this.db.prepare(`
      INSERT INTO loops (
        id, title, next_action, why, status, confidence, project_dir, project_name,
        source_signal_ids, first_seen, last_seen, first_seen_source, last_seen_source,
        origin, dedupe_key, ignored_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      id,
      candidate.title.trim(),
      candidate.nextAction.trim(),
      candidate.why.trim(),
      status,
      candidate.confidence,
      meta.projectDir,
      meta.projectName,
      JSON.stringify(uniqueSourceIds),
      evidence?.firstSeen ?? firstSeen,
      evidence?.lastSeen ?? lastSeen,
      firstSource,
      lastSource,
      this.originForSignalIds(uniqueSourceIds),
      key,
    );

    return { loop: this.getLoop(id)!, created: true };
  }

  getLoop(id: string): LoopRecord | undefined {
    const row = this.db.prepare('SELECT * FROM loops WHERE id = ?').get(id);
    return row ? this.rowToLoop(row) : undefined;
  }

  findLoopsByRef(ref: string): LoopRecord[] {
    const normalized = normalizeLoopRef(ref);
    if (!normalized) return [];
    const rows = this.db.prepare(`
      SELECT * FROM loops
      WHERE id LIKE ?
      ORDER BY last_seen DESC, confidence DESC
    `).all(`loop_${normalized}%`);
    return rows.map((row: any) => this.rowToLoop(row));
  }

  listLoops(filter: LoopListFilter = {}): LoopRecord[] {
    const clauses: string[] = [];
    const params: any[] = [];
    const now = nowIso();

    if (filter.status === 'open') {
      clauses.push("(status = 'open' OR (status = 'snoozed' AND snooze_until IS NOT NULL AND snooze_until <= ?))");
      params.push(now);
    } else if (filter.status === 'snoozed') {
      clauses.push("status = 'snoozed' AND (snooze_until IS NULL OR snooze_until > ?)");
      params.push(now);
    } else if (filter.status) {
      clauses.push('status = ?');
      params.push(filter.status);
    } else if (!filter.includeAll) {
      clauses.push("(status = 'open' OR (status = 'snoozed' AND snooze_until IS NOT NULL AND snooze_until <= ?))");
      params.push(now);
    }
    if (filter.projectDir) {
      clauses.push('project_dir = ?');
      params.push(filter.projectDir);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.max(1, Math.min(10_000, filter.limit ?? 100));
    const rows = this.db.prepare(`
      SELECT * FROM loops ${where}
      ORDER BY last_seen DESC, confidence DESC, title ASC
      LIMIT ?
    `).all(...params, limit);
    return rows.map((row: any) => this.rowToLoop(row));
  }

  listActiveLoops(projectDir?: string, now: Date = new Date()): LoopRecord[] {
    const params: any[] = [];
    let where = "status IN ('open', 'pending', 'snoozed')";
    if (projectDir) {
      where += ' AND project_dir = ?';
      params.push(projectDir);
    }
    const rows = this.db.prepare(`
      SELECT * FROM loops WHERE ${where}
      ORDER BY last_seen DESC, confidence DESC
    `).all(...params);
    return rows.map((row: any) => this.rowToLoop(row, now));
  }

  listAllLoops(): LoopRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM loops
      ORDER BY last_seen DESC, confidence DESC, title ASC
    `).all();
    return rows.map((row: any) => this.rowToLoop(row));
  }

  findLoopsByText(
    query: string,
    options: { projectDir?: string; limit?: number } = {},
  ): LoopRecord[] {
    const needle = normalizeTitle(query);
    if (!needle) return [];

    const exact: LoopRecord[] = [];
    const partial: LoopRecord[] = [];
    for (const loop of this.listActiveLoops(options.projectDir)) {
      const title = normalizeTitle(loop.title);
      if (title === needle) exact.push(loop);
      else if (title.includes(needle)) partial.push(loop);
    }

    const byRecent = (left: LoopRecord, right: LoopRecord) =>
      right.lastSeen.localeCompare(left.lastSeen);
    exact.sort(byRecent);
    partial.sort((left, right) => {
      const lengthDiff = normalizeTitle(left.title).length - normalizeTitle(right.title).length;
      return lengthDiff !== 0 ? lengthDiff : byRecent(left, right);
    });
    return [...exact, ...partial].slice(0, Math.max(1, options.limit ?? 20));
  }

  recordFeedback(
    loopId: string,
    verdict: LoopFeedbackVerdict,
    note?: string,
    at = nowIso(),
  ): LoopFeedbackRecord | undefined {
    if (!this.getLoop(loopId)) return undefined;

    const createdAtMs = Date.parse(at);
    if (!Number.isFinite(createdAtMs)) {
      throw new Error(`invalid feedback timestamp: ${at}`);
    }
    const createdAt = new Date(createdAtMs).toISOString();
    const id = `feedback_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const trimmedNote = note?.trim() || undefined;
    this.db.prepare(`
      INSERT INTO loop_feedback (id, loop_id, verdict, note, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, loopId, verdict, trimmedNote ?? null, createdAt);

    return {
      id,
      loopId,
      verdict,
      note: trimmedNote,
      createdAt,
    };
  }

  runInWriteTransaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const result = operation();
      this.db.exec('COMMIT;');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  getFeedbackCounts(sinceIso?: string): LoopFeedbackCounts {
    const rows = (sinceIso
      ? this.db.prepare(`
          SELECT verdict, COUNT(*) AS count
          FROM loop_feedback
          WHERE created_at >= ?
          GROUP BY verdict
        `).all(normalizeIso(sinceIso))
      : this.db.prepare(`
          SELECT verdict, COUNT(*) AS count
          FROM loop_feedback
          GROUP BY verdict
        `).all()) as Array<{ verdict: LoopFeedbackVerdict; count: number }>;
    const counts: LoopFeedbackCounts = { forgotten: 0, noise: 0 };
    for (const row of rows) {
      if (row.verdict === 'forgotten') counts.forgotten = row.count;
      if (row.verdict === 'noise') counts.noise = row.count;
    }
    return counts;
  }

  getLatestFeedbackForLoop(loopId: string): LoopFeedbackRecord | undefined {
    const row = this.db.prepare(`
      SELECT * FROM loop_feedback
      WHERE loop_id = ?
      ORDER BY julianday(created_at) DESC, rowid DESC
      LIMIT 1
    `).get(loopId);
    return row ? this.rowToFeedback(row) : undefined;
  }

  getLatestFeedback(): LoopFeedbackRecord[] {
    const rows = this.db.prepare(`
      SELECT id, loop_id, verdict, note, created_at
      FROM (
        SELECT id, loop_id, verdict, note, created_at,
          ROW_NUMBER() OVER (
            PARTITION BY loop_id
            ORDER BY julianday(created_at) DESC, rowid DESC
          ) AS rn
        FROM loop_feedback
      )
      WHERE rn = 1
    `).all();
    return rows.map((row: any) => this.rowToFeedback(row));
  }

  recordProjectActivity(
    projectDir: string,
    projectName: string,
    lastActive: string,
    sessionId: string,
  ): string {
    const normalizedLastActive = normalizeIso(lastActive);
    this.db.prepare(`
      INSERT INTO project_sessions (project_dir, session_id, last_active)
      VALUES (?, ?, ?)
      ON CONFLICT(project_dir, session_id) DO UPDATE SET
        last_active = CASE
          WHEN excluded.last_active > project_sessions.last_active THEN excluded.last_active
          ELSE project_sessions.last_active
        END
    `).run(projectDir, sessionId, normalizedLastActive);

    this.db.prepare(`
      INSERT INTO project_activity (
        project_dir, project_name, last_active, session_count, last_session_id
      ) VALUES (?, ?, ?, (
        SELECT COUNT(*) FROM project_sessions WHERE project_dir = ?
      ), ?)
      ON CONFLICT(project_dir) DO UPDATE SET
        project_name = CASE
          WHEN excluded.last_active >= project_activity.last_active THEN excluded.project_name
          ELSE project_activity.project_name
        END,
        last_active = CASE
          WHEN excluded.last_active > project_activity.last_active THEN excluded.last_active
          ELSE project_activity.last_active
        END,
        session_count = (
          SELECT COUNT(*) FROM project_sessions WHERE project_dir = excluded.project_dir
        ),
        last_session_id = CASE
          WHEN excluded.last_active >= project_activity.last_active THEN excluded.last_session_id
          ELSE project_activity.last_session_id
        END
    `).run(projectDir, projectName, normalizedLastActive, projectDir, sessionId);

    return this.getProjectActivity(projectDir)!.projectName;
  }

  getProjectActivity(projectDir: string): ProjectActivity | undefined {
    const row = this.db.prepare('SELECT * FROM project_activity WHERE project_dir = ?').get(projectDir);
    return row ? this.rowToProjectActivity(row) : undefined;
  }

  renameProject(projectDir: string, projectName: string): number {
    const result = this.db.prepare(`
      UPDATE loops SET project_name = ? WHERE project_dir = ? AND project_name <> ?
    `).run(projectName, projectDir, projectName);
    return result.changes;
  }

  listProjectActivity(sinceIso?: string, limit = 100): ProjectActivity[] {
    const rows = sinceIso
      ? this.db.prepare(`
        SELECT * FROM project_activity WHERE last_active >= ?
        ORDER BY last_active DESC LIMIT ?
      `).all(sinceIso, Math.max(1, Math.min(500, limit)))
      : this.db.prepare(`
        SELECT * FROM project_activity ORDER BY last_active DESC LIMIT ?
      `).all(Math.max(1, Math.min(500, limit)));
    return rows.map((row: any) => this.rowToProjectActivity(row));
  }

  listProjectSessionCounts(
    sinceIso?: string,
    limit = 500,
  ): Array<{ projectDir: string; count: number }> {
    const rows = sinceIso
      ? this.db.prepare(`
        SELECT project_dir, COUNT(*) AS count
        FROM project_sessions
        WHERE last_active >= ?
        GROUP BY project_dir
        ORDER BY MAX(last_active) DESC
        LIMIT ?
      `).all(sinceIso, Math.max(1, Math.min(1_000, limit)))
      : this.db.prepare(`
        SELECT project_dir, COUNT(*) AS count
        FROM project_sessions
        GROUP BY project_dir
        ORDER BY MAX(last_active) DESC
        LIMIT ?
      `).all(Math.max(1, Math.min(1_000, limit)));
    return rows.map((row: any) => ({
      projectDir: row.project_dir,
      count: row.count,
    }));
  }

  recordSurfaced(
    ids: string[],
    at = nowIso(),
    countIgnore = true,
    mode: 'hot' | 'review' = 'hot',
  ): LoopRecord[] {
    const updated: LoopRecord[] = [];
    const surfacedAt = normalizeIso(at);
    const surfacedMs = Date.parse(surfacedAt);
    for (const id of ids) {
      const loop = this.getLoop(id);
      if (!loop || loop.status === 'resolved' || loop.status === 'dropped') continue;
      const lastSeenMs = Date.parse(loop.lastSeen);
      const lastSurfacedMs = Date.parse(loop.lastSurfacedAt ?? '');
      const repeat = countIgnore
        && Number.isFinite(lastSeenMs)
        && Number.isFinite(lastSurfacedMs)
        && lastSeenMs <= lastSurfacedMs;
      const ignoredCount = loop.ignoredCount + (repeat ? 1 : 0);
      const downgraded = repeat && ignoredCount >= 3;
      const status: LoopStatus = downgraded ? 'snoozed' : loop.status;
      const snoozeUntil = downgraded
        ? new Date(surfacedMs + 7 * 24 * 60 * 60 * 1000).toISOString()
        : loop.snoozeUntil ?? null;
      const hotSurfacedAt = mode === 'hot' ? surfacedAt : loop.hotSurfacedAt ?? null;
      this.db.prepare(`
        UPDATE loops SET last_surfaced_at = ?, hot_surfaced_at = ?, ignored_count = ?, status = ?, snooze_until = ?
        WHERE id = ?
      `).run(surfacedAt, hotSurfacedAt, ignoredCount, status, snoozeUntil, id);
      updated.push(this.getLoop(id)!);
    }
    return updated;
  }

  countSurfacedSince(sinceIso: string): number {
    return this.countSurfacedBetween(sinceIso, '9999-12-31T23:59:59.999Z');
  }

  countEverSurfaced(): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM loops
      WHERE last_surfaced_at IS NOT NULL
    `).get();
    return Number(row?.count ?? 0);
  }

  countSurfacedBetween(fromIso: string, toIso: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM loops
      WHERE hot_surfaced_at IS NOT NULL
        AND hot_surfaced_at >= ?
        AND hot_surfaced_at < ?
        AND status IN ('open', 'pending', 'snoozed')
    `).get(normalizeIso(fromIso), normalizeIso(toIso));
    return Number(row?.count ?? 0);
  }

  recordPresentation(
    loopIds: string[],
    at = nowIso(),
    mode: 'hot' | 'review' = 'hot',
    kind: 'hot' | 'review' | 'recap' | 'teaser' | 'candidate' = mode,
  ): number | undefined {
    if (loopIds.length === 0) return undefined;
    const presentedAt = normalizeIso(at);
    const info = this.db.prepare(`
      INSERT INTO loop_presentations (presented_at, mode, kind, loop_ids)
      VALUES (?, ?, ?, ?)
    `).run(presentedAt, mode, kind, JSON.stringify(loopIds));
    if (kind === 'review') this.advanceReviewCycle(loopIds, presentedAt);
    if (kind === 'recap' || kind === 'candidate' || kind === 'teaser') {
      this.recordPresentationFatigue(loopIds, presentedAt);
    }
    return Number(info.lastInsertRowid);
  }

  private recordPresentationFatigue(loopIds: string[], at: string): void {
    const select = this.db.prepare(`
      SELECT id, status, snooze_until, last_seen, presentation_count, last_presented_at
      FROM loops
      WHERE id = ?
    `);
    const update = this.db.prepare(`
      UPDATE loops
      SET presentation_count = ?, last_presented_at = ?, status = ?, snooze_until = ?
      WHERE id = ?
    `);
    const latestFeedback = this.db.prepare(`
      SELECT verdict
      FROM loop_feedback
      WHERE loop_id = ?
      ORDER BY julianday(created_at) DESC, id DESC
      LIMIT 1
    `);
    const atMs = Date.parse(at);
    for (const id of loopIds) {
      const row = select.get(id) as any;
      if (!row || row.status === 'resolved' || row.status === 'dropped') continue;
      const snoozeUntilMs = row.snooze_until ? Date.parse(row.snooze_until) : NaN;
      const expiredSnooze = row.status === 'snoozed'
        && Number.isFinite(snoozeUntilMs)
        && snoozeUntilMs <= atMs;
      if (row.status === 'snoozed' && !expiredSnooze) continue;
      const lastPresentedMs = row.last_presented_at
        ? Date.parse(row.last_presented_at)
        : NaN;
      const lastSeenMs = Date.parse(row.last_seen);
      const repeat = Number.isFinite(lastPresentedMs)
        && Number.isFinite(lastSeenMs)
        && lastSeenMs <= lastPresentedMs;
      const count = repeat ? Number(row.presentation_count ?? 0) + 1 : 1;
      const confirmed = (latestFeedback.get(id) as { verdict?: string } | undefined)
        ?.verdict === 'forgotten';
      const snoozed = count >= 3 && !confirmed;
      update.run(
        count,
        at,
        snoozed ? 'snoozed' : (expiredSnooze ? 'open' : row.status),
        snoozed ? new Date(atMs + 7 * 24 * 60 * 60 * 1000).toISOString() : null,
        id,
      );
    }
  }

  getReviewCycleSeen(eligibleIds: Iterable<string>): Set<string> {
    const eligible = new Set(eligibleIds);
    const row = this.db.prepare(
      "SELECT value FROM schema_meta WHERE key = 'review_cycle'",
    ).get() as { value?: string } | undefined;
    const state = parseReviewCycleState(row?.value);
    return new Set(state.seen.filter((id) => eligible.has(id)));
  }

  private advanceReviewCycle(ids: string[], at: string): void {
    const row = this.db.prepare(
      "SELECT value FROM schema_meta WHERE key = 'review_cycle'",
    ).get() as { value?: string } | undefined;
    const state = parseReviewCycleState(row?.value);
    if (sameIdSet(ids, state.lastBatch ?? state.seen)) return;
    const seen = new Set(state.seen);
    const wrapped = ids.some((id) => seen.has(id));
    const nextSeen = wrapped
      ? [...new Set(ids)]
      : [...new Set([...state.seen, ...ids])];
    const startedAt = wrapped ? at : state.startedAt ?? at;
    this.db.prepare(
      'INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)',
    ).run(
      'review_cycle',
      JSON.stringify({ startedAt, seen: nextSeen, lastBatch: [...new Set(ids)] }),
    );
  }

  getFirstPresentationTimes(untilIso?: string): Map<string, string> {
    const rows = this.db.prepare(`
      SELECT presented_at, loop_ids
      FROM loop_presentations
      WHERE (? IS NULL OR julianday(presented_at) <= julianday(?))
      ORDER BY julianday(presented_at) ASC, id ASC
    `).all(untilIso ?? null, untilIso ?? null) as Array<{
      presented_at: string;
      loop_ids: string;
    }>;
    const first = new Map<string, string>();
    for (const row of rows) {
      for (const id of parseJsonArray(row.loop_ids)) {
        if (!first.has(id)) first.set(id, row.presented_at);
      }
    }
    return first;
  }

  getPresentationStats(untilIso?: string): Map<string, LoopPresentationStats> {
    const where = untilIso
      ? 'WHERE julianday(p.presented_at) <= julianday(?)'
      : '';
    const params = untilIso ? [normalizeIso(untilIso)] : [];
    const rows = this.db.prepare(`
      SELECT j.value AS loop_id,
        COUNT(*) AS count,
        MIN(p.presented_at) AS first_at,
        MAX(p.presented_at) AS last_at
      FROM loop_presentations p, json_each(p.loop_ids) j
      ${where}
      GROUP BY j.value
    `).all(...params) as Array<{
      loop_id: string;
      count: number;
      first_at: string;
      last_at: string;
    }>;
    return new Map(rows.map((row) => [row.loop_id, {
      loopId: row.loop_id,
      count: Number(row.count),
      firstPresentedAt: String(row.first_at),
      lastPresentedAt: String(row.last_at),
    }]));
  }

  countPresentationsAfter(iso: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS c
      FROM loop_presentations
      WHERE julianday(presented_at) > julianday(?)
    `).get(normalizeIso(iso)) as { c?: number } | undefined;
    return Number(row?.c ?? 0);
  }

  getPresentedLoopIdsByKind(kind: LoopPresentationKind, sinceIso: string): Set<string> {
    const rows = this.db.prepare(`
      SELECT loop_ids
      FROM loop_presentations
      WHERE kind = ?
        AND julianday(presented_at) >= julianday(?)
    `).all(kind, normalizeIso(sinceIso)) as Array<{ loop_ids: string }>;
    const ids = new Set<string>();
    for (const row of rows) {
      for (const id of parseJsonArray(row.loop_ids)) ids.add(id);
    }
    return ids;
  }

  getPresentationCountsByKind(untilIso?: string): Record<LoopPresentationKind, number> {
    const counts: Record<LoopPresentationKind, number> = {
      hot: 0,
      review: 0,
      recap: 0,
      teaser: 0,
      candidate: 0,
    };
    const where = untilIso ? 'WHERE julianday(presented_at) <= julianday(?)' : '';
    const params = untilIso ? [normalizeIso(untilIso)] : [];
    const rows = this.db.prepare(`
      SELECT kind, COUNT(*) AS count
      FROM loop_presentations
      ${where}
      GROUP BY kind
    `).all(...params) as Array<{ kind: string; count: number }>;
    for (const row of rows) {
      if (row.kind in counts) {
        counts[row.kind as LoopPresentationKind] = Number(row.count);
      }
    }
    return counts;
  }

  listPresentationsAfter(iso: string): LoopPresentation[] {
    const rows = this.db.prepare(`
      SELECT id, presented_at, mode, kind, loop_ids
      FROM loop_presentations
      WHERE julianday(presented_at) > julianday(?)
      ORDER BY julianday(presented_at) ASC, id ASC
    `).all(normalizeIso(iso)) as Array<{
      id: number;
      presented_at: string;
      mode: string;
      kind: string;
      loop_ids: string;
    }>;
    return rows.map((row) => ({
      id: Number(row.id),
      presentedAt: String(row.presented_at),
      mode: row.mode === 'review' ? 'review' : 'hot',
      kind: row.kind === 'review' || row.kind === 'recap' || row.kind === 'teaser' || row.kind === 'candidate'
        ? row.kind
        : 'hot',
      loopIds: parseJsonArray(String(row.loop_ids)),
    }));
  }

  deletePresentations(ids: number[]): number {
    const uniqueIds = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
    if (uniqueIds.length === 0) return 0;
    const placeholders = uniqueIds.map(() => '?').join(', ');
    const info = this.db.prepare(`
      DELETE FROM loop_presentations
      WHERE id IN (${placeholders})
    `).run(...uniqueIds);
    return Number(info.changes ?? 0);
  }

  getLatestPresentation(maxAgeHours = 48, nowMs = Date.now()): LoopPresentation | undefined {
    const row = this.db.prepare(`
      SELECT id, presented_at, mode, kind, loop_ids
      FROM loop_presentations
      WHERE julianday(presented_at) <= julianday(?)
      ORDER BY id DESC
      LIMIT 1
    `).get(new Date(nowMs).toISOString());
    if (!row) return undefined;
    const presentedMs = Date.parse(row.presented_at);
    if (isPresentationInFuture(presentedMs, nowMs)) return undefined;
    if (
      maxAgeHours > 0
      && Number.isFinite(presentedMs)
      && nowMs - presentedMs > maxAgeHours * 60 * 60 * 1000
    ) {
      return undefined;
    }
    return {
      id: Number(row.id),
      presentedAt: String(row.presented_at),
      mode: row.mode === 'review' ? 'review' : 'hot',
      kind: row.kind === 'review' || row.kind === 'recap' || row.kind === 'teaser' || row.kind === 'candidate'
        ? row.kind
        : 'hot',
      loopIds: parseJsonArray(String(row.loop_ids)),
    };
  }

  getLatestPresentationByKind(
    kind: 'hot' | 'review' | 'recap' | 'teaser' | 'candidate',
    maxAgeMinutes = 30,
    nowMs = Date.now(),
  ): LoopPresentation | undefined {
    const row = this.db.prepare(`
      SELECT id, presented_at, mode, kind, loop_ids
      FROM loop_presentations
      WHERE kind = ?
        AND julianday(presented_at) <= julianday(?)
      ORDER BY id DESC
      LIMIT 1
    `).get(kind, new Date(nowMs).toISOString());
    if (!row) return undefined;
    const presentedMs = Date.parse(row.presented_at);
    if (isPresentationInFuture(presentedMs, nowMs)) return undefined;
    if (
      maxAgeMinutes > 0
      && Number.isFinite(presentedMs)
      && nowMs - presentedMs > maxAgeMinutes * 60 * 1000
    ) {
      return undefined;
    }
    return {
      id: Number(row.id),
      presentedAt: String(row.presented_at),
      mode: row.mode === 'review' ? 'review' : 'hot',
      kind: row.kind === 'review' || row.kind === 'recap' || row.kind === 'teaser' || row.kind === 'candidate'
        ? row.kind
        : 'hot',
      loopIds: parseJsonArray(String(row.loop_ids)),
    };
  }

  resolvePresentationIndex(
    index: number,
    options: { maxAgeHours?: number; nowMs?: number } = {},
  ):
    | { status: 'found'; loopId: string; presentation: LoopPresentation }
    | { status: 'missing'; message: string }
    | { status: 'out_of_range'; message: string; presentation: LoopPresentation } {
    const presentation = this.getLatestPresentation(
      options.maxAgeHours ?? 48,
      options.nowMs ?? Date.now(),
    );
    if (!presentation) {
      return {
        status: 'missing',
        message: '没有可用的最近回访编号；请先运行 digest，或编号已超过 48 小时。',
      };
    }
    if (!Number.isInteger(index) || index < 1 || index > presentation.loopIds.length) {
      return {
        status: 'out_of_range',
        message: `编号 ${index} 超出范围：最近一次回访共 ${presentation.loopIds.length} 条。`,
        presentation,
      };
    }
    return {
      status: 'found',
      loopId: presentation.loopIds[index - 1],
      presentation,
    };
  }

  updateLoop(
    id: string,
    patch: { status?: LoopStatus; note?: string; snoozeUntil?: string },
  ): LoopRecord | undefined {
    const existing = this.getLoop(id);
    if (!existing) return undefined;

    const status = patch.status ?? existing.status;
    const closed = status === 'resolved' || status === 'dropped';
    const resolvedAt = closed ? existing.resolvedAt ?? nowIso() : null;
    const resetIgnore = status === 'open';
    const snoozeUntil = status !== 'snoozed'
      ? null
      : patch.snoozeUntil
        ? normalizeIso(patch.snoozeUntil)
        : existing.snoozeUntil ?? null;
    this.db.prepare(`
      UPDATE loops SET status = ?, snooze_until = ?, resolved_at = ?, resolution_note = ?,
        ignored_count = CASE WHEN ? THEN 0 ELSE ignored_count END
      WHERE id = ?
    `).run(
      status,
      snoozeUntil,
      resolvedAt ?? null,
      patch.note ?? existing.resolutionNote ?? null,
      resetIgnore ? 1 : 0,
      id,
    );
    return this.getLoop(id);
  }

  startRun(source = 'session'): string {
    const id = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.db.prepare(`
      INSERT INTO ingest_runs (id, started_at, source) VALUES (?, ?, ?)
    `).run(id, nowIso(), source);
    return id;
  }

  finishRun(id: string, summary: IngestSummary): void {
    this.db.prepare(`
      UPDATE ingest_runs SET
        finished_at = ?, signals_seen = ?, loops_created = ?, loops_merged = ?, errors = ?
      WHERE id = ?
    `).run(
      nowIso(),
      summary.signalsSeen,
      summary.loopsCreated,
      summary.loopsMerged,
      summary.errors.length > 0 ? JSON.stringify(summary.errors) : null,
      id,
    );
  }

  getLastRun(): IngestRunRecord | undefined {
    const row = this.db.prepare(`
      SELECT * FROM ingest_runs ORDER BY started_at DESC LIMIT 1
    `).get();
    if (!row) return undefined;
    let errors: string[] = [];
    if (row.errors) {
      try {
        const parsed = JSON.parse(row.errors);
        if (Array.isArray(parsed)) errors = parsed.filter((item): item is string => typeof item === 'string');
      } catch {
        errors = [String(row.errors)];
      }
    }
    return {
      id: row.id,
      startedAt: row.started_at,
      finishedAt: row.finished_at ?? undefined,
      source: row.source,
      signalsSeen: row.signals_seen,
      loopsCreated: row.loops_created,
      loopsMerged: row.loops_merged,
      errors,
    };
  }

  getReconcileCache(sessionKey: string): {
    contentHash: string;
    candidates: ResolvedLoop[];
  } | undefined {
    const row = this.db.prepare(`
      SELECT content_hash, candidates_json
      FROM loop_reconcile_cache
      WHERE session_key = ?
    `).get(sessionKey) as { content_hash: string; candidates_json: string } | undefined;
    if (!row) return undefined;
    try {
      const candidates = JSON.parse(row.candidates_json);
      if (!Array.isArray(candidates)) return undefined;
      return { contentHash: row.content_hash, candidates };
    } catch {
      return undefined;
    }
  }

  setReconcileCache(
    sessionKey: string,
    contentHash: string,
    candidates: ResolvedLoop[],
    checkedAt = nowIso(),
  ): void {
    this.db.prepare(`
      INSERT INTO loop_reconcile_cache (
        session_key, content_hash, candidates_json, checked_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(session_key) DO UPDATE SET
        content_hash = excluded.content_hash,
        candidates_json = excluded.candidates_json,
        checked_at = excluded.checked_at
    `).run(sessionKey, contentHash, JSON.stringify(candidates), checkedAt);
  }

  listRecentReconcileCandidates(
    now = new Date(),
    maxAgeHours = 24,
    limit = 3,
  ): ReconcileCacheCandidate[] {
    if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) return [];
    const cutoff = new Date(now.getTime() - maxAgeHours * 60 * 60 * 1000).toISOString();
    const rows = this.db.prepare(`
      SELECT session_key, candidates_json, checked_at
      FROM loop_reconcile_cache
      WHERE checked_at >= ?
      ORDER BY checked_at DESC
    `).all(cutoff) as Array<{
      session_key: string;
      candidates_json: string;
      checked_at: string;
    }>;
    const active = new Map(this.listActiveLoops().map((loop) => [loop.id, loop]));
    const best = new Map<string, ReconcileCacheCandidate>();
    for (const row of rows) {
      let candidates: unknown;
      try {
        candidates = JSON.parse(row.candidates_json);
      } catch {
        continue;
      }
      if (!Array.isArray(candidates)) continue;
      for (const candidate of candidates) {
        if (!candidate || typeof candidate !== 'object') continue;
        const value = candidate as Record<string, unknown>;
        const loopId = String(value.loopId ?? '');
        const confidence = Number(value.confidence);
        const reason = String(value.reason ?? '').trim();
        if (!loopId || !Number.isFinite(confidence) || !reason) continue;
        const loop = active.get(loopId);
        if (!loop) continue;
        if (Date.parse(loop.lastSeen) > Date.parse(row.checked_at)) continue;
        const item: ReconcileCacheCandidate = {
          loopId,
          confidence,
          reason,
          evidenceMessageIds: Array.isArray(value.evidenceMessageIds)
            ? value.evidenceMessageIds.map(String)
            : [],
          checkedAt: row.checked_at,
          sessionKey: row.session_key,
          title: loop.title,
          projectDir: loop.projectDir,
          projectName: loop.projectName,
        };
        const existing = best.get(loopId);
        if (
          !existing
          || item.confidence > existing.confidence
          || (item.confidence === existing.confidence && item.checkedAt > existing.checkedAt)
        ) {
          best.set(loopId, item);
        }
      }
    }
    return [...best.values()]
      .sort((left, right) => (
        right.confidence - left.confidence
        || right.checkedAt.localeCompare(left.checkedAt)
        || left.title.localeCompare(right.title)
      ))
      .slice(0, Math.max(0, Math.floor(limit)));
  }

  pruneReconcileCache(olderThanDays: number, now = new Date()): number {
    if (!Number.isFinite(olderThanDays) || olderThanDays <= 0) {
      throw new Error('cache retention days must be a positive number');
    }
    const cutoff = new Date(
      now.getTime() - olderThanDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    const result = this.db.prepare(`
      DELETE FROM loop_reconcile_cache WHERE checked_at < ?
    `).run(cutoff);
    return Number(result.changes);
  }

  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }

  private rowToSignal(row: any): LoopSignal {
    return {
      id: row.id,
      source: row.source,
      sourceId: row.source_id,
      messageId: row.message_id,
      agent: row.agent,
      role: row.role,
      text: row.text,
      projectDir: row.project_dir,
      capturedAt: row.captured_at,
      capturedAtSource: row.captured_at_source === 'session' ? 'session' : 'message',
      contentHash: row.content_hash,
      processedAt: row.processed_at ?? undefined,
    };
  }

  private rowToProjectActivity(row: any): ProjectActivity {
    return {
      projectDir: row.project_dir,
      projectName: row.project_name,
      lastActive: row.last_active,
      sessionCount: row.session_count,
      lastSessionId: row.last_session_id ?? undefined,
    };
  }

  private rowToFeedback(row: any): LoopFeedbackRecord {
    return {
      id: row.id,
      loopId: row.loop_id,
      verdict: row.verdict,
      note: row.note ?? undefined,
      createdAt: row.created_at,
    };
  }

  private rowToLoop(row: any, now: Date = new Date()): LoopRecord {
    const snoozeUntil = row.snooze_until ?? undefined;
    const snoozeExpired = row.status === 'snoozed'
      && snoozeUntil !== undefined
      && Date.parse(snoozeUntil) <= now.getTime();
    return {
      id: row.id,
      title: row.title,
      nextAction: row.next_action,
      why: row.why,
      status: snoozeExpired ? 'open' : row.status,
      origin: row.origin === 'user' || row.origin === 'assistant' ? row.origin : 'mixed',
      confidence: row.confidence,
      projectDir: row.project_dir,
      projectName: row.project_name,
      sourceSignalIds: parseJsonArray(row.source_signal_ids),
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      lastSurfacedAt: row.last_surfaced_at ?? undefined,
      hotSurfacedAt: row.hot_surfaced_at ?? undefined,
      ignoredCount: row.ignored_count ?? 0,
      presentationCount: row.presentation_count ?? 0,
      lastPresentedAt: row.last_presented_at ?? undefined,
      snoozeUntil: snoozeExpired ? undefined : snoozeUntil,
      resolvedAt: row.resolved_at ?? undefined,
      resolutionNote: row.resolution_note ?? undefined,
    };
  }
}
