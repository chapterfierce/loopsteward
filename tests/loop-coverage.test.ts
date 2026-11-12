import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import {
  buildCoverageReport,
  formatCoverageReport,
  readMagpieSessionIndex,
} from '../src/loops/coverage.js';
import type { RecentSession } from '../src/loops/types.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempIndex(files: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-coverage-'));
  dirs.push(dir);
  const file = path.join(dir, 'sessions.json');
  fs.writeFileSync(file, JSON.stringify({ version: 29, files }));
  return file;
}

function session(agent: RecentSession['agent'], sessionId: string): RecentSession {
  return {
    agent,
    sessionId,
    title: sessionId,
    projectDir: 'C:\\work\\alpha',
    lastActive: '2026-11-10T10:00:00.000Z',
    messages: [],
    sourceFile: `${sessionId}.jsonl`,
  };
}

function tempZcodeDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-zcode-'));
  dirs.push(dir);
  const file = path.join(dir, 'db.sqlite');
  const req = createRequire(import.meta.url);
  const { DatabaseSync } = req('node:sqlite') as { DatabaseSync: new (file: string) => any };
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, time_archived INTEGER)');
  db.prepare('INSERT INTO session VALUES (?, ?, ?)').run('sess_side_2', 'sess_parent', null);
  db.close();
  return file;
}

function tempWorkbuddyErrorFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-workbuddy-'));
  dirs.push(dir);
  const file = path.join(dir, 'w-error.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'session-meta', sessionId: 'w-error' }),
    JSON.stringify({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '限制了吗' }],
    }),
    JSON.stringify({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: '429 使用量已超出限制' }],
      providerData: { skipRun: true },
    }),
  ].join('\n'));
  return file;
}

const now = new Date('2026-11-11T12:00:00.000Z');

describe('coverage report', () => {
  it('matches indexed sessions against local discovery and separates unsupported agents', () => {
    const workbuddyErrorPath = tempWorkbuddyErrorFile();
    const indexPath = tempIndex({
      'C:\\codex\\c1.jsonl': {
        agent: 'codex', id: 'c1', title: 'Codex 主会话', cwd: 'C:\\work\\alpha',
        last: '2026-11-10T10:00:00.000Z',
      },
      'C:\\codex\\c2.jsonl': {
        agent: 'codex', id: 'c2', title: 'Codex 分叉', cwd: 'C:\\work\\alpha',
        last: '2026-11-10T09:00:00.000Z',
      },
      'C:\\codex\\c3.jsonl': {
        agent: 'codex', id: 'c3', title: 'Codex 子代理', cwd: 'C:\\work\\alpha',
        codex_identity: { role: 'subagent' },
        last: '2026-11-10T09:30:00.000Z',
      },
      'C:\\claude\\cl1.jsonl': {
        agent: 'claude', id: 'cl1', title: 'Claude 会话', cwd: 'C:\\work\\beta',
        last: '2026-11-10T08:00:00.000Z',
      },
      'C:\\qoder\\q1.jsonl': {
        agent: 'qoder-cn', id: 'q1', title: 'Qoder 会话', cwd: 'C:\\work\\gamma',
        last: '2026-11-10T07:00:00.000Z',
      },
      'C:\\zcode\\z1': {
        agent: 'zcode', id: 'sess_subagent_1', title: 'ZCode 子代理', cwd: 'C:\\work\\zeta',
        last: '2026-11-10T06:30:00.000Z',
      },
      'C:\\zcode\\z2': {
        agent: 'zcode', id: 'sess_side_1', title: 'Selection side chat', cwd: 'C:\\work\\zeta',
        last: '2026-11-10T06:20:00.000Z',
      },
      'C:\\zcode\\z3': {
        agent: 'zcode', id: 'sess_side_2', title: '', cwd: 'C:\\work\\zeta',
        last: '2026-11-10T06:10:00.000Z',
      },
      'C:\\Users\\dev\\AppData\\Local\\hermes\\state.db#h1': {
        agent: 'hermes', title: 'Hermes 顶层', cwd: 'C:\\Users\\dev',
        last: '2026-11-10T06:00:00.000Z',
      },
      'C:\\Users\\dev\\AppData\\Local\\hermes\\state.db#h2': {
        agent: 'hermes', title: 'Hermes cron', cwd: 'C:\\Users\\dev',
        last: '2026-11-10T05:00:00.000Z',
      },
      'C:\\dsh\\d1': {
        agent: 'dsh', id: 'd1', title: 'DeepSeek Harness 1', cwd: 'C:\\work\\delta',
        last: '2026-11-10T04:00:00.000Z',
      },
      'C:\\dsh\\d2': {
        agent: 'dsh', id: 'd2', title: 'DeepSeek Harness 2', cwd: 'C:\\work\\delta',
        last: '2026-11-10T03:00:00.000Z',
      },
      'C:\\dsh\\d3': {
        agent: 'dsh', id: 'd3', title: 'DeepSeek Harness 子代理', cwd: 'C:\\work\\delta',
        dsh: { head: { parentSession: 'd1', delegationDepth: 1 } },
        last: '2026-11-10T02:30:00.000Z',
      },
      'C:\\dsh\\d4': {
        agent: 'dsh', id: 'd4', size: 320, cwd: 'C:\\work\\delta',
        dsh: { head: { delegationDepth: 0 } },
        last: '2026-11-10T02:00:00.000Z',
      },
      [workbuddyErrorPath]: {
        agent: 'workbuddy', id: 'w-error', title: '', named: '询问限制状态',
        cwd: 'C:\\work\\omega', last: '2026-11-10T05:00:00.000Z',
      },
      'C:\\old\\old': {
        agent: 'dsh', id: 'old', title: '旧会话', cwd: 'C:\\work\\delta',
        last: '2026-10-01T03:00:00.000Z',
      },
    });

    const result = buildCoverageReport({
      now,
      days: 7,
      magpieCachePath: indexPath,
      zcodeDbPath: tempZcodeDb(),
      discover: () => [
        session('codex', 'c1'),
        session('claude', 'cl1'),
        session('hermes', 'h1'),
        session('workbuddy', 'w1'),
      ],
    });

    expect(result.errors).toEqual([]);
    expect(result.magpieEntries).toBe(15);
    expect(result.magpieSessions).toBe(15);
    expect(result.localSessions).toBe(4);

    const codex = result.agents.find((row) => row.agent === 'codex')!;
    expect(codex).toMatchObject({
      magpieSessions: 3, localSessions: 1, matched: 1, missingLocal: 1, localOnly: 0,
      ignoredByPolicy: 1,
    });
    const zcode = result.agents.find((row) => row.agent === 'zcode')!;
    expect(zcode).toMatchObject({
      magpieSessions: 3, localSessions: 0, matched: 0, missingLocal: 0, ignoredByPolicy: 3,
    });
    const workbuddy = result.agents.find((row) => row.agent === 'workbuddy')!;
    expect(workbuddy).toMatchObject({
      magpieSessions: 1, localSessions: 1, matched: 0, missingLocal: 0, localOnly: 1,
      ignoredByPolicy: 1,
    });
    const hermes = result.agents.find((row) => row.agent === 'hermes')!;
    expect(hermes).toMatchObject({
      magpieSessions: 2, localSessions: 1, matched: 1, missingLocal: 0, ignoredByPolicy: 1,
      comparable: false,
    });
    const dsh = result.agents.find((row) => row.agent === 'dsh')!;
    expect(dsh).toMatchObject({
      magpieSessions: 4, localSessions: 0, matched: 0, missingLocal: 2, ignoredByPolicy: 2,
      comparable: true,
    });

    expect(result.missingLocally.map((entry) => entry.sessionId)).toEqual(['c2', 'q1', 'd1', 'd2']);
    expect(result.unsupported).toHaveLength(0);
    expect(formatCoverageReport(result)).toContain('已支持 Agent');
  });

  it('reads a missing index as an error without throwing', () => {
    const missing = path.join(os.tmpdir(), 'missing-magpie-sessions.json');
    const index = readMagpieSessionIndex(missing, Date.now());
    expect(index.entries).toEqual([]);
    expect(index.errors[0]).toContain('不存在');
  });

  it('does not report an active Codex session as missing when it is newer than now', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-coverage-active-'));
    dirs.push(dir);
    const codexRoot = path.join(dir, '.codex', 'sessions', '2026', '11', '11');
    fs.mkdirSync(codexRoot, { recursive: true });
    const codexFile = path.join(codexRoot, 'rollout-active.jsonl');
    fs.writeFileSync(codexFile, [
      JSON.stringify({
        timestamp: '2026-11-11T11:59:59.000Z',
        type: 'session_meta',
        payload: { session_id: 'codex-active', id: 'codex-active', cwd: 'C:\\work\\alpha' },
      }),
      JSON.stringify({
        timestamp: '2026-11-11T12:00:05.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '还在写' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-11-11T12:00:06.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '继续写' }],
        },
      }),
    ].join('\n'));
    fs.utimesSync(codexFile, new Date('2026-11-11T12:00:06Z'), new Date('2026-11-11T12:00:06Z'));

    const indexPath = tempIndex({
      [codexFile]: {
        agent: 'codex',
        id: 'codex-active',
        title: '活跃会话',
        cwd: 'C:\\work\\alpha',
        last: '2026-11-11T12:00:06.000Z',
      },
    });
    const result = buildCoverageReport({
      now: new Date('2026-11-11T12:00:00.000Z'),
      days: 7,
      home: dir,
      magpieCachePath: indexPath,
      zcodeDbPath: path.join(dir, 'no-zcode.sqlite'),
      hermesDbPath: path.join(dir, 'no-hermes.sqlite'),
      dshRoot: path.join(dir, 'no-dsh'),
    });

    expect(result.localSessions).toBe(1);
    expect(result.missingLocally).toEqual([]);
    expect(result.agents.find((row) => row.agent === 'codex')).toMatchObject({
      magpieSessions: 1,
      localSessions: 1,
      matched: 1,
      missingLocal: 0,
    });
  });

  it('treats Antigravity as a supported comparable agent', () => {
    const agyId = '34ac4414-ec5d-4fdf-9130-593c5a30aac6';
    const indexPath = tempIndex({
      [`C:\\Users\\Alice\\.gemini\\antigravity-cli\\brain\\${agyId}\\.system_generated\\logs\\transcript_full.jsonl`]: {
        agent: 'agy',
        title: 'Antigravity 会话',
        cwd: 'C:\\work\\theta',
        last: '2026-11-10T10:00:00.000Z',
      },
    });

    const result = buildCoverageReport({
      now,
      magpieCachePath: indexPath,
      discover: () => [session('agy', agyId)],
    });

    expect(result.unsupported).toHaveLength(0);
    expect(result.agents.find((row) => row.agent === 'agy')).toMatchObject({
      magpieSessions: 1,
      localSessions: 1,
      matched: 1,
      missingLocal: 0,
      localOnly: 0,
      comparable: true,
    });
  });

  it('filters Antigravity sessions without an assistant reply', () => {
    const validId = '34ac4414-ec5d-4fdf-9130-593c5a30aac6';
    const incomplete = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'loops-agy-')),
      'transcript_full.jsonl',
    );
    dirs.push(path.dirname(incomplete));
    fs.writeFileSync(incomplete, JSON.stringify({
      type: 'USER_INPUT',
      content: '<USER_REQUEST>只回复四个字：启动成功</USER_REQUEST>',
    }));

    const indexPath = tempIndex({
      [`C:\\Users\\Alice\\.gemini\\antigravity-cli\\brain\\${validId}\\.system_generated\\logs\\transcript_full.jsonl`]: {
        agent: 'agy',
        title: '正常会话',
        cwd: 'C:\\work\\theta',
        last: '2026-11-10T10:00:00.000Z',
      },
      [incomplete]: {
        agent: 'agy',
        title: '半截会话',
        cwd: 'C:\\work\\theta',
        last: '2026-11-10T09:00:00.000Z',
      },
    });

    const result = buildCoverageReport({
      now,
      magpieCachePath: indexPath,
      discover: () => [session('agy', validId)],
    });

    expect(result.unsupported).toHaveLength(0);
    expect(result.agents.find((row) => row.agent === 'agy')).toMatchObject({
      magpieSessions: 2,
      localSessions: 1,
      matched: 1,
      missingLocal: 0,
      ignoredByPolicy: 1,
    });
    expect(formatCoverageReport(result)).toContain('策略过滤 1');
  });
});
