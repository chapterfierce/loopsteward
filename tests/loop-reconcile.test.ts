import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import { LoopStore } from '../src/loops/loop-store.js';
import {
  findCompletionEvidence,
  reconcileRecentSessions,
  selectReconcileMessages,
  type ReconcileOptions,
} from '../src/loops/reconcile.js';
import { LoopExtractionError, parseResolutions } from '../src/loops/extractor.js';
import { loopRef } from '../src/loops/loop-ref.js';
import type { LoopRecord, RecentSession } from '../src/loops/types.js';
import type { DiscoverSessionsOptions } from '../src/loops/session-source.js';

const stores: LoopStore[] = [];

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
});

const messages = new Set(['m1', 'm2']);
const loops = new Set(['loop_a', 'loop_b']);

describe('parseResolutions', () => {
  it('parses a valid resolution above the confidence threshold', () => {
    const result = parseResolutions(
      JSON.stringify({
        resolved: [{
          loop_id: 'loop_a',
          confidence: 0.95,
          reason: '用户确认已经提交',
          evidence_message_ids: ['m2'],
        }],
      }),
      messages,
      loops,
    );
    expect(result).toEqual([{
      loopId: 'loop_a',
      confidence: 0.95,
      reason: '用户确认已经提交',
      evidenceMessageIds: ['m2'],
    }]);
  });

  it('accepts an empty resolved array', () => {
    expect(parseResolutions('{"resolved":[]}', messages, loops)).toEqual([]);
  });

  it('rejects unknown loop ids and unknown message ids', () => {
    expect(() => parseResolutions(
      '{"resolved":[{"loop_id":"loop_x","confidence":0.9,"reason":"done","evidence_message_ids":["m1"]}]}',
      messages,
      loops,
    )).toThrow(/unknown|未知/i);
    expect(() => parseResolutions(
      '{"resolved":[{"loop_id":"loop_a","confidence":0.9,"reason":"done","evidence_message_ids":["m9"]}]}',
      messages,
      loops,
    )).toThrow(/白名单|whitelist/i);
  });

  it('resolves role-prefixed message ids without widening the whitelist', () => {
    const prefixed = parseResolutions(
      '{"resolved":[{"loop_id":"loop_a","confidence":0.95,"reason":"done","evidence_message_ids":["m1"]}]}',
      new Set(['assistant:m1']),
      loops,
    );
    expect(prefixed[0].evidenceMessageIds).toEqual(['assistant:m1']);

    const bare = parseResolutions(
      '{"resolved":[{"loop_id":"loop_a","confidence":0.95,"reason":"done","evidence_message_ids":["assistant:m2"]}]}',
      new Set(['m2']),
      loops,
    );
    expect(bare[0].evidenceMessageIds).toEqual(['m2']);
  });

  it('drops unknown evidence ids in tolerant mode without dropping valid candidates', () => {
    const partial = parseResolutions(
      JSON.stringify({
        resolved: [{
          loop_id: 'loop_a',
          confidence: 0.95,
          reason: 'done',
          evidence_message_ids: ['m1', 'invented'],
        }],
      }),
      messages,
      loops,
      0.85,
      { tolerateUnknownEvidence: true },
    );
    expect(partial).toHaveLength(1);
    expect(partial[0].evidenceMessageIds).toEqual(['m1']);

    const allUnknown = parseResolutions(
      JSON.stringify({
        resolved: [{
          loop_id: 'loop_a',
          confidence: 0.95,
          reason: 'done',
          evidence_message_ids: ['invented'],
        }],
      }),
      messages,
      loops,
      0.85,
      { tolerateUnknownEvidence: true },
    );
    expect(allUnknown).toEqual([]);
  });

  it('filters low-confidence results and deduplicates by loop id', () => {
    const result = parseResolutions(
      JSON.stringify({
        resolved: [
          { loop_id: 'loop_a', confidence: 0.5, reason: 'maybe', evidence_message_ids: ['m1'] },
          { loop_id: 'loop_a', confidence: 0.97, reason: 'confirmed', evidence_message_ids: ['m2'] },
          { loop_id: 'loop_b', confidence: 0.8, reason: 'weak', evidence_message_ids: ['m1'] },
        ],
      }),
      messages,
      loops,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ loopId: 'loop_a', confidence: 0.97, reason: 'confirmed' });
  });

  it('keeps up to ten resolutions to match the prompt limit', () => {
    const manyLoops = new Set(Array.from({ length: 12 }, (_, index) => `loop_${index}`));
    const raw = JSON.stringify({
      resolved: Array.from({ length: 10 }, (_, index) => ({
        loop_id: `loop_${index}`,
        confidence: 0.99 - index * 0.01,
        reason: `完成 ${index}`,
        evidence_message_ids: ['m1'],
      })),
    });

    expect(parseResolutions(raw, messages, manyLoops)).toHaveLength(10);
  });
});

function makeSession(): RecentSession {
  return {
    agent: 'codex',
    sessionId: 's1',
    title: '登录页收尾',
    projectDir: path.normalize('C:/work/alpha'),
    lastActive: '2026-11-11T10:02:00.000Z',
    sourceFile: 'codex-s1.jsonl',
    messages: [
      { id: 'm1', role: 'user', text: '错误提示做了吗', timestamp: '2026-11-11T10:00:00.000Z' },
      { id: 'm2', role: 'assistant', text: '已经补上并验证通过。', timestamp: '2026-11-11T10:02:00.000Z' },
    ],
  };
}

function seedLoop(store: LoopStore): string {
  const { loop } = store.saveLoop(
    {
      title: '补齐登录页错误提示',
      nextAction: '在登录失败时展示具体原因',
      why: '会话结束时还没做',
      confidence: 0.82,
      sourceSignalIds: ['codex:s0:m1'],
    },
    {
      projectDir: path.normalize('C:/work/alpha'),
      projectName: 'alpha',
      firstSeen: '2026-11-10T10:00:00.000Z',
      lastSeen: '2026-11-10T10:00:00.000Z',
    },
  );
  return loop.id;
}

describe('selectReconcileMessages', () => {
  it('keeps the tail and pulls older status evidence for an active loop', () => {
    const history = [
      {
        id: 'old-status',
        role: 'assistant' as const,
        text: '真实反馈已按 5 条 forgotten 写入，反馈不再为 0。',
        timestamp: '2026-11-11T08:15:00.000Z',
      },
      ...Array.from({ length: 30 }, (_, index) => ({
        id: `m${index}`,
        role: 'assistant' as const,
        text: `进度 ${index}`,
        timestamp: `2026-11-11T09:00:${String(index).padStart(2, '0')}.000Z`,
      })),
    ];
    const session: RecentSession = {
      agent: 'codex',
      sessionId: 'long-session',
      title: '长会话',
      projectDir: path.normalize('C:/work/alpha'),
      lastActive: '2026-11-11T09:00:29.000Z',
      messages: history.slice(-20),
      history,
      sourceFile: 'long-session.jsonl',
    };
    const activeLoops = [{
      id: 'loop_a',
      title: '真实反馈仍为 0，5 条候选循环待判定',
      nextAction: '记录 5 条反馈并重算 usefulRate',
      why: '',
      status: 'open',
      confidence: 0.85,
      projectDir: path.normalize('C:/work/alpha'),
      projectName: 'alpha',
      sourceSignalIds: [],
      firstSeen: '2026-11-11T02:00:00.000Z',
      lastSeen: '2026-11-11T08:00:00.000Z',
      ignoredCount: 0,
    }] as LoopRecord[];

    const selected = selectReconcileMessages(session, activeLoops);

    expect(selected.some((message) => message.id === 'old-status')).toBe(true);
    expect(selected.some((message) => message.id === 'm29')).toBe(true);
    expect(selected.length).toBeLessThanOrEqual(40);
  });

  it('reserves one relevant message per active loop', () => {
    const evidence = [
      {
        id: 'evidence-a',
        role: 'assistant' as const,
        text: 'M96 持续跟进已实现。',
        timestamp: '2026-11-11T08:29:00.000Z',
      },
      {
        id: 'evidence-b',
        role: 'assistant' as const,
        text: '配额与回访轮换已经补完并验证通过。',
        timestamp: '2026-11-11T08:32:00.000Z',
      },
    ];
    const noise = Array.from({ length: 60 }, (_, index) => ({
      id: `noise-${index}`,
      role: 'assistant' as const,
      text: '回访 重复提醒 配额 持续跟进 M96 已实现 已完成 已验证',
      timestamp: `2026-11-11T10:00:${String(index).padStart(2, '0')}.000Z`,
    }));
    const history = [...evidence, ...noise];
    const session: RecentSession = {
      agent: 'codex',
      sessionId: 'crowded-session',
      title: '长会话',
      projectDir: path.normalize('C:/work/alpha'),
      lastActive: '2026-11-11T10:00:59.000Z',
      messages: history.slice(-20),
      history,
      sourceFile: 'crowded-session.jsonl',
    };
    const activeLoops = [
      {
        id: 'loop_a',
        title: '回访缺少重复提醒配额，持续跟进承诺冲突',
        nextAction: '补齐 repeated 配额并验证',
        why: '',
        status: 'open',
        confidence: 0.9,
        projectDir: path.normalize('C:/work/alpha'),
        projectName: 'alpha',
        sourceSignalIds: [],
        firstSeen: '2026-11-11T02:00:00.000Z',
        lastSeen: '2026-11-11T08:00:00.000Z',
        ignoredCount: 0,
      },
      {
        id: 'loop_b',
        title: '回访配额改动尚未完成',
        nextAction: '补齐配额并验证',
        why: '',
        status: 'open',
        confidence: 0.9,
        projectDir: path.normalize('C:/work/alpha'),
        projectName: 'alpha',
        sourceSignalIds: [],
        firstSeen: '2026-11-11T02:00:00.000Z',
        lastSeen: '2026-11-11T08:00:00.000Z',
        ignoredCount: 0,
      },
    ] as LoopRecord[];

    const selected = selectReconcileMessages(session, activeLoops);

    expect(selected.some((message) => message.id === 'evidence-a')).toBe(true);
    expect(selected.some((message) => message.id === 'evidence-b')).toBe(true);
    expect(selected.length).toBeLessThanOrEqual(40);
  });

  it('falls back to the stored source evidence when text matching finds nothing', () => {
    const history = [
      {
        id: 'source-message',
        role: 'assistant' as const,
        text: '这个还没做。',
        timestamp: '2026-11-11T08:00:00.000Z',
      },
      ...Array.from({ length: 40 }, (_, index) => ({
        id: `u${index}`,
        role: 'assistant' as const,
        text: `无关进度 ${index}`,
        timestamp: `2026-11-11T09:00:${String(index).padStart(2, '0')}.000Z`,
      })),
    ];
    const session: RecentSession = {
      agent: 'codex',
      sessionId: 'source-fallback',
      title: '长会话',
      projectDir: path.normalize('C:/work/alpha'),
      lastActive: '2026-11-11T09:00:39.000Z',
      messages: history.slice(-20),
      history,
      sourceFile: 'source-fallback.jsonl',
    };
    const activeLoops = [{
      id: 'loop_source',
      title: '补齐导出功能',
      nextAction: '实现 CSV 导出',
      why: '',
      status: 'open',
      confidence: 0.9,
      projectDir: path.normalize('C:/work/alpha'),
      projectName: 'alpha',
      sourceSignalIds: [],
      firstSeen: '2026-11-11T08:00:00.000Z',
      lastSeen: '2026-11-11T08:00:00.000Z',
      ignoredCount: 0,
    }] as LoopRecord[];

    const selected = selectReconcileMessages(session, activeLoops, {
      evidenceByLoop: new Map([['loop_source', ['source-message']]]),
    });

    expect(selected.some((message) => message.id === 'source-message')).toBe(true);
  });
});

describe('findCompletionEvidence', () => {
  it('ignores zero-count problem statements and keeps later completion evidence', () => {
    const projectDir = path.normalize('C:/work/alpha');
    const loop = {
      id: 'loop_a',
      title: '回访缺少重复提醒配额，持续跟进承诺冲突',
      nextAction: '在热区选条逻辑中加入重复回访配额',
      why: '',
      status: 'open',
      confidence: 0.9,
      projectDir,
      projectName: 'alpha',
      sourceSignalIds: [],
      firstSeen: '2026-11-11T05:00:00.000Z',
      lastSeen: '2026-11-11T06:00:00.000Z',
      ignoredCount: 0,
    } as LoopRecord;
    const session: RecentSession = {
      ...makeSession(),
      projectDir,
      history: [
        {
          id: 'blocked',
          role: 'assistant',
          text: '技术面已收口，目标 blocked；202 条循环只有 27 条被回访、0 条重复提醒。',
          timestamp: '2026-11-11T06:00:10.000Z',
        },
        {
          id: 'progress',
          role: 'assistant',
          text: '新逻辑的 7 条用例已通过，测试通过。',
          timestamp: '2026-11-11T08:24:00.000Z',
        },
        {
          id: 'done',
          role: 'assistant',
          text: 'M96 持续跟进已实现，复访配额已经补完。',
          timestamp: '2026-11-11T08:29:00.000Z',
        },
      ],
    };

    const evidence = findCompletionEvidence(session, [loop]).get(loop.id) ?? [];
    const ids = evidence.map((message) => message.id);

    expect(ids).not.toContain('blocked');
    expect(ids).toContain('done');
  });
});

describe('reconcileRecentSessions', () => {
  it('checks multiple sessions concurrently instead of serially', async () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    seedLoop(store);
    const sessions = Array.from({ length: 6 }, (_, index) => ({
      ...makeSession(),
      sessionId: `s${index + 1}`,
      sourceFile: `codex-s${index + 1}.jsonl`,
    }));
    let inFlight = 0;
    let maxInFlight = 0;

    const summary = await reconcileRecentSessions({
      store,
      concurrency: 3,
      discover: () => sessions,
      resolve: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight -= 1;
        return [];
      },
      magpieHome: path.join(process.cwd(), 'tests', 'fixtures', 'missing-magpie'),
    });

    expect(summary.sessionsChecked).toBe(6);
    expect(maxInFlight).toBe(3);
  });

  it('splits a parse-failing batch instead of losing the session', async () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    const projectDir = path.normalize('C:/work/alpha');
    store.saveSignal({
      id: 'sig-batch',
      source: 'session',
      sourceId: 's0',
      messageId: 'm1',
      agent: 'codex',
      role: 'assistant',
      text: '批量事项的原始证据。',
      projectDir,
      capturedAt: '2026-11-11T08:00:00.000Z',
      contentHash: 'hash-batch',
    });
    const titles = ['导出 CSV', '修复登录限流', '补齐悬浮窗跳转', '更新发布脚本'];
    for (const title of titles) {
      store.saveLoop(
        {
          title,
          nextAction: `完成：${title}`,
          why: '测试二分重试',
          confidence: 0.9,
          sourceSignalIds: ['sig-batch'],
        },
        {
          projectDir,
          projectName: 'alpha',
          firstSeen: '2026-11-11T08:00:00.000Z',
          lastSeen: '2026-11-11T08:00:00.000Z',
        },
      );
    }
    const calls: number[] = [];
    const resolve: NonNullable<ReconcileOptions['resolve']> = async (input) => {
      calls.push(input.loops.length);
      if (input.loops.length > 2) {
        throw new LoopExtractionError('parse', '模型输出里没有完整的 JSON 对象');
      }
      return input.loops.map((loop) => ({
        loopId: loop.id,
        confidence: 0.95,
        reason: '批量事项已完成',
        evidenceMessageIds: ['m1'],
      }));
    };

    const summary = await reconcileRecentSessions({
      store,
      discover: () => [makeSession()],
      resolve,
      secondLook: false,
      magpieHome: path.join(process.cwd(), 'tests', 'fixtures', 'missing-magpie'),
    });

    expect(calls).toEqual([4, 2, 2]);
    expect(summary.errors).toEqual([]);
    expect(summary.candidates).toHaveLength(4);
  });

  it('batches projects with more active loops than one prompt can cover', async () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    const projectDir = path.normalize('C:/work/alpha');
    const loopIdByTitle = new Map<string, string>();
    const evidenceByTitle = new Map<string, string>();

    for (let index = 0; index < 20; index += 1) {
      const token = `alpha${String(index).padStart(2, '0')}`;
      const signalId = `sig-${token}`;
      const messageId = `evidence-${token}`;
      store.saveSignal({
        id: signalId,
        source: 'session',
        sourceId: 's0',
        messageId,
        agent: 'codex',
        role: 'assistant',
        text: `${token} 已完成。`,
        projectDir,
        capturedAt: '2026-11-11T08:00:00.000Z',
        contentHash: `hash-${token}`,
      });
      const { loop } = store.saveLoop(
        {
          title: `${token} 未完成`,
          nextAction: `finish ${token}`,
          why: '测试批次',
          confidence: 0.9,
          sourceSignalIds: [signalId],
        },
        {
          projectDir,
          projectName: 'alpha',
          firstSeen: '2026-11-11T08:00:00.000Z',
          lastSeen: '2026-11-11T08:00:00.000Z',
        },
      );
      loopIdByTitle.set(loop.title, loop.id);
      evidenceByTitle.set(loop.title, messageId);
    }

    const history = [
      ...Array.from({ length: 20 }, (_, index) => {
        const token = `alpha${String(index).padStart(2, '0')}`;
        return {
          id: `evidence-${token}`,
          role: 'assistant' as const,
          text: `${token} 已完成。`,
          timestamp: `2026-11-11T09:00:${String(index).padStart(2, '0')}.000Z`,
        };
      }),
      ...Array.from({ length: 40 }, (_, index) => ({
        id: `noise-${index}`,
        role: 'assistant' as const,
        text: `无关进度 ${index}`,
        timestamp: `2026-11-11T10:00:${String(index).padStart(2, '0')}.000Z`,
      })),
    ];
    const session: RecentSession = {
      ...makeSession(),
      messages: history.slice(-20),
      history,
      lastActive: '2026-11-11T10:00:39.000Z',
    };
    const calls: Array<{ loopIds: string[]; messageIds: string[] }> = [];
    const resolve: NonNullable<ReconcileOptions['resolve']> = async (input) => {
      calls.push({
        loopIds: input.loops.map((loop) => loop.id),
        messageIds: input.messages.map((message) => message.id),
      });
      return [];
    };
    const run = () => reconcileRecentSessions({
      store,
      discover: () => [session],
      resolve,
      secondLook: false,
      magpieHome: path.join(process.cwd(), 'tests', 'fixtures', 'missing-magpie'),
    });

    const first = await run();

    expect(first.sessionsSeen).toBe(1);
    expect(first.sessionsChecked).toBe(1);
    expect(first.errors).toEqual([]);
    expect(calls).toHaveLength(2);
    const seen = new Set<string>();
    for (const call of calls) {
      expect(call.loopIds.length).toBeLessThanOrEqual(16);
      for (const loopId of call.loopIds) {
        expect(seen.has(loopId)).toBe(false);
        seen.add(loopId);
        const title = [...loopIdByTitle.entries()]
          .find(([, id]) => id === loopId)?.[0];
        expect(title).toBeTruthy();
        expect(call.messageIds).toContain(evidenceByTitle.get(title as string));
      }
    }
    expect(seen.size).toBe(20);

    const second = await run();

    expect(calls).toHaveLength(2);
    expect(second.sessionsChecked).toBe(1);
    expect(second.sessionsCached).toBe(1);
  });

  it('rechecks loops with completion evidence that the first pass missed', async () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    const projectDir = path.normalize('C:/work/alpha');

    const seed = (title: string, token: string) => {
      const signalId = `sig-${token}`;
      store.saveSignal({
        id: signalId,
        source: 'session',
        sourceId: 's0',
        messageId: `evidence-${token}`,
        agent: 'codex',
        role: 'assistant',
        text: `${token} 已完成。`,
        projectDir,
        capturedAt: '2026-11-11T09:00:00.000Z',
        contentHash: `hash-${token}`,
      });
      const { loop } = store.saveLoop(
        {
          title,
          nextAction: `finish ${token}`,
          why: '测试定向复检',
          confidence: 0.9,
          sourceSignalIds: [signalId],
        },
        {
          projectDir,
          projectName: 'alpha',
          firstSeen: '2026-11-11T08:00:00.000Z',
          lastSeen: '2026-11-11T08:00:00.000Z',
        },
      );
      return loop;
    };

    const done = seed('补齐导出功能', 'csv');
    seed('补齐登录限流', 'limit');

    const history = [
      ...Array.from({ length: 20 }, (_, index) => ({
        id: `before-${index}`,
        role: 'assistant' as const,
        text: `准备 ${index}`,
        timestamp: `2026-11-11T08:30:${String(index).padStart(2, '0')}.000Z`,
      })),
      {
        id: 'evidence-csv',
        role: 'assistant' as const,
        text: 'CSV 导出功能已完成并验证通过。',
        timestamp: '2026-11-11T09:00:00.000Z',
      },
      ...Array.from({ length: 20 }, (_, index) => ({
        id: `after-${index}`,
        role: 'assistant' as const,
        text: `后续进度 ${index}`,
        timestamp: `2026-11-11T10:00:${String(index).padStart(2, '0')}.000Z`,
      })),
    ];
    const session: RecentSession = {
      ...makeSession(),
      messages: history.slice(-20),
      history,
      lastActive: '2026-11-11T10:00:19.000Z',
    };
    const calls: Array<{ loopIds: string[]; messageIds: string[] }> = [];
    const resolve: NonNullable<ReconcileOptions['resolve']> = async (input) => {
      calls.push({
        loopIds: input.loops.map((loop) => loop.id),
        messageIds: input.messages.map((message) => message.id),
      });
      if (calls.length === 1) return [];
      return [{
        loopId: done.id,
        confidence: 0.95,
        reason: 'CSV 导出已完成并验证',
        evidenceMessageIds: ['evidence-csv'],
      }];
    };

    const summary = await reconcileRecentSessions({
      store,
      discover: () => [session],
      resolve,
      magpieHome: path.join(process.cwd(), 'tests', 'fixtures', 'missing-magpie'),
    });

    expect(calls).toHaveLength(2);
    expect(calls[1].loopIds).toEqual([done.id]);
    expect(calls[1].messageIds).toContain('evidence-csv');
    expect(calls[1].messageIds.length).toBeLessThanOrEqual(7);
    expect(summary.candidates.map((candidate) => candidate.loopId)).toEqual([done.id]);
  });

  it('keeps the stronger second-look result when the first pass was weak', async () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    const projectDir = path.normalize('C:/work/alpha');
    const signalId = 'sig-weak';
    store.saveSignal({
      id: signalId,
      source: 'session',
      sourceId: 's0',
      messageId: 'weak-evidence',
      agent: 'codex',
      role: 'assistant',
      text: '导出功能已完成。',
      projectDir,
      capturedAt: '2026-11-11T09:00:00.000Z',
      contentHash: 'hash-weak',
    });
    const { loop } = store.saveLoop(
      {
        title: '补齐导出功能',
        nextAction: '实现 CSV 导出',
        why: '测试置信度合并',
        confidence: 0.9,
        sourceSignalIds: [signalId],
      },
      {
        projectDir,
        projectName: 'alpha',
        firstSeen: '2026-11-11T08:00:00.000Z',
        lastSeen: '2026-11-11T08:00:00.000Z',
      },
    );
    const history = [
      {
        id: 'weak-evidence',
        role: 'assistant' as const,
        text: '导出功能已完成。',
        timestamp: '2026-11-11T09:00:00.000Z',
      },
      ...Array.from({ length: 30 }, (_, index) => ({
        id: `tail-${index}`,
        role: 'assistant' as const,
        text: `后续 ${index}`,
        timestamp: `2026-11-11T10:00:${String(index).padStart(2, '0')}.000Z`,
      })),
    ];
    const session: RecentSession = {
      ...makeSession(),
      messages: history.slice(-20),
      history,
      lastActive: '2026-11-11T10:00:29.000Z',
    };
    let calls = 0;
    const resolve: NonNullable<ReconcileOptions['resolve']> = async () => {
      calls += 1;
      if (calls === 1) {
        return [{
          loopId: loop.id,
          confidence: 0.6,
          reason: '弱证据',
          evidenceMessageIds: ['weak-evidence'],
        }];
      }
      return [{
        loopId: loop.id,
        confidence: 0.97,
        reason: '导出已完成并验证',
        evidenceMessageIds: ['weak-evidence'],
      }];
    };

    const summary = await reconcileRecentSessions({
      store,
      discover: () => [session],
      resolve,
      magpieHome: path.join(process.cwd(), 'tests', 'fixtures', 'missing-magpie'),
    });

    expect(calls).toBe(2);
    expect(summary.candidates).toHaveLength(1);
    expect(summary.candidates[0]).toMatchObject({
      loopId: loop.id,
      confidence: 0.97,
      reason: '导出已完成并验证',
    });
  });

  it('uses older session history as reconcile evidence', async () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    seedLoop(store);
    const history = [
      {
        id: 'old-status',
        role: 'assistant' as const,
        text: '登录页错误提示已于昨天补上并验证通过。',
        timestamp: '2026-11-10T10:01:00.000Z',
      },
      ...Array.from({ length: 30 }, (_, index) => ({
        id: `p${index}`,
        role: 'assistant' as const,
        text: `后续进度 ${index}`,
        timestamp: `2026-11-11T10:00:${String(index).padStart(2, '0')}.000Z`,
      })),
    ];
    const session: RecentSession = {
      ...makeSession(),
      messages: history.slice(-20),
      history,
      lastActive: '2026-11-11T10:00:29.000Z',
    };
    let received: string[] = [];

    const summary = await reconcileRecentSessions({
      store,
      discover: () => [session],
      resolve: async (input) => {
        received = input.messages.map((message) => message.text);
        return [];
      },
      magpieHome: path.join(process.cwd(), 'tests', 'fixtures', 'missing-magpie'),
    });

    expect(summary.sessionsChecked).toBe(1);
    expect(received.some((text) => text.includes('登录页错误提示已于昨天补上'))).toBe(true);
  });

  it('passes a loop source evidence message into the reconcile prompt', async () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    const signalId = 'sig-evidence';
    store.saveSignal({
      id: signalId,
      source: 'session',
      sourceId: 's0',
      messageId: 'evidence-old',
      agent: 'codex',
      role: 'assistant',
      text: 'M96 持续跟进已实现。',
      projectDir: path.normalize('C:/work/alpha'),
      capturedAt: '2026-11-11T08:29:00.000Z',
      contentHash: 'hash-evidence',
    });
    store.saveLoop(
      {
        title: '回访缺少重复提醒配额，持续跟进承诺冲突',
        nextAction: '补齐 repeated 配额并验证',
        why: '回访承诺没有落地',
        confidence: 0.9,
        sourceSignalIds: [signalId],
      },
      {
        projectDir: path.normalize('C:/work/alpha'),
        projectName: 'alpha',
        firstSeen: '2026-11-11T02:00:00.000Z',
        lastSeen: '2026-11-11T08:00:00.000Z',
      },
    );
    const history = [
      {
        id: 'evidence-old',
        role: 'assistant' as const,
        text: 'M96 持续跟进已实现。',
        timestamp: '2026-11-11T08:29:00.000Z',
      },
      ...Array.from({ length: 60 }, (_, index) => ({
        id: `q${index}`,
        role: 'assistant' as const,
        text: '回访 重复提醒 配额 持续跟进 M96 已实现 已完成',
        timestamp: `2026-11-11T10:00:${String(index).padStart(2, '0')}.000Z`,
      })),
    ];
    const session: RecentSession = {
      ...makeSession(),
      messages: history.slice(-20),
      history,
      lastActive: '2026-11-11T10:00:59.000Z',
    };
    let received: string[] = [];

    await reconcileRecentSessions({
      store,
      discover: () => [session],
      resolve: async (input) => {
        received = input.messages.map((message) => message.id);
        return [];
      },
      magpieHome: path.join(process.cwd(), 'tests', 'fixtures', 'missing-magpie'),
    });

    expect(received).toContain('evidence-old');
  });

  it('asks discovery for deep history during reconcile', async () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    let received: DiscoverSessionsOptions | undefined;

    await reconcileRecentSessions({
      store,
      discover: (options) => {
        received = options;
        return [];
      },
      resolve: async () => [],
      magpieHome: path.join(process.cwd(), 'tests', 'fixtures', 'missing-magpie'),
    });

    expect(received?.historyMessages).toBe(2_000);
  });

  it('reuses cached resolutions for an unchanged session', async () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    const loopId = seedLoop(store);
    let calls = 0;
    const resolve = async () => {
      calls += 1;
      return [{
        loopId,
        confidence: 0.96,
        reason: '助手确认已补齐并验证',
        evidenceMessageIds: ['m2'],
      }];
    };
    const run = () => reconcileRecentSessions({
      store,
      discover: () => [makeSession()],
      resolve,
      magpieHome: path.join(process.cwd(), 'tests', 'fixtures', 'missing-magpie'),
    });

    const first = await run();
    const second = await run();

    expect(calls).toBe(1);
    expect(first.sessionsCached).toBe(0);
    expect(second.sessionsCached).toBe(1);
    expect(second.candidates).toHaveLength(1);
  });

  it('does not reuse a no-second-look cache in the default mode', async () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    seedLoop(store);
    let calls = 0;
    const resolve = async () => {
      calls += 1;
      return [];
    };
    const run = (secondLook?: boolean) => reconcileRecentSessions({
      store,
      discover: () => [makeSession()],
      resolve,
      secondLook,
      magpieHome: path.join(process.cwd(), 'tests', 'fixtures', 'missing-magpie'),
    });

    await run(false);
    const second = await run();
    const third = await run();

    expect(calls).toBe(2);
    expect(second.sessionsCached).toBe(0);
    expect(third.sessionsCached).toBe(1);
  });

  it('rechecks a session when its messages change', async () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    const loopId = seedLoop(store);
    let session = makeSession();
    let calls = 0;
    const resolve = async () => {
      calls += 1;
      return [{
        loopId,
        confidence: 0.96,
        reason: '助手确认已补齐并验证',
        evidenceMessageIds: ['m2'],
      }];
    };
    const run = () => reconcileRecentSessions({
      store,
      discover: () => [session],
      resolve,
      magpieHome: path.join(process.cwd(), 'tests', 'fixtures', 'missing-magpie'),
    });

    await run();
    session = {
      ...session,
      messages: [
        ...session.messages,
        {
          id: 'm3',
          role: 'user',
          text: '再确认一下',
          timestamp: '2026-11-11T10:03:00.000Z',
        },
      ],
    };
    const second = await run();

    expect(calls).toBe(2);
    expect(second.sessionsCached).toBe(0);
  });

  it('rechecks a session when only its history changes', async () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    const loopId = seedLoop(store);
    let session: RecentSession = {
      ...makeSession(),
      history: [
        {
          id: 'old-status',
          role: 'assistant',
          text: '旧证据：已完成',
          timestamp: '2026-11-11T09:00:00.000Z',
        },
        ...makeSession().messages,
      ],
    };
    let calls = 0;
    const resolve = async () => {
      calls += 1;
      return [{
        loopId,
        confidence: 0.96,
        reason: '助手确认已补齐并验证',
        evidenceMessageIds: ['m2'],
      }];
    };
    const run = () => reconcileRecentSessions({
      store,
      discover: () => [session],
      resolve,
      magpieHome: path.join(process.cwd(), 'tests', 'fixtures', 'missing-magpie'),
    });

    await run();
    session = {
      ...session,
      history: [
        {
          id: 'older-status',
          role: 'assistant',
          text: '更早证据：其实早已完成',
          timestamp: '2026-11-11T08:00:00.000Z',
        },
        ...(session.history ?? []),
      ],
    };
    const second = await run();

    expect(calls).toBe(2);
    expect(second.sessionsCached).toBe(0);
  });

  it('bypasses the cache when refresh is requested', async () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    const loopId = seedLoop(store);
    let calls = 0;
    const resolve = async () => {
      calls += 1;
      return [{
        loopId,
        confidence: 0.96,
        reason: '助手确认已补齐并验证',
        evidenceMessageIds: ['m2'],
      }];
    };
    const run = (refresh: boolean) => reconcileRecentSessions({
      store,
      refresh,
      discover: () => [makeSession()],
      resolve,
      magpieHome: path.join(process.cwd(), 'tests', 'fixtures', 'missing-magpie'),
    });

    await run(false);
    const second = await run(true);

    expect(calls).toBe(2);
    expect(second.sessionsCached).toBe(0);
  });

  it('rewrites the cache after a forced refresh so the next run can reuse it', async () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    seedLoop(store);
    let session = makeSession();
    let calls = 0;
    const resolve = async () => {
      calls += 1;
      return [];
    };
    const run = (refresh: boolean, current: RecentSession) => reconcileRecentSessions({
      store,
      refresh,
      discover: () => [current],
      resolve,
      magpieHome: path.join(process.cwd(), 'tests', 'fixtures', 'missing-magpie'),
    });

    await run(false, session);
    session = {
      ...session,
      messages: [
        ...session.messages,
        {
          id: 'm3',
          role: 'user',
          text: '再确认一下',
          timestamp: '2026-11-11T10:03:00.000Z',
        },
      ],
    };
    const forced = await run(true, session);
    const third = await run(false, session);

    expect(forced.sessionsCached).toBe(0);
    expect(calls).toBe(2);
    expect(third.sessionsCached).toBe(1);
  });

  it('prunes cache rows older than the retention window', async () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    store.setReconcileCache('codex:old', 'hash-old', [], '2026-10-01T00:00:00.000Z');
    store.setReconcileCache('codex:fresh', 'hash-fresh', [], '2026-11-10T00:00:00.000Z');

    const summary = await reconcileRecentSessions({
      store,
      now: new Date('2026-11-11T12:00:00.000Z'),
      cacheRetentionDays: 7,
      discover: () => [],
      resolve: async () => [],
      magpieHome: path.join(process.cwd(), 'tests', 'fixtures', 'missing-magpie'),
    });

    expect(summary.cachePruned).toBe(1);
    expect(store.getReconcileCache('codex:old')).toBeUndefined();
    expect(store.getReconcileCache('codex:fresh')).toBeDefined();
  });

  it('rejects a non-positive cache retention window', async () => {
    const store = new LoopStore(':memory:');
    stores.push(store);

    await expect(reconcileRecentSessions({
      store,
      cacheRetentionDays: 0,
      discover: () => [],
      magpieHome: path.join(process.cwd(), 'tests', 'fixtures', 'missing-magpie'),
    })).rejects.toThrow(/cacheRetentionDays/);
  });

  it('reports candidates without changing loops in dry-run mode', async () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    const loopId = seedLoop(store);
    const summary = await reconcileRecentSessions({
      store,
      discover: () => [makeSession()],
      resolve: async () => [{
        loopId,
        confidence: 0.96,
        reason: '助手确认已补齐并验证',
        evidenceMessageIds: ['m2'],
      }],
      magpieHome: path.join(process.cwd(), 'tests', 'fixtures', 'missing-magpie'),
    });

    expect(summary.sessionsChecked).toBe(1);
    expect(summary.candidates).toHaveLength(1);
    expect(summary.candidates[0].ref).toBe(loopRef(loopId));
    expect(summary.applied).toEqual([]);
    expect(store.getLoop(loopId)?.status).toBe('open');
  });

  it('resolves a loop when apply is true and confidence clears the threshold', async () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    const loopId = seedLoop(store);
    const summary = await reconcileRecentSessions({
      store,
      apply: true,
      discover: () => [makeSession()],
      resolve: async () => [{
        loopId,
        confidence: 0.96,
        reason: '助手确认已补齐并验证',
        evidenceMessageIds: ['m2'],
      }],
      magpieHome: path.join(process.cwd(), 'tests', 'fixtures', 'missing-magpie'),
    });

    expect(summary.applied).toEqual([loopId]);
    const loop = store.getLoop(loopId)!;
    expect(loop.status).toBe('resolved');
    expect(loop.resolutionNote).toContain('助手确认已补齐并验证');
  });

  it('ignores low-confidence resolutions', async () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    const loopId = seedLoop(store);
    const summary = await reconcileRecentSessions({
      store,
      apply: true,
      discover: () => [makeSession()],
      resolve: async () => [{
        loopId,
        confidence: 0.5,
        reason: '只是猜的',
        evidenceMessageIds: ['m2'],
      }],
      magpieHome: path.join(process.cwd(), 'tests', 'fixtures', 'missing-magpie'),
    });

    expect(summary.candidates).toEqual([]);
    expect(summary.applied).toEqual([]);
    expect(store.getLoop(loopId)?.status).toBe('open');
  });
});
