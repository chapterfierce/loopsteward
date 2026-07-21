/**
 * Claw Task Service — Disambiguation Module (Phase 2.5)
 *
 * Resolves conflicts when multiple intent rules match the same input.
 * Implements the 6-step disambiguation strategy from the design doc:
 *
 *   1. Rule priority comparison — higher priority wins
 *   2. Entity richness — more extracted entities win
 *   3. Keyword density — higher keyword-to-token ratio wins
 *   4. Specificity — more conditions (more specific rule) wins
 *   5. Negation exclusion — rules with negative conditions are penalized
 *   6. Context awareness — previous intent affects current classification
 */

import {
  TaskIntentCategory,
  TaskSubCategory,
  IntentContext,
  AlternativeIntent,
  TaskEntity,
} from './types';
import { ClassificationRule } from './types';

/** A candidate match from the rule engine */
export interface RuleMatch {
  rule: ClassificationRule;
  score: number;
  matchedKeywords: string[];
  entities?: TaskEntity[];
}

/** Disambiguation result */
export interface DisambiguationResult {
  /** Winning match (undefined if no clear winner) */
  winner?: RuleMatch;
  /** Runners-up (alternative intents) */
  alternatives: AlternativeIntent[];
  /** Whether the result was ambiguous (needed disambiguation) */
  wasAmbiguous: boolean;
  /** Strategy used to resolve conflict */
  strategy: string;
}

// ─── Core Disambiguation ────────────────────────────────────────────

/**
 * Disambiguate between multiple rule matches using the 6-step strategy.
 *
 * @param matches - All matching rules, already scored
 * @param tokenCount - Total token count in the input (for density calculation)
 * @param entities - Extracted entities (for richness calculation)
 * @param context - Optional context (previous intent, conversation history)
 * @returns Resolved intent with alternatives
 */
export function disambiguate(
  matches: RuleMatch[],
  tokenCount: number,
  entities: TaskEntity[],
  context?: IntentContext,
): DisambiguationResult {
  if (matches.length === 0) {
    return {
      winner: undefined,
      alternatives: [],
      wasAmbiguous: false,
      strategy: 'no_matches',
    };
  }

  if (matches.length === 1) {
    // Single match — no ambiguity
    return {
      winner: matches[0],
      alternatives: [],
      wasAmbiguous: false,
      strategy: 'single_match',
    };
  }

  // Sort matches by score descending
  const sorted = [...matches].sort((a, b) => b.score - a.score);

  // Check if there's clear separation
  const topScore = sorted[0].score;
  const secondScore = sorted[1].score;
  const gap = topScore - secondScore;

  // If gap is wide enough (>0.15), it's not really ambiguous
  if (gap > 0.15) {
    return {
      winner: sorted[0],
      alternatives: buildAlternatives(sorted.slice(1)),
      wasAmbiguous: false,
      strategy: 'clear_score_separation',
    };
  }

  // ── Step 1: Rule Priority Comparison ─────────────────────────────
  const topPriority = sorted.filter(m => m.rule.priority === sorted[0].rule.priority);
  if (topPriority.length === 1) {
    return {
      winner: topPriority[0],
      alternatives: buildAlternatives(sorted.filter(m => m !== topPriority[0])),
      wasAmbiguous: true,
      strategy: 'priority_comparison',
    };
  }

  // ── Step 2: Entity Richness ──────────────────────────────────────
  const tied = topPriority;
  const withEntities = tied.map(m => ({
    match: m,
    entityCount: m.entities?.length ?? 0,
  }));
  const maxEntities = Math.max(...withEntities.map(e => e.entityCount));
  const richest = withEntities.filter(e => e.entityCount === maxEntities);

  if (richest.length === 1 && maxEntities > 0) {
    return {
      winner: richest[0].match,
      alternatives: buildAlternatives(sorted.filter(m => m !== richest[0].match)),
      wasAmbiguous: true,
      strategy: 'entity_richness',
    };
  }

  // ── Step 3: Keyword Density ──────────────────────────────────────
  const candidates = richest.length > 0
    ? richest.map(r => r.match)
    : tied;

  const withDensity = candidates.map(m => ({
    match: m,
    density: tokenCount > 0 ? m.matchedKeywords.length / tokenCount : 0,
  }));
  const maxDensity = Math.max(...withDensity.map(d => d.density));
  const densest = withDensity.filter(d => d.density === maxDensity);

  if (densest.length === 1 && maxDensity > 0) {
    return {
      winner: densest[0].match,
      alternatives: buildAlternatives(sorted.filter(m => m !== densest[0].match)),
      wasAmbiguous: true,
      strategy: 'keyword_density',
    };
  }

  // ── Step 4: Specificity (Rule Condition Count) ───────────────────
  const contending = densest.length > 0
    ? densest.map(d => d.match)
    : candidates;

  const withSpecificity = contending.map(m => ({
    match: m,
    specificity: m.rule.conditions.filter(c => c.type !== 'negation').length,
  }));
  const maxSpecificity = Math.max(...withSpecificity.map(s => s.specificity));
  const mostSpecific = withSpecificity.filter(s => s.specificity === maxSpecificity);

  if (mostSpecific.length === 1) {
    return {
      winner: mostSpecific[0].match,
      alternatives: buildAlternatives(sorted.filter(m => m !== mostSpecific[0].match)),
      wasAmbiguous: true,
      strategy: 'specificity',
    };
  }

  // ── Step 5: Negation Exclusion ───────────────────────────────────
  const finalContenders = mostSpecific.length > 0
    ? mostSpecific.map(s => s.match)
    : contending;

  const negationPenalties = finalContenders.map(m => {
    const negCount = m.rule.conditions.filter(c => c.type === 'negation').length;
    return { match: m, penalty: negCount * 0.1 };
  });
  const minPenalty = Math.min(...negationPenalties.map(n => n.penalty));
  const leastNegated = negationPenalties.filter(n => n.penalty === minPenalty);

  if (leastNegated.length === 1) {
    return {
      winner: leastNegated[0].match,
      alternatives: buildAlternatives(sorted.filter(m => m !== leastNegated[0].match)),
      wasAmbiguous: true,
      strategy: 'negation_exclusion',
    };
  }

  // ── Step 6: Context Awareness ────────────────────────────────────
  // If all else fails, use previous intent context
  if (context?.previousIntent) {
    const contextMatch = finalContenders.find(
      m => m.rule.category === context.previousIntent
    );
    if (contextMatch) {
      return {
        winner: contextMatch,
        alternatives: buildAlternatives(sorted.filter(m => m !== contextMatch)),
        wasAmbiguous: true,
        strategy: 'context_awareness',
      };
    }
  }

  // ── Ultimate Fallback: Take the highest-scoring match ────────────
  return {
    winner: sorted[0],
    alternatives: buildAlternatives(sorted.slice(1)),
    wasAmbiguous: true,
    strategy: 'fallback_highest_score',
  };
}

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Build AlternativeIntent list from runner-up matches.
 */
function buildAlternatives(matches: RuleMatch[]): AlternativeIntent[] {
  return matches.slice(0, 3).map(m => ({
    category: m.rule.category,
    subCategory: m.rule.subCategory,
    confidence: Math.round(m.score * 100) / 100,
    rationale: m.rule.rationale ?? `Matched rule: ${m.rule.id}`,
  }));
}

// ─── Ambiguity Detection ────────────────────────────────────────────

/**
 * Pre-disambiguation: check if the top two results are close enough
 * to trigger the disambiguation pipeline.
 */
export function isAmbiguous(topScore: number, secondScore: number): boolean {
  return (topScore - secondScore) < 0.15;
}

/**
 * Compute the "ambiguity score" — how ambiguous a set of matches is.
 * 0 = perfectly clear, 1 = completely ambiguous.
 */
export function ambiguityScore(matches: RuleMatch[]): number {
  if (matches.length <= 1) return 0;
  const sorted = [...matches].sort((a, b) => b.score - a.score);
  const gap = sorted[0].score - sorted[1].score;
  // Map gap [0, 0.15] to ambiguity [1, 0]
  return Math.max(0, Math.min(1, 1 - (gap / 0.15)));
}

// ─── Context Helpers ────────────────────────────────────────────────

/**
 * Determine if the context (previous intent) should influence
 * the current classification.
 */
export function shouldUseContext(
  currentMatches: RuleMatch[],
  context?: IntentContext,
): boolean {
  if (!context?.previousIntent) return false;

  // Only use context if the current classification is ambiguous
  if (currentMatches.length <= 1) return false;

  // Check if current matches are close
  const sorted = [...currentMatches].sort((a, b) => b.score - a.score);
  if ((sorted[0].score - sorted[1].score) > 0.1) return false;

  // Check if previous intent is among the candidates
  return currentMatches.some(m => m.rule.category === context.previousIntent);
}

/**
 * Boost a match score if it aligns with the context (previous intent).
 */
export function applyContextBoost(
  match: RuleMatch,
  context?: IntentContext,
): RuleMatch {
  if (!context?.previousIntent) return match;

  // Boost if category matches, bigger boost if sub-category also matches
  let boost = 0;
  if (match.rule.category === context.previousIntent) {
    boost += 0.05;
    if (context.previousSubCategory &&
        match.rule.subCategory === context.previousSubCategory) {
      boost += 0.03;
    }
  }

  return {
    ...match,
    score: Math.min(1, match.score + boost),
  };
}
