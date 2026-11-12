import { describe, it, expect, vi } from 'vitest';
import {
  buildExtractionPrompt,
  buildResolutionPrompt,
  chatHeaders,
  extractLoops,
  extractResolutions,
  parseExtraction,
  LoopExtractionError,
  type ExtractInput,
} from '../src/loops/extractor.js';

describe('chatHeaders', () => {
  it('omits Authorization when no key is configured', () => {
    expect(chatHeaders(undefined)).toEqual({ 'Content-Type': 'application/json' });
  });

  it('sends a Bearer token when a key is configured', () => {
    expect(chatHeaders('sk-test')).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer sk-test',
    });
  });
});

const input: ExtractInput = {
  session: {
    agent: 'codex',
    sessionId: 's1',
    title: '登录页',
    projectDir: 'C:/work/alpha',
  },
  messages: [
    { id: 'm1', role: 'user', text: '登录页还差错误提示没做', timestamp: '2026-11-10T10:00:00Z' },
    { id: 'm2', role: 'assistant', text: '我接下来补错误提示。', timestamp: '2026-11-10T10:00:01Z' },
  ],
};

const valid = JSON.stringify({
  loops: [
    {
      title: '补齐登录页错误提示',
      next_action: '在登录失败时展示具体原因',
      why: '会话结束时还没做',
      confidence: 0.82,
      source_message_ids: ['m1', 'm2'],
    },
  ],
});

describe('parseExtraction', () => {
  it('parses valid JSON and maps snake_case fields', () => {
    const loops = parseExtraction(valid, new Set(['m1', 'm2']));
    expect(loops).toHaveLength(1);
    expect(loops[0]).toEqual({
      title: '补齐登录页错误提示',
      nextAction: '在登录失败时展示具体原因',
      why: '会话结束时还没做',
      confidence: 0.82,
      sourceMessageIds: ['m1', 'm2'],
    });
  });

  it('accepts fenced JSON', () => {
    expect(parseExtraction('```json\n' + valid + '\n```', new Set(['m1', 'm2']))).toHaveLength(1);
  });

  it('rejects a source id outside the whitelist', () => {
    const bad = valid.replace('"m2"', '"invented"');
    expect(() => parseExtraction(bad, new Set(['m1', 'm2']))).toThrow(LoopExtractionError);
    expect(() => parseExtraction(bad, new Set(['m1', 'm2']))).toThrow(/invented/);
  });

  it('resolves role-prefixed source ids without widening the whitelist', () => {
    const parsed = parseExtraction(valid, new Set(['m1', 'assistant:m2']));
    expect(parsed[0].sourceMessageIds).toContain('assistant:m2');
    expect(() => parseExtraction(
      valid.replace('"m2"', '"invented"'),
      new Set(['m1', 'assistant:m2']),
    )).toThrow(/invented/);
  });

  it('rejects non-numeric confidence', () => {
    const bad = valid.replace('0.82', '"0.82"');
    expect(() => parseExtraction(bad, new Set(['m1', 'm2']))).toThrow(/confidence/);
  });

  it('caps the batch and deduplicates normalized titles', () => {
    const loops = Array.from({ length: 7 }, (_, index) => ({
      title: index === 1 ? '补齐登录页错误提示！' : `任务 ${index}`,
      next_action: `下一步 ${index}`,
      why: `原因 ${index}`,
      confidence: 0.8,
      source_message_ids: ['m1'],
    }));
    const parsed = parseExtraction(JSON.stringify({ loops }), new Set(['m1', 'm2']));
    expect(parsed).toHaveLength(3);
    expect(parsed.filter((loop) => loop.title.includes('补齐登录页错误提示'))).toHaveLength(1);
  });

  it('truncates a long action at a sentence boundary instead of mid-sentence', () => {
    const longAction = '退出旧进程并确认托盘已关闭。启动新包并确认版本号。读取日志确认配置行。补全屏回签。补语义搜索回签。补稳定性复点。'.repeat(3);
    const raw = JSON.stringify({
      loops: [{
        title: '补齐三项真机回签',
        next_action: longAction,
        why: '会话结束时还没做',
        confidence: 0.82,
        source_message_ids: ['m1'],
      }],
    });

    const parsed = parseExtraction(raw, new Set(['m1']));

    expect(parsed[0].nextAction.length).toBeLessThanOrEqual(120);
    expect(parsed[0].nextAction.length).toBeGreaterThan(60);
    expect(parsed[0].nextAction.endsWith('。')).toBe(true);
    expect(parsed[0].nextAction).not.toContain('…');
  });

  it('marks a long action with ellipsis when there is no sentence boundary', () => {
    const longAction = 'a'.repeat(200);
    const raw = JSON.stringify({
      loops: [{
        title: '补齐三项真机回签',
        next_action: longAction,
        why: '会话结束时还没做',
        confidence: 0.82,
        source_message_ids: ['m1'],
      }],
    });

    const parsed = parseExtraction(raw, new Set(['m1']));

    expect(parsed[0].nextAction).toHaveLength(120);
    expect(parsed[0].nextAction.endsWith('…')).toBe(true);
  });

  it('accepts a merge target only from the current project whitelist', () => {
    const withMerge = JSON.stringify({
      loops: [{
        title: '首屏性能回归',
        next_action: '抓 trace 对比',
        why: '同一目标',
        confidence: 0.9,
        source_message_ids: ['m1'],
        merge_into: 'loop_existing',
      }],
    });
    const parsed = parseExtraction(withMerge, new Set(['m1']), {
      allowedMergeIds: new Set(['loop_existing']),
    });
    expect(parsed[0].mergeInto).toBe('loop_existing');

    expect(() => parseExtraction(withMerge, new Set(['m1']), {
      allowedMergeIds: new Set(['loop_other']),
    })).toThrow(/merge_into/);
  });

  it('puts existing loops into the extraction prompt', () => {
    const prompt = buildExtractionPrompt({
      ...input,
      existingLoops: [{
        id: 'loop_existing',
        title: '首页加载慢',
        nextAction: '定位首屏请求',
        status: 'open',
        confidence: 0.8,
        lastSeen: '2026-11-10T10:00:00Z',
      }],
    });
    expect(prompt[1].content).toContain('[loop_existing]');
    expect(prompt[0].content).toContain('merge_into');
    expect(prompt[0].content).toContain('确认语');
  });

  it('tells the extractor not to turn assistant status snapshots into loops', () => {
    const prompt = buildExtractionPrompt(input);
    expect(prompt[0].content).toContain('状态快照');
    expect(prompt[0].content).toContain('仍为 0');
    expect(prompt[0].content).toContain('不要提取');
  });

  it('keeps a 2,050-character reply intact', () => {
    const text = [
      '开头：下面是对比结论。',
      '中间细节。'.repeat(395),
      '两个必须知道的问题：1. 幻觉率 89%。2. 团队承认差距。',
    ].join('');
    const prompt = buildExtractionPrompt({
      ...input,
      messages: [{
        id: 'long-reply',
        role: 'assistant',
        text,
        timestamp: '2026-11-10T10:00:02Z',
      }],
    });

    expect(text.length).toBeGreaterThan(2_000);
    expect(text.length).toBeLessThan(2_400);
    expect(prompt[1].content).toContain('两个必须知道的问题');
    expect(prompt[1].content).not.toContain('提取器省略中间');
  });

  it('keeps both the head and tail of a message over 2,400 characters', () => {
    const prompt = buildExtractionPrompt({
      ...input,
      messages: [{
        id: 'long-reply',
        role: 'assistant',
        text: [
          '开头：下面是对比结论。',
          '中间细节。'.repeat(600),
          '两个必须知道的问题：1. 幻觉率 89%。2. 团队承认差距。',
        ].join(''),
        timestamp: '2026-11-10T10:00:02Z',
      }],
    });

    expect(prompt[1].content).toContain('开头：下面是对比结论。');
    expect(prompt[1].content).toContain('两个必须知道的问题');
    expect(prompt[1].content).toContain('提取器省略中间');
    expect(prompt[1].content).toContain('原文完整');
    expect(prompt[0].content).toContain('不是原消息缺失');
  });

  it('leaves a short message untouched and unmarked', () => {
    const prompt = buildExtractionPrompt(input);

    expect(prompt[1].content).toContain('我接下来补错误提示。');
    expect(prompt[1].content).not.toContain('提取器省略中间');
  });

  it('includes more than 20 existing loops in the extraction prompt', () => {
    const existingLoops = Array.from({ length: 25 }, (_, index) => ({
      id: `loop_${index}`,
      title: `任务 ${index}`,
      nextAction: `下一步 ${index}`,
      status: 'open',
      confidence: 0.8,
      lastSeen: '2026-11-10T10:00:00Z',
    }));

    const prompt = buildExtractionPrompt({ ...input, existingLoops });

    expect(prompt[1].content).toContain('[loop_24]');
    expect(prompt[1].content).toContain('任务 24');
  });

  it('includes more than 20 existing loops in the resolution prompt', () => {
    const loops = Array.from({ length: 25 }, (_, index) => ({
      id: `loop_${index}`,
      title: `任务 ${index}`,
      nextAction: `下一步 ${index}`,
      status: 'open',
      confidence: 0.8,
      lastSeen: '2026-11-10T10:00:00Z',
    }));

    const prompt = buildResolutionPrompt({
      session: input.session,
      loops,
      messages: input.messages,
    });

    expect(prompt[1].content).toContain('[loop_24]');
    expect(prompt[1].content).toContain('任务 24');
    expect(prompt[0].content).toContain('状态已被更新');
    expect(prompt[0].content).toContain('上下文压缩标记');
  });

  it('can widen the resolution transcript window for older evidence', () => {
    const messages = [
      {
        id: 'old-status',
        role: 'assistant' as const,
        text: '反馈已按 5 条 forgotten 写入。',
        timestamp: '2026-11-11T08:15:00.000Z',
      },
      ...Array.from({ length: 20 }, (_, index) => ({
        id: `progress-${index}`,
        role: 'assistant' as const,
        text: `进度 ${index}`,
        timestamp: `2026-11-11T09:00:${String(index).padStart(2, '0')}.000Z`,
      })),
    ];

    const prompt = buildResolutionPrompt({
      session: input.session,
      loops: [],
      messages,
      maxMessages: 30,
    });

    expect(prompt[1].content).toContain('[old-status]');
    expect(prompt[1].content).toContain('@ 2026-11-11T08:15:00.000Z');
  });

  it('keeps the earliest user request when the tail is assistant-only', () => {
    const prompt = buildExtractionPrompt({
      ...input,
      messages: [
        { id: 'u1', role: 'user', text: '目标：完成 DSH 迁移', timestamp: '2026-11-10T10:00:00Z' },
        ...Array.from({ length: 15 }, (_, index) => ({
          id: `a${index}`,
          role: 'assistant' as const,
          text: `进度 ${index}`,
          timestamp: `2026-11-10T10:00:${String(index + 1).padStart(2, '0')}Z`,
        })),
      ],
    });
    expect(prompt[1].content).toContain('目标：完成 DSH 迁移');
    expect(prompt[1].content).toContain('进度 14');
  });
});

describe('extractLoops', () => {
  it('retries once after a parse failure and then succeeds', async () => {
    const chat = vi.fn()
      .mockResolvedValueOnce('{"loops": [')
      .mockResolvedValueOnce(valid);

    const loops = await extractLoops(input, { chat });
    expect(chat).toHaveBeenCalledTimes(2);
    expect(loops).toHaveLength(1);
  });

  it('fails after two invalid outputs', async () => {
    const chat = vi.fn().mockResolvedValue('not json at all');
    await expect(extractLoops(input, { chat })).rejects.toThrow(LoopExtractionError);
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it('requires an explicit endpoint when no chat is injected', async () => {
    await expect(extractLoops(input, { baseUrl: '' })).rejects.toThrow(/LOOPSTEWARD_BASE_URL/);
  });

  it('requires an explicit model when no chat is injected', async () => {
    await expect(
      extractLoops(input, { baseUrl: 'https://api.openai.com/v1', model: '' }),
    ).rejects.toThrow(/LOOPSTEWARD_MODEL/);
  });

  it('wraps transport errors and retries once', async () => {
    const chat = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(valid);

    const loops = await extractLoops(input, { chat });
    expect(loops).toHaveLength(1);
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it('downgrades a loop when every cited message is only an acknowledgement', async () => {
    const weakInput: ExtractInput = {
      ...input,
      messages: [
        { id: 'w1', role: 'user', text: '继续', timestamp: '2026-11-10T10:00:00Z' },
        { id: 'w2', role: 'assistant', text: '还需要补上错误提示和回归测试。', timestamp: '2026-11-10T10:00:01Z' },
      ],
    };
    const chat = vi.fn().mockResolvedValue(JSON.stringify({
      loops: [{
        title: '补齐登录页错误提示',
        next_action: '补错误提示和回归测试',
        why: '会话结束时还没做',
        confidence: 0.9,
        source_message_ids: ['w1'],
      }],
    }));

    const loops = await extractLoops(weakInput, { chat });
    expect(loops).toHaveLength(1);
    expect(loops[0].confidence).toBe(0.55);
  });
});

describe('extractResolutions', () => {
  it('raises the output budget when the provider spends it all on reasoning', async () => {
    const chat = vi.fn()
      .mockRejectedValueOnce(new LoopExtractionError(
        'transport',
        '模型服务返回 HTTP 502: an empty reply (the model answered nothing; try again) — cut at its length, the whole output spent on reasoning',
      ))
      .mockResolvedValueOnce('{"resolved":[]}');

    await extractResolutions({
      session: input.session,
      loops: [],
      messages: input.messages,
    }, { chat });

    expect(chat).toHaveBeenCalledTimes(2);
    const retryOptions = chat.mock.calls[1][1] as { maxTokens: number };
    expect(retryOptions.maxTokens).toBe(8_192);
    const retryMessages = chat.mock.calls[1][0] as Array<{ content: string }>;
    expect(retryMessages.at(-1)?.content).toContain('输出预算');
  });

  it('keeps the normal budget on a parse retry', async () => {
    const chat = vi.fn()
      .mockResolvedValueOnce('not json')
      .mockResolvedValueOnce('{"resolved":[]}');

    await extractResolutions({
      session: input.session,
      loops: [],
      messages: input.messages,
    }, { chat });

    const retryOptions = chat.mock.calls[1][1] as { maxTokens: number };
    expect(retryOptions.maxTokens).toBe(4_096);
  });
});
