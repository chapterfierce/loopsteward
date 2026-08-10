/**
 * Claw Task Service — M7 Test Server
 *
 * Minimal Express server for M7 E2E tests.
 * Uses InMemoryStore for fast, isolated testing.
 *
 * Run: npx tsx tests/m7-test-server.ts
 */

import express from 'express';
import { TaskManager } from '../src/task-manager/task-manager.js';
import { InMemoryStore } from '../src/task-manager/task-persistence.js';
import type { CreateTaskInput, ModifyTaskInput, TaskQueryFilter } from '../src/task-manager/task-types.js';

const PORT = parseInt(process.env['PORT'] ?? '3198', 10);

const app = express();
app.use(express.json());

// Task Manager with InMemoryStore
const store = new InMemoryStore();
const manager = new TaskManager(store);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Task CRUD API ───────────────────────────────────────────────────

/**
 * POST /api/tasks — Create a task
 */
app.post('/api/tasks', (req, res) => {
  const input = req.body as CreateTaskInput;
  if (!input?.title) {
    res.status(400).json({ ok: false, message: 'title is required' });
    return;
  }
  const result = manager.createTask(input);
  res.status(result.ok ? 201 : 400).json(result);
});

/**
 * GET /api/tasks — Query tasks with pagination
 * Query params: status, priority, category, assignee, archived, page, pageSize, sortBy, sortOrder
 */
app.get('/api/tasks', (req, res) => {
  const page = req.query['page'] ? parseInt(req.query['page'] as string, 10) : undefined;
  const pageSize = req.query['pageSize'] ? parseInt(req.query['pageSize'] as string, 10) : undefined;
  const sortBy = req.query['sortBy'] as any;
  const sortOrder = req.query['sortOrder'] as any;

  const filter: TaskQueryFilter = {};
  if (req.query['status']) filter.status = req.query['status'] as any;
  if (req.query['priority']) filter.priority = req.query['priority'] as any;
  if (req.query['category']) filter.category = req.query['category'] as any;
  if (req.query['assignee']) filter.assignee = req.query['assignee'] as string;
  if (req.query['archived'] !== undefined) filter.archived = req.query['archived'] === 'true';

  // Use extended query if pagination params present
  if (page !== undefined || pageSize !== undefined || sortBy !== undefined) {
    const result = manager.queryTasksExtended({
      ...filter,
      page,
      pageSize,
      sortBy,
      sortOrder,
    });
    res.json(result);
  } else {
    const result = manager.queryTasks(filter);
    res.json(result);
  }
});

/**
 * GET /api/tasks/:id — Get a single task
 */
app.get('/api/tasks/:id', (req, res) => {
  const task = manager.getTask(req.params['id']);
  if (!task) {
    res.status(404).json({ success: false, message: `Task not found: ${req.params['id']}` });
    return;
  }
  res.json({ success: true, task });
});

/**
 * PATCH /api/tasks/:id — Modify a task
 */
app.patch('/api/tasks/:id', (req, res) => {
  const input = req.body as ModifyTaskInput;
  const result = manager.modifyTask(req.params['id'], input);
  res.status(result.ok ? 200 : 400).json(result);
});

/**
 * PATCH /api/tasks/:id/status — Update task status
 */
app.patch('/api/tasks/:id/status', (req, res) => {
  const { status, reason } = req.body;
  if (!status) {
    res.status(400).json({ ok: false, message: 'status is required' });
    return;
  }
  const result = manager.changeStatus(req.params['id'], status, reason);
  res.status(result.ok ? 200 : 400).json(result);
});

/**
 * DELETE /api/tasks/:id — Cancel or archive a task
 */
app.delete('/api/tasks/:id', (req, res) => {
  const mode = req.query['mode'] as string | undefined;
  const result = mode === 'archive'
    ? manager.archiveTask(req.params['id'])
    : manager.cancelTask(req.params['id']);
  res.status(result.ok ? 200 : 404).json(result);
});

/**
 * GET /api/tasks/:id/lifecycle — Get lifecycle events
 */
app.get('/api/tasks/:id/lifecycle', (req, res) => {
  const events = manager.getLifecycleEvents(req.params['id']);
  res.json({ success: true, events });
});

// Start server
app.listen(PORT, () => {
  console.log(`M7 Test Server running on port ${PORT}`);
});
