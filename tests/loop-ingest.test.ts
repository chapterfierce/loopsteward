import { describe, it, expect, afterEach } from 'vitest';
import { LoopStore } from '../src/loops/loop-store.js';
import { ingestRecentSessions } from '../src/loops/ingest.js';
import { buildDigest } from '../src/loops/digest.js';
import type { RecentSession } from '../src/loops/types.js';

const stores: LoopStore[] = [];

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
});

function makeSession(): RecentSession {
  return {
    agent: 'codex',
    sessionId: 's1',
    title: '登录页',
    projectDir: 'C:/work/alpha',
    lastActive: '2026-11-10T10:01:00.000Z',
    sourceFile: 'codex-s1.jsonl',
    messages: [
      { id: 'm1', role: 'user', text: '登录页还差错误提示没做', timestamp: '2026-11-10T10:00:00.000Z' },
      { id: 'm2', role: 'assistant', text: '我接下来补错误提示。', timestamp: '2026-11-10T10:01:00.000Z' },
    ],
  };
}

describe('ingestRecentSessions', () => {
  it('creates a loop on the first run and merges it on the second', async () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    const extract = async (input: any, _options?: unknown) => {
      const existing = input.existingLoops?.[0];
      return [{
        title: existing ? '首屏登录失败提示补齐' : '补齐登录页错误提示',
        nextAction: '在登录失败时展示具体原因',
        why: '会话结束时还没做',
        confidence: 0.82,
        sourceMessageIds: existing ? ['m3'] : ['m1', 'm2'],
        ...(existing ? { mergeInto: existing.id } : {}),
      }];
    };

    const first = await ingestRecentSessions({
      discover: () => [makeSession()],
      extract,
      store,
      now: new Date('2026-11-11T12:00:00Z'),
    });

    expect(first).toMatchObject({
      sessionsSeen: 1,
      sessionsProcessed: 1,
      signalsSeen: 2,
      loopsCreated: 1,
      loopsMerged: 0,
    });
    expect(first.errors).toEqual([]);
    expect(store.listLoops({ status: 'open' })).toHaveLength(1);
    expect(store.listLoops({ status: 'open' })[0].sourceSignalIds).toEqual([
      'codex:s1:m1',
      'codex:s1:m2',
    ]);

    const sessionWithNewMessage = makeSession();
    sessionWithNewMessage.messages.push({
      id: 'm3',
      role: 'assistant',
      text: '错误提示还没补，下一步继续。',
      timestamp: '2026-11-11T12:59:00.000Z',
    });
    sessionWithNewMessage.lastActive = '2026-11-11T12:59:00.000Z';

    const second = await ingestRecentSessions({
      discover: () => [sessionWithNewMessage],
      extract,
      store,
      now: new Date('2026-11-11T13:00:00Z'),
    });

    expect(second.loopsCreated).toBe(0);
    expect(second.loopsMerged).toBe(1);
    expect(second.sessionsSkipped).toBe(0);
    expect(store.listLoops({ status: 'open' })).toHaveLength(1);
    expect(store.listLoops({ status: 'open' })[0].sourceSignalIds).toEqual([
      'codex:s1:m1',
      'codex:s1:m2',
      'codex:s1:m3',
    ]);

    const third = await ingestRecentSessions({
      discover: () => [sessionWithNewMessage],
      extract,
      store,
      now: new Date('2026-11-11T14:00:00Z'),
    });
    expect(third.sessionsSkipped).toBe(1);
    expect(third.loopsCreated).toBe(0);
    expect(third.loopsMerged).toBe(0);
  });

  it('records one session failure without aborting the rest', async () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    const failing = makeSession();
    const working = {
      ...makeSession(),
      sessionId: 's2',
      projectDir: 'C:/work/beta',
    };

    const extract = async (input: any) => {
      if (input.session.sessionId === 's1') throw new Error('bad JSON');
      return [{
        title: 'Beta 设置页保存按钮',
        nextAction: '接上保存按钮',
        why: '还没接',
        confidence: 0.7,
        sourceMessageIds: ['m1'],
      }];
    };

    const summary = await ingestRecentSessions({
      discover: () => [failing, working],
      extract,
      store,
    });

    expect(summary.sessionsSeen).toBe(2);
    expect(summary.sessionsProcessed).toBe(1);
    expect(summary.loopsCreated).toBe(1);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]).toContain('codex/s1');
    expect(store.listLoops({ status: 'open' })).toHaveLength(1);
  });

  it('extracts sessions concurrently while respecting the cap', async () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    const sessions = Array.from({ length: 6 }, (_, index) => ({
      ...makeSession(),
      sessionId: `s${index}`,
      projectDir: `C:/work/p${index}`,
    }));
    let inFlight = 0;
    let maxInFlight = 0;
    const extract = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      return [];
    };

    const summary = await ingestRecentSessions({
      discover: () => sessions,
      extract,
      store,
      concurrency: 2,
    });

    expect(summary.sessionsProcessed).toBe(6);
    expect(maxInFlight).toBe(2);
  });

  it('advances lastSeen only from cited messages so unrelated activity keeps noise suppression', async () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    let cite = ['m1', 'm2'];
    const extract = async (input: any) => {
      const existing = input.existingLoops?.[0];
      return [{
        title: '补齐登录页错误提示',
        nextAction: '在登录失败时展示具体原因',
        why: '会话结束时还没做',
        confidence: 0.82,
        sourceMessageIds: cite,
        ...(existing ? { mergeInto: existing.id } : {}),
      }];
    };

    const first = await ingestRecentSessions({
      discover: () => [makeSession()],
      extract,
      store,
      now: new Date('2026-11-11T12:00:00Z'),
    });
    expect(first.errors).toEqual([]);
    const loop = store.listLoops({ status: 'open' })[0];
    expect(loop.lastSeen).toBe('2026-11-10T10:01:00.000Z');
    store.recordFeedback(loop.id, 'noise', '不是要跟的', '2026-11-11T11:00:00.000Z');

    const unrelated = makeSession();
    unrelated.lastActive = '2026-11-11T11:30:00.000Z';
    unrelated.messages.push({
      id: 'm3',
      role: 'assistant',
      text: '换个话题，先聊一下发布流程。',
      timestamp: '2026-11-11T11:30:00.000Z',
    });
    cite = ['m1', 'm2'];
    await ingestRecentSessions({
      discover: () => [unrelated],
      extract,
      store,
      now: new Date('2026-11-11T12:00:00Z'),
    });

    expect(store.getLoop(loop.id)?.lastSeen).toBe('2026-11-10T10:01:00.000Z');
    const suppressed = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T12:00:00.000Z'),
      markSurfaced: false,
    });
    expect(suppressed.total).toBe(0);
    expect(suppressed.noiseSuppressed).toBe(1);

    const withNewEvidence = makeSession();
    withNewEvidence.messages.push(
      {
        id: 'm3',
        role: 'assistant',
        text: '换个话题，先聊一下发布流程。',
        timestamp: '2026-11-11T11:30:00.000Z',
      },
      {
        id: 'm4',
        role: 'user',
        text: '登录错误提示还是没补，继续做这个。',
        timestamp: '2026-11-11T11:45:00.000Z',
      },
    );
    withNewEvidence.lastActive = '2026-11-11T11:45:00.000Z';
    cite = ['m4'];
    await ingestRecentSessions({
      discover: () => [withNewEvidence],
      extract,
      store,
      now: new Date('2026-11-11T12:00:00Z'),
    });

    expect(store.getLoop(loop.id)?.lastSeen).toBe('2026-11-11T11:45:00.000Z');
    const resumed = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-11T12:00:00.000Z'),
      markSurfaced: false,
    });
    expect(resumed.total).toBe(1);
    expect(resumed.noiseSuppressed).toBe(0);
  });

  it('uses the cited message timestamp when creating a loop', async () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    const session: RecentSession = {
      agent: 'codex',
      sessionId: 'fresh',
      title: '旧文件被重新扫描',
      projectDir: 'C:/work/beta',
      lastActive: '2026-11-11T11:30:00.000Z',
      sourceFile: 'codex-fresh.jsonl',
      messages: [
        {
          id: 'm1',
          role: 'user',
          text: '设置页保存按钮还没接',
          timestamp: '2026-11-10T10:00:00.000Z',
        },
      ],
    };

    await ingestRecentSessions({
      discover: () => [session],
      extract: async () => [{
        title: '设置页保存按钮',
        nextAction: '接上保存按钮',
        why: '还没接',
        confidence: 0.7,
        sourceMessageIds: ['m1'],
      }],
      store,
    });

    expect(store.listLoops({ status: 'open' })[0].lastSeen)
      .toBe('2026-11-10T10:00:00.000Z');
  });

  it('does not push lastSeen forward when an old session is replayed', async () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    const loop = store.saveLoop(
      {
        title: '补登录提示',
        nextAction: '补登录提示',
        why: '还没补',
        confidence: 0.9,
        sourceSignalIds: ['codex:old:m1'],
      },
      {
        projectDir: 'C:/work/alpha',
        projectName: 'alpha',
        firstSeen: '2026-11-10T09:00:00.000Z',
        lastSeen: '2026-11-11T11:00:00.000Z',
      },
    ).loop;
    const replay: RecentSession = {
      agent: 'codex',
      sessionId: 'old',
      title: '旧会话',
      projectDir: 'C:/work/alpha',
      lastActive: '2026-11-11T11:30:00.000Z',
      sourceFile: 'codex-old.jsonl',
      messages: [
        {
          id: 'm1',
          role: 'user',
          text: '登录提示还没补',
          timestamp: '2026-11-10T10:00:00.000Z',
        },
      ],
    };

    await ingestRecentSessions({
      discover: () => [replay],
      extract: async () => [{
        title: '补登录提示',
        nextAction: '补登录提示',
        why: '还没补',
        confidence: 0.9,
        sourceMessageIds: ['m1'],
        mergeInto: loop.id,
      }],
      store,
    });

    expect(store.getLoop(loop.id)?.lastSeen).toBe('2026-11-11T11:00:00.000Z');
  });

  it('ignores empty and duplicate message timestamps when computing evidence time', async () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    const session: RecentSession = {
      agent: 'codex',
      sessionId: 'timestamps',
      title: '时间戳边界',
      projectDir: 'C:/work/gamma',
      lastActive: '2026-11-12T10:00:00.000Z',
      sourceFile: 'codex-timestamps.jsonl',
      messages: [
        {
          id: 'm1',
          role: 'user',
          text: '错误提示没补（重复 id 旧消息）',
          timestamp: '2026-11-10T10:00:00.000Z',
        },
        {
          id: 'm1',
          role: 'user',
          text: '错误提示没补',
          timestamp: '2026-11-10T11:00:00.000Z',
        },
        {
          id: 'm2',
          role: 'assistant',
          text: '继续补错误提示',
          timestamp: '',
        },
      ],
    };

    await ingestRecentSessions({
      discover: () => [session],
      extract: async () => [{
        title: '补错误提示',
        nextAction: '补错误提示',
        why: '还没补',
        confidence: 0.8,
        sourceMessageIds: ['m1', 'm2'],
      }],
      store,
    });

    const loop = store.listLoops({ status: 'open' })[0];
    expect(loop.firstSeen).toBe('2026-11-10T11:00:00.000Z');
    expect(loop.lastSeen).toBe('2026-11-10T11:00:00.000Z');
    expect(store.getSignals(loop.sourceSignalIds)[0].capturedAt)
      .toBe('2026-11-10T11:00:00.000Z');
  });

  it('normalizes timezone offsets and scopes firstSeen to cited evidence', async () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    const session: RecentSession = {
      agent: 'codex',
      sessionId: 'offsets',
      title: '时区边界',
      projectDir: 'C:/work/delta',
      lastActive: '2026-11-10T02:30:00.000Z',
      sourceFile: 'codex-offsets.jsonl',
      messages: [
        {
          id: 'm1',
          role: 'user',
          text: '早上提过一句',
          timestamp: '2026-11-10T09:00:00+08:00',
        },
        {
          id: 'm2',
          role: 'user',
          text: '现在确认要做的是补错误提示',
          timestamp: '2026-11-10T02:00:00Z',
        },
      ],
    };

    await ingestRecentSessions({
      discover: () => [session],
      extract: async () => [{
        title: '补错误提示',
        nextAction: '补错误提示',
        why: '还没补',
        confidence: 0.8,
        sourceMessageIds: ['m2'],
      }],
      store,
    });

    const loop = store.listLoops({ status: 'open' })[0];
    expect(loop.firstSeen).toBe('2026-11-10T02:00:00.000Z');
    expect(loop.lastSeen).toBe('2026-11-10T02:00:00.000Z');
  });

  it('does not treat a fallback-only merge as new evidence', async () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    let cite = ['m1', 'm2'];
    const extract = async (input: any) => {
      const existing = input.existingLoops?.[0];
      return [{
        title: '补齐登录页错误提示',
        nextAction: '在登录失败时展示具体原因',
        why: '会话结束时还没做',
        confidence: 0.82,
        sourceMessageIds: cite,
        ...(existing ? { mergeInto: existing.id } : {}),
      }];
    };

    await ingestRecentSessions({
      discover: () => [makeSession()],
      extract,
      store,
    });
    const loop = store.listLoops({ status: 'open' })[0];
    store.recordFeedback(loop.id, 'noise', '不是要跟的', '2026-11-11T11:00:00.000Z');

    const fallback = makeSession();
    fallback.lastActive = '2026-11-12T10:00:00.000Z';
    fallback.messages.push({
      id: 'm3',
      role: 'user',
      text: '补一句没有时间戳的说明',
      timestamp: '',
    });
    cite = ['m3'];
    await ingestRecentSessions({
      discover: () => [fallback],
      extract,
      store,
    });

    expect(store.getLoop(loop.id)?.lastSeen).toBe('2026-11-10T10:01:00.000Z');
    const digest = buildDigest({
      store,
      mode: 'hot',
      now: new Date('2026-11-12T11:00:00.000Z'),
      markSurfaced: false,
    });
    expect(digest.total).toBe(0);
    expect(digest.noiseSuppressed).toBe(1);
  });

  it('holds a fresh user question when settleMinutes is zero', async () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    let extractCalls = 0;
    const extract = async () => {
      extractCalls += 1;
      return [{
        title: '解释报错含义',
        nextAction: '说明报错原因',
        why: '用户提问后还没有回答',
        confidence: 0.7,
        sourceMessageIds: ['m1'],
      }];
    };
    const question = makeSession();
    question.messages = [{
      id: 'm1',
      role: 'user',
      text: '这个报错是什么意思？',
      timestamp: '2026-11-11T11:59:30.000Z',
    }];
    question.lastActive = '2026-11-11T11:59:30.000Z';

    const held = await ingestRecentSessions({
      discover: () => [question],
      extract,
      store,
      now: new Date('2026-11-11T12:00:00.000Z'),
      settleMinutes: 0,
    });

    expect(held.sessionsSkipped).toBe(1);
    expect(held.sessionsProcessed).toBe(0);
    expect(extractCalls).toBe(0);

    const later = await ingestRecentSessions({
      discover: () => [question],
      extract,
      store,
      now: new Date('2026-11-11T12:06:00.000Z'),
      settleMinutes: 0,
    });

    expect(later.sessionsProcessed).toBe(1);
    expect(extractCalls).toBe(1);
  });

  it('redacts secrets before sending session messages to the model', async () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    const session = makeSession();
    const fakeApiKey = ['sk', 'verify', 'redaction', '0000000000'].join('-');
    const fakePassword = ['verify', 'password', '000000'].join('-');
    session.messages = [
      {
        id: 'm1',
        role: 'user',
        text: `配置 api_key=${fakeApiKey}，password=${fakePassword}，下一步补错误提示`,
        timestamp: '2026-11-10T10:00:00.000Z',
      },
      {
        id: 'm2',
        role: 'assistant',
        text: '收到，下一步补错误提示。',
        timestamp: '2026-11-10T10:01:00.000Z',
      },
    ];
    let sentText = '';
    const extract = async (input: any) => {
      sentText = input.messages.map((message: any) => message.text).join('\n');
      return [{
        title: '补错误提示',
        nextAction: '补错误提示',
        why: '还没补',
        confidence: 0.8,
        sourceMessageIds: ['m2'],
      }];
    };

    const summary = await ingestRecentSessions({
      discover: () => [session],
      extract,
      store,
    });

    expect(summary.errors).toEqual([]);
    expect(sentText).not.toContain(fakeApiKey);
    expect(sentText).not.toContain(fakePassword);
    expect(sentText).toContain('[REDACTED]');
    expect(sentText).toContain('下一步补错误提示');
  });
});
