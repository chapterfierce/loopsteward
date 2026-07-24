/**
 * Claw Task Service — Task Entity Types (Phase 3 M4)
 *
 * Task entity type definitions for the Task Manager integration.
 * Defines Task, TaskStatus, TaskPriority, and related types used
 * throughout the task management lifecycle.
 *
 * Based on: Phase 3 M4 spec (2026-07-24)
 */

// ─── Task Status (Lifecycle States) ───────────────────────────────

/**
 * Task lifecycle states.
 *
 * State machine transitions:
 *   created → assigned → in_progress → completed
 *   created → assigned → in_progress → cancelled
 *   created → cancelled (direct cancel before assignment)
 *   assigned → cancelled
 *   in_progress → on_hold → in_progress
 *   in_progress → cancelled
 */
export type TaskStatus =
  | 'created'
  | 'assigned'
  | 'in_progress'
  | 'on_hold'
  | 'completed'
  | 'cancelled';

/**
 * Task priority levels, aligned with common P0–P3 convention.
 */
export type TaskPriority = 'P0' | 'P1' | 'P2' | 'P3';

/**
 * Task category for classification.
 */
export type TaskCategory =
  | 'bugfix'
  | 'feature'
  | 'refactor'
  | 'doc'
  | 'test'
  | 'design'
  | 'general';

// ─── Task Entity ───────────────────────────────────────────────────

/**
 * The core Task entity managed by the Task Manager.
 */
export interface Task {
  /** Unique task identifier (UUID-like string) */
  id: string;
  /** Human-readable task title */
  title: string;
  /** Detailed task description (optional) */
  description?: string;
  /** Current lifecycle status */
  status: TaskStatus;
  /** Priority level */
  priority: TaskPriority;
  /** Task category */
  category: TaskCategory;
  /** Assigned user identifier (optional, unassigned if undefined) */
  assignee?: string;
  /** ISO 8601 creation timestamp */
  createdAt: string;
  /** ISO 8601 last update timestamp */
  updatedAt: string;
  /** ISO 8601 deadline (optional) */
  deadline?: string;
  /** Tags for flexible categorization */
  tags: string[];
  /** Whether the task is archived (soft-delete) */
  archived: boolean;
}

/**
 * Input for creating a new task.
 */
export interface CreateTaskInput {
  title: string;
  description?: string;
  priority?: TaskPriority;
  category?: TaskCategory;
  assignee?: string;
  deadline?: string;
  tags?: string[];
}

/**
 * Input for modifying a task. All fields optional.
 */
export interface ModifyTaskInput {
  title?: string;
  description?: string;
  priority?: TaskPriority;
  category?: TaskCategory;
  assignee?: string;
  status?: TaskStatus;
  deadline?: string;
  tags?: string[];
}

// ─── Query Types ───────────────────────────────────────────────────

/**
 * Filter criteria for querying tasks.
 */
export interface TaskQueryFilter {
  status?: TaskStatus;
  priority?: TaskPriority;
  category?: TaskCategory;
  assignee?: string;
  archived?: boolean;
}

/**
 * Result of a task query.
 */
export interface TaskQueryResult {
  tasks: Task[];
  total: number;
  filter: TaskQueryFilter;
}

// ─── Operation Result ─────────────────────────────────────────────

/**
 * Generic result of a task operation.
 */
export interface TaskOperationResult {
  success: boolean;
  message: string;
  task?: Task;
  tasks?: Task[];
  /** Original intent category that triggered this operation */
  intentCategory?: string;
  /** Processing time in ms */
  processingTimeMs?: number;
}

// ─── Constants ─────────────────────────────────────────────────────

/**
 * Valid status transitions for the task state machine.
 * Used by task-lifecycle.ts to validate transitions.
 */
export const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  created: ['assigned', 'cancelled'],
  assigned: ['in_progress', 'cancelled'],
  in_progress: ['on_hold', 'completed', 'cancelled'],
  on_hold: ['in_progress', 'cancelled'],
  completed: [],
  cancelled: [],
};

/**
 * Priority weight mapping for sorting (lower number = higher priority).
 */
export const PRIORITY_WEIGHT: Record<TaskPriority, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};

/**
 * Default values for new tasks.
 */
export const DEFAULT_TASK_VALUES: Partial<CreateTaskInput> = {
  priority: 'P2',
  category: 'general',
  tags: [],
};
