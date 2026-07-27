/**
 * Claw Task Service — Entity Extractor (Phase 2.5)
 *
 * Extracts structured entities from preprocessed user input:
 *  - task_name: The task being referenced
 *  - deadline: Time constraints (dates, relative times)
 *  - priority: P0-P3 priority levels
 *  - assignee: Person assigned to the task
 *  - status: Target status (completed, in-progress, etc.)
 *  - category: Task category (bug, feature, refactor, doc)
 */

import { TaskEntity, EntityType } from './types.js';
import { PreprocessResult } from './preprocessor.js';

/** Single entity extraction result (internal) */
interface EntityCandidate {
  type: EntityType;
  value: string;
  position: number;
  confidence: number;
}

// ─── Regex Patterns ─────────────────────────────────────────────────

/** Priority patterns: P0, P1, P2, P3 with optional context */
const PRIORITY_PATTERNS = [
  { regex: /P[0-3]/i, conf: 0.95 },
  { regex: /紧急/, conf: 0.85 },
  { regex: /高优先/, conf: 0.8 },
  { regex: /低优先/, conf: 0.8 },
  { regex: /重要的/, conf: 0.7 },
  { regex: /不急/, conf: 0.7 },
];

/** Deadline patterns: dates, relative times, day-of-week */
const DEADLINE_PATTERNS = [
  // Absolute dates
  { regex: /\d{4}[-/年]\d{1,2}[-/月]\d{1,2}[日号]?/, conf: 1.0 },
  { regex: /\d{1,2}月\d{1,2}[日号]/, conf: 0.95 },
  // Relative time
  { regex: /(今天|明天|后天|昨天|前天)/, conf: 0.95 },
  { regex: /(本周|下周|上周|这周)\s*(一|二|三|四|五|六|日|末)?/, conf: 0.9 },
  { regex: /(周一|周二|周三|周四|周五|周六|周日|星期一|星期二|星期三|星期四|星期五|星期六|星期日)/, conf: 0.9 },
  { regex: /\d+天[之以]?(后|前|内)/, conf: 0.85 },
  { regex: /\d+个?(小时|分钟|周|月)[之以]?(后|前|内)/, conf: 0.85 },
  { regex: /\d{1,2}[点时:：]\d{0,2}分?/, conf: 0.8 },
  { regex: /(上午|下午|晚上)[\d一二两三四五六七八九十]{0,3}[点时]?/, conf: 0.8 },
  { regex: /(下?周[一二三四五六日])/, conf: 0.85 },
  { regex: /(月初|月底|周末|月末|年初|年底|年末)/, conf: 0.8 },
  { regex: /截止[日到]?/, conf: 0.7 },
  { regex: /(前|之前|以前)/, conf: 0.6 },
];

/** Status patterns: target or current task status */
const STATUS_PATTERNS = [
  { regex: /已完成/, conf: 0.95 },
  { regex: /进行中/, conf: 0.95 },
  { regex: /待办|待处理/, conf: 0.9 },
  { regex: /已关闭/, conf: 0.9 },
  { regex: /已完成/, conf: 0.9 },
  { regex: /(做|完成了|搞定)了/, conf: 0.8 },
  { regex: /开始做|启动/, conf: 0.8 },
  { regex: /暂停/, conf: 0.85 },
  { regex: /阻塞|卡住/, conf: 0.85 },
  { regex: /关闭/, conf: 0.75 },
  { regex: /完成/, conf: 0.7 },
  { regex: /进行/, conf: 0.6 },
];

/** Category patterns: task type classification */
const CATEGORY_PATTERNS = [
  { regex: /bug|缺陷|漏洞/, conf: 0.9 },
  { regex: /功能|feature/i, conf: 0.9 },
  { regex: /重构|refactor/i, conf: 0.9 },
  { regex: /文档|doc/i, conf: 0.9 },
  { regex: /优化/, conf: 0.8 },
  { regex: /设计(稿)?/, conf: 0.8 },
  { regex: /测试/, conf: 0.8 },
  { regex: /需求/, conf: 0.75 },
];

/** Assignee patterns: person names after specific markers */
const ASSIGNEE_PATTERNS = [
  // @-mention style (WeChat/Slack)
  { regex: /@(\S{1,20})/, conf: 0.95 },
  // "转给X" pattern (capture the name)
  { regex: /转给([\u4e00-\u9fff]{2,4})/, conf: 0.95 },
  // "交给X" pattern
  { regex: /交给([\u4e00-\u9fff]{2,4})/, conf: 0.9 },
  // "分配" pattern
  { regex: /分配[给到]?([\u4e00-\u9fff]{2,4})/, conf: 0.85 },
  // "让X做/负责" pattern
  { regex: /让([\u4e00-\u9fff]{2,4})[做负责]/, conf: 0.85 },
];

/** Task name patterns: extract what the task is about */
const TASK_NAME_PATTERNS = [
  // "完成[task]" / "实现[task]"
  { regex: /(?:完成|实现|做|写|开发|开发)(.+?)(?:这个)?(?:任务|需求|功能|模块|吗|了|的|吧|呢|啊|呀)?$/, conf: 0.7 },
  // "[task]重构" / "[task]修复" / "[task]优化"
  { regex: /(.+?)(?:模块|功能|页面|接口|服务|系统|重构|修复|优化|开发|设计|实现|升级|整理)/, conf: 0.75 },
  // "这个[task]" / "那个[task]"
  { regex: /[这那]个(.+?)(?:任务|需求|功能)?(?:的)?/, conf: 0.7 },
];

// ─── Entity Extractor ───────────────────────────────────────────────

/**
 * Extract entities by matching regex patterns against text.
 * Returns candidates sorted by confidence.
 */
function extractByPatterns(
  text: string,
  type: EntityType,
  patterns: { regex: RegExp; conf: number }[],
): EntityCandidate[] {
  const candidates: EntityCandidate[] = [];
  const seen = new Set<string>();

  for (const { regex, conf } of patterns) {
    let match: RegExpExecArray | null;
    // Reset lastIndex for global regex
    const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
    while ((match = re.exec(text)) !== null) {
      const value = match[1] ?? match[0];
      const key = `${type}:${value}`;
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push({
          type,
          value: value.trim(),
          position: match.index,
          confidence: conf,
        });
      }
      // Prevent infinite loop on zero-length matches
      if (match.index === re.lastIndex) re.lastIndex++;
    }
  }

  return candidates.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Extract task name from preprocessed text.
 * Uses heuristics: look for the most descriptive noun phrase.
 */
function extractTaskName(text: string, tokens: string[]): EntityCandidate[] {
  const candidates: EntityCandidate[] = [];

  // Strategy 1: Use task name patterns
  for (const { regex, conf } of TASK_NAME_PATTERNS) {
    const match = text.match(regex);
    if (match) {
      const value = (match[1] ?? match[0]).trim();
      if (value.length > 1 && value.length < 50) {
        candidates.push({
          type: 'task_name',
          value,
          position: match.index ?? 0,
          confidence: conf,
        });
      }
    }
  }

  // Strategy 2: If no pattern match, use the longest noun-like phrase
  if (candidates.length === 0 && tokens.length > 0) {
    // Take the text after common verb prefixes
    const verbPrefixes = /^(帮我|请[你我]?|可以|能不能|帮忙|需要|要|来)\s*/;
    const cleaned = text.replace(verbPrefixes, '').trim();
    if (cleaned.length > 1) {
      candidates.push({
        type: 'task_name',
        value: cleaned.substring(0, Math.min(cleaned.length, 40)),
        position: text.indexOf(cleaned) >= 0 ? text.indexOf(cleaned) : 0,
        confidence: 0.5,
      });
    }
  }

  return candidates;
}

// ─── Main Export ────────────────────────────────────────────────────

/**
 * Extract all entities from preprocessed input.
 *
 * Extraction pipeline:
 * 1. Extract priority (P0-P3)
 * 2. Extract deadlines (dates, relative times)
 * 3. Extract status (completed, in-progress, etc.)
 * 4. Extract category (bug, feature, etc.)
 * 5. Extract assignee (@mentions, names)
 * 6. Extract task name (descriptive phrase)
 */
export function extractEntities(preprocessed: PreprocessResult): TaskEntity[] {
  const text = preprocessed.normalized;
  const tokens = preprocessed.tokens;
  const allCandidates: EntityCandidate[] = [];

  // Extract each entity type
  allCandidates.push(...extractByPatterns(text, 'priority', PRIORITY_PATTERNS));
  allCandidates.push(...extractByPatterns(text, 'deadline', DEADLINE_PATTERNS));
  allCandidates.push(...extractByPatterns(text, 'status', STATUS_PATTERNS));
  allCandidates.push(...extractByPatterns(text, 'category', CATEGORY_PATTERNS));
  allCandidates.push(...extractByPatterns(text, 'assignee', ASSIGNEE_PATTERNS));
  allCandidates.push(...extractTaskName(text, tokens));

  // Deduplicate: keep highest confidence per (type, value)
  const deduped = new Map<string, EntityCandidate>();
  for (const c of allCandidates) {
    const key = `${c.type}:${c.value}`;
    const existing = deduped.get(key);
    if (!existing || c.confidence > existing.confidence) {
      deduped.set(key, c);
    }
  }

  // Convert to TaskEntity[], sorted by confidence descending
  return Array.from(deduped.values())
    .sort((a, b) => b.confidence - a.confidence)
    .map(c => ({
      type: c.type,
      value: c.value,
      position: c.position,
      confidence: Math.round(c.confidence * 100) / 100,
    }));
}

/**
 * Extract entities from raw text (convenience function with inline preprocessing).
 */
export function extractEntitiesFromText(text: string): TaskEntity[] {
  // Import inline to avoid circular dependency
  const { preprocess } = require('./preprocessor');
  return extractEntities(preprocess(text));
}

/**
 * Count entities by type.
 */
export function countEntitiesByType(entities: TaskEntity[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of entities) {
    counts[e.type] = (counts[e.type] || 0) + 1;
  }
  return counts;
}

/**
 * Get all entities of a specific type.
 */
export function getEntitiesByType(entities: TaskEntity[], type: EntityType): TaskEntity[] {
  return entities.filter(e => e.type === type);
}
