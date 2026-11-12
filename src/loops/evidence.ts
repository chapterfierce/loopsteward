import type { ExtractedLoop, SessionMessage } from './types.js';

const GENERIC_WORDS = new Set([
  'ok',
  'okay',
  'yes',
  'go',
  '继续',
  '推进',
  '做吧',
  '干吧',
  '都做',
  '好',
  '好的',
  '行',
  '行啊',
  '可以',
  '嗯',
  '对',
  '是',
  '收到',
  '明白',
  '了解',
  '你看着办',
  '汇报进展',
  '汇报一下进展',
  '就这些吗',
  '还有呢',
  '然后呢',
]);

const TRACKER_HEADER = /^\s*#\s*(?:今天提过|本周回顾|每周回顾|回访校准|回访|开放循环审计)(?:\s*·[^\n]*)?\s*(?:\n|$)/u;
const TRACKER_MARKERS = [
  /回编号或 ref 看下一步和依据/u,
  /确认已完成就说.{0,4}关闭这条/u,
  /回复格式:编号 \+ 判断/u,
  /只记.{0,2}忘了\/噪音/u,
  /今天已有 \d+ 条回访记录/u,
  /今天 \d+ 条新回访已用完;这几条不占新预算/u,
  /这几条里,哪条已经完成、哪条是你确实忘了、哪条是噪音/u,
  /回复示例.{0,4}1 忘了/u,
  /想让我现在处理.{0,4}说.{0,4}做第 [N\d]+ 条/u,
  /另有 \d+ 条已标为噪音/u,
  /还有 \d+ 条未闭环/u,
  /还有 \d+ 条没进这一批;说.{0,2}继续看/u,
  /本轮还有 \d+ 条没看;说.{0,2}继续看/u,
  /本轮已经看完;说.{0,2}继续看/u,
  /其中 \d+ 条把握不高;说.{0,2}看待确认/u,
];

export function isTrackerOutputMessage(
  message: Pick<SessionMessage, 'role' | 'text'>,
): boolean {
  if (message.role !== 'assistant') return false;
  const text = message.text.normalize('NFKC');
  if (TRACKER_HEADER.test(text)) return true;
  return TRACKER_MARKERS.some((marker) => marker.test(text));
}

export function isWeakEvidenceMessage(
  message: Pick<SessionMessage, 'role' | 'text'>,
): boolean {
  const text = message.text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return true;
  const parts = text
    .split(/[\s,，。.!！?？、;；:：~～]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 && parts.every((part) => GENERIC_WORDS.has(part));
}

export function hasDirectEvidence(
  messages: SessionMessage[],
  sourceMessageIds: string[],
): boolean {
  const byId = new Map(messages.map((message) => [message.id, message]));
  return sourceMessageIds.some((id) => {
    const message = byId.get(id);
    return message ? !isWeakEvidenceMessage(message) : false;
  });
}

export function downgradeWeakEvidence(
  loops: ExtractedLoop[],
  messages: SessionMessage[],
): ExtractedLoop[] {
  return loops.map((loop) => {
    if (hasDirectEvidence(messages, loop.sourceMessageIds)) return loop;
    return {
      ...loop,
      confidence: Math.min(loop.confidence, 0.55),
    };
  });
}
