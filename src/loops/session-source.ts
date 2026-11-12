import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import type { RecentSession, SessionAgent, SessionMessage } from './types.js';
import { isTrackerOutputMessage } from './evidence.js';

export interface DiscoverSessionsOptions {
  home?: string;
  days?: number;
  settleMinutes?: number;
  maxSessions?: number;
  historyMessages?: number;
  now?: Date;
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
}

const MAX_MESSAGES_PER_SESSION = 20;
export const MAX_HISTORY_MESSAGES = 2_000;
const HISTORY_HEAD_MESSAGES = 200;
const MAX_MESSAGE_CHARS = 4_000;

function historyWindowLimits(historyMessages: number): {
  headLimit: number;
  fetchLimit: number;
} {
  if (historyMessages <= 0) {
    return { headLimit: 0, fetchLimit: MAX_MESSAGES_PER_SESSION };
  }
  const headLimit = Math.min(historyMessages, HISTORY_HEAD_MESSAGES);
  return {
    headLimit,
    fetchLimit: Math.max(
      MAX_MESSAGES_PER_SESSION,
      Math.min(historyMessages, MAX_HISTORY_MESSAGES - headLimit),
    ),
  };
}

function cleanText(value: string): string {
  return value
    .replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/gi, ' ')
    .replace(/<codex_internal_context\b[^>]*>[\s\S]*?<\/codex_internal_context>/gi, ' ')
    .replace(/<skills_instructions>[\s\S]*?<\/skills_instructions>/gi, ' ')
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_MESSAGE_CHARS);
}

function cleanTitle(value: string, fallback: string): string {
  const cleaned = value
    .replace(/<user_query\b[^>]*>([\s\S]*?)<\/user_query>/gi, ' $1 ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^#+\s*/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (/[\p{L}\p{N}]/u.test(cleaned)) return cleaned.slice(0, 80);
  return /[\p{L}\p{N}]/u.test(fallback) ? fallback.slice(0, 80) : '';
}

function normalizeDir(value: string): string {
  return path.normalize(value.trim());
}

function messageId(fallback: string, value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function latestTimestamp(messages: SessionMessage[], fallback: string): string {
  let latest = fallback;
  for (const message of messages) {
    if (message.timestamp && message.timestamp > latest) latest = message.timestamp;
  }
  return latest;
}

function mergeHistoryRows<T>(
  head: T[],
  recent: T[],
  key: (row: T) => string,
  compare: (left: T, right: T) => number,
): T[] {
  const byKey = new Map<string, T>();
  for (const row of [...head, ...recent]) byKey.set(key(row), row);
  return [...byKey.values()].sort(compare);
}

function isContextMessage(message: Pick<SessionMessage, 'role' | 'text'>): boolean {
  if (message.role !== 'user') return true;
  const text = message.text.trim();
  if (text.length < 4) return true;
  if (/^\[Image:/i.test(text)) return true;
  if (/^<task-notification>/i.test(text)) return true;
  if (/^<(?:codex_internal_context|skills_instructions|environment_context)\b/i.test(text)) return true;
  if (/^#\s*(?:AGENTS\.md|Environment)\b/i.test(text)) return true;
  if (/^You are powered by the model named\b/i.test(text)) return true;
  if (/^Available agent types for the Agent tool:/i.test(text)) return true;
  if (/^The following skills are available for use with the Skill tool:/i.test(text)) return true;
  if (/^Codebase and user instructions are shown below/i.test(text)) return true;
  if (/^Today's date is\b/i.test(text)) return true;
  if (/^The TodoWrite tool hasn't been used recently/i.test(text)) return true;
  if (/^The user hasn't heard from you in a while/i.test(text)) return true;
  if (/system-reminder/i.test(text)) return true;
  return false;
}

function titleFromMessages(
  messages: SessionMessage[],
  fallback: string,
  firstUserText = '',
): string {
  if (firstUserText && !isContextMessage({ role: 'user', text: firstUserText })) {
    return cleanTitle(firstUserText, fallback);
  }
  const useful = messages.find((message) => !isContextMessage(message));
  return cleanTitle(useful?.text ?? fallback, fallback);
}

const PLACEHOLDER_TITLE = /^(?:untitled|new chat|new conversation|未命名会话|未命名|新会话|新对话|无标题)$/i;
const RESPONSE_TITLE_START = /^(?:结论\s*[:：]|好的[，,。\s]|当然[，,。\s]|抱歉|我(?:没有|无法|看不到|不能|已|这边|先)|你(?:指的是|可以|需要|应该|是不是)|(?:目前|已经)(?:已|还|只|完|处|更|把|在))/;

export function isPlaceholderSessionTitle(value: string): boolean {
  return PLACEHOLDER_TITLE.test(value.trim());
}

export function isWeakSessionTitle(value: string): boolean {
  const title = value.trim();
  if (!title) return true;
  if (isPlaceholderSessionTitle(title)) return true;
  if (!RESPONSE_TITLE_START.test(title)) return false;
  return title.length >= 16 || /[。！？；：，]/.test(title);
}

function shortTitle(value: string, max = 24): string {
  const title = value.replace(/\s+/g, ' ').trim();
  if (title.length <= max) return title;
  const head = title.slice(0, max);
  const boundary = Math.max(
    head.lastIndexOf(' '),
    head.lastIndexOf('，'),
    head.lastIndexOf('。'),
    head.lastIndexOf('；'),
    head.lastIndexOf('：'),
    head.lastIndexOf('？'),
    head.lastIndexOf('！'),
  );
  return (boundary >= Math.floor(max / 2) ? head.slice(0, boundary) : head).trim();
}

function walkFiles(
  root: string,
  out: string[] = [],
  skipDirs = new Set<string>(),
): string[] {
  if (!fs.existsSync(root)) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) walkFiles(full, out, skipDirs);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
  return out;
}

function walkMetadataFiles(root: string, out: string[] = [], baseRoot = root): string[] {
  if (!fs.existsSync(root)) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      walkMetadataFiles(full, out, baseRoot);
      continue;
    }
    if (
      !entry.isFile()
      || !entry.name.toLowerCase().startsWith('local_')
      || !entry.name.toLowerCase().endsWith('.json')
    ) continue;
    const relative = path.relative(baseRoot, full);
    if (relative.split(/[\\/]/).length !== 3) continue;
    out.push(full);
  }
  return out;
}

interface CodexSessionSegment {
  canonicalId: string;
  startedAt: string;
  title: string;
  projectDir: string;
  lastActive: string;
  messages: SessionMessage[];
  history: SessionMessage[];
  sourceFile: string;
  historyBase: string;
}

function readCodexSession(file: string): CodexSessionSegment | null {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  let sessionId = '';
  let projectDir = '';
  let startedAt = '';
  let historyBase = '';
  const messages: SessionMessage[] = [];

  for (const line of lines) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = entry.payload ?? {};

    if (entry.type === 'session_meta') {
      if (payload.parent_thread_id) return null;
      sessionId = String(payload.session_id ?? payload.id ?? sessionId);
      projectDir = String(payload.cwd ?? projectDir);
      startedAt = String(payload.timestamp ?? startedAt);
      const base = payload.history_base;
      historyBase = typeof base === 'string'
        ? base
        : String(base?.thread_id ?? base?.threadId ?? historyBase);
      continue;
    }

    if (entry.type === 'response_item' && payload.type === 'message') {
      const role = payload.role;
      if (role !== 'user' && role !== 'assistant') continue;
      const text = Array.isArray(payload.content)
        ? payload.content
          .filter((part: any) => part && typeof part.text === 'string')
          .filter((part: any) => part.type === 'input_text' || part.type === 'output_text' || part.type === 'text')
          .map((part: any) => part.text)
          .join(' ')
        : String(payload.content ?? '');
      const cleaned = cleanText(text);
      if (cleaned) {
        messages.push({
          id: messageId(`${path.basename(file)}#${messages.length}`, payload.id),
          role,
          text: cleaned,
          timestamp: String(entry.timestamp ?? ''),
        });
      }
      continue;
    }

    if (entry.type === 'event_msg' && (payload.type === 'user_message' || payload.type === 'agent_message')) {
      const cleaned = cleanText(String(payload.message ?? payload.text ?? ''));
      if (cleaned) {
        messages.push({
          id: messageId(`${path.basename(file)}#e${messages.length}`, payload.id),
          role: payload.type === 'user_message' ? 'user' : 'assistant',
          text: cleaned,
          timestamp: String(entry.timestamp ?? ''),
        });
      }
    }
  }

  if (!sessionId || !projectDir || messages.length < 2) return null;
  const recent = messages.slice(-MAX_MESSAGES_PER_SESSION);
  const history = messages.slice(-MAX_HISTORY_MESSAGES);
  const stat = fs.statSync(file);
  const fallback = stat.mtime.toISOString();
  return {
    canonicalId: sessionId,
    startedAt: startedAt || messages[0]?.timestamp || fallback,
    title: titleFromMessages(recent, path.basename(projectDir)),
    projectDir: normalizeDir(projectDir),
    lastActive: latestTimestamp(recent, fallback),
    messages: recent,
    history,
    sourceFile: file,
    historyBase,
  };
}

function mergeCodexSessions(segments: CodexSessionSegment[]): RecentSession[] {
  const groups = new Map<string, CodexSessionSegment[]>();
  for (const segment of segments) {
    const group = groups.get(segment.canonicalId);
    if (group) group.push(segment);
    else groups.set(segment.canonicalId, [segment]);
  }

  const merged: RecentSession[] = [];
  for (const [sessionId, group] of groups) {
    const orderedGroup = [...group].sort((left, right) => (
      left.startedAt.localeCompare(right.startedAt)
      || left.sourceFile.localeCompare(right.sourceFile)
    ));
    const root = orderedGroup.find((segment) => !segment.historyBase) ?? orderedGroup[0];
    const perSegment = Math.max(
      4,
      Math.floor(MAX_MESSAGES_PER_SESSION / Math.max(1, orderedGroup.length)),
    );
    const byContent = new Map<string, SessionMessage>();
    for (const segment of orderedGroup) {
      for (const message of segment.messages.slice(-perSegment)) {
        const key = `${message.timestamp}\u0000${message.role}\u0000${message.text}`;
        if (!byContent.has(key)) byContent.set(key, message);
      }
    }
    const ordered = [...byContent.values()].sort((left, right) => {
      if (!left.timestamp) return right.timestamp ? 1 : 0;
      if (!right.timestamp) return -1;
      return left.timestamp.localeCompare(right.timestamp);
    });
    const historyByContent = new Map<string, SessionMessage>();
    for (const segment of orderedGroup) {
      for (const message of segment.history) {
        const key = `${message.timestamp}\u0000${message.role}\u0000${message.text}`;
        if (!historyByContent.has(key)) historyByContent.set(key, message);
      }
    }
    const history = [...historyByContent.values()]
      .sort((left, right) => {
        if (!left.timestamp) return right.timestamp ? 1 : 0;
        if (!right.timestamp) return -1;
        return left.timestamp.localeCompare(right.timestamp);
      })
      .slice(-MAX_HISTORY_MESSAGES);
    const lastActive = group.reduce(
      (latest, segment) => segment.lastActive > latest ? segment.lastActive : latest,
      root.lastActive,
    );
    merged.push({
      agent: 'codex',
      sessionId,
      title: root.title,
      projectDir: root.projectDir,
      lastActive,
      messages: ordered.slice(-MAX_MESSAGES_PER_SESSION),
      history,
      sourceFile: root.sourceFile,
    });
  }
  return merged;
}

interface ClaudeSessionOverrides {
  projectDir?: string;
  title?: string;
  sessionId?: string;
  lastActive?: string;
  sourceFile?: string;
}

function readClaudeSession(
  file: string,
  overrides: ClaudeSessionOverrides = {},
): RecentSession | null {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  let projectDir = '';
  const messages: SessionMessage[] = [];

  for (const line of lines) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.isSidechain === true) continue;
    if (!projectDir) {
      projectDir = String(
        entry.cwd
        ?? entry.attachment?.snapshot?.workingDirectory
        ?? '',
      );
    }
    if (entry.type !== 'user' && entry.type !== 'assistant') continue;
    const payload = entry.message ?? {};
    const role = payload.role === 'user' || payload.role === 'assistant'
      ? payload.role
      : entry.type;
    const text = Array.isArray(payload.content)
      ? payload.content
        .filter((part: any) => part && part.type === 'text' && typeof part.text === 'string')
        .map((part: any) => part.text)
        .join(' ')
      : typeof payload.content === 'string' ? payload.content : '';
    const cleaned = cleanText(text);
    if (cleaned) {
      messages.push({
        id: messageId(`${path.basename(file)}#${messages.length}`, entry.uuid),
        role,
        text: cleaned,
        timestamp: String(entry.timestamp ?? ''),
      });
    }
  }

  if (overrides.projectDir) projectDir = overrides.projectDir;
  if (!projectDir || messages.length < 2) return null;
  const stem = path.basename(file, '.jsonl');
  const recent = messages.slice(-MAX_MESSAGES_PER_SESSION);
  const stat = fs.statSync(file);
  return {
    agent: 'claude',
    sessionId: overrides.sessionId ?? stem,
    title: overrides.title || titleFromMessages(recent, path.basename(projectDir)),
    projectDir: normalizeDir(projectDir),
    lastActive: overrides.lastActive ?? latestTimestamp(recent, stat.mtime.toISOString()),
    messages: recent,
    history: messages.slice(-MAX_HISTORY_MESSAGES),
    sourceFile: overrides.sourceFile ?? file,
  };
}

function usableCoworkProjectDir(value: string, home: string): string | null {
  const candidate = normalizeDir(value);
  if (!path.isAbsolute(candidate)) return null;
  if (candidate === path.parse(candidate).root) return null;
  if (candidate === normalizeDir(home)) return null;
  if (candidate.includes(`${path.sep}local-agent-mode-sessions${path.sep}`)) return null;
  return candidate;
}

function readClaudeCoworkSessions(
  root: string,
  cutoffMs: number,
  maxSessions: number,
  home: string,
): RecentSession[] {
  const candidates: Array<{ file: string; lastActive: number; meta: any }> = [];
  const metadataFiles = walkMetadataFiles(root);
  for (const file of metadataFiles) {
    let meta: any;
    try {
      meta = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (meta.isArchived === true) continue;
    const lastActive = Number(meta.lastActivityAt ?? meta.createdAt);
    if (!Number.isFinite(lastActive) || lastActive < cutoffMs) continue;
    if (typeof meta.cliSessionId !== 'string' || meta.cliSessionId.length === 0) continue;
    candidates.push({ file, lastActive, meta });
  }

  candidates.sort((left, right) => right.lastActive - left.lastActive);
  const sessions: RecentSession[] = [];
  for (const candidate of candidates) {
    if (sessions.length >= maxSessions) break;
    const selected = Array.isArray(candidate.meta.userSelectedFolders)
      ? candidate.meta.userSelectedFolders
      : [];
    const projectDir = selected
      .map((value: unknown) => typeof value === 'string' ? usableCoworkProjectDir(value, home) : null)
      .find((value: string | null) => value !== null);
    if (!projectDir) continue;

    const shortId = path.basename(candidate.file).replace(/^local_/i, '').split('-')[0];
    const transcript = path.join(
      path.dirname(candidate.file),
      shortId,
      '.claude',
      'projects',
      'session',
      `${candidate.meta.cliSessionId}.jsonl`,
    );
    if (!fs.existsSync(transcript)) continue;

    const session = readClaudeSession(transcript, {
      projectDir,
      title: typeof candidate.meta.title === 'string' ? candidate.meta.title : undefined,
      sessionId: candidate.meta.cliSessionId,
      lastActive: new Date(candidate.lastActive).toISOString(),
      sourceFile: transcript,
    });
    if (session) sessions.push(session);
  }
  return sessions;
}

function readQoderSessions(
  dbPath: string,
  cutoffMs: number,
  maxSessions: number,
  historyMessages = 0,
): RecentSession[] {
  if (!fs.existsSync(dbPath)) return [];
  const req = createRequire(import.meta.url);
  const { DatabaseSync } = req('node:sqlite') as { DatabaseSync: new (file: string, options?: any) => any };
  let db: any;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return [];
  }

  try {
    const sessions = db.prepare(`
      SELECT session_id, title, cwd, updated_at
      FROM chat_sessions
      WHERE archived = 0 AND deleted_at IS NULL AND cwd IS NOT NULL AND updated_at >= ?
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(cutoffMs, maxSessions);

    const results: RecentSession[] = [];
    const messageStmt = db.prepare(`
      SELECT message_id, sequence, role, payload_json, created_at
      FROM chat_session_messages
      WHERE session_id = ? AND role IN ('user', 'assistant')
      ORDER BY sequence DESC
      LIMIT ?
    `);
    const headStmt = db.prepare(`
      SELECT message_id, sequence, role, payload_json, created_at
      FROM chat_session_messages
      WHERE session_id = ? AND role IN ('user', 'assistant')
      ORDER BY sequence ASC
      LIMIT ?
    `);

    const { headLimit, fetchLimit } = historyWindowLimits(historyMessages);
    for (const session of sessions) {
      let rows = messageStmt.all(session.session_id, fetchLimit).reverse();
      if (headLimit > 0) {
        rows = mergeHistoryRows(
          headStmt.all(session.session_id, headLimit),
          rows,
          (row: any) => String(row.message_id ?? row.sequence),
          (left: any, right: any) => Number(left.sequence) - Number(right.sequence),
        );
      }
      const messages: SessionMessage[] = [];
      for (const row of rows) {
        let payload: any = {};
        try {
          payload = JSON.parse(row.payload_json);
        } catch {
          continue;
        }
        const parts = Array.isArray(payload.parts) ? payload.parts : [];
        const text = parts
          .filter((part: any) => part && part.type === 'text' && typeof part.text === 'string')
          .map((part: any) => part.text)
          .join(' ');
        const cleaned = cleanText(text);
        if (!cleaned) continue;
        messages.push({
          id: messageId(`q${row.sequence}`, row.message_id),
          role: row.role,
          text: cleaned,
          timestamp: new Date(row.created_at).toISOString(),
        });
      }
      if (messages.length < 2) continue;
      const recent = messages.slice(-MAX_MESSAGES_PER_SESSION);
      const lastActive = new Date(session.updated_at).toISOString();
      const title = cleanTitle(String(session.title ?? ''), '')
        || titleFromMessages(recent, '')
        || '未命名会话';
      results.push({
        agent: 'qoder-cn',
        sessionId: session.session_id,
        title,
        projectDir: normalizeDir(String(session.cwd)),
        lastActive: latestTimestamp(messages, lastActive),
        messages: recent,
        ...(historyMessages > 0 ? { history: messages.slice(-MAX_HISTORY_MESSAGES) } : {}),
        sourceFile: `${dbPath}#${session.session_id}`,
      });
    }
    return results;
  } finally {
    db.close();
  }
}

function hermesEpochToIso(value: unknown): string {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  return new Date(seconds * 1000).toISOString();
}

function agyTimestamp(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const normalized = raw
    .replace(' ', 'T')
    .replace(/(\.\d{3})\d+/, '$1');
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

function agyUserText(content: string): string {
  const request = content.match(/<USER_REQUEST\b[^>]*>([\s\S]*?)<\/USER_REQUEST>/i);
  return cleanText(request ? request[1] : content);
}

function agyWorkspacePath(value: unknown, home: string, sessionId: string): string {
  let entries: unknown;
  try {
    entries = JSON.parse(String(value ?? ''));
  } catch {
    entries = [];
  }
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (typeof entry !== 'string' || !entry.startsWith('file://')) continue;
      try {
        const decoded = decodeURIComponent(entry.slice('file://'.length));
        const windowsPath = decoded.match(/^\/([A-Za-z]:[\\/].*)$/);
        return windowsPath
          ? windowsPath[1].replace(/\//g, '\\')
          : path.normalize(decoded);
      } catch {
        continue;
      }
    }
  }
  return path.join(home, '.gemini-antigravity-sessions', sessionId);
}

function recentAgyMessages(messages: SessionMessage[]): SessionMessage[] {
  if (messages.length <= MAX_MESSAGES_PER_SESSION) return messages;
  const recent = messages.slice(-MAX_MESSAGES_PER_SESSION);
  if (recent.some((message) => message.role === 'user')) return recent;
  const firstUser = messages.find((message) => message.role === 'user');
  if (!firstUser) return recent;
  return [firstUser, ...messages.slice(-(MAX_MESSAGES_PER_SESSION - 1))];
}

function readAgyTranscript(file: string, sessionId: string): SessionMessage[] {
  if (!fs.existsSync(file)) return [];
  const messages: SessionMessage[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const type = String(record?.type ?? '');
    const role = type === 'USER_INPUT'
      ? 'user'
      : type === 'PLANNER_RESPONSE'
        ? 'assistant'
        : null;
    if (!role) continue;
    const raw = typeof record.content === 'string' ? record.content : '';
    const text = role === 'user' ? agyUserText(raw) : cleanText(raw);
    if (!text) continue;
    messages.push({
      id: `${sessionId}:${String(record.step_index ?? messages.length)}`,
      role,
      text,
      timestamp: String(record.created_at ?? ''),
    });
  }
  return messages.slice(-MAX_HISTORY_MESSAGES);
}

function readAgySessions(
  dbPath: string,
  brainRoot: string,
  cutoffMs: number,
  maxSessions: number,
  home: string,
): RecentSession[] {
  if (!fs.existsSync(dbPath) || !fs.existsSync(brainRoot)) return [];
  const req = createRequire(import.meta.url);
  const { DatabaseSync } = req('node:sqlite') as {
    DatabaseSync: new (file: string, options?: any) => any;
  };
  let db: any;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return [];
  }
  try {
    const rows = db.prepare(`
      SELECT conversation_id, title, preview, step_count, last_modified_time,
             workspace_uris, parent_conversation_id, nesting_depth
      FROM conversation_summaries
      ORDER BY last_modified_time DESC
    `).all() as Array<Record<string, unknown>>;
    const sessions: RecentSession[] = [];
    for (const row of rows) {
      if (sessions.length >= maxSessions) break;
      if (String(row.parent_conversation_id ?? '').trim()) continue;
      if (Number(row.nesting_depth ?? 0) > 0) continue;
      if (Number(row.step_count ?? 0) <= 0) continue;
      const sessionId = String(row.conversation_id ?? '').trim();
      if (!sessionId) continue;
      const transcript = path.join(
        brainRoot,
        sessionId,
        '.system_generated',
        'logs',
        'transcript_full.jsonl',
      );
      if (!fs.existsSync(transcript)) continue;
      const history = readAgyTranscript(transcript, sessionId);
      if (history.length < 2) continue;
      const messages = recentAgyMessages(history);
      const fallback = agyTimestamp(row.last_modified_time)
        || fs.statSync(transcript).mtime.toISOString();
      if (Date.parse(fallback) < cutoffMs) continue;
      const title = cleanTitle(
        String(row.title ?? ''),
        String(row.preview ?? ''),
      );
      sessions.push({
        agent: 'agy',
        sessionId,
        title: title || titleFromMessages(messages, '') || '未命名会话',
        projectDir: agyWorkspacePath(row.workspace_uris, home, sessionId),
        lastActive: latestTimestamp(messages, fallback),
        messages,
        history,
        sourceFile: transcript,
      });
    }
    return sessions;
  } catch {
    return [];
  } finally {
    db.close();
  }
}

function readHermesSessions(
  dbPath: string,
  cutoffMs: number,
  maxSessions: number,
  homeDir: string,
  historyMessages = 0,
): RecentSession[] {
  if (!fs.existsSync(dbPath)) return [];
  const req = createRequire(import.meta.url);
  const { DatabaseSync } = req('node:sqlite') as { DatabaseSync: new (file: string, options?: any) => any };
  let db: any;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return [];
  }

  try {
    const cutoffSeconds = cutoffMs / 1000;
    const sessions = db.prepare(`
      SELECT id, source, title, cwd, started_at, last_activity_at, message_count
      FROM sessions
      WHERE archived = 0
        AND hidden = 0
        AND parent_session_id IS NULL
        AND source IN ('local', 'gui', 'feishu', 'weixin')
        AND cwd IS NOT NULL
        AND cwd <> ''
        AND COALESCE(last_activity_at, started_at) >= ?
      ORDER BY COALESCE(last_activity_at, started_at) DESC
      LIMIT ?
    `).all(cutoffSeconds, maxSessions);

    const results: RecentSession[] = [];
    const messageStmt = db.prepare(`
      SELECT id, message_uid, role, content, timestamp
      FROM messages
      WHERE session_id = ?
        AND role IN ('user', 'assistant')
        AND content IS NOT NULL
        AND TRIM(content) <> ''
      ORDER BY timestamp DESC
      LIMIT ?
    `);
    const headStmt = db.prepare(`
      SELECT id, message_uid, role, content, timestamp
      FROM messages
      WHERE session_id = ?
        AND role IN ('user', 'assistant')
        AND content IS NOT NULL
        AND TRIM(content) <> ''
      ORDER BY timestamp ASC, id ASC
      LIMIT ?
    `);

    const { headLimit, fetchLimit } = historyWindowLimits(historyMessages);
    for (const session of sessions) {
      let rows = messageStmt.all(session.id, fetchLimit).reverse();
      if (headLimit > 0) {
        rows = mergeHistoryRows(
          headStmt.all(session.id, headLimit),
          rows,
          (row: any) => String(row.id),
          (left: any, right: any) => (
            Number(left.timestamp) - Number(right.timestamp)
            || Number(left.id) - Number(right.id)
          ),
        );
      }
      const messages: SessionMessage[] = [];
      for (const row of rows) {
        if (row.role !== 'user' && row.role !== 'assistant') continue;
        const cleaned = cleanText(String(row.content ?? ''));
        if (!cleaned) continue;
        messages.push({
          id: messageId(`h${row.id}`, row.message_uid),
          role: row.role,
          text: cleaned,
          timestamp: hermesEpochToIso(row.timestamp),
        });
      }
      if (messages.length < 2) continue;
      const recent = messages.slice(-MAX_MESSAGES_PER_SESSION);

      const fallbackLastActive = hermesEpochToIso(session.last_activity_at ?? session.started_at);
      const title = cleanTitle(String(session.title ?? ''), '')
        || titleFromMessages(recent, '')
        || '未命名会话';
      const cwd = normalizeDir(String(session.cwd));
      const isHome = path.normalize(cwd).replace(/[\\/]+$/, '').toLowerCase()
        === path.normalize(homeDir).replace(/[\\/]+$/, '').toLowerCase();
      results.push({
        agent: 'hermes',
        sessionId: session.id,
        title,
        projectDir: isHome
          ? path.join(cwd, '.hermes-sessions', session.id)
          : cwd,
        lastActive: latestTimestamp(messages, fallbackLastActive),
        messages: recent,
        ...(historyMessages > 0 ? { history: messages.slice(-MAX_HISTORY_MESSAGES) } : {}),
        sourceFile: `${dbPath}#${session.id}`,
      });
    }
    return results;
  } finally {
    db.close();
  }
}

const DSH_ZSTD_MAGIC = 0xFD2FB528;

function dshFrameLength(buffer: Buffer, offset: number): number {
  let position = offset + 4;
  if (position >= buffer.length) return -1;
  const descriptor = buffer[position];
  position += 1;
  if ((descriptor & 0x08) !== 0) return -1;

  const contentSizeFlag = descriptor >>> 6;
  const singleSegment = (descriptor >>> 5) & 1;
  const hasChecksum = (descriptor >>> 2) & 1;
  const dictionaryFlag = descriptor & 0x03;

  if (!singleSegment) {
    if (position >= buffer.length) return -1;
    position += 1;
  }
  position += dictionaryFlag === 3 ? 4 : dictionaryFlag;
  position += contentSizeFlag === 0
    ? (singleSegment ? 1 : 0)
    : contentSizeFlag === 1
      ? 2
      : contentSizeFlag === 2
        ? 4
        : 8;

  while (position + 3 <= buffer.length) {
    const blockHeader = buffer[position]
      | (buffer[position + 1] << 8)
      | (buffer[position + 2] << 16);
    position += 3;
    const lastBlock = blockHeader & 1;
    const blockType = (blockHeader >>> 1) & 0x03;
    const blockSize = blockHeader >>> 3;
    if (blockType === 3) return -1;
    position += blockType === 1 ? 1 : blockSize;
    if (position > buffer.length) return -1;
    if (lastBlock) {
      if (hasChecksum) position += 4;
      return position <= buffer.length ? position - offset : -1;
    }
  }
  return -1;
}

function decompressDshFile(file: string): string {
  const buffer = fs.readFileSync(file);
  const req = createRequire(import.meta.url);
  const { zstdDecompressSync } = req('node:zlib') as {
    zstdDecompressSync: (data: Buffer) => Buffer;
  };
  const chunks: Buffer[] = [];
  let offset = 0;

  while (offset + 4 <= buffer.length) {
    const magic = buffer.readUInt32LE(offset);
    if (magic >= 0x184D2A50 && magic <= 0x184D2A5F) {
      if (offset + 8 > buffer.length) break;
      const size = buffer.readUInt32LE(offset + 4);
      offset += 8 + size;
      continue;
    }
    if (magic !== DSH_ZSTD_MAGIC) break;
    const length = dshFrameLength(buffer, offset);
    if (length <= 0) break;
    try {
      chunks.push(zstdDecompressSync(buffer.subarray(offset, offset + length)));
    } catch {
      break;
    }
    offset += length;
  }

  return Buffer.concat(chunks).toString('utf8');
}

function dshGoalObjective(text: string): string {
  const match = text.match(/Objective:\s*"([\s\S]*?)"\s*\n\s*Round:/);
  return match ? match[1] : '';
}

function recentDshMessages(messages: SessionMessage[]): SessionMessage[] {
  if (messages.length <= MAX_MESSAGES_PER_SESSION) return messages;
  const recent = messages.slice(-MAX_MESSAGES_PER_SESSION);
  if (recent.some((message) => message.role === 'user')) return recent;
  const firstUser = messages.find((message) => message.role === 'user');
  if (!firstUser) return recent;
  return [firstUser, ...messages.slice(-(MAX_MESSAGES_PER_SESSION - 1))];
}

function readDshSession(file: string, homeDir: string): RecentSession | null {
  const lines = decompressDshFile(file).split(/\r?\n/).filter(Boolean);
  let sessionId = '';
  let projectDir = '';
  let parentSession = '';
  let delegationDepth = 0;
  let title = '';
  const messages: SessionMessage[] = [];
  const seenGoals = new Set<string>();

  for (const line of lines) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type === 'session') {
      sessionId = String(entry.id ?? sessionId);
      projectDir = String(entry.cwd ?? projectDir);
      parentSession = String(entry.parentSession ?? parentSession);
      delegationDepth = Number(entry.delegationDepth ?? delegationDepth);
      continue;
    }

    if (entry.type === 'session/title') {
      const value = String(entry.data?.title ?? '');
      if (value) title = value;
      continue;
    }

    const timeMs = Number(entry.time);
    const timestamp = Number.isFinite(timeMs) && timeMs > 0
      ? new Date(timeMs).toISOString()
      : '';

    if (entry.type === 'user/message') {
      const data = entry.data ?? {};
      const kind = String(data.source?.kind ?? '');
      let text = Array.isArray(data.content)
        ? data.content
          .filter((part: any) => part && part.type === 'text' && typeof part.text === 'string')
          .map((part: any) => part.text)
          .join(' ')
        : '';
      if (kind === 'goal') {
        text = dshGoalObjective(text);
        if (!text) continue;
        const goalKey = cleanText(text);
        if (!goalKey || seenGoals.has(goalKey)) continue;
        seenGoals.add(goalKey);
      } else if (kind !== 'user') {
        continue;
      }
      const cleaned = cleanText(text);
      if (!cleaned) continue;
      messages.push({
        id: messageId(`${path.basename(file)}#${messages.length}`, data.id),
        role: 'user',
        text: cleaned,
        timestamp,
      });
      continue;
    }

    if (entry.type === 'assistant/message') {
      const data = entry.data ?? {};
      const payload = data.message ?? {};
      const text = Array.isArray(payload.content)
        ? payload.content
          .filter((part: any) => part && part.type === 'text' && typeof part.text === 'string')
          .map((part: any) => part.text)
          .join(' ')
        : '';
      const cleaned = cleanText(text);
      if (!cleaned) continue;
      messages.push({
        id: messageId(`${path.basename(file)}#${messages.length}`, payload.id ?? data.id),
        role: 'assistant',
        text: cleaned,
        timestamp,
      });
    }
  }

  if (!sessionId || !projectDir || parentSession || delegationDepth > 0) return null;
  if (messages.length < 2) return null;

  const recent = recentDshMessages(messages);
  const stat = fs.statSync(file);
  const cwd = normalizeDir(projectDir);
  const isHome = path.normalize(cwd).replace(/[\\/]+$/, '').toLowerCase()
    === path.normalize(homeDir).replace(/[\\/]+$/, '').toLowerCase();
  return {
    agent: 'dsh',
    sessionId,
    title: cleanTitle(title, '')
      || titleFromMessages(recent, '')
      || '未命名会话',
    projectDir: isHome ? path.join(cwd, '.dsh-sessions', sessionId) : cwd,
    lastActive: latestTimestamp(recent, stat.mtime.toISOString()),
    messages: recent,
    history: messages.slice(-MAX_HISTORY_MESSAGES),
    sourceFile: file,
  };
}

function readDshSessions(
  root: string,
  cutoffMs: number,
  maxSessions: number,
  homeDir: string,
): RecentSession[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name === 'session.v4.jsonl.zstd') {
        files.push(full);
      }
    }
  };
  walk(root);

  const candidates = files
    .map((file) => ({ file, mtimeMs: fs.statSync(file).mtimeMs }))
    .filter((candidate) => candidate.mtimeMs >= cutoffMs)
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, Math.max(maxSessions * 2, 40));

  const sessions: RecentSession[] = [];
  for (const candidate of candidates) {
    if (sessions.length >= maxSessions) break;
    try {
      const session = readDshSession(candidate.file, homeDir);
      if (session) sessions.push(session);
    } catch {
      // A partially written or unknown frame should not hide other sessions.
    }
  }
  return sessions;
}

function readWorkbuddySession(file: string): RecentSession | null {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  let sessionId = '';
  let projectDir = '';
  let aiTitle = '';
  const messages: SessionMessage[] = [];

  for (const line of lines) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type === 'session-meta') {
      sessionId = String(entry.sessionId ?? entry.id ?? sessionId);
      continue;
    }
    if (entry.cwd && !projectDir) projectDir = String(entry.cwd);
    if (entry.type === 'ai-title' && entry.aiTitle) {
      aiTitle = String(entry.aiTitle);
      continue;
    }
    if (entry.type !== 'message') continue;
    if (entry.providerData?.skipRun === true) continue;
    const role = entry.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = Array.isArray(entry.content)
      ? entry.content
        .filter((part: any) => part
          && typeof part.text === 'string'
          && (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text'))
        .map((part: any) => part.text)
        .join(' ')
      : '';
    const cleaned = cleanText(text);
    if (!cleaned) continue;
    messages.push({
      id: messageId(`${path.basename(file)}#${messages.length}`, entry.id),
      role,
      text: cleaned,
      timestamp: entry.timestamp ? new Date(entry.timestamp).toISOString() : '',
    });
  }

  if (!sessionId || !projectDir || messages.length < 2) return null;
  const recent = messages.slice(-MAX_MESSAGES_PER_SESSION);
  const stat = fs.statSync(file);
  return {
    agent: 'workbuddy',
    sessionId,
    title: cleanTitle(aiTitle, '')
      || titleFromMessages(recent, '')
      || '未命名会话',
    projectDir: normalizeDir(projectDir),
    lastActive: latestTimestamp(recent, stat.mtime.toISOString()),
    messages: recent,
    history: messages.slice(-MAX_HISTORY_MESSAGES),
    sourceFile: file,
  };
}

function readZcodeSessions(
  dbPath: string,
  cutoffMs: number,
  maxSessions: number,
  historyMessages = 0,
): RecentSession[] {
  if (!fs.existsSync(dbPath)) return [];
  const req = createRequire(import.meta.url);
  const { DatabaseSync } = req('node:sqlite') as { DatabaseSync: new (file: string, options?: any) => any };
  let db: any;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return [];
  }

  try {
    const sessions = db.prepare(`
      SELECT id, title, directory, time_updated
      FROM session
      WHERE time_archived IS NULL
        AND directory IS NOT NULL
        AND parent_id IS NULL
        AND id NOT LIKE 'sess_subagent_%'
        AND time_updated >= ?
      ORDER BY time_updated DESC
      LIMIT ?
    `).all(cutoffMs, maxSessions);

    const results: RecentSession[] = [];
    const messageStmt = db.prepare(`
      SELECT id, time_created, data, sequence
      FROM message
      WHERE session_id = ?
      ORDER BY sequence DESC
      LIMIT ?
    `);
    const headStmt = db.prepare(`
      SELECT id, time_created, data, sequence
      FROM message
      WHERE session_id = ?
      ORDER BY sequence ASC
      LIMIT ?
    `);
    const partStmt = db.prepare(`
      SELECT data
      FROM part
      WHERE message_id = ?
      ORDER BY sequence
    `);

    const { headLimit, fetchLimit } = historyWindowLimits(historyMessages);
    for (const session of sessions) {
      let rows = messageStmt.all(session.id, fetchLimit).reverse();
      if (headLimit > 0) {
        rows = mergeHistoryRows(
          headStmt.all(session.id, headLimit),
          rows,
          (row: any) => String(row.id),
          (left: any, right: any) => Number(left.sequence) - Number(right.sequence),
        );
      }
      const messages: SessionMessage[] = [];
      for (const row of rows) {
        let data: any = {};
        try {
          data = JSON.parse(row.data);
        } catch {
          continue;
        }
        if (data.role !== 'user' && data.role !== 'assistant') continue;
        const parts = partStmt.all(row.id);
        const text = parts
          .map((part: any) => {
            try {
              return JSON.parse(part.data);
            } catch {
              return null;
            }
          })
          .filter((part: any) => part && part.type === 'text' && typeof part.text === 'string')
          .map((part: any) => part.text)
          .join(' ');
        const cleaned = cleanText(text);
        if (!cleaned) continue;
        messages.push({
          id: messageId(`z${row.id}`, row.id),
          role: data.role,
          text: cleaned,
          timestamp: new Date(data.time?.created ?? row.time_created).toISOString(),
        });
      }
      if (messages.length < 2) continue;
      const recent = messages.slice(-MAX_MESSAGES_PER_SESSION);
      const title = cleanTitle(String(session.title ?? ''), '')
        || titleFromMessages(recent, '')
        || '未命名会话';
      results.push({
        agent: 'zcode',
        sessionId: session.id,
        title,
        projectDir: normalizeDir(String(session.directory)),
        lastActive: latestTimestamp(messages, new Date(session.time_updated).toISOString()),
        messages: recent,
        ...(historyMessages > 0 ? { history: messages.slice(-MAX_HISTORY_MESSAGES) } : {}),
        sourceFile: `${dbPath}#${session.id}`,
      });
    }
    return results;
  } finally {
    db.close();
  }
}

function dedupeSessions(sessions: RecentSession[]): RecentSession[] {
  const map = new Map<string, RecentSession>();
  for (const session of sessions) {
    const key = `${session.agent}:${session.sessionId}`;
    const existing = map.get(key);
    if (!existing || session.lastActive > existing.lastActive) map.set(key, session);
  }
  return [...map.values()];
}

function withoutTrackerOutput(session: RecentSession): RecentSession {
  const messages = session.messages.filter((message) => !isTrackerOutputMessage(message));
  if (!session.history) return { ...session, messages };
  return {
    ...session,
    messages,
    history: session.history.filter((message) => !isTrackerOutputMessage(message)),
  };
}

export function discoverRecentSessions(options: DiscoverSessionsOptions = {}): RecentSession[] {
  const home = options.home ?? os.homedir();
  const days = options.days ?? 7;
  const settleMinutes = options.settleMinutes ?? 30;
  const maxSessions = options.maxSessions ?? 120;
  const historyMessages = Math.max(
    0,
    Math.min(options.historyMessages ?? 0, MAX_HISTORY_MESSAGES),
  );
  const now = options.now ?? new Date();
  const cutoffMs = now.getTime() - days * 24 * 60 * 60 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();
  const settledIso = new Date(now.getTime() - settleMinutes * 60 * 1000).toISOString();

  const codexRoot = options.codexRoot ?? path.join(home, '.codex', 'sessions');
  const claudeRoot = options.claudeRoot ?? path.join(home, '.claude', 'projects');
  const localAppData = options.home
    ? path.join(home, 'AppData', 'Local')
    : process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
  const claudeDesktopRoot = options.claudeDesktopRoot
    ?? path.join(localAppData, 'Claude-3p', 'local-agent-mode-sessions');
  const qoderDbPath = options.qoderDbPath
    ?? path.join(home, 'AppData', 'Roaming', 'com.qodercn.app.stable', 'main.sqlite');
  const zcodeDbPath = options.zcodeDbPath
    ?? path.join(home, '.zcode', 'cli', 'db', 'db.sqlite');
  const workbuddyRoot = options.workbuddyRoot
    ?? path.join(home, '.workbuddy', 'projects');
  const dshRoot = options.dshRoot
    ?? path.join(home, '.dsh', 'sessions');
  const hermesCandidates = [
    path.join(localAppData, 'hermes', 'state.db'),
    path.join(home, '.local', 'state', 'hermes', 'state.db'),
  ];
  const hermesDbPath = options.hermesDbPath
    ?? hermesCandidates.find((candidate) => fs.existsSync(candidate))
    ?? hermesCandidates[0];
  const agyRoot = options.agyRoot
    ?? path.join(home, '.gemini', 'antigravity-cli', 'brain');
  const agyDbPath = options.agyDbPath
    ?? path.join(home, '.gemini', 'antigravity-cli', 'conversation_summaries.db');

  const sessions: RecentSession[] = [];

  const codexSegments: CodexSessionSegment[] = [];
  for (const file of walkFiles(codexRoot)) {
    if (fs.statSync(file).mtimeMs < cutoffMs) continue;
    const segment = readCodexSession(file);
    if (segment) codexSegments.push(segment);
  }
  sessions.push(...mergeCodexSessions(codexSegments));

  for (const file of walkFiles(claudeRoot, [], new Set(['subagents', 'tool-results']))) {
    if (fs.statSync(file).mtimeMs < cutoffMs) continue;
    const session = readClaudeSession(file);
    if (session && session.lastActive >= cutoffIso) sessions.push(session);
  }

  sessions.push(...readClaudeCoworkSessions(
    claudeDesktopRoot,
    cutoffMs,
    maxSessions,
    home,
  ));

  sessions.push(...readQoderSessions(qoderDbPath, cutoffMs, maxSessions, historyMessages));
  sessions.push(...readZcodeSessions(zcodeDbPath, cutoffMs, maxSessions, historyMessages));
  sessions.push(...readHermesSessions(
    hermesDbPath,
    cutoffMs,
    maxSessions,
    home,
    historyMessages,
  ));
  sessions.push(...readDshSessions(dshRoot, cutoffMs, maxSessions, home));
  sessions.push(...readAgySessions(agyDbPath, agyRoot, cutoffMs, maxSessions, home));

  for (const file of walkFiles(workbuddyRoot)) {
    if (fs.statSync(file).mtimeMs < cutoffMs) continue;
    const session = readWorkbuddySession(file);
    if (session && session.lastActive >= cutoffIso) sessions.push(session);
  }

  return dedupeSessions(sessions)
    .map(withoutTrackerOutput)
    .filter((session) => session.lastActive >= cutoffIso
      && (settleMinutes === 0 || session.lastActive <= settledIso))
    .sort((a, b) => b.lastActive.localeCompare(a.lastActive))
    .slice(0, maxSessions);
}

export function projectNameFromDir(projectDir: string): string {
  const normalized = projectDir.replace(/\\/g, '/');
  const worktree = normalized.match(/^(.*?)\/\.claude\/worktrees\//);
  if (worktree) return path.basename(worktree[1]);
  return path.basename(normalized) || 'unknown';
}

export function displayProjectName(
  identityName: string,
  session: RecentSession,
  homeDir: string = os.homedir(),
): string {
  const hashLike = /^(?:[0-9a-f]{8,}|\d{10,}-[0-9a-f-]{8,}|draft-[0-9a-f-]{8,})$/i;
  const timestampLike = /^\d{4}[-_]\d{2}[-_]\d{2}(?:[-_]\d{2}[-_]\d{2}[-_]\d{2})?$/;
  const sessionOnly = hashLike.test(identityName)
    || (session.agent === 'hermes' && /^local-[0-9a-f]{16,}$/i.test(identityName));
  const workbuddyOnly = session.agent === 'workbuddy' && timestampLike.test(identityName);
  const hermesHome = session.agent === 'hermes'
    && path.normalize(session.projectDir).replace(/[\\/]+$/, '').toLowerCase()
      === path.normalize(homeDir).replace(/[\\/]+$/, '').toLowerCase();
  const dshHome = session.agent === 'dsh'
    && session.projectDir.replace(/\\/g, '/').toLowerCase().includes('/.dsh-sessions/');
  const agySession = session.agent === 'agy'
    && (
      session.projectDir.replace(/\\/g, '/').toLowerCase().includes('/.gemini-antigravity-sessions/')
      || /\/workspace\/conv_[^/]+\/temp$/i.test(session.projectDir.replace(/\\/g, '/'))
    );
  if (sessionOnly || workbuddyOnly || hermesHome || dshHome || agySession) {
    const storedTitle = cleanTitle(session.title, '').replace(/\s+/g, ' ').trim();
    const fallbackTitle = titleFromMessages(
      [...(session.history ?? []), ...session.messages],
      '',
    );
    const title = isWeakSessionTitle(storedTitle)
      ? shortTitle(fallbackTitle || '未命名会话', 24)
      : shortTitle(storedTitle, 40);
    const dir = session.projectDir.replace(/\\/g, '/').toLowerCase();
    const prefix = dir.includes('/.zcode/workspace/')
      ? 'ZCode'
      : dir.includes('/documents/qoder/')
        ? 'Qoder'
        : dir.includes('/workbuddy/')
          ? 'WorkBuddy'
          : session.agent === 'qoder-cn'
            ? 'Qoder'
            : session.agent === 'zcode'
              ? 'ZCode'
              : session.agent === 'workbuddy'
                ? 'WorkBuddy'
                : session.agent === 'hermes'
                  ? 'Hermes'
                  : session.agent === 'dsh'
                    ? 'DSH'
                : session.agent === 'agy'
                  ? 'Antigravity'
                  : session.agent === 'claude' ? 'Claude' : 'Codex';
    return `${prefix} · ${title}`;
  }
  return identityName;
}

export function isHotSession(session: RecentSession, now = new Date(), hotDays = 3): boolean {
  return Date.parse(session.lastActive) >= now.getTime() - hotDays * 24 * 60 * 60 * 1000;
}
