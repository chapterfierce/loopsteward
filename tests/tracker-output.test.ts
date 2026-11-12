import { describe, expect, it } from 'vitest';
import { isTrackerOutputMessage } from '../src/loops/evidence.js';

describe('isTrackerOutputMessage', () => {
  it('detects every tracker digest header', () => {
    for (const text of [
      '# 今天提过 · 3 条\n\n1. **回访配额**',
      '# 本周回顾 · 1 条\n\n1. **旧库存**',
      '# 每周回顾 · 15 条\n\n## example-project',
      '# 回访 · 5 条\n\n1. **登录提示**',
      '# 回访校准 · 5 条\n\n1. **登录提示**',
      '# 开放循环审计\n\n- 弱证据 4',
    ]) {
      expect(isTrackerOutputMessage({ role: 'assistant', text })).toBe(true);
    }
  });

  it('detects tracker output by its reply footer', () => {
    expect(isTrackerOutputMessage({
      role: 'assistant',
      text: '还有 217 条没进这一批；说“继续看”看下一批。\n\n回编号或 ref 看下一步和依据。',
    })).toBe(true);
    expect(isTrackerOutputMessage({
      role: 'assistant',
      text: '本轮还有 198 条没看；说“继续看”看下一批。\n\n回编号或 ref 看下一步和依据。',
    })).toBe(true);
    expect(isTrackerOutputMessage({
      role: 'assistant',
      text: '本轮已经看完；说“继续看”从头再看一轮。',
    })).toBe(true);
    expect(isTrackerOutputMessage({
      role: 'assistant',
      text: '确认已完成就说“关闭这条”；确实忘了或噪音，也回编号说一声。',
    })).toBe(true);
    expect(isTrackerOutputMessage({
      role: 'assistant',
      text: '回复格式：编号 + 判断，例如「1 忘了」「2 噪音」「3 跳过」。只记“忘了/噪音”，跳过不算样本。',
    })).toBe(true);
    expect(isTrackerOutputMessage({
      role: 'assistant',
      text: '今天 3 条新回访已用完；这几条不占新预算。',
    })).toBe(true);
    expect(isTrackerOutputMessage({
      role: 'assistant',
      text: '其中 5 条把握不高；说“看待确认”单独看。',
    })).toBe(true);
    expect(isTrackerOutputMessage({
      role: 'assistant',
      text: '想让我现在处理，就说“做第 N 条”；我会先查证据再动手。',
    })).toBe(true);
    expect(isTrackerOutputMessage({
      role: 'assistant',
      text: '回复示例：“1 忘了”“2 噪音”“3 已完成”；要细节就回编号。',
    })).toBe(true);
  });

  it('does not flag ordinary assistant or user messages', () => {
    expect(isTrackerOutputMessage({
      role: 'assistant',
      text: '下一步补登录错误提示。',
    })).toBe(false);
    expect(isTrackerOutputMessage({
      role: 'user',
      text: '# 今天提过 · 3 条\n\n这只是引用。',
    })).toBe(false);
  });
});
