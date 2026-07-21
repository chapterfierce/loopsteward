/**
 * Claw Task Service — Custom Intent Types (Phase 3 M2)
 *
 * Type definitions for the custom intent extension mechanism.
 * Allows users to register custom intent rules at runtime without
 * modifying built-in patterns.ts rules.
 *
 * Based on: phase3-roadmap.md M2 — 自定义意图扩展机制
 */

import {
  TaskIntentCategory,
  TaskSubCategory,
  RuleCondition,
  ClassificationRule,
} from './types';

// ─── Intent Priority ───────────────────────────────────────────────

/**
 * Intent rule priority levels.
 * Higher priority rules are evaluated first and win ties.
 *
 * - OVERRIDE: User-defined rules that always take precedence over built-in rules
 * - HIGH: User-defined rules that take precedence over low-priority built-in rules
 * - NORMAL: Default priority for custom rules (same level as most built-in rules)
 * - LOW: Custom rules that only fire when no higher-priority rule matches
 * - BUILTIN: Internal built-in rules (patterns.ts)
 */
export enum IntentPriority {
  /** Custom rules that always override built-in rules (priority 90+) */
  OVERRIDE = 100,
  /** High-priority custom rules (priority 80-89) */
  HIGH = 85,
  /** Normal-priority custom rules (priority 50-79) */
  NORMAL = 65,
  /** Low-priority custom rules (priority 20-49) */
  LOW = 35,
  /** Built-in rules from patterns.ts (priority set in rule definition) */
  BUILTIN = 0,
}

// ─── Validation Function ───────────────────────────────────────────

/**
 * Custom validation function for intent rules.
 * Called after regex/keyword conditions match to provide additional
 * programmatic validation logic.
 *
 * @param text - The normalized input text
 * @param tokens - Tokenized input
 * @param matchedKeywords - Keywords that matched in the condition phase
 * @returns True if the rule should fire, false to reject the match
 */
export type ValidationFunction = (
  text: string,
  tokens: string[],
  matchedKeywords: string[],
) => boolean;

// ─── Custom Intent Rule ────────────────────────────────────────────

/**
 * A user-defined custom intent rule.
 * Extends the built-in ClassificationRule with:
 * - Optional validation callback function
 * - Priority level enum for easier priority management
 * - Enable/disable toggle
 * - Metadata for tracking rule source
 */
export interface CustomIntentRule {
  /** Unique rule identifier (must be unique across built-in + custom rules) */
  id: string;

  /** Intent category this rule maps to (can be a custom string for extensibility) */
  category: TaskIntentCategory | string;

  /** Sub-category for finer-grained classification */
  subCategory: TaskSubCategory | string;

  /** Priority level — determines evaluation order and tie-breaking */
  priority: IntentPriority;

  /** Numeric priority value (derived from IntentPriority or manually set) */
  priorityValue: number;

  /** Conditions for rule matching (keyword, phrase, regex, negation, required) */
  conditions: RuleCondition[];

  /** Base confidence when all conditions match */
  confidence: number;

  /** Minimum confidence threshold for this rule to be considered */
  minConfidence: number;

  /** Optional custom validation function (called after condition matching) */
  validator?: ValidationFunction;

  /** Whether this rule is currently enabled */
  enabled: boolean;

  /** Human-readable rationale for this rule match */
  rationale?: string;

  /** Source description — where this rule was registered from */
  source?: string;

  /** Timestamp when this rule was registered (ms since epoch) */
  createdAt: number;

  /** Timestamp when this rule was last updated (ms since epoch) */
  updatedAt: number;
}

// ─── Registration Result ───────────────────────────────────────────

/**
 * Result of registering a custom intent rule.
 */
export interface RegistrationResult {
  /** Whether the registration was successful */
  success: boolean;
  /** The registered rule (if successful) */
  rule?: CustomIntentRule;
  /** Error message (if failed) */
  error?: string;
}

// ─── Hot-Load Config Format ────────────────────────────────────────

/**
 * Configuration file format for hot-loading custom intent rules.
 * This is the JSON/JSON5 structure that loadRulesFromConfig() expects.
 *
 * Example JSON:
 * {
 *   "rules": [
 *     {
 *       "id": "custom-deploy-task",
 *       "category": "development",
 *       "subCategory": "feature_impl",
 *       "priority": "HIGH",
 *       "conditions": [
 *         { "type": "keyword", "value": "部署", "weight": 0.9 },
 *         { "type": "keyword", "value": "上线", "weight": 0.85 }
 *       ],
 *       "confidence": 0.88,
 *       "minConfidence": 0.6,
 *       "rationale": "Deployment task detected"
 *     }
 *   ]
 * }
 */
export interface CustomIntentConfig {
  /** Schema version for forward compatibility */
  version?: string;
  /** List of custom intent rules to register */
  rules: CustomIntentConfigRule[];
}

/**
 * A rule definition in the config file (before registration).
 * Differs from CustomIntentRule in that priority is a string enum name,
 * validator is omitted (cannot be serialized), and enabled/createdAt/
 * updatedAt are auto-populated.
 */
export interface CustomIntentConfigRule {
  id: string;
  category: TaskIntentCategory | string;
  subCategory: TaskSubCategory | string;
  priority?: keyof typeof IntentPriority;
  priorityValue?: number;
  conditions: RuleCondition[];
  confidence: number;
  minConfidence: number;
  rationale?: string;
  source?: string;
}

// ─── Registry Statistics ───────────────────────────────────────────

/**
 * Statistics about the custom intent registry.
 */
export interface RegistryStats {
  /** Total number of registered custom rules */
  totalRules: number;
  /** Number of enabled rules */
  enabledRules: number;
  /** Number of disabled rules */
  disabledRules: number;
  /** Rules by priority level */
  byPriority: Record<string, number>;
  /** Rules by category */
  byCategory: Record<string, number>;
  /** Number of rules loaded from config files */
  loadedFromConfig: number;
  /** Number of rules registered programmatically */
  registeredProgrammatically: number;
}

// ─── Conversion Utility ────────────────────────────────────────────

/**
 * Convert a CustomIntentRule to a ClassificationRule for use in the
 * classification pipeline. This allows the existing classifier to
 * evaluate custom rules alongside built-in rules without modification.
 */
export function toClassificationRule(rule: CustomIntentRule): ClassificationRule {
  return {
    id: rule.id,
    category: rule.category as TaskIntentCategory,
    subCategory: rule.subCategory as TaskSubCategory,
    priority: rule.priorityValue,
    conditions: rule.conditions,
    confidence: rule.confidence,
    minConfidence: rule.minConfidence,
    rationale: rule.rationale,
  };
}
