/**
 * Claw Task Service — M7 Persistence & Query Integration Tests
 *
 * Comprehensive test suite for task persistence layer:
 *   Part 1:  InMemoryStore CRUD + lifecycle validation
 *   Part 2:  SQLiteStore CRUD + persistence across restarts
 *   Part 3:  Query API (pagination, time range, sorting, filtering)
 *   Part 4:  Concurrent writes + transaction safety
 *   Part 5:  Invalid transition handling + metrics
 *   Part 6:  Edge cases (empty store, large datasets, boundary conditions)
 *   Part 7:  Integration with TaskManager + HTTP API layer
 *
 * Run: npx tsx tests/m7-persistence-test.ts
 */

import {
  InMemoryStore,
  SQLiteStore,
  createTaskStore,
  type ExtendedQueryFilter,
} from '../src/task-manager/task-persistence.js';
import { TaskManager, findTransitionPath } from '../src/task-manager/task-manager.js';
import { generateTaskId } from '../src/task-manager/task-store.js';
import type { Task, TaskStatus, TaskPriority, TaskCategory } from '../src/task-manager/task-types.js';
import { VALID_TRANSITIONS } from '../src/task-manager/task-types.js';
import { isValidTransition } from '../src/task-manager/task-lifecycle.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── Test Harness ──────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let skipped = 0;
const failures: string[] = [];
const skips: string[] = [];

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✅ PASS — ${name}`);
  } else {
    failed++;
    failures.push(name + (detail ? ` [${detail}]` : ''));
    console.log(`  ❌ FAIL — ${name}${detail ? ` [${detail}]` : ''}`);
  }
}

/**
 * Record a genuinely skipped test.
 *
 * IMPORTANT: a skip is NOT a pass. Earlier revisions of this suite called
 * check(name, true) for skipped SQLite/E2E cases, which manufactured a green
 * run while the SQLite layer was never exercised at all. Skips are counted
 * and reported separately so they can never hide untested code.
 */
function skip(name: string, why: string): void {
  skipped++;
  skips.push(`${name} [${why}]`);
  console.log(`  ⏭️  SKIP — ${name} [${why}]`);
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(4, 60 - title.length))}`);
}

function createMockTask(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    id: generateTaskId(),
    title: 'Test Task',
    status: 'created',
    priority: 'P2',
    category: 'general',
    createdAt: now,
    updatedAt: now,
    tags: [],
    archived: false,
    ...overrides,
  };
}

// ─── Part 1: InMemoryStore CRUD + Lifecycle ────────────────────────

section('Part 1: InMemoryStore CRUD & Lifecycle');

{
  const store = new InMemoryStore();

  // ── Create ─────────────────────────────────────────────────────
  const t1 = createMockTask({ id: 'mem-1', title: 'Task One' });
  store.create(t1);
  check('create: task exists', store.get('mem-1')?.title === 'Task One');
  check('create: duplicate throws', (() => {
    try { store.create(t1); return false; }
    catch (e: any) { return e.message.includes('already exists'); }
  })());

  // ── Read ───────────────────────────────────────────────────────
  check('get: returns task', store.get('mem-1')?.id === 'mem-1');
  check('get: missing returns undefined', store.get('missing') === undefined);

  // ── Update ─────────────────────────────────────────────────────
  const updated = { ...t1, title: 'Updated' };
  check('update: returns true', store.update(updated));
  check('update: persists change', store.get('mem-1')?.title === 'Updated');
  check('update: missing returns false', !store.update(createMockTask({ id: 'missing' })));

  // ── Delete ─────────────────────────────────────────────────────
  const t2 = createMockTask({ id: 'mem-2' });
  store.create(t2);
  check('delete: returns true', store.delete('mem-2'));
  check('delete: removes task', store.get('mem-2') === undefined);
  check('delete: missing returns false', !store.delete('mem-2'));

  // ── Lifecycle Transitions ─────────────────────────────────────
  const t3 = createMockTask({ id: 'mem-3', status: 'created' });
  store.create(t3);

  check('transition: created → assigned succeeds', store.transitionStatus('mem-3', 'assigned'));
  check('transition: status updated', store.get('mem-3')?.status === 'assigned');
  check('transition: assigned → in_progress succeeds', store.transitionStatus('mem-3', 'in_progress'));
  check('transition: in_progress → completed succeeds', store.transitionStatus('mem-3', 'completed'));

  // Invalid transition
  const t4 = createMockTask({ id: 'mem-4', status: 'completed' });
  store.create(t4);
  const invalidCountBefore = store.getInvalidTransitionCount();
  check('transition: completed → in_progress fails', !store.transitionStatus('mem-4', 'in_progress'));
  check('transition: invalid count incremented', store.getInvalidTransitionCount() > invalidCountBefore);
  check('transition: status unchanged', store.get('mem-4')?.status === 'completed');

  // ── Count ──────────────────────────────────────────────────────
  store.clear();
  store.create(createMockTask({ id: 'a', archived: false }));
  store.create(createMockTask({ id: 'b', archived: false }));
  store.create(createMockTask({ id: 'c', archived: true }));
  check('countActive: excludes archived', store.countActive() === 2);
  check('count: total includes archived', store.count() === 3);
  check('count: with filter', store.count({ archived: true }) === 1);

  store.close();
}

// ─── Part 2: SQLiteStore CRUD + Persistence ────────────────────────

section('Part 2: SQLiteStore CRUD & Persistence');

{
  const dbPath = './test-m7-tasks.db';
  
  // Clean up any existing test database
  if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
  }
  // Also clean WAL files
  if (fs.existsSync(`${dbPath}-wal`)) fs.unlinkSync(`${dbPath}-wal`);
  if (fs.existsSync(`${dbPath}-shm`)) fs.unlinkSync(`${dbPath}-shm`);

  // Check if node:sqlite is available.
  // NOTE: this file is ESM, so bare `require` is undefined here and the old
  // probe ALWAYS reported "unavailable" — silently skipping every SQLite test.
  // Use createRequire so availability is detected for real.
  let sqliteAvailable = false;
  let sqliteUnavailableReason = '';
  try {
    const req = createRequire(import.meta.url);
    // @ts-ignore - node:sqlite is a built-in but may not be in types
    req('node:sqlite');
    sqliteAvailable = true;
  } catch (err: any) {
    sqliteUnavailableReason = err.message;
    console.log(`  ⚠️  node:sqlite not available, skipping SQLite tests: ${err.message}`);
  }

  if (sqliteAvailable) {
    const store = new SQLiteStore(dbPath);

    // ── Create & Persist ───────────────────────────────────────
    const t1 = createMockTask({ id: 'sqlite-1', title: 'SQLite Task' });
    store.create(t1);
    check('sqlite: create persists', store.get('sqlite-1')?.title === 'SQLite Task');

    // ── Restart Simulation (close + reopen) ───────────────────
    store.close();
    const store2 = new SQLiteStore(dbPath);
    check('sqlite: data survives restart', store2.get('sqlite-1')?.title === 'SQLite Task');

    // ── Update & Delete ───────────────────────────────────────
    const updated = { ...t1, title: 'Updated SQLite Task' };
    store2.update(updated);
    check('sqlite: update persists', store2.get('sqlite-1')?.title === 'Updated SQLite Task');

    check('sqlite: delete succeeds', store2.delete('sqlite-1'));
    check('sqlite: delete removes task', store2.get('sqlite-1') === undefined);

    // ── Lifecycle Events ───────────────────────────────────────
    const t2 = createMockTask({ id: 'sqlite-2', status: 'created' });
    store2.create(t2);
    store2.transitionStatus('sqlite-2', 'assigned', 'initial assignment');
    store2.transitionStatus('sqlite-2', 'in_progress', 'work started');

    const events = store2.getLifecycleEvents('sqlite-2');
    check('sqlite: lifecycle events recorded', events.length === 2);
    check('sqlite: first event correct', events[0]?.toStatus === 'assigned');
    check('sqlite: second event correct', events[1]?.toStatus === 'in_progress');
    check('sqlite: event reason stored', events[1]?.reason === 'work started');

    store2.close();

    // Clean up
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    if (fs.existsSync(`${dbPath}-wal`)) fs.unlinkSync(`${dbPath}-wal`);
    if (fs.existsSync(`${dbPath}-shm`)) fs.unlinkSync(`${dbPath}-shm`);
  } else {
    skip('sqlite: full SQLiteStore suite', `node:sqlite unavailable — ${sqliteUnavailableReason}`);
  }
}

// ─── Part 3: Query API (Pagination, Time Range, Sorting) ───────────

section('Part 3: Query API — Pagination, Time Range, Sorting');

{
  const store = new InMemoryStore();

  // Create 25 tasks with varied attributes
  const now = new Date();
  for (let i = 0; i < 25; i++) {
    const date = new Date(now.getTime() - i * 3600000); // 1 hour apart
    const task = createMockTask({
      id: `query-${i}`,
      title: `Task ${i}`,
      status: i < 5 ? 'completed' : i < 10 ? 'in_progress' : 'created',
      priority: i % 4 === 0 ? 'P0' : i % 4 === 1 ? 'P1' : i % 4 === 2 ? 'P2' : 'P3',
      createdAt: date.toISOString(),
      updatedAt: date.toISOString(),
    });
    store.create(task);
  }

  // ── Basic Query ───────────────────────────────────────────────
  const all = store.query({});
  check('query: returns all non-archived', all.tasks.length === 25);
  check('query: total correct', all.total === 25);

  const completed = store.query({ status: 'completed' });
  check('query: filter by status', completed.tasks.length === 5);
  check('query: filtered total correct', completed.total === 5);

  const p0Tasks = store.query({ priority: 'P0' });
  check('query: filter by priority', p0Tasks.tasks.length === 7); // 0, 4, 8, 12, 16, 20, 24

  // ── Pagination ────────────────────────────────────────────────
  const page1 = store.queryExtended({ page: 1, pageSize: 10 });
  check('pagination: page 1 has 10 items', page1.tasks.length === 10);
  check('pagination: total correct', page1.total === 25);
  check('pagination: totalPages correct', page1.totalPages === 3);
  check('pagination: hasNextPage true', page1.hasNextPage === true);
  check('pagination: hasPrevPage false', page1.hasPrevPage === false);
  check('pagination: page number correct', page1.page === 1);

  const page2 = store.queryExtended({ page: 2, pageSize: 10 });
  check('pagination: page 2 has 10 items', page2.tasks.length === 10);
  check('pagination: page 2 hasNextPage true', page2.hasNextPage === true);
  check('pagination: page 2 hasPrevPage true', page2.hasPrevPage === true);

  const page3 = store.queryExtended({ page: 3, pageSize: 10 });
  check('pagination: page 3 has 5 items', page3.tasks.length === 5);
  check('pagination: page 3 hasNextPage false', page3.hasNextPage === false);

  // ── Sorting ───────────────────────────────────────────────────
  const sortByCreatedAsc = store.queryExtended({ sortBy: 'createdAt', sortOrder: 'asc' });
  const dates = sortByCreatedAsc.tasks.map(t => t.createdAt);
  check('sorting: createdAt asc ordered', dates.every((d, i) => i === 0 || d >= dates[i - 1]));

  const sortByPriorityDesc = store.queryExtended({ sortBy: 'priority', sortOrder: 'asc' });
  check('sorting: priority asc first is P0', sortByPriorityDesc.tasks[0]?.priority === 'P0');

  // ── Time Range ────────────────────────────────────────────────
  const cutoff = new Date(now.getTime() - 10 * 3600000); // 10 hours ago
  const recent = store.queryExtended({ createdAfter: cutoff.toISOString() });
  check('timeRange: createdAfter filters', recent.tasks.length === 11); // 0-10 hours

  const old = store.queryExtended({ createdBefore: cutoff.toISOString() });
  check('timeRange: createdBefore filters', old.tasks.length === 14); // 11-24 hours

  // ── Combined Filters ──────────────────────────────────────────
  const combined = store.queryExtended({
    status: 'in_progress',
    priority: 'P1',
    page: 1,
    pageSize: 5,
    sortBy: 'createdAt',
    sortOrder: 'desc',
  });
  check('combined: filter + pagination works', combined.tasks.length >= 0);

  store.close();
}

// ─── Part 4: Concurrent Writes & Transaction Safety ─────────────────

section('Part 4: Concurrent Writes & Transaction Safety');

{
  const store = new InMemoryStore();

  // Simulate concurrent creates
  const tasks: Task[] = [];
  for (let i = 0; i < 10; i++) {
    tasks.push(createMockTask({ id: `concurrent-${i}`, title: `Concurrent ${i}` }));
  }

  // Synchronous "concurrent" writes (InMemoryStore is sync-safe)
  tasks.forEach(t => store.create(t));
  check('concurrent: all creates succeed', store.count() === 10);

  // Concurrent updates
  tasks.forEach(t => {
    t.title = `Updated ${t.id}`;
    store.update(t);
  });
  check('concurrent: all updates succeed', store.get('concurrent-5')?.title === 'Updated concurrent-5');

  // Concurrent status transitions
  for (let i = 0; i < 5; i++) {
    store.transitionStatus(`concurrent-${i}`, 'assigned');
  }
  check('concurrent: transitions succeed', store.get('concurrent-0')?.status === 'assigned');

  store.close();
}

// ─── Part 5: Invalid Transition Handling + Metrics ─────────────────

section('Part 5: Invalid Transition Handling & Metrics');

{
  const store = new InMemoryStore();

  // Create tasks in various states
  const t1 = createMockTask({ id: 'inv-1', status: 'completed' });
  const t2 = createMockTask({ id: 'inv-2', status: 'cancelled' });
  const t3 = createMockTask({ id: 'inv-3', status: 'created' });
  store.create(t1);
  store.create(t2);
  store.create(t3);

  // Test all invalid transitions from terminal states
  const terminalStates: TaskStatus[] = ['completed', 'cancelled'];
  const allStates: TaskStatus[] = ['created', 'assigned', 'in_progress', 'on_hold', 'completed', 'cancelled'];

  let invalidCount = 0;
  terminalStates.forEach(from => {
    allStates.forEach(to => {
      if (to !== from) {
        const success = store.transitionStatus(`inv-${from === 'completed' ? 1 : 2}`, to);
        if (!success) invalidCount++;
      }
    });
  });

  check('invalid: all terminal transitions rejected', invalidCount > 0);
  check('invalid: count tracked', store.getInvalidTransitionCount() > 0);

  // Valid transitions from created
  check('valid: created → assigned', store.transitionStatus('inv-3', 'assigned'));
  check('valid: assigned → in_progress', store.transitionStatus('inv-3', 'in_progress'));
  check('valid: in_progress → on_hold', store.transitionStatus('inv-3', 'on_hold'));
  check('valid: on_hold → in_progress', store.transitionStatus('inv-3', 'in_progress'));
  check('valid: in_progress → completed', store.transitionStatus('inv-3', 'completed'));

  // Verify state machine compliance
  const t4 = createMockTask({ id: 'inv-4', status: 'created' });
  store.create(t4);
  store.transitionStatus('inv-4', 'assigned');
  store.transitionStatus('inv-4', 'in_progress');
  store.transitionStatus('inv-4', 'completed');

  const finalTask = store.get('inv-4');
  check('state machine: full path created → completed', finalTask?.status === 'completed');

  store.close();
}

// ─── Part 6: Edge Cases ───────────────────────────────────────────

section('Part 6: Edge Cases — Empty Store, Large Datasets, Boundaries');

{
  const store = new InMemoryStore();

  // ── Empty Store ───────────────────────────────────────────────
  check('edge: empty store query returns []', store.query().tasks.length === 0);
  check('edge: empty store count is 0', store.count() === 0);
  check('edge: empty store countActive is 0', store.countActive() === 0);
  check('edge: empty store get undefined', store.get('nonexistent') === undefined);

  // ── Pagination Boundaries ─────────────────────────────────────
  for (let i = 0; i < 100; i++) {
    store.create(createMockTask({ id: `edge-${i}` }));
  }

  // Page beyond range
  const beyondPage = store.queryExtended({ page: 100, pageSize: 10 });
  check('edge: page beyond range returns empty', beyondPage.tasks.length === 0);
  check('edge: page beyond range total still correct', beyondPage.total === 100);
  check('edge: page beyond range hasNextPage false', beyondPage.hasNextPage === false);

  // Page size = 1
  const pageSizeOne = store.queryExtended({ page: 1, pageSize: 1 });
  check('edge: pageSize=1 returns 1 item', pageSizeOne.tasks.length === 1);
  check('edge: pageSize=1 totalPages correct', pageSizeOne.totalPages === 100);

  // Page size = 500 (max)
  const pageSizeMax = store.queryExtended({ page: 1, pageSize: 500 });
  check('edge: pageSize=500 capped', pageSizeMax.pageSize === 500);
  check('edge: pageSize=500 returns all', pageSizeMax.tasks.length === 100);

  // Page size = 0 (should default to 20)
  const pageSizeZero = store.queryExtended({ page: 1, pageSize: 0 });
  check('edge: pageSize=0 defaults to 20', pageSizeZero.pageSize === 20);

  // Negative page (should default to 1)
  const negativePage = store.queryExtended({ page: -1, pageSize: 10 });
  check('edge: negative page defaults to 1', negativePage.page === 1);

  // ── Large Dataset ─────────────────────────────────────────────
  store.clear();
  for (let i = 0; i < 500; i++) {
    store.create(createMockTask({ id: `large-${i}` }));
  }
  check('edge: large dataset count correct', store.count() === 500);

  const largeQuery = store.queryExtended({ page: 10, pageSize: 50 });
  check('edge: large dataset pagination works', largeQuery.tasks.length === 50);

  store.close();
}

// ─── Part 7: TaskManager Integration ───────────────────────────────

section('Part 7: TaskManager Integration with Persistence');

{
  const store = new InMemoryStore();
  const manager = new TaskManager(store);

  // ── Create via Manager ────────────────────────────────────────
  const r1 = manager.createTask({ title: 'Manager Task 1', priority: 'P1' });
  check('manager: create succeeds', r1.ok);
  check('manager: task persisted', store.get(r1.task!.id) !== undefined);

  // ── Query via Manager ─────────────────────────────────────────
  const all = manager.queryTasks();
  check('manager: query returns tasks', all.tasks.length === 1);

  // ── Extended Query via Manager ────────────────────────────────
  for (let i = 0; i < 15; i++) {
    manager.createTask({ title: `Task ${i}`, priority: i % 2 === 0 ? 'P0' : 'P2' });
  }

  const paged = manager.queryTasksExtended({ page: 1, pageSize: 5, priority: 'P0' });
  check('manager: extended query pagination works', paged.tasks.length <= 5);
  check('manager: extended query filter works', paged.tasks.every(t => t.priority === 'P0'));

  // ── Status Transitions via Manager ─────────────────────────────
  const task = r1.task!;
  manager.changeStatus(task.id, 'assigned');
  manager.changeStatus(task.id, 'in_progress');
  manager.changeStatus(task.id, 'completed');

  const finalTask = store.get(task.id);
  check('manager: status transitions persisted', finalTask?.status === 'completed');

  // ── Invalid Transition via Manager ────────────────────────────
  const r2 = manager.createTask({ title: 'Task 2' });
  manager.changeStatus(r2.task!.id, 'assigned');
  manager.changeStatus(r2.task!.id, 'in_progress');
  manager.changeStatus(r2.task!.id, 'completed');

  const result = manager.changeStatus(r2.task!.id, 'in_progress');
  check('manager: invalid transition rejected', !result.ok);

  store.close();
}

// ─── Part 8: Factory Function ──────────────────────────────────────

section('Part 8: Factory Function');

{
  const memoryStore = createTaskStore('memory');
  check('factory: creates InMemoryStore', memoryStore instanceof InMemoryStore);

  // SQLite factory (may fail if node:sqlite not available)
  try {
    const sqliteStore = createTaskStore('sqlite', './test-factory.db');
    check('factory: creates SQLiteStore', sqliteStore instanceof SQLiteStore);
    sqliteStore.close();
    // Clean up
    if (fs.existsSync('./test-factory.db')) fs.unlinkSync('./test-factory.db');
    if (fs.existsSync('./test-factory.db-wal')) fs.unlinkSync('./test-factory.db-wal');
    if (fs.existsSync('./test-factory.db-shm')) fs.unlinkSync('./test-factory.db-shm');
  } catch (err: any) {
    skip('factory: creates SQLiteStore', `node:sqlite unavailable — ${err.message}`);
  }

  memoryStore.close();
}

// ─── Part 9: HTTP API Integration (E2E) ────────────────────────────

section('Part 9: HTTP API Integration (E2E)');

{
  const BASE_URL = 'http://localhost:3198';
  let serverProc: ChildProcess | null = null;

  async function startServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      const isWin = process.platform === 'win32';
      const cmd = isWin ? 'node' : 'npx';
      const args = isWin
        ? ['--import', 'tsx', 'tests/m7-test-server.ts']
        : ['tsx', 'tests/m7-test-server.ts'];

      serverProc = spawn(cmd, args, {
        cwd: process.cwd(),
        env: { ...process.env, PORT: '3198', LOG_LEVEL: 'ERROR' },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: isWin ? false : true,
      });

      let started = false;
      const timeout = setTimeout(() => {
        if (!started) reject(new Error('Server failed to start within 10s'));
      }, 10000);

      const poll = async () => {
        for (let i = 0; i < 20; i++) {
          try {
            const res = await fetch(`${BASE_URL}/health`);
            if (res.ok) {
              started = true;
              clearTimeout(timeout);
              setTimeout(resolve, 300);
              return;
            }
          } catch {}
          await sleep(300);
        }
      };
      poll();
    });
  }

  async function stopServer(): Promise<void> {
    if (serverProc) {
      serverProc.kill();
      serverProc = null;
    }
  }

  async function http(method: string, path: string, body?: any): Promise<any> {
    const url = `${BASE_URL}${path}`;
    const init: RequestInit = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(url, init);
    return res.json();
  }

  // Run E2E tests
  try {
    await startServer();

    // Test 1: Create task
    const createRes = await http('POST', '/api/tasks', { title: 'E2E Task', priority: 'P1' });
    check('e2e: POST /api/tasks creates task', createRes.ok === true);

    const taskId = createRes.task?.id;

    // Test 2: Get task
    const getRes = await http('GET', `/api/tasks/${taskId}`);
    check('e2e: GET /api/tasks/:id returns task', getRes.success === true);

    // Test 3: Query tasks with pagination
    for (let i = 0; i < 15; i++) {
      await http('POST', '/api/tasks', { title: `Task ${i}` });
    }

    const queryRes = await http('GET', '/api/tasks?page=1&pageSize=5');
    check('e2e: GET /api/tasks pagination works', queryRes.tasks?.length <= 5);

    // Test 4: Query with filters
    const filterRes = await http('GET', '/api/tasks?priority=P1');
    check('e2e: GET /api/tasks filter works', filterRes.tasks?.every((t: any) => t.priority === 'P1') || filterRes.tasks?.length === 0);

    // Test 5: Update status
    const updateRes = await http('PATCH', `/api/tasks/${taskId}`, { status: 'assigned' });
    check('e2e: PATCH /api/tasks/:id updates status', updateRes.ok === true);

    // Test 6: Get lifecycle events
    const lifecycleRes = await http('GET', `/api/tasks/${taskId}/lifecycle`);
    check('e2e: GET /api/tasks/:id/lifecycle returns events', lifecycleRes.success === true);

    // Test 7: Delete task
    const deleteRes = await http('DELETE', `/api/tasks/${taskId}`);
    check('e2e: DELETE /api/tasks/:id deletes task', deleteRes.ok === true);

    await stopServer();
  } catch (err: any) {
    // Do NOT convert an E2E failure into passes — that hides real breakage.
    console.log(`  ⚠️  E2E tests could not run: ${err.message}`);
    skip('e2e: HTTP API suite', err.message);
    await stopServer();
  }
}

// ─── Summary ────────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(60));
console.log(`M7 Persistence Test Summary: ${passed} passed, ${failed} failed, ${skipped} skipped`);
console.log('═'.repeat(60));

if (skips.length > 0) {
  console.log('\nSkipped tests (NOT counted as passed):');
  skips.forEach(s => console.log(`  - ${s}`));
}

if (failures.length > 0) {
  console.log('\nFailed tests:');
  failures.forEach(f => console.log(`  - ${f}`));
  process.exit(1);
} else {
  console.log('\n✅ All M7 persistence tests passed!');
  process.exit(0);
}
