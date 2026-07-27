/**
 * Claw Task Service — Intent Patterns (English) (Phase M5: i18n)
 *
 * English rule definitions for task management intent classification.
 * Functionally equivalent to patterns.ts (22 rules, 10 categories).
 *
 * Trigger words are NOT literal translations — they are functional equivalents
 * that match how English-speaking users naturally express each intent.
 *
 * Based on: patterns.ts (v1.0, 2026-07-06) + M5 i18n framework
 */

import { ClassificationRule } from '../types.js';

// ─── English Rule Library ──────────────────────────────────────────

export const EN_RULES: ClassificationRule[] = [

  // ═══════════════════════════════════════════════════════════════════
  // 1. create_task (5 rules, priority range: 82-88)
  // ═══════════════════════════════════════════════════════════════════

  {
    id: 'create-task-explicit',
    category: 'create_task',
    subCategory: 'general',
    priority: 85,
    conditions: [
      { type: 'keyword', value: 'create', weight: 1.0 },
      { type: 'keyword', value: 'new', weight: 0.95 },
      { type: 'keyword', value: 'add', weight: 0.9 },
      { type: 'keyword', value: 'set up', weight: 0.85 },
      { type: 'keyword', value: 'make a', weight: 0.9 },
      { type: 'keyword', value: 'create a', weight: 0.95 },
      { type: 'keyword', value: 'start a', weight: 0.7 },
    ],
    confidence: 0.90,
    minConfidence: 0.6,
    rationale: 'Explicit task creation keyword detected',
  },

  {
    id: 'create-task-with-deadline',
    category: 'create_task',
    subCategory: 'general',
    priority: 87,
    conditions: [
      { type: 'regex', value: 'by\\s+\\w+|before\\s+\\w+|until\\s+\\w+|due\\s+by', weight: 1.0, required: true },
      { type: 'keyword', value: 'finish', weight: 0.8 },
      { type: 'keyword', value: 'complete', weight: 0.8 },
      { type: 'keyword', value: 'done', weight: 0.7 },
      { type: 'keyword', value: 'do', weight: 0.6 },
    ],
    confidence: 0.92,
    minConfidence: 0.7,
    rationale: 'Task creation with explicit deadline constraint',
  },

  {
    id: 'create-task-bugfix',
    category: 'create_task',
    subCategory: 'bugfix',
    priority: 93,
    conditions: [
      { type: 'keyword', value: 'bug', weight: 0.9 },
      { type: 'keyword', value: 'fix', weight: 0.9 },
      { type: 'keyword', value: 'crash', weight: 0.8 },
      { type: 'keyword', value: 'error', weight: 0.8 },
      { type: 'negation', value: 'query', weight: 0 },
      { type: 'negation', value: 'page crash', weight: 0 },
      { type: 'negation', value: 'ed,', weight: 0 },
      { type: 'negation', value: 'delete', weight: 0 },
      { type: 'negation', value: 'remove', weight: 0 },
      { type: 'negation', value: 'this bug', weight: 0 },
    ],
    confidence: 0.91,
    minConfidence: 0.65,
    rationale: 'Bug fix task creation detected',
  },

  {
    id: 'create-task-feature',
    category: 'create_task',
    subCategory: 'feature',
    priority: 88,
    conditions: [
      { type: 'keyword', value: 'develop', weight: 0.9 },
      { type: 'keyword', value: 'feature', weight: 0.85 },
      { type: 'keyword', value: 'new feature', weight: 0.75 },
    ],
    confidence: 0.88,
    minConfidence: 0.6,
    rationale: 'Feature development task creation detected',
  },

  {
    id: 'create-task-doc',
    category: 'create_task',
    subCategory: 'doc',
    priority: 86,
    conditions: [
      { type: 'keyword', value: 'write', weight: 0.7 },
      { type: 'keyword', value: 'document', weight: 0.9 },
      { type: 'keyword', value: 'organize', weight: 0.6 },
      { type: 'negation', value: 'design api', weight: 0 },
      { type: 'negation', value: 'api definition', weight: 0 },
    ],
    confidence: 0.85,
    minConfidence: 0.6,
    rationale: 'Documentation task creation detected',
  },

  // ═══════════════════════════════════════════════════════════════════
  // 2. query_status (4 rules, priority range: 74-78)
  // ═══════════════════════════════════════════════════════════════════

  {
    id: 'query-single-task',
    category: 'query_status',
    subCategory: 'single',
    priority: 78,
    conditions: [
      { type: 'phrase', value: 'how is it going', weight: 1.0 },
      { type: 'phrase', value: 'what is the progress', weight: 0.9 },
      { type: 'keyword', value: 'progress', weight: 0.9 },
      { type: 'keyword', value: 'status', weight: 0.8 },
      { type: 'negation', value: 'create', weight: 0 },
      { type: 'negation', value: 'change', weight: 0 },
    ],
    confidence: 0.88,
    minConfidence: 0.65,
    rationale: 'Single task status query detected',
  },

  {
    id: 'query-all-tasks',
    category: 'query_status',
    subCategory: 'all',
    priority: 76,
    conditions: [
      { type: 'phrase', value: 'what tasks are there', weight: 1.0 },
      { type: 'phrase', value: 'my tasks', weight: 1.0 },
      { type: 'phrase', value: 'all tasks', weight: 0.9 },
      { type: 'keyword', value: 'all', weight: 0.7 },
      { type: 'keyword', value: 'list', weight: 0.85 },
    ],
    confidence: 0.90,
    minConfidence: 0.7,
    rationale: 'List/query all tasks detected',
  },

  {
    id: 'query-filtered-tasks',
    category: 'query_status',
    subCategory: 'filtered',
    priority: 79,
    conditions: [
      { type: 'phrase', value: 'what tasks are there', weight: 0.85 },
      { type: 'keyword', value: 'query', weight: 0.8 },
      { type: 'keyword', value: 'P0', weight: 0.7 },
      { type: 'keyword', value: 'pending', weight: 0.75 },
      { type: 'keyword', value: 'in progress', weight: 0.75 },
      { type: 'keyword', value: 'view', weight: 0.8 },
      { type: 'keyword', value: 'check', weight: 0.8 },
      { type: 'regex', value: 'P[0-3]\\s*(level|priority|urgent)', weight: 0.95 },
    ],
    confidence: 0.86,
    minConfidence: 0.6,
    rationale: 'Filtered task query detected',
  },

  {
    id: 'query-summary',
    category: 'query_status',
    subCategory: 'summary',
    priority: 74,
    conditions: [
      { type: 'phrase', value: 'how many done', weight: 1.0 },
      { type: 'phrase', value: 'how many left', weight: 0.9 },
      { type: 'keyword', value: 'summary', weight: 0.85 },
      { type: 'keyword', value: 'statistics', weight: 0.7 },
      { type: 'keyword', value: 'remaining', weight: 0.65 },
      { type: 'keyword', value: 'what else', weight: 0.8 },
    ],
    confidence: 0.87,
    minConfidence: 0.65,
    rationale: 'Task summary/statistics query detected',
  },

  // ═══════════════════════════════════════════════════════════════════
  // 3. modify_task (5 rules, priority range: 78-84)
  // ═══════════════════════════════════════════════════════════════════

  {
    id: 'modify-deadline',
    category: 'modify_task',
    subCategory: 'deadline',
    priority: 82,
    conditions: [
      { type: 'keyword', value: 'move to', weight: 0.9 },
      { type: 'keyword', value: 'deadline', weight: 0.9 },
      { type: 'keyword', value: 'extend', weight: 0.9 },
      { type: 'keyword', value: 'earlier', weight: 0.85 },
      { type: 'regex', value: '\\d{1,4}\\s*(am|pm|oclock|th|st|nd|rd)', weight: 0.8 },
    ],
    confidence: 0.90,
    minConfidence: 0.65,
    rationale: 'Deadline modification detected',
  },

  {
    id: 'modify-priority',
    category: 'modify_task',
    subCategory: 'priority',
    priority: 84,
    conditions: [
      { type: 'keyword', value: 'raise to', weight: 1.0 },
      { type: 'keyword', value: 'lower to', weight: 0.9 },
      { type: 'phrase', value: 'priority', weight: 1.0 },
      { type: 'keyword', value: 'change to P', weight: 0.85 },
      { type: 'regex', value: 'P[0-3]', weight: 0.8 },
    ],
    confidence: 0.92,
    minConfidence: 0.7,
    rationale: 'Priority modification detected',
  },

  {
    id: 'modify-assignee',
    category: 'modify_task',
    subCategory: 'assignee',
    priority: 83,
    conditions: [
      { type: 'keyword', value: 'assign to', weight: 1.0, required: true },
      { type: 'keyword', value: 'assign', weight: 0.7 },
      { type: 'keyword', value: 'reassign', weight: 0.7 },
      { type: 'keyword', value: 'hand over', weight: 0.7 },
    ],
    confidence: 0.93,
    minConfidence: 0.75,
    rationale: 'Assignee reassignment detected',
  },

  {
    id: 'modify-status',
    category: 'modify_task',
    subCategory: 'status',
    priority: 81,
    conditions: [
      { type: 'keyword', value: 'mark as', weight: 1.0 },
      { type: 'keyword', value: 'completed', weight: 0.9 },
      { type: 'keyword', value: 'complete', weight: 0.75 },
      { type: 'keyword', value: 'close', weight: 0.8 },
      { type: 'keyword', value: 'start', weight: 0.7 },
      { type: 'keyword', value: 'modify', weight: 0.6 },
      { type: 'keyword', value: 'adjust', weight: 0.5 },
      { type: 'negation', value: 'delete', weight: 0 },
      { type: 'negation', value: 'cancel', weight: 0 },
    ],
    confidence: 0.89,
    minConfidence: 0.65,
    rationale: 'Task status modification detected',
  },

  {
    id: 'modify-description',
    category: 'modify_task',
    subCategory: 'description',
    priority: 78,
    conditions: [
      { type: 'keyword', value: 'add detail', weight: 0.7 },
      { type: 'keyword', value: 'description', weight: 0.85 },
      { type: 'keyword', value: 'update', weight: 0.6 },
      { type: 'phrase', value: 'requirement description', weight: 0.9 },
    ],
    confidence: 0.83,
    minConfidence: 0.6,
    rationale: 'Task description modification detected',
  },

  // ═══════════════════════════════════════════════════════════════════
  // 4. delete_task (3 rules, priority range: 78-82)
  // ═══════════════════════════════════════════════════════════════════

  {
    id: 'delete-explicit',
    category: 'delete_task',
    subCategory: 'single',
    priority: 90,
    conditions: [
      { type: 'keyword', value: 'delete', weight: 1.0 },
      { type: 'keyword', value: 'remove', weight: 0.9 },
      { type: 'keyword', value: 'trash', weight: 0.85 },
      { type: 'keyword', value: 'clear', weight: 0.75 },
      { type: 'keyword', value: 'discard', weight: 0.8 },
      { type: 'negation', value: 'delete feature', weight: 0 },
      { type: 'negation', value: 'delete file', weight: 0 },
    ],
    confidence: 0.90,
    minConfidence: 0.7,
    rationale: 'Explicit task deletion detected',
  },

  {
    id: 'delete-cancel',
    category: 'delete_task',
    subCategory: 'cancel',
    priority: 90,
    conditions: [
      { type: 'keyword', value: 'cancel', weight: 1.0 },
      { type: 'keyword', value: 'no longer need', weight: 0.85 },
      { type: 'keyword', value: 'abandon', weight: 0.8 },
      { type: 'negation', value: 'remind', weight: 0 },
      { type: 'negation', value: 'meeting', weight: 0 },
    ],
    confidence: 0.88,
    minConfidence: 0.65,
    rationale: 'Task cancellation detected',
  },

  {
    id: 'delete-archive',
    category: 'delete_task',
    subCategory: 'archive',
    priority: 86,
    conditions: [
      { type: 'keyword', value: 'archive', weight: 1.0, required: true },
      { type: 'keyword', value: 'completed', weight: 0.7 },
    ],
    confidence: 0.91,
    minConfidence: 0.7,
    rationale: 'Task archival detected',
  },

  // ═══════════════════════════════════════════════════════════════════
  // 5. schedule (4 rules, priority range: 72-75)
  // ═══════════════════════════════════════════════════════════════════

  {
    id: 'schedule-view',
    category: 'schedule',
    subCategory: 'view',
    priority: 72,
    conditions: [
      { type: 'keyword', value: 'schedule', weight: 0.85 },
      { type: 'keyword', value: 'calendar', weight: 0.9 },
      { type: 'keyword', value: 'agenda', weight: 0.85 },
      { type: 'keyword', value: 'next week', weight: 0.7 },
      { type: 'keyword', value: 'this week', weight: 0.7 },
      { type: 'negation', value: 'schedule a', weight: 0 },
      { type: 'negation', value: 'book a', weight: 0 },
    ],
    confidence: 0.85,
    minConfidence: 0.6,
    rationale: 'Schedule view query detected',
  },

  {
    id: 'schedule-create',
    category: 'schedule',
    subCategory: 'create',
    priority: 75,
    conditions: [
      { type: 'keyword', value: 'schedule a', weight: 0.95 },
      { type: 'keyword', value: 'book', weight: 0.8 },
      { type: 'keyword', value: 'meeting', weight: 0.85 },
      { type: 'keyword', value: 'set up a time', weight: 0.9 },
      { type: 'keyword', value: 'plan a time', weight: 0.8 },
      { type: 'regex', value: '(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\\s*(morning|afternoon|evening|at)', weight: 0.9 },
    ],
    confidence: 0.88,
    minConfidence: 0.65,
    rationale: 'Schedule creation detected',
  },

  {
    id: 'schedule-conflict',
    category: 'schedule',
    subCategory: 'conflict',
    priority: 73,
    conditions: [
      { type: 'phrase', value: 'are you free', weight: 1.0 },
      { type: 'phrase', value: 'is there time', weight: 0.95 },
      { type: 'keyword', value: 'conflict', weight: 0.85 },
      { type: 'phrase', value: 'free time', weight: 0.8 },
    ],
    confidence: 0.90,
    minConfidence: 0.7,
    rationale: 'Schedule conflict check detected',
  },

  {
    id: 'schedule-modify',
    category: 'schedule',
    subCategory: 'modify',
    priority: 83,
    conditions: [
      { type: 'keyword', value: 'reschedule', weight: 0.9 },
      { type: 'keyword', value: 'postpone', weight: 0.9 },
      { type: 'keyword', value: 'cancel', weight: 0.8 },
      { type: 'keyword', value: 'meeting', weight: 0.8 },
      { type: 'phrase', value: 'the meeting', weight: 0.9 },
      { type: 'negation', value: 'task', weight: 0 },
      { type: 'negation', value: 'deadline', weight: 0 },
    ],
    confidence: 0.87,
    minConfidence: 0.65,
    rationale: 'Schedule modification detected',
  },

  // ═══════════════════════════════════════════════════════════════════
  // 6. debug (5 rules, priority range: 80-92)
  // ═══════════════════════════════════════════════════════════════════

  {
    id: 'debug-crash',
    category: 'debug',
    subCategory: 'crash',
    priority: 92,
    conditions: [
      { type: 'keyword', value: 'crash', weight: 1.0 },
      { type: 'keyword', value: 'crashed', weight: 1.0 },
      { type: 'keyword', value: 'white screen', weight: 0.9 },
      { type: 'keyword', value: 'frozen', weight: 0.85 },
      { type: 'keyword', value: 'hung', weight: 0.8 },
      { type: 'keyword', value: 'down', weight: 0.85 },
      { type: 'negation', value: 'fix', weight: 0 },
      { type: 'negation', value: 'bug', weight: 0 },
    ],
    confidence: 0.93,
    minConfidence: 0.7,
    rationale: 'Crash debugging detected',
  },

  {
    id: 'debug-error-log',
    category: 'debug',
    subCategory: 'error_log',
    priority: 88,
    conditions: [
      { type: 'keyword', value: 'error', weight: 0.9 },
      { type: 'keyword', value: 'exception', weight: 0.9 },
      { type: 'keyword', value: 'stack trace', weight: 0.95 },
      { type: 'keyword', value: 'log', weight: 0.7 },
      { type: 'keyword', value: 'logs', weight: 0.7 },
      { type: 'phrase', value: 'check the logs', weight: 0.9 },
      { type: 'phrase', value: 'investigate error', weight: 0.9 },
      { type: 'negation', value: 'fix', weight: 0 },
    ],
    confidence: 0.88,
    minConfidence: 0.6,
    rationale: 'Error/log debugging detected',
  },

  {
    id: 'debug-performance',
    category: 'debug',
    subCategory: 'performance',
    priority: 86,
    conditions: [
      { type: 'keyword', value: 'slow', weight: 0.8 },
      { type: 'keyword', value: 'lag', weight: 0.9 },
      { type: 'keyword', value: 'latency', weight: 0.9 },
      { type: 'keyword', value: 'performance', weight: 0.9 },
      { type: 'keyword', value: 'memory leak', weight: 0.95 },
      { type: 'keyword', value: 'CPU', weight: 0.8 },
      { type: 'phrase', value: 'slow response', weight: 0.9 },
      { type: 'phrase', value: 'slow loading', weight: 0.9 },
    ],
    confidence: 0.89,
    minConfidence: 0.65,
    rationale: 'Performance debugging detected',
  },

  {
    id: 'debug-data-issue',
    category: 'debug',
    subCategory: 'data_issue',
    priority: 82,
    conditions: [
      { type: 'keyword', value: 'data is wrong', weight: 0.95 },
      { type: 'keyword', value: 'data loss', weight: 0.95 },
      { type: 'keyword', value: 'data anomaly', weight: 0.9 },
      { type: 'keyword', value: 'dirty data', weight: 0.9 },
      { type: 'keyword', value: 'inconsistent', weight: 0.85 },
      { type: 'phrase', value: 'data issue', weight: 0.95 },
      { type: 'phrase', value: 'does not match', weight: 0.85 },
    ],
    confidence: 0.87,
    minConfidence: 0.6,
    rationale: 'Data issue debugging detected',
  },

  {
    id: 'debug-environment',
    category: 'debug',
    subCategory: 'environment',
    priority: 80,
    conditions: [
      { type: 'keyword', value: 'environment', weight: 0.8 },
      { type: 'keyword', value: 'config', weight: 0.7 },
      { type: 'keyword', value: 'dependency', weight: 0.75 },
      { type: 'keyword', value: 'version', weight: 0.7 },
      { type: 'phrase', value: 'cannot install', weight: 0.85 },
      { type: 'phrase', value: 'cannot run', weight: 0.9 },
      { type: 'phrase', value: 'startup failed', weight: 0.85 },
      { type: 'phrase', value: 'environment issue', weight: 0.9 },
      { type: 'negation', value: 'create', weight: 0 },
    ],
    confidence: 0.84,
    minConfidence: 0.6,
    rationale: 'Environment/config debugging detected',
  },

  // ═══════════════════════════════════════════════════════════════════
  // 7. development (5 rules, priority range: 78-88)
  // ═══════════════════════════════════════════════════════════════════

  {
    id: 'dev-feature-impl',
    category: 'development',
    subCategory: 'feature_impl',
    priority: 86,
    conditions: [
      { type: 'keyword', value: 'implement', weight: 0.85 },
      { type: 'keyword', value: 'develop', weight: 0.8 },
      { type: 'keyword', value: 'write a', weight: 0.8 },
      { type: 'keyword', value: 'build a', weight: 0.8 },
      { type: 'keyword', value: 'code', weight: 0.75 },
      { type: 'keyword', value: 'feature', weight: 0.3 },
      { type: 'phrase', value: 'write code', weight: 0.9 },
      { type: 'phrase', value: 'change code', weight: 0.85 },
      { type: 'negation', value: 'create task', weight: 0 },
    ],
    confidence: 0.86,
    minConfidence: 0.6,
    rationale: 'Feature implementation detected',
  },

  {
    id: 'dev-bugfix',
    category: 'development',
    subCategory: 'bugfix',
    priority: 88,
    conditions: [
      { type: 'keyword', value: 'fix', weight: 0.9 },
      { type: 'keyword', value: 'solve', weight: 0.75 },
      { type: 'keyword', value: 'patch', weight: 0.85 },
      { type: 'phrase', value: 'hotfix', weight: 0.9 },
      { type: 'negation', value: 'query', weight: 0 },
      { type: 'keyword', value: 'bug', weight: 0.3 },
    ],
    confidence: 0.89,
    minConfidence: 0.65,
    rationale: 'Bugfix development detected',
  },

  {
    id: 'dev-refactor',
    category: 'development',
    subCategory: 'refactor',
    priority: 82,
    conditions: [
      { type: 'keyword', value: 'refactor', weight: 1.0 },
      { type: 'keyword', value: 'optimize', weight: 0.8 },
      { type: 'keyword', value: 'clean up', weight: 0.7 },
      { type: 'keyword', value: 'cleanup code', weight: 0.85 },
      { type: 'phrase', value: 'code optimization', weight: 0.85 },
      { type: 'negation', value: 'task', weight: 0 },
      { type: 'negation', value: 'cancel', weight: 0 },
    ],
    confidence: 0.88,
    minConfidence: 0.65,
    rationale: 'Code refactoring detected',
  },

  {
    id: 'dev-api-design',
    category: 'development',
    subCategory: 'api_design',
    priority: 84,
    conditions: [
      { type: 'keyword', value: 'api', weight: 0.85 },
      { type: 'keyword', value: 'endpoint', weight: 0.85 },
      { type: 'keyword', value: 'route', weight: 0.75 },
      { type: 'phrase', value: 'design api', weight: 0.9 },
      { type: 'phrase', value: 'api design', weight: 0.9 },
      { type: 'phrase', value: 'api definition', weight: 0.85 },
    ],
    confidence: 0.87,
    minConfidence: 0.6,
    rationale: 'API design detected',
  },

  {
    id: 'dev-architecture',
    category: 'development',
    subCategory: 'architecture',
    priority: 86,
    conditions: [
      { type: 'keyword', value: 'architecture', weight: 0.95 },
      { type: 'keyword', value: 'microservice', weight: 0.85 },
      { type: 'keyword', value: 'layered', weight: 0.8 },
      { type: 'keyword', value: 'design pattern', weight: 0.85 },
      { type: 'phrase', value: 'system design', weight: 0.9 },
      { type: 'phrase', value: 'architecture plan', weight: 0.9 },
    ],
    confidence: 0.88,
    minConfidence: 0.65,
    rationale: 'Architecture design detected',
  },

  // ═══════════════════════════════════════════════════════════════════
  // 8. research (4 rules, priority range: 76-84)
  // ═══════════════════════════════════════════════════════════════════

  {
    id: 'research-investigation',
    category: 'research',
    subCategory: 'investigation',
    priority: 82,
    conditions: [
      { type: 'keyword', value: 'investigate', weight: 0.9 },
      { type: 'keyword', value: 'look into', weight: 0.85 },
      { type: 'keyword', value: 'analyze', weight: 0.8 },
      { type: 'keyword', value: 'find out', weight: 0.9 },
      { type: 'phrase', value: 'check on', weight: 0.8 },
      { type: 'phrase', value: 'look up', weight: 0.75 },
      { type: 'phrase', value: 'research on', weight: 0.85 },
      { type: 'negation', value: 'query status', weight: 0 },
    ],
    confidence: 0.85,
    minConfidence: 0.6,
    rationale: 'Investigation/research detected',
  },

  {
    id: 'research-spike',
    category: 'research',
    subCategory: 'spike',
    priority: 80,
    conditions: [
      { type: 'keyword', value: 'spike', weight: 0.95 },
      { type: 'keyword', value: 'prototype', weight: 0.85 },
      { type: 'keyword', value: 'POC', weight: 0.9 },
      { type: 'keyword', value: 'feasibility', weight: 0.85 },
      { type: 'keyword', value: 'validate', weight: 0.75 },
      { type: 'phrase', value: 'technical validation', weight: 0.9 },
      { type: 'phrase', value: 'proof of concept', weight: 0.9 },
    ],
    confidence: 0.86,
    minConfidence: 0.6,
    rationale: 'Spike/POC research detected',
  },

  {
    id: 'research-comparison',
    category: 'research',
    subCategory: 'comparison',
    priority: 78,
    conditions: [
      { type: 'keyword', value: 'compare', weight: 0.9 },
      { type: 'keyword', value: 'comparison', weight: 0.85 },
      { type: 'keyword', value: 'versus', weight: 0.85 },
      { type: 'keyword', value: 'evaluate', weight: 0.9 },
      { type: 'phrase', value: 'which is better', weight: 0.85 },
      { type: 'phrase', value: 'difference', weight: 0.75 },
      { type: 'phrase', value: 'differences', weight: 0.75 },
    ],
    confidence: 0.84,
    minConfidence: 0.6,
    rationale: 'Comparison research detected',
  },

  {
    id: 'research-docs-lookup',
    category: 'research',
    subCategory: 'documentation_lookup',
    priority: 76,
    conditions: [
      { type: 'keyword', value: 'documentation', weight: 0.7 },
      { type: 'keyword', value: 'docs', weight: 0.7 },
      { type: 'keyword', value: 'manual', weight: 0.8 },
      { type: 'keyword', value: 'usage', weight: 0.75 },
      { type: 'phrase', value: 'how to use', weight: 0.8 },
      { type: 'phrase', value: 'look up', weight: 0.85 },
      { type: 'phrase', value: 'reference docs', weight: 0.85 },
      { type: 'negation', value: 'write doc', weight: 0 },
    ],
    confidence: 0.82,
    minConfidence: 0.55,
    rationale: 'Documentation lookup research detected',
  },

  // ═══════════════════════════════════════════════════════════════════
  // 9. review (4 rules, priority range: 78-87)
  // ═══════════════════════════════════════════════════════════════════

  {
    id: 'review-code',
    category: 'review',
    subCategory: 'code_review',
    priority: 87,
    conditions: [
      { type: 'keyword', value: 'code review', weight: 0.95 },
      { type: 'keyword', value: 'review', weight: 0.85 },
      { type: 'phrase', value: 'look at the code', weight: 0.85 },
      { type: 'phrase', value: 'code walkthrough', weight: 0.9 },
    ],
    confidence: 0.89,
    minConfidence: 0.65,
    rationale: 'Code review detected',
  },

  {
    id: 'review-pr',
    category: 'review',
    subCategory: 'pr_review',
    priority: 85,
    conditions: [
      { type: 'keyword', value: 'PR', weight: 0.85 },
      { type: 'keyword', value: 'pull request', weight: 0.95 },
      { type: 'phrase', value: 'review PR', weight: 0.95 },
      { type: 'phrase', value: 'look at PR', weight: 0.9 },
      { type: 'phrase', value: 'merge PR', weight: 0.85 },
    ],
    confidence: 0.90,
    minConfidence: 0.65,
    rationale: 'PR review detected',
  },

  {
    id: 'review-design',
    category: 'review',
    subCategory: 'design_review',
    priority: 82,
    conditions: [
      { type: 'keyword', value: 'design review', weight: 0.95 },
      { type: 'keyword', value: 'proposal review', weight: 0.9 },
      { type: 'phrase', value: 'review design', weight: 0.9 },
      { type: 'phrase', value: 'look at proposal', weight: 0.8 },
      { type: 'phrase', value: 'review the plan', weight: 0.75 },
    ],
    confidence: 0.87,
    minConfidence: 0.6,
    rationale: 'Design review detected',
  },

  {
    id: 'review-test',
    category: 'review',
    subCategory: 'test_review',
    priority: 78,
    conditions: [
      { type: 'keyword', value: 'test case', weight: 0.8 },
      { type: 'phrase', value: 'review test', weight: 0.9 },
      { type: 'phrase', value: 'look at test', weight: 0.8 },
      { type: 'phrase', value: 'test review', weight: 0.9 },
    ],
    confidence: 0.84,
    minConfidence: 0.6,
    rationale: 'Test review detected',
  },

  // ═══════════════════════════════════════════════════════════════════
  // 10. planning (4 rules, priority range: 77-85)
  // ═══════════════════════════════════════════════════════════════════

  {
    id: 'planning-sprint',
    category: 'planning',
    subCategory: 'sprint_planning',
    priority: 85,
    conditions: [
      { type: 'keyword', value: 'sprint', weight: 0.9 },
      { type: 'keyword', value: 'iteration', weight: 0.85 },
      { type: 'keyword', value: 'schedule', weight: 0.85 },
      { type: 'phrase', value: 'sprint planning', weight: 0.95 },
      { type: 'phrase', value: 'next sprint', weight: 0.85 },
      { type: 'phrase', value: 'this sprint', weight: 0.8 },
    ],
    confidence: 0.88,
    minConfidence: 0.65,
    rationale: 'Sprint planning detected',
  },

  {
    id: 'planning-estimation',
    category: 'planning',
    subCategory: 'estimation',
    priority: 82,
    conditions: [
      { type: 'keyword', value: 'estimate', weight: 0.95 },
      { type: 'keyword', value: 'estimation', weight: 0.9 },
      { type: 'keyword', value: 'effort', weight: 0.85 },
      { type: 'keyword', value: 'man-day', weight: 0.85 },
      { type: 'keyword', value: 'man-hour', weight: 0.85 },
      { type: 'phrase', value: 'how much time', weight: 0.8 },
      { type: 'phrase', value: 'workload', weight: 0.85 },
    ],
    confidence: 0.87,
    minConfidence: 0.6,
    rationale: 'Estimation/planning detected',
  },

  {
    id: 'planning-roadmap',
    category: 'planning',
    subCategory: 'roadmap',
    priority: 80,
    conditions: [
      { type: 'keyword', value: 'roadmap', weight: 0.95 },
      { type: 'keyword', value: 'milestone', weight: 0.85 },
      { type: 'phrase', value: 'long-term plan', weight: 0.9 },
      { type: 'phrase', value: 'version plan', weight: 0.85 },
    ],
    confidence: 0.86,
    minConfidence: 0.6,
    rationale: 'Roadmap planning detected',
  },

  {
    id: 'planning-task-breakdown',
    category: 'planning',
    subCategory: 'task_breakdown',
    priority: 77,
    conditions: [
      { type: 'keyword', value: 'break down', weight: 0.9 },
      { type: 'keyword', value: 'split', weight: 0.85 },
      { type: 'keyword', value: 'breakdown', weight: 0.9 },
      { type: 'keyword', value: 'WBS', weight: 0.95 },
      { type: 'phrase', value: 'task split', weight: 0.9 },
      { type: 'phrase', value: 'decompose', weight: 0.75 },
    ],
    confidence: 0.85,
    minConfidence: 0.6,
    rationale: 'Task breakdown planning detected',
  },
];

/**
 * Get all English rules sorted by priority descending (standard evaluation order).
 */
export function getEnRulesByPriority(): ClassificationRule[] {
  return [...EN_RULES].sort((a, b) => b.priority - a.priority);
}

/**
 * Get English rules filtered by category.
 */
export function getEnRulesByCategory(category: string): ClassificationRule[] {
  return EN_RULES.filter(r => r.category === category);
}

/**
 * Summary statistics for the English rule library.
 */
export function getEnRuleStats() {
  const byCategory: Record<string, number> = {};
  const triggerWords = new Set<string>();

  for (const rule of EN_RULES) {
    byCategory[rule.category] = (byCategory[rule.category] || 0) + 1;
    for (const cond of rule.conditions) {
      if (cond.type !== 'negation') {
        triggerWords.add(cond.value);
      }
    }
  }

  return {
    totalRules: EN_RULES.length,
    totalTriggerWords: triggerWords.size,
    byCategory,
    categories: Object.keys(byCategory),
  };
}
