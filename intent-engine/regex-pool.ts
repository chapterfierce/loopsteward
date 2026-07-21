/**
 * Claw Task Service — RegExp Pre-Compilation Pool (Phase 3 M1)
 *
 * Global Map cache for all RegExp instances used in intent classification.
 * Eliminates per-call RegExp construction overhead by compiling once at module load.
 *
 * Compiled patterns:
 *   - 33 classification rules (regex-type conditions from patterns.ts)
 *   - 5 priority keyword patterns (from entity-extractor.ts)
 *   - 6 deadline/date patterns (from entity-extractor.ts)
 *   - 3 assignee patterns (from entity-extractor.ts)
 *   Total: up to 105 RegExp instances (depending on rule conditions)
 *
 * Based on: phase3-m1-report.md (v1.0, 2026-07-15)
 */

import { ClassificationRule, RuleCondition } from './types';
import { RULES } from './patterns';

// ─── Types ─────────────────────────────────────────────────────────

/** A rule with pre-compiled RegExp conditions */
export interface CompiledCondition extends RuleCondition {
  /** Pre-compiled RegExp (null for non-regex conditions) */
  compiledRegex: RegExp | null;
}

/** A classification rule with all conditions pre-compiled */
export interface CompiledRule extends Omit<ClassificationRule, 'conditions'> {
  conditions: CompiledCondition[];
}

/** Pre-compiled priority keyword pattern */
export interface CompiledPriorityKeyword {
  regex: RegExp;
  conf: number;
}

// ─── Global RegExp Pool ────────────────────────────────────────────

/**
 * Global Map caching all RegExp instances.
 * Key format: `${rule.category}:${rule.id}:${condition.type}:${index}`
 */
const regexPool = new Map<string, RegExp>();

/**
 * Compile (or retrieve from cache) a RegExp from a pattern string.
 * Falls back to a never-matching RegExp on invalid patterns.
 */
function compileRegex(pattern: string, cacheKey: string): RegExp {
  const existing = regexPool.get(cacheKey);
  if (existing) return existing;

  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch {
    // Invalid pattern — use a never-matching regex as fallback
    re = /$^/;
  }

  regexPool.set(cacheKey, re);
  return re;
}

// ─── Compile All Classification Rules ──────────────────────────────

/**
 * Compile all rules from patterns.ts into CompiledRule[].
 * Each regex-type condition gets a pre-compiled RegExp stored in the pool.
 */
function compileRules(): CompiledRule[] {
  return RULES.map(rule => {
    const compiledConditions: CompiledCondition[] = rule.conditions.map(
      (cond, index) => {
        const cacheKey = `${rule.category}:${rule.id}:${cond.type}:${index}`;
        let compiledRegex: RegExp | null = null;

        if (cond.type === 'regex') {
          compiledRegex = compileRegex(cond.value, cacheKey);
        }

        return {
          ...cond,
          compiledRegex,
        };
      },
    );

    return {
      ...rule,
      conditions: compiledConditions,
    };
  });
}

// ─── Compile Priority Keywords ─────────────────────────────────────

/**
 * Priority keyword patterns (mirrors entity-extractor.ts PRIORITY_PATTERNS).
 * Pre-compiled at module load time.
 */
const PRIORITY_KEYWORD_PATTERNS: { pattern: string; conf: number }[] = [
  { pattern: 'P[0-3]', conf: 0.95 },
  { pattern: '紧急', conf: 0.85 },
  { pattern: '高优先', conf: 0.8 },
  { pattern: '低优先', conf: 0.8 },
  { pattern: '重要的', conf: 0.7 },
];

function compilePriorityKeywords(): CompiledPriorityKeyword[] {
  return PRIORITY_KEYWORD_PATTERNS.map((p, i) => {
    const cacheKey = `priority:keyword:${i}`;
    return {
      regex: compileRegex(p.pattern, cacheKey),
      conf: p.conf,
    };
  });
}

// ─── Compile Due Date Patterns ─────────────────────────────────────

/**
 * Due date / deadline patterns (mirrors entity-extractor.ts DEADLINE_PATTERNS).
 * Pre-compiled at module load time.
 */
const DUE_DATE_PATTERNS: { pattern: string; conf: number }[] = [
  { pattern: '\\d{4}[-/年]\\d{1,2}[-/月]\\d{1,2}[日号]?', conf: 1.0 },
  { pattern: '\\d{1,2}月\\d{1,2}[日号]', conf: 0.95 },
  { pattern: '(今天|明天|后天|昨天|前天)', conf: 0.95 },
  { pattern: '(本周|下周|上周|这周)\\s*(一|二|三|四|五|六|日|末)?', conf: 0.9 },
  { pattern: '(周一|周二|周三|周四|周五|周六|周日|星期一|星期二|星期三|星期四|星期五|星期六|星期日)', conf: 0.9 },
  { pattern: '\\d+天[之以]?(后|前|内)', conf: 0.85 },
];

interface CompiledDuePattern {
  regex: RegExp;
  conf: number;
}

function compileDuePatterns(): CompiledDuePattern[] {
  return DUE_DATE_PATTERNS.map((p, i) => {
    const cacheKey = `due:date:${i}`;
    return {
      regex: compileRegex(p.pattern, cacheKey),
      conf: p.conf,
    };
  });
}

// ─── Compile Assignee Patterns ─────────────────────────────────────

/**
 * Assignee patterns (mirrors entity-extractor.ts ASSIGNEE_PATTERNS).
 * Pre-compiled at module load time.
 */
const ASSIGNEE_PATTERNS_RAW: { pattern: string; conf: number }[] = [
  { pattern: '@(\\S{1,20})', conf: 0.95 },
  { pattern: '转给([\\u4e00-\\u9fff]{2,4})', conf: 0.95 },
  { pattern: '交给([\\u4e00-\\u9fff]{2,4})', conf: 0.9 },
];

interface CompiledAssigneePattern {
  regex: RegExp;
  conf: number;
}

function compileAssigneePatterns(): CompiledAssigneePattern[] {
  return ASSIGNEE_PATTERNS_RAW.map((p, i) => {
    const cacheKey = `assignee:pattern:${i}`;
    return {
      regex: compileRegex(p.pattern, cacheKey),
      conf: p.conf,
    };
  });
}

// ─── Module-Level Singletons (compiled once at load) ───────────────

const compiledRules: CompiledRule[] = compileRules();
const compiledPriorityKeywords: CompiledPriorityKeyword[] = compilePriorityKeywords();
const compiledDuePatterns: CompiledDuePattern[] = compileDuePatterns();
const compiledAssigneePatterns: CompiledAssigneePattern[] = compileAssigneePatterns();

// ─── Public API ────────────────────────────────────────────────────

/**
 * Get all pre-compiled classification rules.
 * Rules are sorted by priority descending (same as getRulesByPriority).
 */
export function getCompiledRules(): CompiledRule[] {
  return compiledRules;
}

/**
 * Get pre-compiled rules sorted by priority descending.
 */
export function getCompiledRulesByPriority(): CompiledRule[] {
  return [...compiledRules].sort((a, b) => b.priority - a.priority);
}

/**
 * Get pre-compiled priority keyword patterns.
 */
export function getCompiledPriorityKeywords(): CompiledPriorityKeyword[] {
  return compiledPriorityKeywords;
}

/**
 * Get pre-compiled due date patterns.
 */
export function getCompiledDuePatterns(): CompiledDuePattern[] {
  return compiledDuePatterns;
}

/**
 * Get pre-compiled assignee patterns.
 */
export function getCompiledAssigneePatterns(): CompiledAssigneePattern[] {
  return compiledAssigneePatterns;
}

// ─── Stats & Maintenance ───────────────────────────────────────────

/**
 * Get statistics about the regex pool.
 */
export function getRegexPoolStats(): {
  poolSize: number;
  rulesCompiled: number;
  priorityKeywordsCompiled: number;
  duePatternsCompiled: number;
  assigneePatternsCompiled: number;
} {
  return {
    poolSize: regexPool.size,
    rulesCompiled: compiledRules.length,
    priorityKeywordsCompiled: compiledPriorityKeywords.length,
    duePatternsCompiled: compiledDuePatterns.length,
    assigneePatternsCompiled: compiledAssigneePatterns.length,
  };
}

/**
 * Reset the regex pool. Mainly for testing.
 * Warning: this clears all cached RegExp instances.
 */
export function resetRegexPool(): void {
  regexPool.clear();
}
