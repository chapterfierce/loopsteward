/**
 * Claw Task Service — Task Lifecycle State Machine (Phase 3 M4)
 *
 * Manages task status transitions according to the defined state machine:
 *
 *   created → assigned → in_progress → completed
 *   created → assigned → in_progress → cancelled
 *   created → cancelled (direct cancel before assignment)
 *   assigned → cancelled
 *   in_progress → on_hold → in_progress
 *   in_progress → cancelled
 *
 * Validates all transitions against VALID_TRANSITIONS to prevent
 * illegal state changes.
 *
 * Based on: Phase 3 M4 spec (2026-07-24)
 */

import {
  TaskStatus,
  VALID_TRANSITIONS,
} from './task-types.js';

// ─── Lifecycle Error ───────────────────────────────────────────────

/**
 * Error thrown when an invalid status transition is attempted.
 */
export class LifecycleError extends Error {
  public readonly from: TaskStatus;
  public readonly to: TaskStatus;

  constructor(from: TaskStatus, to: TaskStatus) {
    super(`Invalid task status transition: ${from} → ${to}`);
    this.name = 'LifecycleError';
    this.from = from;
    this.to = to;
  }
}

// ─── Transition Validation ─────────────────────────────────────────

/**
 * Check whether a status transition is valid.
 *
 * @param from - Current status
 * @param to - Target status
 * @returns true if the transition is allowed
 */
export function isValidTransition(from: TaskStatus, to: TaskStatus): boolean {
  const allowed = VALID_TRANSITIONS[from] ?? [];
  return allowed.includes(to);
}

/**
 * Validate a transition and throw LifecycleError if invalid.
 *
 * @param from - Current status
 * @param to - Target status
 * @throws {LifecycleError} if the transition is not allowed
 */
export function validateTransition(from: TaskStatus, to: TaskStatus): void {
  if (!isValidTransition(from, to)) {
    throw new LifecycleError(from, to);
  }
}

// ─── Lifecycle Helpers ─────────────────────────────────────────────

/**
 * Check if a status is terminal (no further transitions allowed).
 *
 * @param status - The status to check
 * @returns true if the status is terminal (completed or cancelled)
 */
export function isTerminalStatus(status: TaskStatus): boolean {
  return VALID_TRANSITIONS[status].length === 0;
}

/**
 * Get all valid next statuses from the current status.
 *
 * @param status - Current status
 * @returns Array of valid target statuses
 */
export function getNextValidStatuses(status: TaskStatus): TaskStatus[] {
  return [...VALID_TRANSITIONS[status]];
}

/**
 * Check if a task can be cancelled from its current status.
 *
 * @param status - Current status
 * @returns true if cancellation is allowed
 */
export function canCancel(status: TaskStatus): boolean {
  return isValidTransition(status, 'cancelled');
}

/**
 * Check if a task can be completed from its current status.
 *
 * @param status - Current status
 * @returns true if completion is allowed
 */
export function canComplete(status: TaskStatus): boolean {
  return isValidTransition(status, 'completed');
}

/**
 * Check if a task can be started (moved to in_progress).
 *
 * @param status - Current status
 * @returns true if starting is allowed
 */
export function canStart(status: TaskStatus): boolean {
  return isValidTransition(status, 'in_progress');
}

/**
 * Check if a task can be assigned from its current status.
 *
 * @param status - Current status
 * @returns true if assignment is allowed
 */
export function canAssign(status: TaskStatus): boolean {
  return isValidTransition(status, 'assigned');
}

// ─── Lifecycle Event Log ───────────────────────────────────────────

/**
 * A record of a single lifecycle transition.
 */
export interface LifecycleEvent {
  taskId: string;
  from: TaskStatus;
  to: TaskStatus;
  timestamp: string;
  reason?: string;
}

/**
 * In-memory event log for lifecycle transitions.
 * Useful for debugging and auditing.
 */
export class LifecycleLogger {
  private events: LifecycleEvent[] = [];
  private maxEntries: number;

  constructor(maxEntries: number = 1000) {
    this.maxEntries = maxEntries;
  }

  /**
   * Record a lifecycle transition event.
   */
  log(event: LifecycleEvent): void {
    this.events.push(event);
    if (this.events.length > this.maxEntries) {
      this.events.shift();
    }
  }

  /**
   * Get all events for a specific task.
   */
  getEvents(taskId: string): LifecycleEvent[] {
    return this.events.filter(e => e.taskId === taskId);
  }

  /**
   * Get all events.
   */
  getAllEvents(): LifecycleEvent[] {
    return [...this.events];
  }

  /**
   * Clear the event log.
   */
  clear(): void {
    this.events = [];
  }

  /**
   * Get the current number of logged events.
   */
  get size(): number {
    return this.events.length;
  }
}
