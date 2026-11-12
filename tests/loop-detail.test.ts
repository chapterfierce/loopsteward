import { describe, it, expect, afterEach } from 'vitest';
import { LoopStore } from '../src/loops/loop-store.js';
import { buildLoopDetail, formatLoopDetail } from '../src/loops/detail.js';
import { loopRef } from '../src/loops/loop-ref.js';

const stores: LoopStore[] = [];

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
});

function openStore(): LoopStore {
  const store = new LoopStore(':memory:');
  stores.push(store);
  return store;
}

function saveSignal(store: LoopStore, id: string, text: string, capturedAt: string): void {
  store.saveSignal({
    id,
    source: 'session',
    sourceId: 'session-1',
    messageId: `message-${id}`,
    agent: 'codex',
    role: 'user',
    text,
    projectDir: 'C:/work/alpha',
    capturedAt,
    contentHash: `hash-${id}`,
  });
}

describe('loop detail', () => {
  it('shows source evidence in stored order and reports missing signals', () => {
    const store = openStore();
    saveSignal(store, 'sig_1', '记得把大库耗时补上', '2026-11-10T10:00:00.000Z');
    const { loop } = store.saveLoop(
      {
        title: '补大库耗时',
        nextAction: '在装机环境跑一次 44.9 万段',
        why: '本机读数不能代表装机环境',
        confidence: 0.85,
        sourceSignalIds: ['sig_1', 'sig_missing'],
      },
      {
        projectDir: 'C:/work/alpha',
        projectName: 'alpha',
        firstSeen: '2026-11-01T10:00:00.000Z',
        lastSeen: '2026-11-10T10:00:00.000Z',
      },
    );

    const detail = buildLoopDetail(store, loop.id)!;
    expect(detail.ref).toBe(loopRef(loop.id));
    expect(detail.signals.map((signal) => signal.id)).toEqual(['sig_1']);
    expect(detail.missingSignalIds).toEqual(['sig_missing']);

    const output = formatLoopDetail(detail, new Date('2026-11-11T12:00:00.000Z'));
    expect(output).toContain('# 补大库耗时');
    expect(output).toContain(`[ref ${loopRef(loop.id)}]`);
    expect(output).toContain('来源**: 用户消息');
    expect(output).toContain('codex · user');
    expect(output).toContain('记得把大库耗时补上');
    expect(output).toContain('1 条来源 id 找不到对应消息');
  });

  it('caps the evidence list and reports how many were omitted', () => {
    const store = openStore();
    saveSignal(store, 'sig_1', '第一条', '2026-11-10T10:00:00.000Z');
    saveSignal(store, 'sig_2', '第二条', '2026-11-10T11:00:00.000Z');
    const { loop } = store.saveLoop(
      {
        title: '两条证据',
        nextAction: '继续',
        why: '测试',
        confidence: 0.8,
        sourceSignalIds: ['sig_1', 'sig_2'],
      },
      { projectDir: 'C:/work/alpha', projectName: 'alpha' },
    );

    const detail = buildLoopDetail(store, loop.id, 1)!;
    expect(detail.signals).toHaveLength(1);
    expect(detail.omittedSignalCount).toBe(1);
    expect(formatLoopDetail(detail)).toContain('还有 1 条来源未展示');
  });

  it('returns undefined for an unknown loop id', () => {
    const store = openStore();
    expect(buildLoopDetail(store, 'loop_missing')).toBeUndefined();
  });

  it('shows the latest feedback and noise suppression state', () => {
    const store = openStore();
    const { loop } = store.saveLoop(
      {
        title: '带反馈的循环',
        nextAction: '继续',
        why: '测试',
        confidence: 0.8,
        sourceSignalIds: ['sig_1'],
      },
      {
        projectDir: 'C:/work/alpha',
        projectName: 'alpha',
        firstSeen: '2026-11-11T09:00:00.000Z',
        lastSeen: '2026-11-11T09:00:00.000Z',
      },
    );
    store.recordFeedback(loop.id, 'noise', '不是要跟的事', '2026-11-11T10:00:00.000Z');

    const detail = buildLoopDetail(store, loop.id)!;
    expect(detail.latestFeedback).toMatchObject({ verdict: 'noise', note: '不是要跟的事' });
    expect(formatLoopDetail(detail)).toContain('最近反馈');
    expect(formatLoopDetail(detail)).toContain('噪音');
    expect(formatLoopDetail(detail)).toContain('有新证据前不回访');
  });
});
