/**
 * Claw Task Service — Main Server Entry Point (M3)
 *
 * Wires together:
 *   1. Express HTTP server with JSON body parsing
 *   2. Observability middleware (logging + metrics + tracing + health)
 *   3. Task Manager REST API (CRUD + query)
 *   4. Intent → Task bridge endpoint (POST /api/intent)
 *   5. /health, /ready, /metrics endpoints
 *
 * Environment variables:
 *   PORT             — listen port (default 3000)
 *   LOG_LEVEL        — DEBUG|INFO|WARN|ERROR (default INFO)
 *   NODE_ENV         — production|development
 */

import express from 'express';
import { setupObservability } from './observability/index.js';
import { serviceLogger } from './observability/service-logger.js';
import { httpMetrics } from './observability/http-metrics.js';
import { readinessHandler } from './observability/health-check.js';
import { TaskManager } from './task-manager/task-manager.js';
import { IntentTaskBridge } from './task-manager/intent-task-bridge.js';
import type { CreateTaskInput, ModifyTaskInput, TaskQueryFilter } from './task-manager/task-types.js';

// ─── Configuration ─────────────────────────────────────────────────

const PORT = parseInt(process.env['PORT'] ?? '3000', 10);
const SERVICE_NAME = 'claw-task-service';

// ─── App Setup ─────────────────────────────────────────────────────

const app = express();

// JSON body parser (before observability so body is available)
app.use(express.json({ limit: '1mb' }));

// Observability middleware: context + metrics + tracing + /health + /metrics
setupObservability(app, {
  healthPath: '/health',
  metricsPath: '/metrics',
  enableTracing: true,
});

// Additional /ready endpoint (top-level, per M3 spec)
app.get('/ready', readinessHandler);

// ─── Task Manager & Bridge ─────────────────────────────────────────

const taskManager = new TaskManager();
const bridge = new IntentTaskBridge(taskManager, { autoConfirm: true });

// ─── REST API: Task CRUD ───────────────────────────────────────────

/**
 * POST /api/tasks — Create a task.
 * Body: CreateTaskInput
 */
app.post('/api/tasks', (req, res) => {
  const input = req.body as CreateTaskInput;
  if (!input?.title || typeof input.title !== 'string') {
    res.status(400).json({ success: false, message: 'title is required' });
    return;
  }
  const result = taskManager.createTask(input);
  res.status(result.ok ? 201 : 400).json(result);
});

/**
 * GET /api/tasks — Query tasks.
 * Query params: status, priority, category, assignee, archived
 */
app.get('/api/tasks', (req, res) => {
  const filter: TaskQueryFilter = {};
  const q = req.query;
  if (q['status']) filter.status = q['status'] as any;
  if (q['priority']) filter.priority = q['priority'] as any;
  if (q['category']) filter.category = q['category'] as any;
  if (q['assignee']) filter.assignee = q['assignee'] as string;
  if (q['archived'] !== undefined) filter.archived = q['archived'] === 'true';

  const result = taskManager.queryTasks(filter);
  res.json(result);
});

/**
 * GET /api/tasks/:id — Get a single task.
 */
app.get('/api/tasks/:id', (req, res) => {
  const task = taskManager.getTask(req.params['id']);
  if (!task) {
    res.status(404).json({ success: false, message: `Task not found: ${req.params['id']}` });
    return;
  }
  res.json({ success: true, task });
});

/**
 * PATCH /api/tasks/:id — Modify a task.
 * Body: ModifyTaskInput
 */
app.patch('/api/tasks/:id', (req, res) => {
  const input = req.body as ModifyTaskInput;
  const result = taskManager.modifyTask(req.params['id'], input);
  res.status(result.ok ? 200 : 400).json(result);
});

/**
 * DELETE /api/tasks/:id — Cancel/archive a task.
 * Query param: mode=archive to soft-delete; default cancels.
 */
app.delete('/api/tasks/:id', (req, res) => {
  const id = req.params['id'];
  const mode = req.query['mode'] as string | undefined;
  const result = mode === 'archive'
    ? taskManager.archiveTask(id)
    : taskManager.cancelTask(id);
  res.status(result.ok ? 200 : 404).json(result);
});

/**
 * GET /api/tasks/:id/lifecycle — Get lifecycle audit trail.
 */
app.get('/api/tasks/:id/lifecycle', (req, res) => {
  const events = taskManager.getLifecycleEvents(req.params['id']);
  res.json({ success: true, events });
});

// ─── Intent API ────────────────────────────────────────────────────

/**
 * POST /api/intent — Classify natural-language input and execute.
 * Body: { text: string, context?: IntentContext }
 */
app.post('/api/intent', (req, res) => {
  const { text, context } = req.body as { text: string; context?: any };
  if (!text || typeof text !== 'string') {
    res.status(400).json({ success: false, message: 'text is required' });
    return;
  }
  const result = bridge.handleUserInput(text, context);
  res.json(result);
});

// ─── 404 & Error Handler ───────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.path}`,
  });
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, req: any, res: any, next: any) => {
  serviceLogger.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
    method: req.method,
    path: req.path,
  });
  res.status(500).json({
    success: false,
    message: 'Internal server error',
    error: process.env['NODE_ENV'] === 'production' ? undefined : err.message,
  });
});

// ─── Server Lifecycle ──────────────────────────────────────────────

const server = app.listen(PORT, () => {
  serviceLogger.info(`${SERVICE_NAME} started`, {
    port: PORT,
    logLevel: serviceLogger.getLevel(),
    endpoints: [
      'GET  /health',
      'GET  /ready',
      'GET  /metrics',
      'POST /api/tasks',
      'GET  /api/tasks',
      'GET  /api/tasks/:id',
      'PATCH /api/tasks/:id',
      'DELETE /api/tasks/:id',
      'GET  /api/tasks/:id/lifecycle',
      'POST /api/intent',
    ],
  });
});

// Graceful shutdown
function shutdown(signal: string): void {
  serviceLogger.info('Shutting down', { signal });
  server.close(() => {
    serviceLogger.info('Server closed', { signal });
    process.exit(0);
  });

  // Force exit after 10s if server hasn't closed
  setTimeout(() => {
    serviceLogger.error('Forced exit after timeout', { signal });
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Log unhandled rejections
process.on('unhandledRejection', (reason) => {
  serviceLogger.error('Unhandled rejection', {
    error: reason instanceof Error ? reason.message : String(reason),
  });
});

export { app, server, taskManager, bridge };
