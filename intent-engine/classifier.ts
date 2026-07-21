/**
 * Claw Task Service — Intent Classifier (Phase 2.5)
 *
 * Core classifier implementing the 5-module intent recognition pipeline:
 *
 *   Preprocess → Rule Match → Disambiguate → Entity Extract → Confidence Score
 *
 * Supports 6 intent categories: create_task, query_status, modify_task,
 * delete_task, schedule, other — with 22 rules, 44+ triggers, 22 sub-categories.
 *
 * Based on: claw-task-intent-engine-design.md (v1.0, 2026-07-06)
 */

import {
  TaskIntentCategory,
  TaskSubCategory,
  TaskEntity,
  IntentContext,
  IntentRequest,
  IntentResult,
  IntentMeta,
  AlternativeIntent,
  ClassificationRule,
  RuleCondition,
} from './types';
import { RULES, getRulesByPriority } from './patterns';
import { resolveRulesByPriority, normalizeLocale, PatternLoader } from './i18n/pattern-loader';
import { preprocess, PreprocessResult } from './preprocessor';
import { extractEntities } from './entity-extractor';
import {
  disambiguate,
  RuleMatch,
  isAmbiguous,
  applyContextBoost,
} from './disambiguation';
import {
  getCompiledRulesByPriority,
  getCompiledRules,
  CompiledRule,
  CompiledCondition,
  getRegexPoolStats,
} from './regex-pool';

// ─── Classifier Configuration ───────────────────────────────────────

export interface ClassifierConfig {
  /** Minimum confidence to return a result (below → other fallback) */
  minConfidence: number;
  /** Whether to use context-aware disambiguation */
  useContext: boolean;
  /** Maximum number of alternatives to return */
  maxAlternatives: number;
  /** Default locale for pattern selection (default: 'zh-CN') */
  defaultLocale: string;
}

const DEFAULT_CONFIG: ClassifierConfig = {
  minConfidence: 0.0,
  useContext: true,
  maxAlternatives: 3,
  defaultLocale: 'zh-CN',
};

// ─── Rule Matching Engine ───────────────────────────────────────────

/**
 * Check whether a single condition matches the input.
 * Uses pre-compiled RegExp from the regex pool for regex-type conditions.
 */
function matchCondition(
  condition: RuleCondition | CompiledCondition,
  normalizedText: string,
  tokens: string[],
): boolean {
  // Use pre-compiled regex if available (CompiledCondition)
  const compiledCond = condition as CompiledCondition;
  if (compiledCond.compiledRegex) {
    return compiledCond.compiledRegex.test(normalizedText);
  }

  switch (condition.type) {
    case 'keyword':
      // Match as a token or substring in the normalized text
      return tokens.includes(condition.value.toLowerCase()) ||
        normalizedText.includes(condition.value.toLowerCase());

    case 'phrase':
      // Match as a contiguous substring
      return normalizedText.includes(condition.value.toLowerCase());

    case 'regex':
      // Fallback: compile on-the-fly if not pre-compiled
      try {
        const re = new RegExp(condition.value);
        return re.test(normalizedText);
      } catch {
        return false;
      }

    case 'required':
      // A required keyword match (same as keyword but must match)
      return tokens.includes(condition.value.toLowerCase()) ||
        normalizedText.includes(condition.value.toLowerCase());

    case 'negation':
      // Negation: penalty if this word IS found
      return !tokens.includes(condition.value.toLowerCase()) &&
        !normalizedText.includes(condition.value.toLowerCase());

    default:
      return false;
  }
}

/**
 * Evaluate a single rule against the input.
 * Returns the match result with score.
 *
 * Scoring: sum of matched condition weights, capped at 1.0.
 * Multiple keyword matches increase confidence but don't exceed 1.0.
 * Required conditions must all match; negation words disqualify the rule.
 */
function evaluateRule(
  rule: ClassificationRule | CompiledRule,
  normalizedText: string,
  tokens: string[],
): RuleMatch | null {
  let matchedWeight = 0;
  const matchedKeywords: string[] = [];

  // First pass: check negation (disqualifying) and required conditions
  for (const condition of rule.conditions) {
    if (condition.type === 'negation') {
      const negFound =
        tokens.includes(condition.value.toLowerCase()) ||
        normalizedText.includes(condition.value.toLowerCase());
      if (negFound) return null; // Negation found → rule completely disqualified
      continue;
    }

    const isRequired = condition.type === 'required' || condition.required === true;
    if (isRequired) {
      const matched = matchCondition(condition, normalizedText, tokens);
      if (!matched) return null; // Required condition not met → rule fails
    }
  }

  // Second pass: calculate score from all matched positive conditions
  for (const condition of rule.conditions) {
    if (condition.type === 'negation') continue;

    const matched = matchCondition(condition, normalizedText, tokens);
    if (matched) {
      matchedWeight += condition.weight;
      matchedKeywords.push(condition.value);
    }
  }

  // No positive conditions matched at all → rule doesn't fire
  if (matchedWeight === 0) return null;

  // Score: sum of matched weights, clamped to [0, 1]
  // Matched keywords with high weights (e.g. 1.0) give strong scores
  // Multiple matches saturate toward 1.0
  const score = Math.min(1.0, matchedWeight);

  // Check against minimum confidence threshold
  if (score < rule.minConfidence) return null;

  return {
    rule: rule as ClassificationRule,
    score: Math.round(score * 100) / 100,
    matchedKeywords,
  };
}

// ─── Match All Rules ────────────────────────────────────────────────

/**
 * Evaluate all rules against the input and return matches sorted by score.
 * Uses pre-compiled rules from the regex pool for the default locale (zh-CN).
 * For non-default locales, uses the i18n pattern loader with on-the-fly evaluation.
 */
function matchAllRules(
  normalizedText: string,
  tokens: string[],
  locale?: string,
): { matches: RuleMatch[]; rulesEvaluated: number; rulesMatched: number } {
  // If locale is specified and not the default (zh-CN), use i18n pattern loader
  const { locale: resolvedLocale, fellBack } = normalizeLocale(locale);

  if (resolvedLocale !== 'zh-CN' && !fellBack) {
    // Non-default locale: use i18n pattern loader rules (not pre-compiled)
    const rules = resolveRulesByPriority(resolvedLocale);
    const matches: RuleMatch[] = [];

    for (const rule of rules) {
      const result = evaluateRule(rule, normalizedText, tokens);
      if (result) {
        matches.push(result);
      }
    }

    return {
      matches,
      rulesEvaluated: rules.length,
      rulesMatched: matches.length,
    };
  }

  // Default locale (zh-CN): use pre-compiled rules from regex pool
  const rules = getCompiledRulesByPriority();
  const matches: RuleMatch[] = [];

  for (const rule of rules) {
    const result = evaluateRule(rule, normalizedText, tokens);
    if (result) {
      matches.push(result);
    }
  }

  return {
    matches,
    rulesEvaluated: rules.length,
    rulesMatched: matches.length,
  };
}

// ─── Fallback Generation ────────────────────────────────────────────

/**
 * Generate a fallback "other" intent result when no rules match.
 */
function fallbackResult(
  request: IntentRequest,
  preprocessed: PreprocessResult,
  processingTimeMs: number,
  rulesEvaluated: number,
): IntentResult {
  return {
    category: 'other',
    subCategory: 'fallback',
    confidence: 0.3,
    entities: [],
    alternatives: [],
    rationale: 'No classification rule matched the input',
    ambiguous: false,
    meta: {
      processingTimeMs,
      inputLength: request.text.length,
      rulesEvaluated,
      rulesMatched: 0,
      disambiguationTriggered: false,
      contextUsed: false,
      source: 'rule_engine',
    },
  };
}

// ─── Result Builder ─────────────────────────────────────────────────

/**
 * Build the final IntentResult from the winning match and metadata.
 */
function buildResult(
  winner: RuleMatch,
  alternatives: AlternativeIntent[],
  entities: TaskEntity[],
  request: IntentRequest,
  preprocessed: PreprocessResult,
  processingTimeMs: number,
  rulesEvaluated: number,
  rulesMatched: number,
  disambiguationTriggered: boolean,
  contextUsed: boolean,
): IntentResult {
  return {
    category: winner.rule.category,
    subCategory: winner.rule.subCategory,
    confidence: winner.score,
    entities,
    alternatives: alternatives.slice(0, 3),
    rationale: winner.rule.rationale ??
      `Matched rule: ${winner.rule.id} (score: ${winner.score})`,
    ambiguous: false,
    meta: {
      processingTimeMs,
      inputLength: request.text.length,
      rulesEvaluated,
      rulesMatched,
      disambiguationTriggered,
      contextUsed,
      source: 'rule_engine',
    },
  };
}

// ─── Main Classifier ────────────────────────────────────────────────

/**
 * Classify a user message into task management intent categories.
 *
 * Pipeline:
 *   1. Preprocess — normalize text, tokenize, detect abbreviations/time
 *   2. Rule Match — evaluate all rules against the input (locale-aware)
 *   3. Disambiguate — resolve conflicts when multiple rules match
 *   4. Entity Extract — extract task_name, deadline, priority, etc.
 *   5. Confidence — assign final confidence score
 *
 * @param request - The classification request with user text and optional locale
 * @returns Structured intent classification result
 */
export function classify(request: IntentRequest): IntentResult {
  const startTime = Date.now();
  const config = DEFAULT_CONFIG;

  // ═══ Step 1: Preprocess ─────────────────────────────────────────
  const preprocessed = preprocess(request.text);

  // ═══ Step 2: Rule Match (locale-aware) ──────────────────────────
  const { matches, rulesEvaluated, rulesMatched } = matchAllRules(
    preprocessed.normalized,
    preprocessed.tokens,
    request.locale,
  );

  // No matches → fallback to "other"
  if (matches.length === 0) {
    const processingTimeMs = Date.now() - startTime;
    return fallbackResult(request, preprocessed, processingTimeMs, rulesEvaluated);
  }

  // Sort matches by score descending (tiebreak: priority)
  matches.sort((a, b) => {
    const scoreDiff = b.score - a.score;
    if (Math.abs(scoreDiff) > 0.02) return scoreDiff;
    return b.rule.priority - a.rule.priority;
  });

  // ═══ Step 3: Entity Extract (before disambiguation, for richness) ──
  const entities = extractEntities(preprocessed);

  // ═══ Step 4: Context Boost (if applicable) ──────────────────────
  let contextUsed = false;
  if (config.useContext && request.context?.previousIntent) {
    const boosted = matches.map(m => applyContextBoost(m, request.context));
    // Re-sort after boosts
    boosted.sort((a, b) => {
      const scoreDiff = b.score - a.score;
      if (Math.abs(scoreDiff) > 0.02) return scoreDiff;
      return b.rule.priority - a.rule.priority;
    });
    // Replace matches with boosted versions
    matches.length = 0;
    matches.push(...boosted);
    contextUsed = true;
  }

  // ═══ Step 5: Disambiguate ───────────────────────────────────────
  const disambResult = disambiguate(
    matches,
    preprocessed.tokenCount,
    entities,
    request.context,
  );

  // ═══ Step 6: Build Result ───────────────────────────────────────
  const processingTimeMs = Date.now() - startTime;

  if (!disambResult.winner) {
    return fallbackResult(request, preprocessed, processingTimeMs, rulesEvaluated);
  }

  const result = buildResult(
    disambResult.winner,
    disambResult.alternatives,
    entities,
    request,
    preprocessed,
    processingTimeMs,
    rulesEvaluated,
    rulesMatched,
    disambResult.wasAmbiguous,
    contextUsed,
  );

  return result;
}

// ─── Convenience API ────────────────────────────────────────────────

/**
 * Quick classify with just text (no context). Uses default locale (zh-CN).
 */
export function classifyText(text: string): IntentResult {
  return classify({ text });
}

/**
 * Quick classify with text and locale.
 *
 * @param text - User input text
 * @param locale - Locale string (e.g. 'en', 'zh-CN')
 * @returns Structured intent classification result
 */
export function classifyTextWithLocale(text: string, locale: string): IntentResult {
  return classify({ text, locale });
}

// ─── Batch Classification ───────────────────────────────────────────

/**
 * Classify multiple texts in batch.
 * All texts use the same locale (if provided).
 */
export function classifyBatch(
  texts: string[],
  context?: IntentContext,
  locale?: string,
): IntentResult[] {
  return texts.map(text => classify({ text, context, locale }));
}

// ─── Strategy Interface Implementation ──────────────────────────────

/**
 * Rule-based classifier implementing the ClassifierStrategy interface.
 * Supports locale-aware classification via the i18n pattern loader.
 */
export class RuleClassifier {
  private config: ClassifierConfig;

  constructor(config: Partial<ClassifierConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async classify(request: IntentRequest): Promise<IntentResult> {
    // Inject default locale from config if not specified in request
    if (!request.locale && this.config.defaultLocale) {
      request = { ...request, locale: this.config.defaultLocale };
    }
    return classify(request);
  }
}

/**
 * Hybrid classifier: rules first, LLM fallback (future).
 */
export class HybridClassifier {
  private ruleClassifier: RuleClassifier;
  private llmEnabled: boolean;

  constructor(llmEnabled = false) {
    this.ruleClassifier = new RuleClassifier();
    this.llmEnabled = llmEnabled;
  }

  async classify(request: IntentRequest): Promise<IntentResult> {
    const result = await this.ruleClassifier.classify(request);

    // Future: LLM fallback for low-confidence results
    if (this.llmEnabled && result.confidence < 0.4) {
      // Placeholder for LLM classification
      // const llmResult = await llmClassify(request);
      // return mergeResults(result, llmResult);
    }

    return result;
  }
}

// ─── Debug / Inspection ─────────────────────────────────────────────

/**
 * Get rule-level debugging information for a text input.
 * Useful for tuning rules and understanding match decisions.
 * Supports optional locale parameter for i18n debugging.
 */
export function debugClassify(text: string, locale?: string) {
  const preprocessed = preprocess(text);

  // Determine which rules to use based on locale
  const { locale: resolvedLocale, fellBack } = normalizeLocale(locale);
  const useCompiled = resolvedLocale === 'zh-CN' && !fellBack;

  const rules = useCompiled
    ? getCompiledRulesByPriority()
    : resolveRulesByPriority(resolvedLocale);

  const ruleDetails = rules.map(rule => {
    const match = evaluateRule(rule, preprocessed.normalized, preprocessed.tokens);
    return {
      ruleId: rule.id,
      category: rule.category,
      subCategory: rule.subCategory,
      priority: rule.priority,
      matched: !!match,
      score: match?.score ?? 0,
      matchedKeywords: match?.matchedKeywords ?? [],
      conditions: rule.conditions.map(c => ({
        type: c.type,
        value: c.value,
        weight: c.weight,
        matched: matchCondition(c, preprocessed.normalized, preprocessed.tokens),
      })),
    };
  });

  const result = classify({ text, locale });

  return {
    input: text,
    locale: resolvedLocale,
    preprocessed: {
      normalized: preprocessed.normalized,
      tokenCount: preprocessed.tokenCount,
      tokens: preprocessed.tokens,
    },
    result,
    ruleDetails: ruleDetails.filter(r => r.matched || r.score > 0),
    allRules: ruleDetails,
    regexPoolStats: getRegexPoolStats(),
  };
}

// ─── Exports ────────────────────────────────────────────────────────

export { RULES, getRulesByPriority } from './patterns';
export { preprocess } from './preprocessor';
export { extractEntities } from './entity-extractor';
export { disambiguate, isAmbiguous } from './disambiguation';
export { resolveRulesByPriority, normalizeLocale, PatternLoader } from './i18n/pattern-loader';
export { EN_RULES, getEnRulesByPriority } from './i18n/en-patterns';
