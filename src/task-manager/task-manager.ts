/**
 * Claw Task Service — Task Manager (Phase 3 M4)
 *
 * Business-logic layer above TaskStore. Enforces the task lifecycle
 * state machine (task-lifecycle.ts) for every status change and keeps
 * an audit trail via LifecycleLogger.
 *
 * Key design decision — auto-advance:
 *   Intent-driven status changes are colloquial ("标记为已完成") and
 *   users do not think in state-machine steps. `changeStatus` therefore
 *   finds the shortest valid transition path (BFS over VALID_TRANSITIONS)
 *   from the current status to the target and applies each hop, logging
 *   every intermediate transition. If no path exists (e.g. completed →
 *   in_progress) the operation fails cleanly without mutating the task.
 */

import {
  Task,
  TaskStatus,
  CreateTaskInput,
  ModifyTaskInput,
  TaskQueryFilter,
  TaskQueryResult,
  DEFAULT_TASK_VALUES,
  VALID_TRANSITIONS,
} from './task-types.js';
import {
  isValidTransition,
  LifecycleLogger,
  LifecycleEvent,
} from './task-lifecycle.js';
import { TaskStore, generateTaskId } from './task-store.js';
import {
  ITaskStore,
  InMemoryStore,
  ExtendedQueryFilter,
  PaginatedQueryResult,
} from './task-persistence.js';

// ─── Transition Path Finding ───────────────────────────────────────

/**
 * Find the shortest valid transition path from `from` to `to`
 * (excluding `from`, including `to`). Returns undefined if unreachable.
 */
export function findTransitionPath(
  from: TaskStatus,
  to: TaskStatus,
): TaskStatus[] | undefined {
  if (from === to) return [];
  const queue: TaskStatus[][] = [[from]];
  const visited = new Set<TaskStatus>([from]);
  while (queue.length > 0) {
    const path = queue.shift()!;
    const last = path[path.length - 1];
    for (const next of VALID_TRANSITIONS[last]) {
      if (visited.has(next)) continue;
      const nextPath = [...path, next];
      if (next === to) return nextPath.slice(1);
      visited.add(next);
      queue.push(nextPath);
    }
  }
  return undefined;
}

// ─── Manager Operation Result ──────────────────────────────────────

export interface ManagerResult {
  ok: boolean;
  message: string;
  task?: Task;
}

// ─── Task Manager ──────────────────────────────────────────────────

export class TaskManager {
  readonly store: ITaskStore;
  readonly lifecycleLog: LifecycleLogger;

  constructor(store?: ITaskStore, logger?: LifecycleLogger) {
    this.store = store ?? new InMemoryStore();
    this.lifecycleLog = logger ?? new LifecycleLogger();
  }

  // ── Create ──────────────────────────────────────────────────────

  createTask(input: CreateTaskInput): ManagerResult {
    const title = input.title?.trim();
    if (!title) {
      return { ok: false, message: '任务标题不能为空' };
    }
    const now = new Date().toISOString();
    const task: Task = {
      id: generateTaskId(),
      title,
      description: input.description,
      status: 'created',
      priority: input.priority ?? DEFAULT_TASK_VALUES.priority ?? 'P2',
      category: input.category ?? DEFAULT_TASK_VALUES.category ?? 'general',
      assignee: input.assignee,
      createdAt: now,
      updatedAt: now,
      deadline: input.deadline,
      tags: input.tags ?? [],
      archived: false,
    };
    this.store.insert(task);
    // Auto-assign if an assignee was provided at creation time.
    if (task.assignee) {
      this.applyTransition(task, 'assigned', 'auto-assign on create');
    }
    return { ok: true, message: `任务已创建: ${task.title}`, task };
  }

  // ── Read ────────────────────────────────────────────────────────

  getTask(id: string): Task | undefined {
    return this.store.get(id);
  }

  queryTasks(filter: TaskQueryFilter = {}): TaskQueryResult {
    return this.store.query(filter);
  }

  /** Extended query with pagination, time range, sorting (M7). */
  queryTasksExtended(filter: ExtendedQueryFilter = {}): PaginatedQueryResult {
    return this.store.queryExtended(filter);
  }

  findTaskByReference(reference: string): Task | undefined {
    return this.store.findByReference(reference);
  }

  // ── Modify ──────────────────────────────────────────────────────

  modifyTask(id: string, input: ModifyTaskInput): ManagerResult {
    const task = this.store.get(id);
    if (!task) {
      return { ok: false, message: `任务不存在: ${id}` };
    }
    // Status changes go through the lifecycle state machine.
    if (input.status !== undefined && input.status !== task.status) {
      const statusResult = this.changeStatus(id, input.status);
      if (!statusResult.ok) return statusResult;
    }
    if (input.title !== undefined) task.title = input.title;
    if (input.description !== undefined) task.description = input.description;
    if (input.priority !== undefined) task.priority = input.priority;
    if (input.category !== undefined) task.category = input.category;
    if (input.deadline !== undefined) task.deadline = input.deadline;
    if (input.tags !== undefined) task.tags = input.tags;
    if (input.assignee !== undefined && input.assignee !== task.assignee) {
      task.assignee = input.assignee;
      // Assigning an unassigned created task moves it to `assigned`.
      if (task.status === 'created' && isValidTransition('created', 'assigned')) {
        this.applyTransition(task, 'assigned', 'assignee set via modify');
      }
    }
    task.updatedAt = new Date().toISOString();
    this.store.update(task);
    return { ok: true, message: `任务已更新: ${task.title}`, task };
  }

  // ── Status / Lifecycle ──────────────────────────────────────────

  /**
   * Change a task's status, auto-advancing through intermediate valid
   * states when necessary (see module docstring).
   */
  changeStatus(id: string, target: TaskStatus, reason?: string): ManagerResult {
    const task = this.store.get(id);
    if (!task) {
      return { ok: false, message: `任务不存在: ${id}` };
    }
    if (task.status === target) {
      return { ok: true, message: `任务已处于状态 ${target}`, task };
    }
    const path = findTransitionPath(task.status, target);
    if (path === undefined) {
      return {
        ok: false,
        message: `非法状态流转: ${task.status} → ${target}（无有效路径）`,
        task,
      };
    }
    for (const next of path) {
      this.applyTransition(task, next, reason);
    }
    task.updatedAt = new Date().toISOString();
    this.store.update(task);
    return { ok: true, message: `任务状态已更新为 ${target}: ${task.title}`, task };
  }

  cancelTask(id: string, reason?: string): ManagerResult {
    return this.changeStatus(id, 'cancelled', reason ?? 'user cancel');
  }

  completeTask(id: string, reason?: string): ManagerResult {
    return this.changeStatus(id, 'completed', reason ?? 'user complete');
  }

  /** Soft-delete: mark a task as archived. */
  archiveTask(id: string): ManagerResult {
    const task = this.store.get(id);
    if (!task) {
      return { ok: false, message: `任务不存在: ${id}` };
    }
    task.archived = true;
    task.updatedAt = new Date().toISOString();
    this.store.update(task);
    return { ok: true, message: `任务已归档: ${task.title}`, task };
  }

  /** Lifecycle audit events for a task. */
  getLifecycleEvents(id: string): LifecycleEvent[] {
    return this.lifecycleLog.getEvents(id);
  }

  // ── Internal ────────────────────────────────────────────────────

  private applyTransition(task: Task, to: TaskStatus, reason?: string): void {
    const from = task.status;
    task.status = to;
    this.lifecycleLog.log({
      taskId: task.id,
      from,
      to,
      timestamp: new Date().toISOString(),
      reason,
    });
  }
}
