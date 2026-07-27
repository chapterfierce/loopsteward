/**
 * Claw Task Service — Intent → Task Bridge (Phase 3 M4)
 *
 * Integration layer between the intent engine (intent-engine/pipeline)
 * and the Task Manager. Maps classified intents + extracted entities
 * onto concrete task CRUD operations:
 *
 *   create_task  → TaskManager.createTask
 *   query_status → TaskManager.queryTasks / findTaskByReference
 *   modify_task  → TaskManager.modifyTask / changeStatus
 *   delete_task  → TaskManager.cancelTask / archiveTask
 *   (all other categories are routed, not executed — they belong to
 *    dev/schedule/planning handlers outside the Task Manager)
 *
 * Confidence gating (driven by PipelineResult.recommendedAction):
 *   execute_directly / execute_with_log → execute
 *   confirm_with_user                   → execute only if autoConfirm
 *   offer_alternatives / fallback_help  → never execute
 */

import {
  classifyIntent,
  PipelineResult,
  PipelineConfig,
} from '../../intent-engine/pipeline.js';
import {
  IntentContext,
  TaskEntity,
  EntityType,
  TaskSubCategory,
} from '../../intent-engine/types.js';
import {
  TaskPriority,
  TaskStatus,
  TaskCategory,
  CreateTaskInput,
  ModifyTaskInput,
  TaskOperationResult,
} from './task-types.js';
import { TaskManager } from './task-manager.js';

// ─── Bridge Types ──────────────────────────────────────────────────

export type BridgeOperation = 'create' | 'query' | 'modify' | 'delete' | 'none';

export interface BridgeConfig {
  /** Execute operations even when the action is confirm_with_user */
  autoConfirm: boolean;
  /** Pipeline configuration overrides */
  pipelineConfig?: Partial<PipelineConfig>;
}

const DEFAULT_BRIDGE_CONFIG: BridgeConfig = {
  autoConfirm: false,
};

export interface BridgeResult {
  /** Whether a task operation was actually executed */
  executed: boolean;
  /** True when the intent was understood but needs user confirmation */
  needsConfirmation: boolean;
  /** Which task operation the intent mapped to */
  operation: BridgeOperation;
  /** Route handler for non-task intents (dev.debug, plan.manage, …) */
  routeHandler: string;
  /** Full intent classification result */
  intent: PipelineResult;
  /** Task operation result (present when executed) */
  result?: TaskOperationResult;
  /** Human-readable outcome */
  message: string;
}

// ─── Entity Helpers ────────────────────────────────────────────────

/** Get the highest-confidence entity value of a given type. */
export function pickEntity(
  entities: TaskEntity[],
  type: EntityType,
): TaskEntity | undefined {
  return entities
    .filter(e => e.type === type)
    .sort((a, b) => b.confidence - a.confidence)[0];
}

/** Normalize a priority entity value to TaskPriority. */
export function normalizePriority(value?: string): TaskPriority | undefined {
  if (!value) return undefined;
  const m = value.match(/p([0-3])/i);
  if (m) return `P${m[1]}` as TaskPriority;
  if (/紧急|最高|最重要/.test(value)) return 'P0';
  if (/高/.test(value)) return 'P1';
  if (/中/.test(value)) return 'P2';
  if (/低/.test(value)) return 'P3';
  return undefined;
}

/** Normalize a status entity value to TaskStatus. */
export function normalizeStatus(value?: string): TaskStatus | undefined {
  if (!value) return undefined;
  if (/完成|结束|搞定|done/i.test(value)) return 'completed';
  if (/取消|作废|不做/.test(value)) return 'cancelled';
  if (/暂停|搁置|挂起|hold/i.test(value)) return 'on_hold';
  if (/进行|开始|启动|着手/.test(value)) return 'in_progress';
  if (/分配|指派|认领/.test(value)) return 'assigned';
  return undefined;
}

/** Map create_task sub-categories to task categories. */
export function subCategoryToTaskCategory(sub: TaskSubCategory): TaskCategory {
  switch (sub) {
    case 'bugfix': return 'bugfix';
    case 'feature': return 'feature';
    case 'refactor': return 'refactor';
    case 'doc': return 'doc';
    default: return 'general';
  }
}

/** Noise fragments stripped from derived titles. */
const TITLE_NOISE_PATTERNS: RegExp[] = [
  /^(请|麻烦|帮我|给我|帮忙)+/,
  /^(创建|新建|建立|添加|加|加个|建个|创建一个|新建一个|添加一个)+/,
  /(的任务|任务)$/,
  /^(一个|个)/,
];

/** Escape a string for embedding in a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Clean a single title candidate: remove already-captured entity
 * fragments (priority / assignee / deadline), connective phrases,
 * and trigger-verb noise. Applies noise patterns iteratively until
 * the string is stable.
 */
function cleanTitleCandidate(raw: string, entities: TaskEntity[]): string {
  let s = raw;
  for (const type of ['priority', 'assignee', 'deadline'] as EntityType[]) {
    for (const e of entities.filter(x => x.type === type)) {
      if (!e.value) continue;
      s = s.replace(new RegExp(escapeRegExp(e.value), 'gi'), '');
    }
  }
  s = s.replace(/(优先级|负责人|截止|截至|指派给|分配给|交给|转给)[:：]?/g, '');
  let prev = '';
  while (prev !== s) {
    prev = s;
    s = s.replace(/^[，,。.！!？?；;：:\s]+|[，,。.！!？?；;：:\s]+$/g, '');
    for (const p of TITLE_NOISE_PATTERNS) {
      s = s.replace(p, '');
    }
  }
  return s.trim();
}

/**
 * Derive a concise task title from raw text + extracted entities.
 *
 * Strategy: try each task_name entity (highest confidence first),
 * then the full text, and return the first candidate that still has
 * ≥2 meaningful characters after cleaning. Falls back to raw text.
 */
export function deriveTitle(text: string, entities: TaskEntity[]): string {
  const candidates = entities
    .filter(e => e.type === 'task_name')
    .sort((a, b) => b.confidence - a.confidence)
    .map(e => e.value);
  candidates.push(text);
  for (const c of candidates) {
    const cleaned = cleanTitleCandidate(c, entities);
    if (cleaned.length >= 2) return cleaned;
  }
  return text.trim();
}

// ─── Intent → Task Bridge ──────────────────────────────────────────

export class IntentTaskBridge {
  readonly manager: TaskManager;
  private config: BridgeConfig;

  constructor(manager?: TaskManager, config?: Partial<BridgeConfig>) {
    this.manager = manager ?? new TaskManager();
    this.config = { ...DEFAULT_BRIDGE_CONFIG, ...config };
  }

  /**
   * End-to-end entry point: classify a user utterance and execute the
   * mapped task operation (subject to confidence gating).
   */
  handleUserInput(text: string, context?: IntentContext): BridgeResult {
    const intent = classifyIntent(text, context, this.config.pipelineConfig);
    return this.handleIntent(intent, text);
  }

  /**
   * Execute the task operation mapped from an already-classified intent.
   */
  handleIntent(intent: PipelineResult, originalText?: string): BridgeResult {
    const text = originalText ?? '';
    const operation = this.mapOperation(intent);

    // ── Confidence gating ────────────────────────────────────────
    const action = intent.recommendedAction;
    if (action === 'fallback_help' || action === 'offer_alternatives') {
      return this.notExecuted(intent, operation,
        action === 'fallback_help'
          ? '无法理解该指令，请换个说法或提供更多信息'
          : `意图不明确，候选: ${intent.alternatives.map(a => a.category).join(', ') || '无'}`,
      );
    }
    if (action === 'confirm_with_user' && !this.config.autoConfirm) {
      return {
        ...this.notExecuted(intent, operation,
          `需要确认后执行: ${intent.category}/${intent.subCategory} (置信度 ${intent.confidence.toFixed(2)})`),
        needsConfirmation: true,
      };
    }

    // ── Dispatch ─────────────────────────────────────────────────
    const start = Date.now();
    let result: TaskOperationResult;
    switch (operation) {
      case 'create':
        result = this.doCreate(intent, text);
        break;
      case 'query':
        result = this.doQuery(intent, text);
        break;
      case 'modify':
        result = this.doModify(intent, text);
        break;
      case 'delete':
        result = this.doDelete(intent, text);
        break;
      case 'none':
      default:
        // Non-task intents are routed, not executed by the Task Manager.
        return this.notExecuted(intent, 'none',
          `该意图由 ${intent.routeHandler} 处理（不属于任务 CRUD）`);
    }
    result.intentCategory = intent.category;
    result.processingTimeMs = Date.now() - start;

    return {
      executed: true,
      needsConfirmation: false,
      operation,
      routeHandler: intent.routeHandler,
      intent,
      result,
      message: result.message,
    };
  }

  // ── Operation Mapping ───────────────────────────────────────────

  private mapOperation(intent: PipelineResult): BridgeOperation {
    switch (intent.category) {
      case 'create_task': return 'create';
      case 'query_status': return 'query';
      case 'modify_task': return 'modify';
      case 'delete_task': return 'delete';
      default: return 'none';
    }
  }

  // ── Handlers ────────────────────────────────────────────────────

  private doCreate(intent: PipelineResult, text: string): TaskOperationResult {
    const input: CreateTaskInput = {
      title: deriveTitle(text, intent.entities),
      priority: normalizePriority(pickEntity(intent.entities, 'priority')?.value),
      category: subCategoryToTaskCategory(intent.subCategory),
      assignee: pickEntity(intent.entities, 'assignee')?.value,
      deadline: pickEntity(intent.entities, 'deadline')?.value,
    };
    const r = this.manager.createTask(input);
    return { success: r.ok, message: r.message, task: r.task };
  }

  private doQuery(intent: PipelineResult, text: string): TaskOperationResult {
    if (intent.subCategory === 'single') {
      const ref = pickEntity(intent.entities, 'task_name')?.value ?? text;
      const task = this.manager.findTaskByReference(ref);
      if (!task) {
        return { success: false, message: `未找到匹配的任务: ${ref}` };
      }
      return {
        success: true,
        message: `任务 "${task.title}" 当前状态: ${task.status}，优先级 ${task.priority}`,
        task,
      };
    }
    // all / filtered / summary → list non-archived tasks
    const q = this.manager.queryTasks({});
    return {
      success: true,
      message: `共 ${q.total} 个任务`,
      tasks: q.tasks,
    };
  }

  private doModify(intent: PipelineResult, text: string): TaskOperationResult {
    const ref = pickEntity(intent.entities, 'task_name')?.value ?? text;
    const task = this.manager.findTaskByReference(ref);
    if (!task) {
      return { success: false, message: `未找到要修改的任务: ${ref}` };
    }
    const input: ModifyTaskInput = {};
    const priority = normalizePriority(pickEntity(intent.entities, 'priority')?.value);
    const status = normalizeStatus(pickEntity(intent.entities, 'status')?.value);
    const assignee = pickEntity(intent.entities, 'assignee')?.value;
    const deadline = pickEntity(intent.entities, 'deadline')?.value;

    switch (intent.subCategory) {
      case 'priority':
        if (priority) input.priority = priority;
        break;
      case 'status':
        if (status) input.status = status;
        break;
      case 'assignee':
        if (assignee) input.assignee = assignee;
        break;
      case 'deadline':
        if (deadline) input.deadline = deadline;
        break;
      default:
        // Fall back to whatever entities were extracted.
        if (priority) input.priority = priority;
        if (status) input.status = status;
        if (assignee) input.assignee = assignee;
        if (deadline) input.deadline = deadline;
        break;
    }
    if (Object.keys(input).length === 0) {
      return {
        success: false,
        message: `未能从输入中提取到可修改的字段: ${text}`,
        task,
      };
    }
    const r = this.manager.modifyTask(task.id, input);
    return { success: r.ok, message: r.message, task: r.task };
  }

  private doDelete(intent: PipelineResult, text: string): TaskOperationResult {
    const ref = pickEntity(intent.entities, 'task_name')?.value ?? text;
    const task = this.manager.findTaskByReference(ref);
    if (!task) {
      return { success: false, message: `未找到要删除的任务: ${ref}` };
    }
    if (intent.subCategory === 'archive') {
      const r = this.manager.archiveTask(task.id);
      return { success: r.ok, message: r.message, task: r.task };
    }
    // single / cancel → lifecycle cancel
    const r = this.manager.cancelTask(task.id);
    return { success: r.ok, message: r.message, task: r.task };
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private notExecuted(
    intent: PipelineResult,
    operation: BridgeOperation,
    message: string,
  ): BridgeResult {
    return {
      executed: false,
      needsConfirmation: false,
      operation,
      routeHandler: intent.routeHandler,
      intent,
      message,
    };
  }
}

// ─── Convenience API ───────────────────────────────────────────────

/** Shared default bridge instance. */
export const defaultBridge = new IntentTaskBridge();

/**
 * One-shot convenience: classify + execute with the default bridge.
 */
export function handleTaskIntent(
  text: string,
  context?: IntentContext,
): BridgeResult {
  return defaultBridge.handleUserInput(text, context);
}
