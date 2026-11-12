import type {
  ExtractedLoop,
  ResolvedLoop,
  SessionAgent,
  SessionMessage,
} from './types.js';
import { downgradeWeakEvidence } from './evidence.js';

export interface ExtractInput {
  session: {
    agent: SessionAgent;
    sessionId: string;
    title: string;
    projectDir: string;
  };
  messages: SessionMessage[];
  existingLoops?: ExistingLoopRef[];
}

export interface ResolveInput {
  session: {
    agent: SessionAgent;
    sessionId: string;
    title: string;
    projectDir: string;
  };
  loops: ExistingLoopRef[];
  messages: SessionMessage[];
  maxMessages?: number;
}

export interface ExistingLoopRef {
  id: string;
  title: string;
  nextAction: string;
  status: string;
  confidence: number;
  lastSeen: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type ChatFn = (
  messages: ChatMessage[],
  options: { model: string; maxTokens: number },
) => Promise<string>;

export interface ExtractOptions {
  chat?: ChatFn;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxLoops?: number;
  maxTokens?: number;
  retries?: number;
  minConfidence?: number;
  tolerateUnknownEvidence?: boolean;
}

export type ExtractionErrorKind = 'parse' | 'validation' | 'transport';

export class LoopExtractionError extends Error {
  constructor(
    public readonly kind: ExtractionErrorKind,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'LoopExtractionError';
  }
}

export const DEFAULT_MODEL = 'local-model';
export const DEFAULT_BASE_URL = 'http://127.0.0.1:11434/v1';
const MAX_TRANSCRIPT_MESSAGES = 12;
const MAX_MESSAGE_CHARS = 2_400;
const MESSAGE_TAIL_CHARS = 1_200;
const MESSAGE_HEAD_CHARS = MAX_MESSAGE_CHARS - MESSAGE_TAIL_CHARS;
const MAX_EXISTING_LOOPS = 40;
const RESOLUTION_MAX_TOKENS = 4_096;
const RESOLUTION_RETRY_MAX_TOKENS = 8_192;

const SYSTEM_PROMPT = [
  '你是“开放循环”提取器。输入是一段 AI 编程会话的尾部消息。',
  '只提取真正未闭环的事：未完成任务、未解决 bug、承诺的下一步、已知剩余项、待用户拍板的决定。',
  '不要提取：长期偏好、规则、已完成的事、背景事实、泛泛建议、单纯的情绪表达。',
  '助手自己的进度汇报、状态快照、测试计数、反馈计数、提交状态（例如“仍为 0”“只到 M65”“未提交”“全绿”）本身不是未闭环事项；只有同一段话里明确写出未完成动作、待验证项或待用户拍板决策时才提取。',
  '不要把标题写成“某状态仍为 X”这种快照；标题必须落到可执行的下一步。如果给不出下一步，就不要提取。',
  '没有就返回空数组。只输出 JSON，不要 Markdown、代码围栏或解释。',
  '',
  'JSON schema:',
  '{"loops":[{"title":"...","next_action":"...","why":"...","confidence":0.0,"source_message_ids":["..."],"merge_into":"loop_xxx 或 null"}]}',
  '',
  '要求：',
  '- 最多 3 条，按重要性排序；只保留最可能被遗忘、且下一步明确的事项。',
  '- title ≤ 60 字，next_action ≤ 120 字，why ≤ 120 字。',
  '- confidence 是 0 到 1 的数字，表示“这确实是一件会被遗忘的未闭环事项”。',
  '- source_message_ids 只能使用输入里出现过的消息 id，至少一个。',
  '- source_message_ids 必须引用直接写出这个任务、bug、剩余项或决策的消息，优先引用助手消息；不要把“继续”“好”“行啊”“你看着办”等确认语当作证据。',
  '- 输入里的“提取器省略中间 N 字，原文完整”是上下文压缩标记，不是原消息缺失；不要因此提取“回复被截断/正文缺失/内容未写完”这类循环。只有消息本身明确以未完成句子结尾且没有该标记时，才可视为原回复不完整。',
  '- merge_into 只能使用“已有未闭环事项”里出现过的 loop id；不是同一件事就填 null。',
  '- 判断同一件事看交付物、bug、决策目标，不要只看措辞；同一目标的不同说法必须合并。',
  '- 不要提取“让用户从若干项里挑一项/指定方向”这类元事项；直接提取被列出的具体未完成项。',
  '- 同一主题下多个子项，如果下一步相同就合并成一条；下一步不同才分别列出。',
  '- 同一件事只输出一次。',
].join('\n');

const RESOLUTION_PROMPT = [
  '你是“开放循环”核对器。输入是一个项目已有的未闭环事项，以及一段 AI 会话的消息（尾部 + 可能相关的较早状态更新）。',
  '你的任务：只判断哪些已有事项已经被这段会话明确完成、明确放弃，或用户已经明确拍板。',
  '不要因为话题相关、计划变化、用户说“继续”、或只是又讨论了一次就标记完成。',
  '必须有一条会话消息能直接证明该事项已经闭环；没有证据就不要输出。',
  '如果事项的标题或下一步是当时的数量/版本状态（例如“反馈仍为 0”“只写到 M65”“未提交”），而会话消息明确给出了更新的状态并否定了旧断言，可以判为已完成或已过期，reason 写“状态已被更新”。',
  '只做逐条对应；不要因为出现更大数字、更新版本或泛泛进展就推断旧事项已完成。',
  '输入里的“提取器省略中间 N 字，原文完整”是上下文压缩标记；不能因为中间被省略就判断事项未完成或缺少证据，只能按可见内容判断。',
  '消息按时间排序；较早的消息也可能包含状态更新，必须同样逐条核对。',
  '没有就返回空数组。只输出 JSON，不要 Markdown、代码围栏或解释。',
  '',
  'JSON schema:',
  '{"resolved":[{"loop_id":"loop_xxx","confidence":0.0,"reason":"...","evidence_message_ids":["..."]}]}',
  '',
  '要求：',
  '- 最多 10 条，按证据强度排序；不要为了凑数输出弱证据。',
  '- loop_id 只能使用输入里出现过的已有事项 id。',
  '- evidence_message_ids 只能使用输入消息里出现过的 id，至少一个。',
  '- reason ≤ 100 字，写清是“已完成”“已放弃”还是“已拍板”。',
  '- confidence 是 0 到 1 的数字，表示该事项确实已闭环。',
].join('\n');

function messageText(message: SessionMessage): string {
  const cleaned = message.text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= MAX_MESSAGE_CHARS) return cleaned;
  const omitted = cleaned.length - MESSAGE_HEAD_CHARS - MESSAGE_TAIL_CHARS;
  return [
    cleaned.slice(0, MESSAGE_HEAD_CHARS),
    `…[提取器省略中间 ${omitted} 字，原文完整]…`,
    cleaned.slice(-MESSAGE_TAIL_CHARS),
  ].join(' ');
}

function isOutputBudgetError(message: string): boolean {
  return /empty reply|cut at its length|输出预算|reasoning/i.test(message);
}

function promptTail(messages: SessionMessage[], maxMessages = MAX_TRANSCRIPT_MESSAGES): SessionMessage[] {
  const usable = messages.filter((message) => message.text.trim().length > 0);
  if (usable.length <= maxMessages) return usable;
  const recent = usable.slice(-maxMessages);
  if (recent.some((message) => message.role === 'user')) return recent;
  const firstUser = usable.find((message) => message.role === 'user');
  if (!firstUser) return recent;
  return [firstUser, ...usable.slice(-(maxMessages - 1))];
}

export function buildExtractionPrompt(input: ExtractInput): ChatMessage[] {
  const messages = promptTail(input.messages);
  const lines = messages.map((message) => `[${message.id}] ${message.role}: ${messageText(message)}`);
  const existing = (input.existingLoops ?? [])
    .slice(0, MAX_EXISTING_LOOPS)
    .map((loop) => `[${loop.id}] ${loop.title} | ${loop.status} | ${Math.round(loop.confidence * 100)}% | next: ${loop.nextAction}`);
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        `项目: ${input.session.projectDir}`,
        `会话: ${input.session.agent}/${input.session.sessionId} (${input.session.title})`,
        '',
        '已有未闭环事项:',
        ...(existing.length > 0 ? existing : ['（无）']),
        '如果本次发现与上面某条是同一交付物、同一 bug 或同一决策，merge_into 填对应 id；否则填 null。',
        '',
        '消息:',
        ...lines,
      ].join('\n'),
    },
  ];
}

function extractJsonText(raw: string): string {
  const withoutFence = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new LoopExtractionError('parse', '模型输出里没有完整的 JSON 对象');
  }
  return withoutFence.slice(start, end + 1);
}

function normalizedTitle(title: string): string {
  return title.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new LoopExtractionError('validation', `${field} 必须是非空字符串`);
  }
  return value.trim();
}

function truncateAtBoundary(value: string, max: number): string {
  if (value.length <= max) return value;
  const window = value.slice(0, max);
  const sentence = Math.max(
    window.lastIndexOf('。'),
    window.lastIndexOf('！'),
    window.lastIndexOf('？'),
    window.lastIndexOf('；'),
    window.lastIndexOf('!'),
    window.lastIndexOf('?'),
    window.lastIndexOf(';'),
  );
  if (sentence >= Math.floor(max * 0.5)) return window.slice(0, sentence + 1);
  const clause = Math.max(
    window.lastIndexOf('，'),
    window.lastIndexOf('、'),
    window.lastIndexOf(','),
  );
  if (clause >= Math.floor(max * 0.5)) return `${window.slice(0, clause)}…`;
  return `${window.slice(0, max - 1)}…`;
}

export function parseExtraction(
  raw: string,
  allowedMessageIds: Set<string>,
  maxLoopsOrOptions: number | { maxLoops?: number; allowedMergeIds?: Set<string> } = 3,
): ExtractedLoop[] {
  const options = typeof maxLoopsOrOptions === 'number'
    ? { maxLoops: maxLoopsOrOptions, allowedMergeIds: undefined }
    : maxLoopsOrOptions;
  const maxLoops = options.maxLoops ?? 3;
  let data: any;
  try {
    data = JSON.parse(extractJsonText(raw));
  } catch (error) {
    if (error instanceof LoopExtractionError) throw error;
    throw new LoopExtractionError('parse', `JSON 解析失败: ${(error as Error).message}`);
  }

  if (!data || typeof data !== 'object' || !Array.isArray(data.loops)) {
    throw new LoopExtractionError('validation', '顶层必须是 {"loops": [...]}');
  }

  const loops: ExtractedLoop[] = [];
  const seenTitles = new Map<string, number>();

  for (const [index, item] of data.loops.entries()) {
    if (!item || typeof item !== 'object') {
      throw new LoopExtractionError('validation', `loops[${index}] 必须是对象`);
    }
    const title = truncateAtBoundary(
      asNonEmptyString(item.title, `loops[${index}].title`),
      60,
    );
    const nextAction = truncateAtBoundary(
      asNonEmptyString(item.next_action, `loops[${index}].next_action`),
      120,
    );
    const why = truncateAtBoundary(
      asNonEmptyString(item.why, `loops[${index}].why`),
      120,
    );

    if (typeof item.confidence !== 'number' || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) {
      throw new LoopExtractionError('validation', `loops[${index}].confidence 必须是 0 到 1 的数字`);
    }
    if (!Array.isArray(item.source_message_ids) || item.source_message_ids.length === 0) {
      throw new LoopExtractionError('validation', `loops[${index}].source_message_ids 必须是非空数组`);
    }

    const sourceMessageIds: string[] = [];
    for (const id of item.source_message_ids) {
      const resolvedId = typeof id === 'string'
        ? resolveAllowedMessageId(id, allowedMessageIds)
        : null;
      if (!resolvedId) {
        throw new LoopExtractionError(
          'validation',
          `loops[${index}] 引用了不在本批次白名单里的来源 id: ${String(id)}`,
        );
      }
      if (!sourceMessageIds.includes(resolvedId)) sourceMessageIds.push(resolvedId);
    }

    let mergeInto: string | undefined;
    if (item.merge_into !== undefined && item.merge_into !== null) {
      if (
        typeof item.merge_into !== 'string'
        || !options.allowedMergeIds
        || !options.allowedMergeIds.has(item.merge_into)
      ) {
        throw new LoopExtractionError(
          'validation',
          `loops[${index}] 引用了未知的 merge_into: ${String(item.merge_into)}`,
        );
      }
      mergeInto = item.merge_into;
    }

    const key = normalizedTitle(title);
    if (!key) continue;
    const existingIndex = seenTitles.get(key);
    if (existingIndex !== undefined) {
      if (mergeInto && !loops[existingIndex].mergeInto) {
        loops[existingIndex] = { ...loops[existingIndex], mergeInto };
      }
      continue;
    }
    seenTitles.set(key, loops.length);
    loops.push({
      title,
      nextAction,
      why,
      confidence: item.confidence,
      sourceMessageIds,
      ...(mergeInto ? { mergeInto } : {}),
    });
    if (loops.length >= maxLoops) break;
  }

  return loops;
}

export function buildResolutionPrompt(input: ResolveInput): ChatMessage[] {
  const messages = promptTail(input.messages, input.maxMessages);
  const lines = messages.map((message) => {
    const stamp = message.timestamp ? ` @ ${message.timestamp}` : '';
    return `[${message.id}] ${message.role}${stamp}: ${messageText(message)}`;
  });
  const loops = input.loops
    .slice(0, MAX_EXISTING_LOOPS)
    .map((loop) => `[${loop.id}] ${loop.title} | next: ${loop.nextAction}`);
  return [
    { role: 'system', content: RESOLUTION_PROMPT },
    {
      role: 'user',
      content: [
        `项目: ${input.session.projectDir}`,
        `会话: ${input.session.agent}/${input.session.sessionId} (${input.session.title})`,
        '',
        '已有未闭环事项:',
        ...loops,
        '',
        '消息:',
        ...lines,
      ].join('\n'),
    },
  ];
}

function resolveAllowedMessageId(id: string, allowed: Set<string>): string | null {
  if (allowed.has(id)) return id;
  for (const prefix of ['assistant:', 'user:']) {
    if (allowed.has(`${prefix}${id}`)) return `${prefix}${id}`;
    if (id.startsWith(prefix) && allowed.has(id.slice(prefix.length))) {
      return id.slice(prefix.length);
    }
  }
  return null;
}

export function parseResolutions(
  raw: string,
  allowedMessageIds: Set<string>,
  allowedLoopIds: Set<string>,
  minConfidence = 0.85,
  options: { tolerateUnknownEvidence?: boolean } = {},
): ResolvedLoop[] {
  let data: any;
  try {
    data = JSON.parse(extractJsonText(raw));
  } catch (error) {
    if (error instanceof LoopExtractionError) throw error;
    throw new LoopExtractionError('parse', `JSON 解析失败: ${(error as Error).message}`);
  }

  if (!data || typeof data !== 'object' || !Array.isArray(data.resolved)) {
    throw new LoopExtractionError('validation', '顶层必须是 {"resolved": [...]}');
  }

  const resolutions = new Map<string, ResolvedLoop>();
  for (const [index, item] of data.resolved.entries()) {
    if (!item || typeof item !== 'object') {
      throw new LoopExtractionError('validation', `resolved[${index}] 必须是对象`);
    }
    if (typeof item.loop_id !== 'string' || !allowedLoopIds.has(item.loop_id)) {
      throw new LoopExtractionError(
        'validation',
        `resolved[${index}] 引用了未知的 loop_id: ${String(item.loop_id)}`,
      );
    }
    if (
      typeof item.confidence !== 'number'
      || !Number.isFinite(item.confidence)
      || item.confidence < 0
      || item.confidence > 1
    ) {
      throw new LoopExtractionError('validation', `resolved[${index}].confidence 必须是 0 到 1 的数字`);
    }
    if (!Array.isArray(item.evidence_message_ids) || item.evidence_message_ids.length === 0) {
      throw new LoopExtractionError(
        'validation',
        `resolved[${index}].evidence_message_ids 必须是非空数组`,
      );
    }
    const evidenceMessageIds: string[] = [];
    for (const id of item.evidence_message_ids) {
      const resolvedId = typeof id === 'string'
        ? resolveAllowedMessageId(id, allowedMessageIds)
        : null;
      if (!resolvedId) {
        if (options.tolerateUnknownEvidence) continue;
        throw new LoopExtractionError(
          'validation',
          `resolved[${index}] 引用了不在本批次白名单里的来源 id: ${String(id)}`,
        );
      }
      if (!evidenceMessageIds.includes(resolvedId)) evidenceMessageIds.push(resolvedId);
    }
    if (evidenceMessageIds.length === 0) {
      if (options.tolerateUnknownEvidence) continue;
      throw new LoopExtractionError(
        'validation',
        `resolved[${index}] 没有可用的来源 id`,
      );
    }
    const reason = truncateAtBoundary(
      asNonEmptyString(item.reason, `resolved[${index}].reason`),
      100,
    );
    if (item.confidence < minConfidence) continue;
    const previous = resolutions.get(item.loop_id);
    if (!previous || item.confidence > previous.confidence) {
      resolutions.set(item.loop_id, {
        loopId: item.loop_id,
        confidence: item.confidence,
        reason,
        evidenceMessageIds,
      });
    }
  }

  return [...resolutions.values()]
    .sort((left, right) => right.confidence - left.confidence)
    .slice(0, 10);
}

export function chatHeaders(apiKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

function createDefaultChat(baseUrl: string, timeoutMs: number): ChatFn {
  return async (messages, options) => {
    const endpoint = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: chatHeaders(process.env.MAGPIE_API_KEY),
        body: JSON.stringify({
          model: options.model,
          messages,
          temperature: 0.1,
          max_tokens: options.maxTokens,
          stream: false,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new LoopExtractionError('transport', `调用 Magpie 失败: ${(error as Error).message}`);
    }

    const bodyText = await response.text();
    if (!response.ok) {
      throw new LoopExtractionError(
        'transport',
        `Magpie 返回 HTTP ${response.status}: ${bodyText.slice(0, 300)}`,
      );
    }

    let body: any;
    try {
      body = JSON.parse(bodyText);
    } catch {
      throw new LoopExtractionError('transport', 'Magpie 返回的不是 JSON');
    }
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content === 'string' && content.trim()) return content;
    if (Array.isArray(content)) {
      const text = content
        .map((part: any) => typeof part === 'string' ? part : part?.text ?? '')
        .join('');
      if (text.trim()) return text;
    }
    throw new LoopExtractionError('transport', 'Magpie 返回里没有 choices[0].message.content');
  };
}

export async function extractLoops(
  input: ExtractInput,
  options: ExtractOptions = {},
): Promise<ExtractedLoop[]> {
  const model = options.model ?? process.env.MAGPIE_MODEL ?? DEFAULT_MODEL;
  const baseUrl = options.baseUrl ?? process.env.MAGPIE_BASE_URL ?? DEFAULT_BASE_URL;
  const chat = options.chat ?? createDefaultChat(baseUrl, options.timeoutMs ?? 120_000);
  const maxLoops = options.maxLoops ?? 3;
  const maxTokens = options.maxTokens ?? 2_400;
  const retries = options.retries ?? 1;
  const allowed = new Set(input.messages.map((message) => message.id));
  const allowedMergeIds = new Set((input.existingLoops ?? []).map((loop) => loop.id));
  const messages = buildExtractionPrompt(input);
  let lastError: Error | null = null;
  let lastRaw = '';

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const attemptMessages = attempt === 0
      ? messages
      : [
        ...messages,
        {
          role: 'user' as const,
          content: [
            `上一次输出不合法：${lastError?.message ?? '未知错误'}。`,
            lastRaw ? `上次输出片段：${lastRaw.slice(-800)}` : '',
            '请重新只输出一个完整、可解析的 JSON 对象，不要解释，不要 Markdown。',
          ].filter(Boolean).join('\n'),
        },
      ];
    try {
      const raw = await chat(attemptMessages, { model, maxTokens });
      lastRaw = raw;
      return downgradeWeakEvidence(
        parseExtraction(raw, allowed, { maxLoops, allowedMergeIds }),
        input.messages,
      );
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  if (lastError instanceof LoopExtractionError) throw lastError;
  throw new LoopExtractionError('transport', lastError?.message ?? '提取失败');
}

export async function extractResolutions(
  input: ResolveInput,
  options: ExtractOptions = {},
): Promise<ResolvedLoop[]> {
  const model = options.model ?? process.env.MAGPIE_MODEL ?? DEFAULT_MODEL;
  const baseUrl = options.baseUrl ?? process.env.MAGPIE_BASE_URL ?? DEFAULT_BASE_URL;
  const chat = options.chat ?? createDefaultChat(baseUrl, options.timeoutMs ?? 120_000);
  const minConfidence = options.minConfidence ?? 0.85;
  const maxTokens = options.maxTokens ?? RESOLUTION_MAX_TOKENS;
  const retries = options.retries ?? 1;
  const allowedMessages = new Set(input.messages.map((message) => message.id));
  const allowedLoops = new Set(input.loops.map((loop) => loop.id));
  const messages = buildResolutionPrompt(input);
  let lastError: Error | null = null;
  let lastRaw = '';

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const budgetError = lastError ? isOutputBudgetError(lastError.message) : false;
    const attemptMessages = attempt === 0
      ? messages
      : [
        ...messages,
        {
          role: 'user' as const,
          content: budgetError
            ? [
              `上一次模型没有返回内容，输出预算可能被推理耗尽：${lastError?.message ?? '未知错误'}。`,
              '请直接输出一个完整、可解析的 JSON 对象，不要解释，不要 Markdown，不要长篇推理。',
            ].join('\n')
            : [
              `上一次输出不合法：${lastError?.message ?? '未知错误'}。`,
              lastRaw ? `上次输出片段：${lastRaw.slice(-800)}` : '',
              '请重新只输出一个完整、可解析的 JSON 对象，不要解释，不要 Markdown。',
            ].filter(Boolean).join('\n'),
        },
      ];
    const attemptMaxTokens = budgetError
      ? Math.max(maxTokens, RESOLUTION_RETRY_MAX_TOKENS)
      : maxTokens;
    try {
      const raw = await chat(attemptMessages, { model, maxTokens: attemptMaxTokens });
      lastRaw = raw;
      return parseResolutions(raw, allowedMessages, allowedLoops, minConfidence, {
        tolerateUnknownEvidence: options.tolerateUnknownEvidence ?? false,
      });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  if (lastError instanceof LoopExtractionError) throw lastError;
  throw new LoopExtractionError('transport', lastError?.message ?? '核对失败');
}
