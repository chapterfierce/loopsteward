/**
 * Claw Task Service — In-Memory Task Store (Phase 3 M4)
 *
 * Storage layer for Task entities. Provides CRUD primitives and
 * fuzzy title lookup used by the intent→task integration bridge.
 *
 * Design notes:
 *   - In-memory Map keyed by task id (persistence is out of M4 scope;
 *     the interface is deliberately small so a DB-backed store can be
 *     swapped in later).
 *   - Fuzzy lookup uses longest-common-substring scoring so that
 *     colloquial references ("登录页面那个任务") can resolve to a
 *     stored task whose title shares a significant fragment.
 */

import {
  Task,
  TaskQueryFilter,
  TaskQueryResult,
} from './task-types.js';

// ─── ID Generation ─────────────────────────────────────────────────

let idCounter = 0;

/** Generate a unique, sortable task id. */
export function generateTaskId(): string {
  idCounter += 1;
  const ts = Date.now().toString(36);
  const seq = idCounter.toString(36).padStart(4, '0');
  return `task-${ts}-${seq}`;
}

// ─── Fuzzy Matching Helpers ────────────────────────────────────────

/**
 * Length of the longest common substring between two strings.
 * O(n*m) dynamic programming — fine for short titles/queries.
 */
export function longestCommonSubstring(a: string, b: string): number {
  if (!a || !b) return 0;
  const m = a.length;
  const n = b.length;
  let best = 0;
  let prev = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    const curr = new Array<number>(n + 1).fill(0);
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1] + 1;
        if (curr[j] > best) best = curr[j];
      }
    }
    prev = curr;
  }
  return best;
}

// ─── Task Store ────────────────────────────────────────────────────

export class TaskStore {
  private tasks: Map<string, Task> = new Map();

  /** Insert a task. Overwrites any task with the same id. */
  insert(task: Task): void {
    this.tasks.set(task.id, task);
  }

  /** Get a task by id, or undefined. */
  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  /** Replace an existing task. Returns false if the id is unknown. */
  update(task: Task): boolean {
    if (!this.tasks.has(task.id)) return false;
    this.tasks.set(task.id, task);
    return true;
  }

  /** Hard-delete a task by id. Returns whether it existed. */
  remove(id: string): boolean {
    return this.tasks.delete(id);
  }

  /** Total number of stored tasks (including archived). */
  get size(): number {
    return this.tasks.size;
  }

  /** All tasks (defensive copy). */
  all(): Task[] {
    return [...this.tasks.values()];
  }

  /** Remove all tasks. */
  clear(): void {
    this.tasks.clear();
  }

  /**
   * Query tasks by filter. Archived tasks are excluded unless the
   * filter explicitly asks for them.
   */
  query(filter: TaskQueryFilter = {}): TaskQueryResult {
    const tasks = this.all().filter(t => {
      if (filter.archived === undefined) {
        if (t.archived) return false;
      } else if (t.archived !== filter.archived) {
        return false;
      }
      if (filter.status !== undefined && t.status !== filter.status) return false;
      if (filter.priority !== undefined && t.priority !== filter.priority) return false;
      if (filter.category !== undefined && t.category !== filter.category) return false;
      if (filter.assignee !== undefined && t.assignee !== filter.assignee) return false;
      return true;
    });
    return { tasks, total: tasks.length, filter };
  }

  /**
   * Find the task whose title best matches a free-form reference.
   *
   * Scoring: longest common substring between the stored title and the
   * reference text. A minimum overlap of `minOverlap` characters is
   * required (default 2 — one CJK word fragment).
   *
   * @param reference - free-form text referring to a task
   * @param minOverlap - minimum LCS length to accept a match
   * @returns the best-matching non-archived task, or undefined
   */
  findByReference(reference: string, minOverlap: number = 2): Task | undefined {
    if (!reference) return undefined;
    let best: Task | undefined;
    let bestScore = 0;
    for (const task of this.tasks.values()) {
      if (task.archived) continue;
      const score = longestCommonSubstring(task.title, reference);
      if (score > bestScore) {
        bestScore = score;
        best = task;
      }
    }
    return bestScore >= minOverlap ? best : undefined;
  }
}
