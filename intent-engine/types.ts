/**
 * Claw Task Service — Intent Engine Types (Phase 2.5)
 *
 * Task management intent classification types, extending the original
 * development-task classification with create_task/query_status/modify_task/
 * delete_task/schedule/other categories.
 */

// ─── Intent Categories ─────────────────────────────────────────────

/** Primary task management intent categories */
export type TaskIntentCategory =
  | 'create_task'
  | 'query_status'
  | 'modify_task'
  | 'delete_task'
  | 'schedule'
  // Development-oriented intent categories (Phase 2.5 expansion)
  | 'debug'
  | 'development'
  | 'research'
  | 'review'
  | 'planning'
  | 'other';

/** create_task sub-categories */
export type CreateTaskSub =
  | 'general'
  | 'bugfix'
  | 'feature'
  | 'refactor'
  | 'doc';

/** query_status sub-categories */
export type QueryStatusSub =
  | 'single'
  | 'all'
  | 'filtered'
  | 'summary';

/** modify_task sub-categories */
export type ModifyTaskSub =
  | 'deadline'
  | 'priority'
  | 'assignee'
  | 'status'
  | 'description';

/** delete_task sub-categories */
export type DeleteTaskSub =
  | 'single'
  | 'cancel'
  | 'archive';

/** schedule sub-categories */
export type ScheduleSub =
  | 'view'
  | 'create'
  | 'conflict'
  | 'modify';

/** Unified sub-category type */
export type TaskSubCategory =
  | CreateTaskSub
  | QueryStatusSub
  | ModifyTaskSub
  | DeleteTaskSub
  | ScheduleSub
  // Development-oriented sub-categories
  | DebugSub
  | DevelopmentSub
  | ResearchSub
  | ReviewSub
  | PlanningSub
  | 'fallback';

/** debug sub-categories */
export type DebugSub =
  | 'crash'
  | 'error_log'
  | 'performance'
  | 'data_issue'
  | 'environment';

/** development sub-categories */
export type DevelopmentSub =
  | 'feature_impl'
  | 'bugfix'
  | 'refactor'
  | 'api_design'
  | 'architecture';

/** research sub-categories */
export type ResearchSub =
  | 'investigation'
  | 'spike'
  | 'comparison'
  | 'documentation_lookup';

/** review sub-categories */
export type ReviewSub =
  | 'code_review'
  | 'design_review'
  | 'pr_review'
  | 'test_review';

/** planning sub-categories */
export type PlanningSub =
  | 'sprint_planning'
  | 'estimation'
  | 'roadmap'
  | 'task_breakdown';

// ─── Entity Types ──────────────────────────────────────────────────

/** Entity types that can be extracted from user input */
export type EntityType =
  | 'task_name'
  | 'deadline'
  | 'priority'
  | 'assignee'
  | 'status'
  | 'category';

/** An extracted entity from user input */
export interface TaskEntity {
  type: EntityType;
  value: string;
  /** Starting position in the original text */
  position: number;
  /** Confidence of this entity extraction [0, 1] */
  confidence: number;
}

// ─── Rule & Condition Types ────────────────────────────────────────

/** Condition types for rule matching */
export type ConditionType = 'keyword' | 'phrase' | 'regex' | 'negation' | 'required';

/** A single condition within a classification rule */
export interface RuleCondition {
  type: ConditionType;
  value: string;
  weight: number;
  required?: boolean;
}

/** A classification rule that maps to an intent */
export interface ClassificationRule {
  id: string;
  category: TaskIntentCategory;
  subCategory: TaskSubCategory;
  priority: number;
  conditions: RuleCondition[];
  /** Base confidence for this rule when all conditions match */
  confidence: number;
  /** Minimum confidence threshold for this rule to be considered */
  minConfidence: number;
  /** Human-readable rationale for this rule match */
  rationale?: string;
}

// ─── Input Types ───────────────────────────────────────────────────

/** Context provided alongside the user message for disambiguation */
export interface IntentContext {
  userId?: string;
  /** Previously classified intent (for contextual disambiguation) */
  previousIntent?: TaskIntentCategory;
  /** Previously classified sub-category */
  previousSubCategory?: TaskSubCategory;
  /** Recent task names the user has interacted with */
  recentTaskNames?: string[];
  /** Conversation history window (recent messages) */
  conversationHistory?: string[];
}

/** Classification request input */
export interface IntentRequest {
  /** User's raw input text */
  text: string;
  /** Optional user identifier */
  userId?: string;
  /** Optional context for disambiguation */
  context?: IntentContext;
  /** Optional locale for i18n pattern selection (e.g. 'en', 'zh-CN'). Defaults to 'zh-CN'. */
  locale?: string;
}

// ─── Output Types ──────────────────────────────────────────────────

/** An alternative intent considered during classification */
export interface AlternativeIntent {
  category: TaskIntentCategory;
  subCategory: TaskSubCategory;
  confidence: number;
  rationale: string;
}

/** Metadata about the classification process */
export interface IntentMeta {
  /** Processing time in milliseconds */
  processingTimeMs: number;
  /** Length of the input text */
  inputLength: number;
  /** Total number of rules evaluated */
  rulesEvaluated: number;
  /** Number of rules that positively matched */
  rulesMatched: number;
  /** Whether disambiguation was triggered */
  disambiguationTriggered: boolean;
  /** Whether context influenced the result */
  contextUsed: boolean;
  /** Source of the classification */
  source: 'rule_engine' | 'llm' | 'hybrid';
  /** Effective locale used for rule selection (Phase 3 M5) */
  locale?: string;
  /** How the locale was determined (Phase 3 M5) */
  localeSource?: 'explicit' | 'detected' | 'fallback';
}

/** Full intent classification result */
export interface IntentResult {
  /** Primary intent category */
  category: TaskIntentCategory;
  /** Finer-grained sub-category */
  subCategory: TaskSubCategory;
  /** Confidence score [0, 1] */
  confidence: number;
  /** Extracted entities from the input */
  entities: TaskEntity[];
  /** Alternative intents that were considered */
  alternatives: AlternativeIntent[];
  /** Human-readable explanation of the classification */
  rationale: string;
  /** Whether the result is ambiguous (top two scores close) */
  ambiguous: boolean;
  /** Classification metadata */
  meta: IntentMeta;
}

// ─── Classifier Strategy Interface ─────────────────────────────────

/** Classifier strategy for extensibility (rule-based, LLM, hybrid) */
export interface ClassifierStrategy {
  classify(request: IntentRequest): Promise<IntentResult>;
}

// ─── Confidence Thresholds ─────────────────────────────────────────

/** Threshold ranges and their recommended behaviors */
export const CONFIDENCE_THRESHOLDS = {
  /** High confidence — execute directly */
  HIGH: 0.85,
  /** Medium confidence — execute with logging */
  MEDIUM: 0.70,
  /** Low confidence — confirm with user before executing */
  LOW: 0.50,
  /** Minimal confidence — return alternatives for user selection */
  MINIMAL: 0.30,
  /** Below minimal — fallback to other */
  FALLBACK: 0.0,
} as const;

/** Determine recommended action based on confidence score */
export type ConfidenceAction =
  | 'execute_directly'
  | 'execute_with_log'
  | 'confirm_with_user'
  | 'offer_alternatives'
  | 'fallback_help';

export function getConfidenceAction(confidence: number): ConfidenceAction {
  if (confidence >= CONFIDENCE_THRESHOLDS.HIGH) return 'execute_directly';
  if (confidence >= CONFIDENCE_THRESHOLDS.MEDIUM) return 'execute_with_log';
  if (confidence >= CONFIDENCE_THRESHOLDS.LOW) return 'confirm_with_user';
  if (confidence >= CONFIDENCE_THRESHOLDS.MINIMAL) return 'offer_alternatives';
  return 'fallback_help';
}
