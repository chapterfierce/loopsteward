/**
 * Claw Task Service — Task Persistence Layer (Phase 3 M7)
 *
 * Abstract storage interface and implementations for Task entities.
 * Provides:
 *   - ITaskStore interface with CRUD + query operations
 *   - SQLiteStore: persistent storage using node:sqlite
 *   - InMemoryStore: in-memory storage for testing
 *
 * Design decisions:
 *   - Uses node:sqlite (Node.js built-in since v22.13.0) to avoid external deps
 *   - Schema designed for efficient querying by status/intent/time with indexes
 *   - Lifecycle transitions validated against M4 state machine before persist
 *   - Soft delete (archived flag) with optional hard delete
 *
 * Based on: Phase 3 M7 spec (2026-08-02)
 */

import {
  Task,
  TaskStatus,
  TaskPriority,
  TaskCategory,
  TaskQueryFilter,
  TaskQueryResult,
  VALID_TRANSITIONS,
} from './task-types.js';
import {
  isValidTransition,
  LifecycleError,
} from './task-lifecycle.js';
import { generateTaskId } from './task-store.js';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── Query Options ─────────────────────────────────────────────────

/**
 * Pagination parameters.
 */
export interface PaginationOptions {
  /** Page number (1-based) */
  page?: number;
  /** Items per page (default 20, max 500) */
  pageSize?: number;
}

/**
 * Time range filter.
 */
export interface TimeRangeFilter {
  /** Filter tasks created after this timestamp (ISO 8601) */
  createdAfter?: string;
  /** Filter tasks created before this timestamp (ISO 8601) */
  createdBefore?: string;
  /** Filter tasks updated after this timestamp (ISO 8601) */
  updatedAfter?: string;
  /** Filter tasks updated before this timestamp (ISO 8601) */
  updatedBefore?: string;
}

/**
 * Extended query filter with pagination and time range.
 */
export interface ExtendedQueryFilter extends TaskQueryFilter, PaginationOptions, TimeRangeFilter {
  /** Filter by intent category (e.g., 'create_task', 'query_status') */
  intentCategory?: string;
  /** Sort field: 'createdAt' | 'updatedAt' | 'priority' | 'status' */
  sortBy?: 'createdAt' | 'updatedAt' | 'priority' | 'status';
  /** Sort order: 'asc' | 'desc' */
  sortOrder?: 'asc' | 'desc';
}

/**
 * Paginated query result.
 */
export interface PaginatedQueryResult extends TaskQueryResult {
  /** Current page number (1-based) */
  page: number;
  /** Items per page */
  pageSize: number;
  /** Total number of pages */
  totalPages: number;
  /** Whether there's a next page */
  hasNextPage: boolean;
  /** Whether there's a previous page */
  hasPrevPage: boolean;
}

// ─── Storage Interface ─────────────────────────────────────────────

/**
 * Abstract task storage interface.
 *
 * All implementations must:
 *   - Validate lifecycle transitions before persisting status changes
 *   - Record metrics for invalid transitions (M3 observability)
 *   - Support concurrent writes safely
 */
export interface ITaskStore {
  // ── CRUD ───────────────────────────────────────────────────────

  /** Create a new task. Throws if duplicate id. */
  create(task: Task): void;

  /** Get a task by id, or undefined if not found. */
  get(id: string): Task | undefined;

  /** Update an existing task. Returns false if not found. */
  update(task: Task): boolean;

  /** Hard delete a task. Returns false if not found. */
  delete(id: string): boolean;

  // ── Lifecycle ───────────────────────────────────────────────────

  /**
   * Transition task status. Validates against M4 state machine.
   * Returns true if successful, false if invalid or not found.
   * Records metrics for invalid transitions.
   */
  transitionStatus(id: string, newStatus: TaskStatus, reason?: string): boolean;

  // ── Query ───────────────────────────────────────────────────────

  /** Basic query (backward compatible with M4 TaskStore). */
  query(filter?: TaskQueryFilter): TaskQueryResult;

  /** Extended query with pagination, time range, sorting. */
  queryExtended(filter?: ExtendedQueryFilter): PaginatedQueryResult;

  /** Total count of non-archived tasks. */
  countActive(): number;

  /** Total count with optional filter. */
  count(filter?: TaskQueryFilter): number;

  // ── Lifecycle ───────────────────────────────────────────────────

  /** Clear all tasks. Used for testing. */
  clear(): void;

  /** Close connections (for persistent stores). */
  close(): void;
}

// ─── In-Memory Store ───────────────────────────────────────────────

/**
 * In-memory task storage for testing.
 *
 * Thread-safe for concurrent writes using synchronous operations.
 * Implements ITaskStore interface with lifecycle validation.
 */
export class InMemoryStore implements ITaskStore {
  private tasks: Map<string, Task> = new Map();
  private invalidTransitions: number = 0;

  // ── CRUD ───────────────────────────────────────────────────────

  create(task: Task): void {
    if (this.tasks.has(task.id)) {
      throw new Error(`Task already exists: ${task.id}`);
    }
    this.tasks.set(task.id, task);
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  update(task: Task): boolean {
    if (!this.tasks.has(task.id)) return false;
    this.tasks.set(task.id, task);
    return true;
  }

  delete(id: string): boolean {
    return this.tasks.delete(id);
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  transitionStatus(id: string, newStatus: TaskStatus, _reason?: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;

    if (!isValidTransition(task.status, newStatus)) {
      this.invalidTransitions++;
      return false;
    }

    task.status = newStatus;
    task.updatedAt = new Date().toISOString();
    this.tasks.set(id, task);
    return true;
  }

  // ── Query ───────────────────────────────────────────────────────

  query(filter: TaskQueryFilter = {}): TaskQueryResult {
    const tasks = this.filterTasks(filter);
    return { tasks, total: tasks.length, filter };
  }

  queryExtended(filter: ExtendedQueryFilter = {}): PaginatedQueryResult {
    let tasks = this.filterTasks(filter);

    // Time range filtering
    if (filter.createdAfter || filter.createdBefore) {
      tasks = tasks.filter(t => {
        if (filter.createdAfter && t.createdAt < filter.createdAfter) return false;
        if (filter.createdBefore && t.createdAt >= filter.createdBefore) return false;
        return true;
      });
    }

    if (filter.updatedAfter || filter.updatedBefore) {
      tasks = tasks.filter(t => {
        if (filter.updatedAfter && t.updatedAt < filter.updatedAfter) return false;
        if (filter.updatedBefore && t.updatedAt > filter.updatedBefore) return false;
        return true;
      });
    }

    // Sorting
    const sortBy = filter.sortBy ?? 'createdAt';
    const sortOrder = filter.sortOrder ?? 'desc';
    tasks.sort((a, b) => {
      let cmp = 0;
      switch (sortBy) {
        case 'createdAt':
          cmp = a.createdAt.localeCompare(b.createdAt);
          break;
        case 'updatedAt':
          cmp = a.updatedAt.localeCompare(b.updatedAt);
          break;
        case 'priority': {
          const weightA = this.priorityWeight(a.priority);
          const weightB = this.priorityWeight(b.priority);
          cmp = weightA - weightB;
          break;
        }
        case 'status':
          cmp = a.status.localeCompare(b.status);
          break;
      }
      return sortOrder === 'asc' ? cmp : -cmp;
    });

    // Pagination
    const page = Math.max(1, filter.page ?? 1);
    const rawPageSize = filter.pageSize ?? 20;
    // pageSize=0 is a signal to use the default; guard against 0
    const pageSize = Math.min(500, Math.max(1, rawPageSize === 0 ? 20 : rawPageSize));
    const total = tasks.length;
    const totalPages = Math.ceil(total / pageSize);
    const offset = (page - 1) * pageSize;
    const paged = tasks.slice(offset, offset + pageSize);

    return {
      tasks: paged,
      total,
      filter,
      page,
      pageSize,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    };
  }

  countActive(): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (!task.archived) count++;
    }
    return count;
  }

  count(filter?: TaskQueryFilter): number {
    if (!filter || Object.keys(filter).length === 0) {
      return this.tasks.size;
    }
    return this.filterTasks(filter).length;
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  clear(): void {
    this.tasks.clear();
    this.invalidTransitions = 0;
  }

  close(): void {
    // No-op for in-memory store
  }

  // ── Metrics ─────────────────────────────────────────────────────

  /** Get count of invalid transition attempts (for observability). */
  getInvalidTransitionCount(): number {
    return this.invalidTransitions;
  }

  // ── Private ────────────────────────────────────────────────────

  private filterTasks(filter: TaskQueryFilter): Task[] {
    const result: Task[] = [];
    for (const task of this.tasks.values()) {
      if (filter.archived === undefined) {
        if (task.archived) continue;
      } else if (task.archived !== filter.archived) {
        continue;
      }
      if (filter.status !== undefined && task.status !== filter.status) continue;
      if (filter.priority !== undefined && task.priority !== filter.priority) continue;
      if (filter.category !== undefined && task.category !== filter.category) continue;
      if (filter.assignee !== undefined && task.assignee !== filter.assignee) continue;
      result.push(task);
    }
    return result;
  }

  private priorityWeight(p: TaskPriority): number {
    const weights: Record<TaskPriority, number> = {
      P0: 0, P1: 1, P2: 2, P3: 3,
    };
    return weights[p] ?? 2;
  }
}

// ─── SQLite Store ──────────────────────────────────────────────────

/**
 * SQLite-backed persistent task storage.
 *
 * Uses node:sqlite (built-in) for zero external dependencies.
 * Schema:
 *   - tasks table with indexed columns for efficient querying
 *   - lifecycle_events table for audit trail
 *
 * Thread-safe for concurrent writes (SQLite handles locking).
 */
export class SQLiteStore implements ITaskStore {
  private db: any;
  private invalidTransitions: number = 0;
  private closed: boolean = false;

  /**
   * Create or open a SQLite database at the given path.
   * @param dbPath - Path to SQLite file (default: ./data/tasks.db)
   */
  constructor(dbPath: string = './data/tasks.db') {
    // NOTE: this module is ESM ("type": "module"), so bare `require` is not
    // defined. Use createRequire so the constructor can stay synchronous while
    // still loading the built-in lazily (environments without node:sqlite must
    // still be able to import this file and use InMemoryStore).
    let DatabaseSync: any;
    try {
      const req = createRequire(import.meta.url);
      // @ts-ignore - node:sqlite is a built-in but may not be in types
      ({ DatabaseSync } = req('node:sqlite'));
    } catch (err: any) {
      throw new Error(
        `SQLiteStore requires Node.js >= 22.13.0 with node:sqlite. ` +
        `Current error: ${err.message}`
      );
    }

    // Ensure the parent directory exists, otherwise SQLite cannot create the file.
    const dir = path.dirname(dbPath);
    if (dir && dir !== '.' && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new DatabaseSync(dbPath);
    // node:sqlite has no better-sqlite3-style .pragma(); use exec().
    this.db.exec('PRAGMA journal_mode = WAL;'); // Better concurrent write support
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.initSchema();
  }

  /**
   * Run `fn` inside a SQLite transaction.
   *
   * node:sqlite does not provide better-sqlite3's `db.transaction()` helper,
   * so drive BEGIN/COMMIT/ROLLBACK explicitly.
   */
  private runInTransaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* rollback is best-effort */ }
      throw err;
    }
  }

  // ── Schema Initialization ───────────────────────────────────────

  private initSchema(): void {
    // Tasks table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'created',
        priority TEXT NOT NULL DEFAULT 'P2',
        category TEXT NOT NULL DEFAULT 'general',
        assignee TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deadline TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        archived INTEGER NOT NULL DEFAULT 0,
        intent_category TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
      CREATE INDEX IF NOT EXISTS idx_tasks_category ON tasks(category);
      CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee);
      CREATE INDEX IF NOT EXISTS idx_tasks_archived ON tasks(archived);
      CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_updated_at ON tasks(updated_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_intent ON tasks(intent_category);
    `);

    // Lifecycle events table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS lifecycle_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        from_status TEXT NOT NULL,
        to_status TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        reason TEXT,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_lifecycle_task_id ON lifecycle_events(task_id);
      CREATE INDEX IF NOT EXISTS idx_lifecycle_timestamp ON lifecycle_events(timestamp);
    `);
  }

  // ── CRUD ───────────────────────────────────────────────────────

  create(task: Task): void {
    const stmt = this.db.prepare(`
      INSERT INTO tasks (
        id, title, description, status, priority, category, assignee,
        created_at, updated_at, deadline, tags, archived, intent_category
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    try {
      stmt.run(
        task.id,
        task.title,
        task.description ?? null,
        task.status,
        task.priority,
        task.category,
        task.assignee ?? null,
        task.createdAt,
        task.updatedAt,
        task.deadline ?? null,
        JSON.stringify(task.tags),
        task.archived ? 1 : 0,
        (task as any).intentCategory ?? null,
      );
    } catch (err: any) {
      if (err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
        throw new Error(`Task already exists: ${task.id}`);
      }
      throw err;
    }
  }

  get(id: string): Task | undefined {
    const stmt = this.db.prepare('SELECT * FROM tasks WHERE id = ?');
    const row = stmt.get(id);
    return row ? this.rowToTask(row) : undefined;
  }

  update(task: Task): boolean {
    const stmt = this.db.prepare(`
      UPDATE tasks SET
        title = ?, description = ?, status = ?, priority = ?, category = ?,
        assignee = ?, updated_at = ?, deadline = ?, tags = ?, archived = ?, intent_category = ?
      WHERE id = ?
    `);

    const result = stmt.run(
      task.title,
      task.description ?? null,
      task.status,
      task.priority,
      task.category,
      task.assignee ?? null,
      task.updatedAt,
      task.deadline ?? null,
      JSON.stringify(task.tags),
      task.archived ? 1 : 0,
      (task as any).intentCategory ?? null,
      task.id,
    );

    return result.changes > 0;
  }

  delete(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM tasks WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  transitionStatus(id: string, newStatus: TaskStatus, reason?: string): boolean {
    const task = this.get(id);
    if (!task) return false;

    if (!isValidTransition(task.status, newStatus)) {
      this.invalidTransitions++;
      // Record invalid transition attempt for observability
      this.recordInvalidTransition(task.status, newStatus);
      return false;
    }

    // Use transaction for atomicity
    this.runInTransaction(() => {
      // Update task status
      const updateStmt = this.db.prepare(
        'UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?'
      );
      updateStmt.run(newStatus, new Date().toISOString(), id);

      // Record lifecycle event
      const eventStmt = this.db.prepare(`
        INSERT INTO lifecycle_events (task_id, from_status, to_status, timestamp, reason)
        VALUES (?, ?, ?, ?, ?)
      `);
      eventStmt.run(id, task.status, newStatus, new Date().toISOString(), reason ?? null);
    });

    return true;
  }

  // ── Query ───────────────────────────────────────────────────────

  query(filter: TaskQueryFilter = {}): TaskQueryResult {
    const { sql, params } = this.buildQuery(filter);
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params);
    const tasks = rows.map(this.rowToTask);

    // Get total count (without pagination)
    const countSql = this.buildCountQuery(filter);
    const countStmt = this.db.prepare(countSql.sql);
    const countRow = countStmt.get(...countSql.params);
    const total = countRow?.count ?? 0;

    return { tasks, total, filter };
  }

  queryExtended(filter: ExtendedQueryFilter = {}): PaginatedQueryResult {
    const { sql, params } = this.buildExtendedQuery(filter);
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params);
    const tasks = rows.map(this.rowToTask);

    // Get total count (without pagination)
    const countSql = this.buildCountQuery(filter);
    const countStmt = this.db.prepare(countSql.sql);
    const countRow = countStmt.get(...countSql.params);
    const total = countRow?.count ?? 0;

    const page = Math.max(1, filter.page ?? 1);
    const pageSize = Math.min(500, Math.max(1, filter.pageSize ?? 20));
    const totalPages = Math.ceil(total / pageSize);

    return {
      tasks,
      total,
      filter,
      page,
      pageSize,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    };
  }

  countActive(): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM tasks WHERE archived = 0');
    const row = stmt.get();
    return row?.count ?? 0;
  }

  count(filter?: TaskQueryFilter): number {
    if (!filter || Object.keys(filter).length === 0) {
      const stmt = this.db.prepare('SELECT COUNT(*) as count FROM tasks');
      const row = stmt.get();
      return row?.count ?? 0;
    }
    const { sql, params } = this.buildCountQuery(filter);
    const stmt = this.db.prepare(sql);
    const row = stmt.get(...params);
    return row?.count ?? 0;
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  clear(): void {
    this.db.exec('DELETE FROM lifecycle_events');
    this.db.exec('DELETE FROM tasks');
    this.invalidTransitions = 0;
  }

  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }

  // ── Metrics ─────────────────────────────────────────────────────

  /** Get count of invalid transition attempts (for observability). */
  getInvalidTransitionCount(): number {
    return this.invalidTransitions;
  }

  /** Get lifecycle events for a task. */
  getLifecycleEvents(taskId: string): Array<{
    fromStatus: TaskStatus;
    toStatus: TaskStatus;
    timestamp: string;
    reason?: string;
  }> {
    const stmt = this.db.prepare(`
      SELECT from_status, to_status, timestamp, reason
      FROM lifecycle_events
      WHERE task_id = ?
      ORDER BY timestamp ASC
    `);
    const rows = stmt.all(taskId);
    return rows.map((row: any) => ({
      fromStatus: row.from_status as TaskStatus,
      toStatus: row.to_status as TaskStatus,
      timestamp: row.timestamp,
      reason: row.reason ?? undefined,
    }));
  }

  // ── Private ────────────────────────────────────────────────────

  private buildQuery(filter: TaskQueryFilter): { sql: string; params: any[] } {
    const clauses: string[] = [];
    const params: any[] = [];

    if (filter.archived === undefined) {
      clauses.push('archived = 0');
    } else {
      clauses.push('archived = ?');
      params.push(filter.archived ? 1 : 0);
    }

    if (filter.status) {
      clauses.push('status = ?');
      params.push(filter.status);
    }

    if (filter.priority) {
      clauses.push('priority = ?');
      params.push(filter.priority);
    }

    if (filter.category) {
      clauses.push('category = ?');
      params.push(filter.category);
    }

    if (filter.assignee) {
      clauses.push('assignee = ?');
      params.push(filter.assignee);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const sql = `SELECT * FROM tasks ${where} ORDER BY created_at DESC`;

    return { sql, params };
  }

  private buildExtendedQuery(filter: ExtendedQueryFilter): { sql: string; params: any[] } {
    const clauses: string[] = [];
    const params: any[] = [];

    // Archive filter
    if (filter.archived === undefined) {
      clauses.push('archived = 0');
    } else {
      clauses.push('archived = ?');
      params.push(filter.archived ? 1 : 0);
    }

    // Standard filters
    if (filter.status) {
      clauses.push('status = ?');
      params.push(filter.status);
    }

    if (filter.priority) {
      clauses.push('priority = ?');
      params.push(filter.priority);
    }

    if (filter.category) {
      clauses.push('category = ?');
      params.push(filter.category);
    }

    if (filter.assignee) {
      clauses.push('assignee = ?');
      params.push(filter.assignee);
    }

    // Intent filter
    if (filter.intentCategory) {
      clauses.push('intent_category = ?');
      params.push(filter.intentCategory);
    }

    // Time range filters
    if (filter.createdAfter) {
      clauses.push('created_at >= ?');
      params.push(filter.createdAfter);
    }

    if (filter.createdBefore) {
      clauses.push('created_at <= ?');
      params.push(filter.createdBefore);
    }

    if (filter.updatedAfter) {
      clauses.push('updated_at >= ?');
      params.push(filter.updatedAfter);
    }

    if (filter.updatedBefore) {
      clauses.push('updated_at <= ?');
      params.push(filter.updatedBefore);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

    // Sorting
    const sortBy = filter.sortBy ?? 'createdAt';
    const sortOrder = filter.sortOrder ?? 'desc';
    const sortColumn = sortBy === 'createdAt' ? 'created_at' :
                       sortBy === 'updatedAt' ? 'updated_at' :
                       sortBy;

    // Pagination
    const page = Math.max(1, filter.page ?? 1);
    const rawPageSize = filter.pageSize ?? 20;
    // pageSize=0 is a signal to use the default; guard against 0
    const pageSize = Math.min(500, Math.max(1, rawPageSize === 0 ? 20 : rawPageSize));
    const offset = (page - 1) * pageSize;

    const sql = `
      SELECT * FROM tasks
      ${where}
      ORDER BY ${sortColumn} ${sortOrder.toUpperCase()}
      LIMIT ? OFFSET ?
    `;

    params.push(pageSize, offset);

    return { sql, params };
  }

  private buildCountQuery(filter: TaskQueryFilter): { sql: string; params: any[] } {
    const clauses: string[] = [];
    const params: any[] = [];

    if (filter.archived === undefined) {
      clauses.push('archived = 0');
    } else {
      clauses.push('archived = ?');
      params.push(filter.archived ? 1 : 0);
    }

    if (filter.status) {
      clauses.push('status = ?');
      params.push(filter.status);
    }

    if (filter.priority) {
      clauses.push('priority = ?');
      params.push(filter.priority);
    }

    if (filter.category) {
      clauses.push('category = ?');
      params.push(filter.category);
    }

    if (filter.assignee) {
      clauses.push('assignee = ?');
      params.push(filter.assignee);
    }

    if ((filter as ExtendedQueryFilter).intentCategory) {
      clauses.push('intent_category = ?');
      params.push((filter as ExtendedQueryFilter).intentCategory);
    }

    if ((filter as ExtendedQueryFilter).createdAfter) {
      clauses.push('created_at >= ?');
      params.push((filter as ExtendedQueryFilter).createdAfter);
    }

    if ((filter as ExtendedQueryFilter).createdBefore) {
      clauses.push('created_at <= ?');
      params.push((filter as ExtendedQueryFilter).createdBefore);
    }

    if ((filter as ExtendedQueryFilter).updatedAfter) {
      clauses.push('updated_at >= ?');
      params.push((filter as ExtendedQueryFilter).updatedAfter);
    }

    if ((filter as ExtendedQueryFilter).updatedBefore) {
      clauses.push('updated_at <= ?');
      params.push((filter as ExtendedQueryFilter).updatedBefore);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const sql = `SELECT COUNT(*) as count FROM tasks ${where}`;

    return { sql, params };
  }

  private rowToTask(row: any): Task {
    return {
      id: row.id,
      title: row.title,
      description: row.description ?? undefined,
      status: row.status as TaskStatus,
      priority: row.priority as TaskPriority,
      category: row.category as TaskCategory,
      assignee: row.assignee ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deadline: row.deadline ?? undefined,
      tags: JSON.parse(row.tags),
      archived: row.archived === 1,
      intentCategory: row.intent_category ?? undefined,
    } as Task & { intentCategory?: string };
  }

  private recordInvalidTransition(from: TaskStatus, to: TaskStatus): void {
    // Could write to a separate invalid_transitions table for observability
    // For now, just increment counter (accessible via getInvalidTransitionCount)
  }
}

// ─── Factory Function ──────────────────────────────────────────────

/**
 * Create a task store based on environment configuration.
 *
 * @param type - 'memory' for InMemoryStore, 'sqlite' for SQLiteStore
 * @param dbPath - Path for SQLite database (only used for 'sqlite' type)
 */
export function createTaskStore(
  type: 'memory' | 'sqlite' = 'memory',
  dbPath?: string,
): ITaskStore {
  if (type === 'sqlite') {
    return new SQLiteStore(dbPath);
  }
  return new InMemoryStore();
}
