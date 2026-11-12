import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { discoverRecentSessions, displayProjectName } from '../src/loops/session-source.js';

const codexFixture = fileURLToPath(new URL('./fixtures/sessions/codex.sample.jsonl', import.meta.url));
const claudeFixture = fileURLToPath(new URL('./fixtures/sessions/claude.sample.jsonl', import.meta.url));
const workbuddyFixture = fileURLToPath(new URL('./fixtures/sessions/workbuddy.sample.jsonl', import.meta.url));
const now = new Date('2026-11-11T12:00:00.000Z');
let home = '';

function writeZstdFrames(file: string, lines: string[], frameEnds: number[]): void {
  const zlib = createRequire(import.meta.url)('node:zlib') as {
    zstdCompressSync: (data: Buffer) => Buffer;
  };
  const frames: Buffer[] = [];
  let start = 0;
  for (const end of [...frameEnds, lines.length]) {
    if (end <= start) continue;
    frames.push(zlib.zstdCompressSync(Buffer.from(`${lines.slice(start, end).join('\n')}\n`)));
    start = end;
  }
  fs.writeFileSync(file, Buffer.concat(frames));
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-sessions-'));

  const codexRoot = path.join(home, '.codex', 'sessions');
  const codexDir = path.join(codexRoot, '2026', '11', '10');
  fs.mkdirSync(codexDir, { recursive: true });
  const codexFile = path.join(codexDir, 'rollout-2026-11-10T10-00-00-codex-s1.jsonl');
  fs.copyFileSync(codexFixture, codexFile);
  fs.utimesSync(codexFile, new Date('2026-11-10T10:00:00Z'), new Date('2026-11-10T10:00:00Z'));

  const oldDir = path.join(codexRoot, '2026', '10', '01');
  fs.mkdirSync(oldDir, { recursive: true });
  const oldFile = path.join(oldDir, 'rollout-old.jsonl');
  fs.copyFileSync(codexFixture, oldFile);
  fs.utimesSync(oldFile, new Date('2026-10-01T10:00:00Z'), new Date('2026-10-01T10:00:00Z'));

  const claudeDir = path.join(home, '.claude', 'projects', 'C--work-beta');
  fs.mkdirSync(claudeDir, { recursive: true });
  const claudeFile = path.join(claudeDir, 'claude-s1.jsonl');
  fs.copyFileSync(claudeFixture, claudeFile);
  fs.utimesSync(claudeFile, new Date('2026-11-09T10:01:00Z'), new Date('2026-11-09T10:01:00Z'));

  const coworkRoot = path.join(
    home,
    'AppData',
    'Local',
    'Claude-3p',
    'local-agent-mode-sessions',
  );
  const coworkWorkspace = path.join(coworkRoot, 'account-1', '00000000');
  const coworkSessionDir = path.join(coworkWorkspace, 'deadbeef');
  const coworkTranscriptDir = path.join(coworkSessionDir, '.claude', 'projects', 'session');
  fs.mkdirSync(coworkTranscriptDir, { recursive: true });
  const coworkFile = path.join(coworkTranscriptDir, 'claude-cowork-s1.jsonl');
  fs.copyFileSync(claudeFixture, coworkFile);
  fs.utimesSync(coworkFile, new Date('2026-11-09T10:01:00Z'), new Date('2026-11-09T10:01:00Z'));
  fs.writeFileSync(
    path.join(coworkWorkspace, 'local_deadbeef-1111-2222-3333-444455556666.json'),
    JSON.stringify({
      sessionId: 'local_deadbeef-1111-2222-3333-444455556666',
      cliSessionId: 'claude-cowork-s1',
      title: 'Cowork 迁移',
      userSelectedFolders: ['C:\\work\\omega'],
      lastActivityAt: Date.parse('2026-11-09T10:03:00Z'),
      isArchived: false,
    }),
  );
  fs.writeFileSync(
    path.join(coworkWorkspace, 'local_cafebabe-1111-2222-3333-444455556666.json'),
    JSON.stringify({
      sessionId: 'local_cafebabe-1111-2222-3333-444455556666',
      cliSessionId: 'claude-cowork-s2',
      title: '没有项目上下文的闲聊',
      userSelectedFolders: [],
      lastActivityAt: Date.parse('2026-11-09T10:04:00Z'),
      isArchived: false,
    }),
  );
  const chattyDir = path.join(coworkWorkspace, 'cafebabe', '.claude', 'projects', 'session');
  fs.mkdirSync(chattyDir, { recursive: true });
  fs.copyFileSync(claudeFixture, path.join(chattyDir, 'claude-cowork-s2.jsonl'));

  const qoderDb = path.join(home, 'qoder', 'main.sqlite');
  fs.mkdirSync(path.dirname(qoderDb), { recursive: true });
  const req = createRequire(import.meta.url);
  const { DatabaseSync } = req('node:sqlite') as { DatabaseSync: new (file: string) => any };
  const db = new DatabaseSync(qoderDb);
  db.exec(`
    CREATE TABLE chat_sessions (
      session_id TEXT PRIMARY KEY, title TEXT, cwd TEXT, updated_at INTEGER,
      archived INTEGER, deleted_at TEXT
    );
    CREATE TABLE chat_session_messages (
      session_id TEXT, message_id TEXT, sequence INTEGER, role TEXT,
      payload_json TEXT, created_at INTEGER
    );
  `);
  db.prepare('INSERT INTO chat_sessions VALUES (?, ?, ?, ?, ?, ?)').run(
    'qoder-s1',
    'Qoder work',
    'C:\\work\\gamma',
    Date.parse('2026-11-10T09:00:00Z'),
    0,
    null,
  );
  const insertMessage = db.prepare(
    'INSERT INTO chat_session_messages VALUES (?, ?, ?, ?, ?, ?)',
  );
  insertMessage.run(
    'qoder-s1',
    'q-m1',
    1,
    'user',
    JSON.stringify({ parts: [{ type: 'text', text: '还有设置页没接' }] }),
    Date.parse('2026-11-10T09:00:01Z'),
  );
  insertMessage.run(
    'qoder-s1',
    'q-m2',
    2,
    'assistant',
    JSON.stringify({ parts: [{ type: 'text', text: '设置页下一步接保存按钮。' }, { type: 'tool_call', text: 'ignored' }] }),
    Date.parse('2026-11-10T09:00:02Z'),
  );
  db.close();

  const agyRoot = path.join(home, '.gemini', 'antigravity-cli', 'brain');
  const agySessionId = 'agy-s1';
  const agyLogs = path.join(agyRoot, agySessionId, '.system_generated', 'logs');
  fs.mkdirSync(agyLogs, { recursive: true });
  const agyFile = path.join(agyLogs, 'transcript_full.jsonl');
  fs.copyFileSync(
    fileURLToPath(new URL('./fixtures/sessions/agy.sample.jsonl', import.meta.url)),
    agyFile,
  );
  fs.utimesSync(agyFile, new Date('2026-11-10T09:30:02Z'), new Date('2026-11-10T09:30:02Z'));
  const agyDbPath = path.join(home, '.gemini', 'antigravity-cli', 'conversation_summaries.db');
  const agyDb = new DatabaseSync(agyDbPath);
  agyDb.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      preview TEXT NOT NULL DEFAULT '',
      step_count INTEGER NOT NULL DEFAULT 0,
      last_modified_time DATETIME NOT NULL,
      workspace_uris TEXT NOT NULL,
      parent_conversation_id TEXT NOT NULL DEFAULT '',
      nesting_depth INTEGER NOT NULL DEFAULT 0
    );
  `);
  const insertAgy = agyDb.prepare(
    'INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  insertAgy.run(
    agySessionId,
    '',
    'Antigravity 还差发布脚本',
    3,
    '2026-11-10 09:30:02+00:00',
    JSON.stringify(['file:///C:/work/theta']),
    '',
    0,
  );
  insertAgy.run(
    'agy-child',
    'Antigravity 子会话',
    '子会话不应进入回访',
    2,
    '2026-11-10 09:31:00+00:00',
    JSON.stringify(['file:///C:/work/theta']),
    agySessionId,
    1,
  );
  agyDb.close();

  const workbuddyDir = path.join(home, '.workbuddy', 'projects', 'c-work-delta');
  fs.mkdirSync(workbuddyDir, { recursive: true });
  const workbuddyFile = path.join(workbuddyDir, 'wb-s1.jsonl');
  fs.copyFileSync(workbuddyFixture, workbuddyFile);
  fs.utimesSync(workbuddyFile, new Date('2026-11-10T11:00:00Z'), new Date('2026-11-10T11:00:00Z'));

  const dshDir = path.join(
    home,
    '.dsh',
    'sessions',
    '--C-work-eta--',
    'session-dsh-1',
  );
  fs.mkdirSync(dshDir, { recursive: true });
  const dshFile = path.join(dshDir, 'session.v4.jsonl.zstd');
  writeZstdFrames(dshFile, [
    JSON.stringify({
      type: 'session',
      id: 'session-dsh-1',
      cwd: 'C:\\work\\eta',
      delegationDepth: 0,
    }),
    JSON.stringify({
      type: 'session/title',
      data: { title: 'DSH 迁移' },
    }),
    JSON.stringify({
      type: 'user/message',
      time: Date.parse('2026-11-10T12:00:00Z'),
      data: {
        id: 'dsh-goal-1',
        content: [{ type: 'text', text: '<goal_round>\nObjective: "把 DSH 会话接进回访"\nRound: 1/8\nContinue.' }],
        source: { kind: 'goal' },
      },
    }),
    JSON.stringify({
      type: 'user/message',
      time: Date.parse('2026-11-10T12:00:01Z'),
      data: {
        id: 'dsh-user-1',
        content: [{ type: 'text', text: 'DSH 还差迁移脚本' }],
        source: { kind: 'user' },
      },
    }),
    JSON.stringify({
      type: 'assistant/message',
      time: Date.parse('2026-11-10T12:00:02Z'),
      data: {
        id: 'dsh-assistant-1',
        message: {
          id: 'dsh-assistant-message-1',
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'ignore me' },
            { type: 'text', text: '下一步补迁移脚本，先处理多帧 zstd。' },
          ],
        },
      },
    }),
    JSON.stringify({
      type: 'user/message',
      time: Date.parse('2026-11-10T12:00:03Z'),
      data: {
        id: 'dsh-goal-2',
        content: [{ type: 'text', text: '<goal_round>\nObjective: "把 DSH 会话接进回访"\nRound: 2/8\nContinue.' }],
        source: { kind: 'goal' },
      },
    }),
    JSON.stringify({
      type: 'user/message',
      time: Date.parse('2026-11-10T12:00:04Z'),
      data: {
        id: 'dsh-time-1',
        content: [{ type: 'text', text: 'Time sampled while preparing turn 1.' }],
        source: { kind: 'time-context' },
      },
    }),
  ], [2, 4]);
  fs.utimesSync(dshFile, new Date('2026-11-10T12:00:05Z'), new Date('2026-11-10T12:00:05Z'));

  const dshChildDir = path.join(
    home,
    '.dsh',
    'sessions',
    '--C-work-eta--',
    'session-dsh-child',
  );
  fs.mkdirSync(dshChildDir, { recursive: true });
  const dshChildFile = path.join(dshChildDir, 'session.v4.jsonl.zstd');
  writeZstdFrames(dshChildFile, [
    JSON.stringify({
      type: 'session',
      id: 'session-dsh-child',
      cwd: 'C:\\work\\eta',
      parentSession: 'session-dsh-1',
      delegationDepth: 1,
    }),
    JSON.stringify({
      type: 'user/message',
      time: Date.parse('2026-11-10T12:01:00Z'),
      data: {
        id: 'dsh-child-user',
        content: [{ type: 'text', text: '子代理任务' }],
        source: { kind: 'user' },
      },
    }),
    JSON.stringify({
      type: 'assistant/message',
      time: Date.parse('2026-11-10T12:01:01Z'),
      data: {
        id: 'dsh-child-assistant',
        message: {
          id: 'dsh-child-message',
          role: 'assistant',
          content: [{ type: 'text', text: '子代理结果' }],
        },
      },
    }),
  ], [1]);
  fs.utimesSync(dshChildFile, new Date('2026-11-10T12:01:01Z'), new Date('2026-11-10T12:01:01Z'));

  const hermesDb = path.join(home, 'AppData', 'Local', 'hermes', 'state.db');
  fs.mkdirSync(path.dirname(hermesDb), { recursive: true });
  const hdb = new DatabaseSync(hermesDb);
  hdb.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, source TEXT, title TEXT, cwd TEXT, started_at REAL,
      last_activity_at REAL, parent_session_id TEXT, archived INTEGER, hidden INTEGER,
      message_count INTEGER
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY, message_uid TEXT, session_id TEXT, role TEXT,
      content TEXT, timestamp REAL
    );
  `);
  const insertHermesSession = hdb.prepare(
    'INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  insertHermesSession.run(
    'hermes-s1',
    'local',
    'Hermes 迁移',
    'C:\\work\\zeta',
    Date.parse('2026-11-10T12:00:00Z') / 1000,
    Date.parse('2026-11-10T12:01:00Z') / 1000,
    null,
    0,
    0,
    2,
  );
  insertHermesSession.run(
    'hermes-cron',
    'cron',
    '后台任务',
    'C:\\work\\zeta',
    Date.parse('2026-11-10T12:00:00Z') / 1000,
    Date.parse('2026-11-10T12:01:00Z') / 1000,
    null,
    0,
    0,
    2,
  );
  insertHermesSession.run(
    'hermes-s2',
    'local',
    'Hermes 家庭目录会话',
    home,
    Date.parse('2026-11-10T12:02:00Z') / 1000,
    Date.parse('2026-11-10T12:03:00Z') / 1000,
    null,
    0,
    0,
    2,
  );
  insertHermesSession.run(
    'hermes-subagent',
    'subagent',
    '子代理',
    'C:\\work\\zeta',
    Date.parse('2026-11-10T12:00:00Z') / 1000,
    Date.parse('2026-11-10T12:01:00Z') / 1000,
    'hermes-s1',
    0,
    0,
    2,
  );
  const insertHermesMessage = hdb.prepare(
    'INSERT INTO messages (id, message_uid, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
  );
  insertHermesMessage.run(
    1,
    'hermes-m1',
    'hermes-s1',
    'user',
    'Hermes 还差迁移脚本',
    Date.parse('2026-11-10T12:00:01Z') / 1000,
  );
  insertHermesMessage.run(
    2,
    'hermes-m2',
    'hermes-s1',
    'assistant',
    '下一步补迁移脚本。',
    Date.parse('2026-11-10T12:00:02Z') / 1000,
  );
  insertHermesMessage.run(
    3,
    'hermes-cron-m1',
    'hermes-cron',
    'user',
    '后台任务不应进入回访',
    Date.parse('2026-11-10T12:00:03Z') / 1000,
  );
  insertHermesMessage.run(
    4,
    'hermes-cron-m2',
    'hermes-cron',
    'assistant',
    '这条也不应进入回访。',
    Date.parse('2026-11-10T12:00:04Z') / 1000,
  );
  insertHermesMessage.run(
    5,
    'hermes-s2-m1',
    'hermes-s2',
    'user',
    '家庭目录里的会话也要保留',
    Date.parse('2026-11-10T12:02:01Z') / 1000,
  );
  insertHermesMessage.run(
    6,
    'hermes-s2-m2',
    'hermes-s2',
    'assistant',
    '会拆成独立临时工作区。',
    Date.parse('2026-11-10T12:02:02Z') / 1000,
  );
  hdb.close();

  const zcodeDb = path.join(home, '.zcode', 'cli', 'db', 'db.sqlite');
  fs.mkdirSync(path.dirname(zcodeDb), { recursive: true });
  const zdb = new DatabaseSync(zcodeDb);
  zdb.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, directory TEXT,
      time_created INTEGER, time_updated INTEGER, time_archived INTEGER
    );
    CREATE TABLE message (
      id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER,
      data TEXT, sequence INTEGER
    );
    CREATE TABLE part (
      id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER,
      time_updated INTEGER, data TEXT, sequence INTEGER
    );
  `);
  const insertZSession = zdb.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?)');
  insertZSession.run(
    'sess_z1',
    null,
    'ZCode 会话',
    'C:\\work\\epsilon',
    Date.parse('2026-11-10T08:00:00Z'),
    Date.parse('2026-11-10T08:05:00Z'),
    null,
  );
  insertZSession.run(
    'sess_subagent_z1',
    'sess_z1',
    '子代理',
    'C:\\work\\epsilon',
    Date.parse('2026-11-10T08:01:00Z'),
    Date.parse('2026-11-10T08:04:00Z'),
    null,
  );
  insertZSession.run(
    'sess_old',
    null,
    '旧会话',
    'C:\\work\\epsilon',
    Date.parse('2026-10-01T08:00:00Z'),
    Date.parse('2026-10-01T08:05:00Z'),
    null,
  );
  const insertZMessage = zdb.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?, ?)');
  const insertZPart = zdb.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?, ?)');
  insertZMessage.run('z-m1', 'sess_z1', 1794300100000, 1794300100000, '{"role":"user"}', 1);
  insertZPart.run('z-p1', 'z-m1', 'sess_z1', 1794300100000, 1794300100000, '{"type":"text","text":"导出还差 Excel"}', 1);
  insertZMessage.run('z-m2', 'sess_z1', 1794300101000, 1794300101000, '{"role":"assistant"}', 2);
  insertZPart.run('z-p2', 'z-m2', 'sess_z1', 1794300101000, 1794300101000, '{"type":"reasoning","text":"ignore"}', 1);
  insertZPart.run('z-p3', 'z-m2', 'sess_z1', 1794300101000, 1794300101000, '{"type":"text","text":"Excel 导出下一步补表头。"}', 2);
  zdb.close();
});

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('discoverRecentSessions', () => {
  it('discovers recent sessions from all supported sources with normalized messages', () => {
    const sessions = discoverRecentSessions({
      home,
      days: 7,
      maxSessions: 10,
      now,
      qoderDbPath: path.join(home, 'qoder', 'main.sqlite'),
      claudeDesktopRoot: path.join(
        home,
        'AppData',
        'Local',
        'Claude-3p',
        'local-agent-mode-sessions',
      ),
    });

    expect(sessions).toHaveLength(10);
    expect(sessions.map((session) => session.agent).sort()).toEqual([
      'agy',
      'claude',
      'claude',
      'codex',
      'dsh',
      'hermes',
      'hermes',
      'qoder-cn',
      'workbuddy',
      'zcode',
    ]);

    const codex = sessions.find((session) => session.agent === 'codex')!;
    expect(codex.projectDir).toBe('C:\\work\\alpha');
    expect(codex.title).toBe('登录页还差错误提示没做');
    expect(codex.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(codex.messages[0].text).toContain('错误提示');
    expect(codex.messages[1].text).toContain('接下来补');

    const claude = sessions.find((session) => session.sessionId === 'claude-s1')!;
    expect(claude.projectDir).toBe('C:\\work\\beta');
    expect(claude.messages).toHaveLength(2);
    expect(claude.messages[0].text).toBe('继续做导出');
    expect(claude.messages[1].text).toContain('CSV 编码');

    const cowork = sessions.find((session) => session.title === 'Cowork 迁移')!;
    expect(cowork.agent).toBe('claude');
    expect(cowork.projectDir).toBe('C:\\work\\omega');
    expect(cowork.lastActive).toBe('2026-11-09T10:03:00.000Z');
    expect(cowork.messages[0].text).toBe('继续做导出');
    expect(sessions.some((session) => session.title === '没有项目上下文的闲聊')).toBe(false);

    const qoder = sessions.find((session) => session.agent === 'qoder-cn')!;
    expect(qoder.projectDir).toBe('C:\\work\\gamma');
    expect(qoder.title).toBe('Qoder work');
    expect(qoder.messages[0].text).toBe('还有设置页没接');
    expect(qoder.messages[1].text).toBe('设置页下一步接保存按钮。');

    const agy = sessions.find((session) => session.agent === 'agy')!;
    expect(agy.sessionId).toBe('agy-s1');
    expect(agy.projectDir).toBe('C:\\work\\theta');
    expect(agy.title).toBe('Antigravity 还差发布脚本');
    expect(agy.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(agy.messages[0].text).toBe('Antigravity 还差发布脚本');
    expect(agy.messages[1].text).toBe('下一步补发布脚本并验证安装包。');
    expect(sessions.some((session) => session.sessionId === 'agy-child')).toBe(false);

    const hermes = sessions.find((session) => session.sessionId === 'hermes-s1')!;
    expect(hermes.sessionId).toBe('hermes-s1');
    expect(hermes.projectDir).toBe('C:\\work\\zeta');
    expect(hermes.title).toBe('Hermes 迁移');
    expect(hermes.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(hermes.messages[0].text).toBe('Hermes 还差迁移脚本');
    expect(hermes.messages[1].text).toBe('下一步补迁移脚本。');

    const hermesHome = sessions.find((session) => session.sessionId === 'hermes-s2')!;
    expect(hermesHome.projectDir).toBe(path.join(home, '.hermes-sessions', 'hermes-s2'));

    const dsh = sessions.find((session) => session.agent === 'dsh')!;
    expect(dsh.sessionId).toBe('session-dsh-1');
    expect(dsh.projectDir).toBe('C:\\work\\eta');
    expect(dsh.title).toBe('DSH 迁移');
    expect(dsh.messages.map((message) => message.role)).toEqual(['user', 'user', 'assistant']);
    expect(dsh.messages[0].text).toBe('把 DSH 会话接进回访');
    expect(dsh.messages[1].text).toBe('DSH 还差迁移脚本');
    expect(dsh.messages[2].text).toBe('下一步补迁移脚本，先处理多帧 zstd。');
    expect(sessions.some((session) => session.sessionId === 'session-dsh-child')).toBe(false);

    const workbuddy = sessions.find((session) => session.agent === 'workbuddy')!;
    expect(workbuddy.projectDir).toBe('C:\\work\\delta');
    expect(workbuddy.title).toBe('WorkBuddy 离线导出');
    expect(workbuddy.messages).toHaveLength(2);
    expect(workbuddy.messages[0].text).toBe('继续做离线导出');
    expect(workbuddy.messages[1].text).toBe('离线导出还差失败重试没做。');

    const zcode = sessions.find((session) => session.agent === 'zcode')!;
    expect(zcode.projectDir).toBe('C:\\work\\epsilon');
    expect(zcode.title).toBe('ZCode 会话');
    expect(zcode.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(zcode.messages[0].text).toBe('导出还差 Excel');
    expect(zcode.messages[1].text).toBe('Excel 导出下一步补表头。');
  });

  it('uses the session title for timestamp-only WorkBuddy workspaces', () => {
    expect(displayProjectName('2026-11-07-19-09-00', {
      agent: 'workbuddy',
      sessionId: 'wb-s2',
      title: '离线导出失败重试',
      projectDir: 'c:\\Users\\dev\\WorkBuddy\\2026-11-07-19-09-00',
      lastActive: '2026-11-10T11:00:00.000Z',
      messages: [],
      sourceFile: 'wb-s2.jsonl',
    })).toBe('WorkBuddy · 离线导出失败重试');
  });

  it('labels Hermes sessions running in the home directory by title', () => {
    expect(displayProjectName('Alice', {
      agent: 'hermes',
      sessionId: 'hermes-s2',
      title: '排查 Magpie 路由错误',
      projectDir: 'C:\\Users\\Alice',
      lastActive: '2026-11-10T11:00:00.000Z',
      messages: [],
      sourceFile: 'hermes-s2',
    }, 'C:\\Users\\Alice')).toBe('Hermes · 排查 Magpie 路由错误');
  });

  it('labels DSH sessions running in the home directory by title', () => {
    expect(displayProjectName('session-dsh-home', {
      agent: 'dsh',
      sessionId: 'session-dsh-home',
      title: '排查 zstd 多帧',
      projectDir: 'C:\\Users\\Alice\\.dsh-sessions\\session-dsh-home',
      lastActive: '2026-11-10T11:00:00.000Z',
      messages: [],
      sourceFile: 'session.v4.jsonl.zstd',
    }, 'C:\\Users\\Alice')).toBe('DSH · 排查 zstd 多帧');
  });

  it('labels Antigravity sessions in scratch workspaces by title', () => {
    expect(displayProjectName('temp', {
      agent: 'agy',
      sessionId: 'agy-s2',
      title: '用一句话说明你是什么模型',
      projectDir: 'C:\\Users\\Alice\\workspace\\conv_abc\\temp',
      lastActive: '2026-11-10T11:00:00.000Z',
      messages: [],
      sourceFile: 'transcript_full.jsonl',
    }, 'C:\\Users\\Alice')).toBe('Antigravity · 用一句话说明你是什么模型');
  });

  it('strips XML wrappers from display names', () => {
    expect(displayProjectName('2026-11-07-19-09-00', {
      agent: 'workbuddy',
      sessionId: 'wb-s3',
      title: '<user_query>帮我看下离线导出</user_query>',
      projectDir: 'c:\\Users\\dev\\WorkBuddy\\2026-11-07-19-09-00',
      lastActive: '2026-11-10T11:00:00.000Z',
      messages: [],
      sourceFile: 'wb-s3.jsonl',
    })).toBe('WorkBuddy · 帮我看下离线导出');
  });

  it('does not turn punctuation-only titles into project names', () => {
    expect(displayProjectName('2026-11-07-19-09-00', {
      agent: 'workbuddy',
      sessionId: 'wb-s4',
      title: '<user_query>？</user_query>',
      projectDir: 'c:\\Users\\dev\\WorkBuddy\\2026-11-07-19-09-00',
      lastActive: '2026-11-10T11:00:00.000Z',
      messages: [],
      sourceFile: 'wb-s4.jsonl',
    })).toBe('WorkBuddy · 未命名会话');
  });

  it('falls back to user intent when an agent title is an assistant reply', () => {
    expect(displayProjectName('draft-5db1d25c-0dc1-4fc5-8322-c8b74110b140', {
      agent: 'zcode',
      sessionId: 'zcode-s6',
      title: '你指的是哪个插件？我无法直接操作你的电脑，但可以指导你启用',
      projectDir: 'C:\\Users\\Alice\\.zcode\\workspace\\draft-5db1d25c-0dc1-4fc5-8322-c8b74110b140',
      lastActive: '2026-11-10T11:00:00.000Z',
      messages: [
        {
          id: 'm1',
          role: 'user',
          text: '# Environment\nYou have been invoked in the following environment:',
          timestamp: '2026-11-10T10:59:00.000Z',
        },
        {
          id: 'm2',
          role: 'user',
          text: 'VSCode 中的这个插件怎么启用？',
          timestamp: '2026-11-10T11:00:00.000Z',
        },
      ],
      sourceFile: 'zcode-s6',
    })).toBe('ZCode · VSCode 中的这个插件怎么启用？');
  });

  it('uses a real user request when a placeholder title has one', () => {
    expect(displayProjectName('2026-11-07-19-09-00', {
      agent: 'workbuddy',
      sessionId: 'wb-s5',
      title: '未命名会话',
      projectDir: 'c:\\Users\\dev\\WorkBuddy\\2026-11-07-19-09-00',
      lastActive: '2026-11-10T11:00:00.000Z',
      messages: [{
        id: 'm1',
        role: 'user',
        text: '帮我看下离线导出',
        timestamp: '2026-11-10T11:00:00.000Z',
      }],
      sourceFile: 'wb-s5',
    })).toBe('WorkBuddy · 帮我看下离线导出');
  });

  it('shortens a long fallback title at a word boundary', () => {
    expect(displayProjectName('draft-5db1d25c-0dc1-4fc5-8322-c8b74110b140', {
      agent: 'zcode',
      sessionId: 'zcode-s7',
      title: '我没有看到你贴出的配置文件内容，也无法直接读取你本地的 magpie 网关。',
      projectDir: 'C:\\Users\\Alice\\.zcode\\workspace\\draft-5db1d25c-0dc1-4fc5-8322-c8b74110b140',
      lastActive: '2026-11-10T11:00:00.000Z',
      messages: [{
        id: 'm1',
        role: 'user',
        text: '能把本地easyclaw agent 接到magpie吗',
        timestamp: '2026-11-10T11:00:00.000Z',
      }],
      sourceFile: 'zcode-s7',
    })).toBe('ZCode · 能把本地easyclaw agent');
  });

  it('keeps a concise multi-word agent title intact', () => {
    expect(displayProjectName('draft-5a70f268-cadf-4929-bc47-0cc1710db469', {
      agent: 'zcode',
      sessionId: 'zcode-s8',
      title: 'Claude Code 配置修改与 Magpie 代理网关兼容性',
      projectDir: 'C:\\Users\\Alice\\.zcode\\workspace\\draft-5a70f268-cadf-4929-bc47-0cc1710db469',
      lastActive: '2026-11-10T11:00:00.000Z',
      messages: [],
      sourceFile: 'zcode-s8',
    })).toBe('ZCode · Claude Code 配置修改与 Magpie 代理网关兼容性');
  });

  it('labels a Claude session that runs inside a scratch workspace by its directory', () => {
    expect(displayProjectName('draft-3600ade2-9c2c-40be-9dba-de88cddc7563', {
      agent: 'claude',
      sessionId: 'claude-s5',
      title: 'z code 任务接手',
      projectDir: 'C:\\Users\\dev\\.zcode\\workspace\\draft-3600ade2-9c2c-40be-9dba-de88cddc7563',
      lastActive: '2026-11-10T11:00:00.000Z',
      messages: [],
      sourceFile: 'claude-s5.jsonl',
    })).toBe('ZCode · z code 任务接手');
  });

  it('excludes sessions older than the window and caps the result', () => {
    const sessions = discoverRecentSessions({
      home,
      days: 7,
      maxSessions: 2,
      now,
      qoderDbPath: path.join(home, 'qoder', 'main.sqlite'),
      claudeDesktopRoot: path.join(
        home,
        'AppData',
        'Local',
        'Claude-3p',
        'local-agent-mode-sessions',
      ),
    });
    expect(sessions).toHaveLength(2);
    expect(sessions.every((session) => session.sessionId !== 'old')).toBe(true);
  });

  it('ignores Codex child threads that point at a parent thread', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-codex-fork-'));
    try {
      const codexRoot = path.join(dir, 'sessions');
      fs.mkdirSync(codexRoot, { recursive: true });
      const message = (role: string, text: string) => JSON.stringify({
        timestamp: '2026-11-10T10:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role,
          content: [{ type: 'input_text', text }],
        },
      });
      const meta = (id: string, parent?: string) => JSON.stringify({
        timestamp: '2026-11-10T10:00:00.000Z',
        type: 'session_meta',
        payload: {
          session_id: parent ?? id,
          id,
          ...(parent ? { parent_thread_id: parent } : {}),
          cwd: 'C:\\work\\alpha',
        },
      });

      const parentFile = path.join(codexRoot, 'rollout-parent.jsonl');
      fs.writeFileSync(parentFile, [
        meta('parent-1'),
        message('user', '还差登录提示'),
        message('assistant', '下一步补。'),
      ].join('\n'));
      const childFile = path.join(codexRoot, 'rollout-child.jsonl');
      fs.writeFileSync(childFile, [
        meta('child-1', 'parent-1'),
        message('user', '子代理任务'),
        message('assistant', '子代理结果。'),
      ].join('\n'));
      fs.utimesSync(parentFile, new Date('2026-11-10T10:00:00Z'), new Date('2026-11-10T10:00:00Z'));
      fs.utimesSync(childFile, new Date('2026-11-10T10:00:00Z'), new Date('2026-11-10T10:00:00Z'));

      const sessions = discoverRecentSessions({
        home: dir,
        days: 7,
        now,
        codexRoot,
        claudeRoot: path.join(dir, 'no-claude'),
        claudeDesktopRoot: path.join(dir, 'no-cowork'),
        qoderDbPath: path.join(dir, 'no-qoder.sqlite'),
        zcodeDbPath: path.join(dir, 'no-zcode.sqlite'),
        workbuddyRoot: path.join(dir, 'no-workbuddy'),
        hermesDbPath: path.join(dir, 'no-hermes.sqlite'),
      });

      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionId).toBe('parent-1');
      expect(sessions[0].messages[0].text).toBe('还差登录提示');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('merges Codex rollouts and keeps the main title when a side chat is longer', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-codex-side-chat-'));
    try {
      const codexRoot = path.join(dir, 'sessions');
      fs.mkdirSync(codexRoot, { recursive: true });
      const message = (role: string, text: string, timestamp: string) => JSON.stringify({
        timestamp,
        type: 'response_item',
        payload: {
          type: 'message',
          role,
          content: [{ type: 'input_text', text }],
        },
      });
      const meta = (id: string, timestamp: string, historyBase?: string) => JSON.stringify({
        timestamp,
        type: 'session_meta',
        payload: {
          session_id: id,
          id,
          cwd: 'C:\\work\\alpha',
          timestamp,
          ...(historyBase ? { history_base: { thread_id: historyBase } } : {}),
        },
      });

      const parentFile = path.join(codexRoot, 'rollout-parent.jsonl');
      fs.writeFileSync(parentFile, [
        meta('thread-1', '2026-11-10T10:00:00.000Z'),
        message('user', '主会话还差登录提示', '2026-11-10T10:00:01.000Z'),
        message('assistant', '下一步补登录提示。', '2026-11-10T10:00:02.000Z'),
      ].join('\n'));
      const sideFile = path.join(codexRoot, 'rollout-parent_side-a.jsonl');
      fs.writeFileSync(sideFile, [
        meta('thread-1', '2026-11-10T10:05:00.000Z', 'thread-1'),
        message('user', '侧聊结论：先做 A', '2026-11-10T10:05:01.000Z'),
        message('assistant', '收到，先做 A。', '2026-11-10T10:05:02.000Z'),
        message('user', '侧聊补充：接口先留旧版', '2026-11-10T10:05:03.000Z'),
        message('assistant', '已记下兼容旧版。', '2026-11-10T10:05:04.000Z'),
        message('user', '侧聊再补充：周五前完成', '2026-11-10T10:05:05.000Z'),
        message('assistant', '周五前完成。', '2026-11-10T10:05:06.000Z'),
      ].join('\n'));
      const nestedFile = path.join(codexRoot, 'rollout-parent_side-b.jsonl');
      fs.writeFileSync(nestedFile, [
        meta('thread-1', '2026-11-10T10:06:00.000Z', 'side-a'),
        message('user', '侧聊追问：B 呢', '2026-11-10T10:06:01.000Z'),
        message('assistant', 'B 也记下了。', '2026-11-10T10:06:02.000Z'),
      ].join('\n'));
      const activeAt = new Date('2026-11-10T10:06:02Z');
      for (const file of [parentFile, sideFile, nestedFile]) {
        fs.utimesSync(file, activeAt, activeAt);
      }

      const sessions = discoverRecentSessions({
        home: dir,
        days: 7,
        now,
        codexRoot,
        claudeRoot: path.join(dir, 'no-claude'),
        claudeDesktopRoot: path.join(dir, 'no-cowork'),
        qoderDbPath: path.join(dir, 'no-qoder.sqlite'),
        zcodeDbPath: path.join(dir, 'no-zcode.sqlite'),
        workbuddyRoot: path.join(dir, 'no-workbuddy'),
        hermesDbPath: path.join(dir, 'no-hermes.sqlite'),
      });

      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionId).toBe('thread-1');
      expect(sessions[0].title).toBe('主会话还差登录提示');
      expect(sessions[0].lastActive).toBe('2026-11-10T10:06:02.000Z');
      expect(sessions[0].messages.map((entry) => entry.text)).toEqual([
        '主会话还差登录提示',
        '下一步补登录提示。',
        '侧聊结论：先做 A',
        '收到，先做 A。',
        '侧聊补充：接口先留旧版',
        '已记下兼容旧版。',
        '侧聊再补充：周五前完成',
        '周五前完成。',
        '侧聊追问：B 呢',
        'B 也记下了。',
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps older Codex messages available for reconcile evidence', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-codex-history-'));
    try {
      const codexRoot = path.join(dir, 'sessions');
      fs.mkdirSync(codexRoot, { recursive: true });
      const message = (role: string, text: string, timestamp: string) => JSON.stringify({
        timestamp,
        type: 'response_item',
        payload: {
          type: 'message',
          role,
          content: [{ type: 'input_text', text }],
        },
      });
      const at = (second: number) => new Date(
        Date.UTC(2026, 10, 11, 8, 0, second),
      ).toISOString();
      const entries = [
        JSON.stringify({
          timestamp: at(0),
          type: 'session_meta',
          payload: {
            session_id: 'codex-long',
            id: 'codex-long',
            cwd: 'C:\\work\\alpha',
          },
        }),
        message('user', '起点：真实反馈仍为 0', at(1)),
        ...Array.from({ length: 30 }, (_, index) => message(
          'assistant',
          `继续推进第 ${index + 1} 步`,
          at(index + 2),
        )),
      ];
      const file = path.join(codexRoot, 'rollout-long.jsonl');
      fs.writeFileSync(file, entries.join('\n'));
      fs.utimesSync(file, new Date(at(31)), new Date(at(31)));

      const sessions = discoverRecentSessions({
        home: dir,
        days: 7,
        now,
        codexRoot,
        claudeRoot: path.join(dir, 'no-claude'),
        claudeDesktopRoot: path.join(dir, 'no-cowork'),
        qoderDbPath: path.join(dir, 'no-qoder.sqlite'),
        zcodeDbPath: path.join(dir, 'no-zcode.sqlite'),
        workbuddyRoot: path.join(dir, 'no-workbuddy'),
        hermesDbPath: path.join(dir, 'no-hermes.sqlite'),
      });

      const session = sessions.find((entry) => entry.sessionId === 'codex-long');
      expect(session).toBeDefined();
      expect(session?.messages).toHaveLength(20);
      expect(session?.messages.some((entry) => entry.text.includes('真实反馈仍为 0'))).toBe(false);
      expect(session?.history?.some((entry) => entry.text.includes('真实反馈仍为 0'))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps deep history for every other agent without slowing normal discovery', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-all-history-'));
    const req = createRequire(import.meta.url);
    const { DatabaseSync } = req('node:sqlite') as {
      DatabaseSync: new (file: string) => any;
    };
    const messageCount = 120;
    const early = '早期状态：导出已按 5 条写入';
    const at = (second: number) => new Date(
      Date.UTC(2026, 10, 10, 8, 0, second),
    ).toISOString();
    const textAt = (index: number) => (index === 0 ? early : `后续进度 ${index}`);
    const roleAt = (index: number) => (index % 2 === 0 ? 'user' : 'assistant');

    try {
      const qoderDb = path.join(dir, 'qoder.sqlite');
      const qdb = new DatabaseSync(qoderDb);
      qdb.exec(`
        CREATE TABLE chat_sessions (
          session_id TEXT PRIMARY KEY, title TEXT, cwd TEXT, updated_at INTEGER,
          archived INTEGER, deleted_at TEXT
        );
        CREATE TABLE chat_session_messages (
          session_id TEXT, message_id TEXT, sequence INTEGER, role TEXT,
          payload_json TEXT, created_at INTEGER
        );
      `);
      qdb.prepare('INSERT INTO chat_sessions VALUES (?, ?, ?, ?, ?, ?)').run(
        'qoder-long',
        'Qoder 长会话',
        'C:\\work\\qoder',
        Date.parse(at(messageCount - 1)),
        0,
        null,
      );
      const qInsert = qdb.prepare(
        'INSERT INTO chat_session_messages VALUES (?, ?, ?, ?, ?, ?)',
      );
      for (let index = 0; index < messageCount; index += 1) {
        qInsert.run(
          'qoder-long',
          `q-m${index}`,
          index + 1,
          roleAt(index),
          JSON.stringify({ parts: [{ type: 'text', text: textAt(index) }] }),
          Date.parse(at(index)),
        );
      }
      qdb.close();

      const zcodeDb = path.join(dir, 'zcode.sqlite');
      const zdb = new DatabaseSync(zcodeDb);
      zdb.exec(`
        CREATE TABLE session (
          id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, directory TEXT,
          time_created INTEGER, time_updated INTEGER, time_archived INTEGER
        );
        CREATE TABLE message (
          id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER,
          data TEXT, sequence INTEGER
        );
        CREATE TABLE part (
          id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER,
          time_updated INTEGER, data TEXT, sequence INTEGER
        );
      `);
      zdb.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        'zcode-long',
        null,
        'ZCode 长会话',
        'C:\\work\\zcode',
        Date.parse(at(0)),
        Date.parse(at(messageCount - 1)),
        null,
      );
      const zInsertMessage = zdb.prepare(
        'INSERT INTO message VALUES (?, ?, ?, ?, ?, ?)',
      );
      const zInsertPart = zdb.prepare(
        'INSERT INTO part VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      for (let index = 0; index < messageCount; index += 1) {
        const messageId = `z-m${index}`;
        const time = Date.parse(at(index));
        zInsertMessage.run(
          messageId,
          'zcode-long',
          time,
          time,
          JSON.stringify({ role: roleAt(index) }),
          index + 1,
        );
        zInsertPart.run(
          `z-p${index}`,
          messageId,
          'zcode-long',
          time,
          time,
          JSON.stringify({ type: 'text', text: textAt(index) }),
          1,
        );
      }
      zdb.close();

      const hermesDb = path.join(dir, 'hermes.sqlite');
      const hdb = new DatabaseSync(hermesDb);
      hdb.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY, source TEXT, title TEXT, cwd TEXT, started_at REAL,
          last_activity_at REAL, parent_session_id TEXT, archived INTEGER,
          hidden INTEGER, message_count INTEGER
        );
        CREATE TABLE messages (
          id INTEGER PRIMARY KEY, message_uid TEXT, session_id TEXT, role TEXT,
          content TEXT, timestamp REAL
        );
      `);
      hdb.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        'hermes-long',
        'local',
        'Hermes 长会话',
        'C:\\work\\hermes',
        Date.parse(at(0)) / 1000,
        Date.parse(at(messageCount - 1)) / 1000,
        null,
        0,
        0,
        messageCount,
      );
      const hInsert = hdb.prepare(
        'INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)',
      );
      for (let index = 0; index < messageCount; index += 1) {
        hInsert.run(
          index + 1,
          `h-m${index}`,
          'hermes-long',
          roleAt(index),
          textAt(index),
          Date.parse(at(index)) / 1000,
        );
      }
      hdb.close();

      const claudeRoot = path.join(dir, 'claude');
      fs.mkdirSync(claudeRoot, { recursive: true });
      const claudeLines = Array.from({ length: messageCount }, (_, index) => JSON.stringify({
        type: roleAt(index),
        cwd: 'C:\\work\\claude',
        uuid: `c-${index}`,
        timestamp: at(index),
        message: {
          role: roleAt(index),
          content: [{ type: 'text', text: textAt(index) }],
        },
      }));
      fs.writeFileSync(path.join(claudeRoot, 'claude-long.jsonl'), claudeLines.join('\n'));

      const workbuddyRoot = path.join(dir, 'workbuddy');
      fs.mkdirSync(workbuddyRoot, { recursive: true });
      const wbLines = [
        JSON.stringify({ type: 'session-meta', sessionId: 'wb-long' }),
        JSON.stringify({ cwd: 'C:\\work\\workbuddy' }),
        ...Array.from({ length: messageCount }, (_, index) => JSON.stringify({
          type: 'message',
          id: `wb-${index}`,
          role: roleAt(index),
          timestamp: at(index),
          content: [{ type: 'text', text: textAt(index) }],
        })),
      ];
      fs.writeFileSync(path.join(workbuddyRoot, 'wb-long.jsonl'), wbLines.join('\n'));

      const dshRoot = path.join(dir, 'dsh');
      fs.mkdirSync(dshRoot, { recursive: true });
      const dshFile = path.join(dshRoot, 'session.v4.jsonl.zstd');
      writeZstdFrames(dshFile, [
        JSON.stringify({ type: 'session', id: 'dsh-long', cwd: 'C:\\work\\dsh' }),
        JSON.stringify({ type: 'session/title', data: { title: 'DSH 长会话' } }),
        ...Array.from({ length: messageCount }, (_, index) => (
          index % 2 === 0
            ? JSON.stringify({
              type: 'user/message',
              time: Date.parse(at(index)),
              data: {
                id: `dsh-${index}`,
                content: [{ type: 'text', text: textAt(index) }],
                source: { kind: 'user' },
              },
            })
            : JSON.stringify({
              type: 'assistant/message',
              time: Date.parse(at(index)),
              data: {
                id: `dsh-${index}`,
                message: {
                  id: `dsh-message-${index}`,
                  role: 'assistant',
                  content: [{ type: 'text', text: textAt(index) }],
                },
              },
            })
        )),
      ], [2, 16]);

      const agyRoot = path.join(dir, 'agy');
      const agyDir = path.join(agyRoot, 'agy-long', '.system_generated', 'logs');
      fs.mkdirSync(agyDir, { recursive: true });
      fs.writeFileSync(
        path.join(agyDir, 'transcript_full.jsonl'),
        Array.from({ length: messageCount }, (_, index) => JSON.stringify({
          type: index % 2 === 0 ? 'USER_INPUT' : 'PLANNER_RESPONSE',
          content: textAt(index),
          step_index: index,
          created_at: at(index),
        })).join('\n'),
      );
      const agyDb = path.join(dir, 'agy.sqlite');
      const adb = new DatabaseSync(agyDb);
      adb.exec(`
        CREATE TABLE conversation_summaries (
          conversation_id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '',
          preview TEXT NOT NULL DEFAULT '', step_count INTEGER NOT NULL DEFAULT 0,
          last_modified_time DATETIME NOT NULL, workspace_uris TEXT NOT NULL,
          parent_conversation_id TEXT NOT NULL DEFAULT '',
          nesting_depth INTEGER NOT NULL DEFAULT 0
        );
      `);
      adb.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        'agy-long',
        'Antigravity 长会话',
        '',
        messageCount,
        at(messageCount - 1).replace('T', ' ').replace('Z', '+00:00'),
        JSON.stringify(['file:///C:/work/agy']),
        '',
        0,
      );
      adb.close();

      const options = {
        home: dir,
        days: 7,
        now,
        settleMinutes: 0,
        codexRoot: path.join(dir, 'no-codex'),
        claudeRoot,
        claudeDesktopRoot: path.join(dir, 'no-cowork'),
        qoderDbPath: qoderDb,
        zcodeDbPath: zcodeDb,
        hermesDbPath: hermesDb,
        workbuddyRoot,
        dshRoot,
        agyRoot,
        agyDbPath: agyDb,
      };
      const shallow = discoverRecentSessions(options);
      const deep = discoverRecentSessions({ ...options, historyMessages: 50 });

      for (const sessionId of ['qoder-long', 'zcode-long', 'hermes-long']) {
        const shallowSession = shallow.find((session) => session.sessionId === sessionId)!;
        const deepSession = deep.find((session) => session.sessionId === sessionId)!;
        expect(shallowSession.messages).toHaveLength(20);
        expect(shallowSession.history).toBeUndefined();
        expect(deepSession.messages).toHaveLength(20);
        expect(deepSession.history).toHaveLength(100);
        expect(deepSession.history?.[0].text).toBe(early);
      }

      for (const sessionId of ['claude-long', 'wb-long', 'dsh-long', 'agy-long']) {
        const shallowSession = shallow.find((session) => session.sessionId === sessionId)!;
        const deepSession = deep.find((session) => session.sessionId === sessionId)!;
        expect(shallowSession.messages).toHaveLength(20);
        expect(shallowSession.history).toHaveLength(messageCount);
        expect(shallowSession.history?.[0].text).toBe(early);
        expect(deepSession.history?.[0].text).toBe(early);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the middle of a database session when history is deep', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-mid-history-'));
    const req = createRequire(import.meta.url);
    const { DatabaseSync } = req('node:sqlite') as {
      DatabaseSync: new (file: string) => any;
    };
    const messageCount = 1_003;
    const middleIndex = 500;
    const early = '早期状态：第一条';
    const middle = '中间证据：M121 需要捞回这一条';
    const at = (second: number) => new Date(
      Date.UTC(2026, 10, 10, 8, 0, second),
    ).toISOString();
    const textAt = (index: number) => {
      if (index === 0) return early;
      if (index === middleIndex) return middle;
      return `后续进度 ${index}`;
    };

    try {
      const qoderDb = path.join(dir, 'qoder-mid.sqlite');
      const qdb = new DatabaseSync(qoderDb);
      qdb.exec(`
        CREATE TABLE chat_sessions (
          session_id TEXT PRIMARY KEY, title TEXT, cwd TEXT, updated_at INTEGER,
          archived INTEGER, deleted_at TEXT
        );
        CREATE TABLE chat_session_messages (
          session_id TEXT, message_id TEXT, sequence INTEGER, role TEXT,
          payload_json TEXT, created_at INTEGER
        );
      `);
      qdb.prepare('INSERT INTO chat_sessions VALUES (?, ?, ?, ?, ?, ?)').run(
        'qoder-mid',
        'Qoder 超长会话',
        'C:\\work\\qoder-mid',
        Date.parse(at(messageCount - 1)),
        0,
        null,
      );
      const insert = qdb.prepare(
        'INSERT INTO chat_session_messages VALUES (?, ?, ?, ?, ?, ?)',
      );
      qdb.exec('BEGIN');
      for (let index = 0; index < messageCount; index += 1) {
        insert.run(
          'qoder-mid',
          `qm-${index}`,
          index + 1,
          index % 2 === 0 ? 'user' : 'assistant',
          JSON.stringify({ parts: [{ type: 'text', text: textAt(index) }] }),
          Date.parse(at(index)),
        );
      }
      qdb.exec('COMMIT');
      qdb.close();

      const sessions = discoverRecentSessions({
        home: dir,
        days: 7,
        now,
        settleMinutes: 0,
        historyMessages: 2_000,
        codexRoot: path.join(dir, 'no-codex'),
        claudeRoot: path.join(dir, 'no-claude'),
        claudeDesktopRoot: path.join(dir, 'no-cowork'),
        qoderDbPath: qoderDb,
        zcodeDbPath: path.join(dir, 'no-zcode.sqlite'),
        workbuddyRoot: path.join(dir, 'no-workbuddy'),
        hermesDbPath: path.join(dir, 'no-hermes.sqlite'),
        dshRoot: path.join(dir, 'no-dsh'),
        agyRoot: path.join(dir, 'no-agy'),
        agyDbPath: path.join(dir, 'no-agy.sqlite'),
      });

      const session = sessions.find((entry) => entry.sessionId === 'qoder-mid');
      expect(session).toBeDefined();
      expect(session?.messages).toHaveLength(20);
      expect(session?.history).toHaveLength(messageCount);
      expect(session?.history?.[0].text).toBe(early);
      expect(session?.history?.[middleIndex].text).toBe(middle);
      expect(session?.history?.at(-1)?.text).toBe(`后续进度 ${messageCount - 1}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('keeps active Codex sessions when settleMinutes is zero', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-codex-active-'));
    try {
      const codexRoot = path.join(dir, 'sessions');
      fs.mkdirSync(codexRoot, { recursive: true });
      const message = (role: string, text: string, timestamp: string) => JSON.stringify({
        timestamp,
        type: 'response_item',
        payload: {
          type: 'message',
          role,
          content: [{ type: 'input_text', text }],
        },
      });
      const file = path.join(codexRoot, 'rollout-active.jsonl');
      fs.writeFileSync(file, [
        JSON.stringify({
          timestamp: '2026-11-11T12:00:01.000Z',
          type: 'session_meta',
          payload: {
            session_id: 'codex-active',
            id: 'codex-active',
            cwd: 'C:\\work\\alpha',
          },
        }),
        message('user', '还在写', '2026-11-11T12:00:05.000Z'),
        message('assistant', '继续写', '2026-11-11T12:00:06.000Z'),
      ].join('\n'));
      fs.utimesSync(file, new Date('2026-11-11T12:00:06Z'), new Date('2026-11-11T12:00:06Z'));

      const options = {
        home: dir,
        days: 7,
        now,
        codexRoot,
        claudeRoot: path.join(dir, 'no-claude'),
        claudeDesktopRoot: path.join(dir, 'no-cowork'),
        qoderDbPath: path.join(dir, 'no-qoder.sqlite'),
        zcodeDbPath: path.join(dir, 'no-zcode.sqlite'),
        workbuddyRoot: path.join(dir, 'no-workbuddy'),
        hermesDbPath: path.join(dir, 'no-hermes.sqlite'),
      };

      expect(discoverRecentSessions({ ...options, settleMinutes: 0 })
        .map((session) => session.sessionId)).toContain('codex-active');
      expect(discoverRecentSessions({ ...options, settleMinutes: 30 })).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('drops tracker-generated digest messages from extraction and history', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-codex-digest-'));
    try {
      const codexRoot = path.join(dir, 'sessions');
      fs.mkdirSync(codexRoot, { recursive: true });
      const message = (role: string, text: string, timestamp: string) => JSON.stringify({
        timestamp,
        type: 'response_item',
        payload: {
          type: 'message',
          role,
          content: [{ type: 'input_text', text }],
        },
      });
      const digest = '# 今天提过 · 1 条\n\n1. **登录提示还没补**\n\n回编号或 ref 看下一步和依据。';
      const file = path.join(codexRoot, 'rollout-digest.jsonl');
      fs.writeFileSync(file, [
        JSON.stringify({
          timestamp: '2026-11-10T10:00:00.000Z',
          type: 'session_meta',
          payload: {
            session_id: 'codex-digest',
            id: 'codex-digest',
            cwd: 'C:\\work\\alpha',
          },
        }),
        message('user', '登录提示还没补', '2026-11-10T10:00:01.000Z'),
        message('assistant', digest, '2026-11-10T10:00:02.000Z'),
        message('assistant', '下一步补登录提示。', '2026-11-10T10:00:03.000Z'),
      ].join('\n'));
      fs.utimesSync(file, new Date('2026-11-10T10:00:03Z'), new Date('2026-11-10T10:00:03Z'));

      const sessions = discoverRecentSessions({
        home: dir,
        days: 7,
        now,
        historyMessages: 100,
        codexRoot,
        claudeRoot: path.join(dir, 'no-claude'),
        claudeDesktopRoot: path.join(dir, 'no-cowork'),
        qoderDbPath: path.join(dir, 'no-qoder.sqlite'),
        zcodeDbPath: path.join(dir, 'no-zcode.sqlite'),
        workbuddyRoot: path.join(dir, 'no-workbuddy'),
        hermesDbPath: path.join(dir, 'no-hermes.sqlite'),
      });

      const session = sessions.find((item) => item.sessionId === 'codex-digest');
      expect(session).toBeDefined();
      expect(session?.messages.some((item) => item.text === digest)).toBe(false);
      expect(session?.history?.some((item) => item.text === digest)).toBe(false);
      expect(session?.messages.some((item) => item.text.includes('下一步补登录提示'))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
