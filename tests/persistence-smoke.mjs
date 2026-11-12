/**
 * Persistence smoke test — proves the built service survives a restart
 * when running with the production SQLite store.
 *
 * Run: npm run build && node tests/persistence-smoke.mjs
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const dbPath = path.join(root, 'data', 'smoke-persist.db');
const port = 3210;
const baseUrl = `http://127.0.0.1:${port}`;

for (const suffix of ['', '-wal', '-shm']) {
  fs.rmSync(dbPath + suffix, { force: true });
}

async function waitForHealth(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Server did not become healthy in time');
}

async function startServer() {
  const child = spawn(process.execPath, ['dist/src/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'production',
      TASK_STORE: 'sqlite',
      TASK_DB_PATH: dbPath,
      LOG_LEVEL: 'ERROR',
    },
    stdio: 'ignore',
  });
  await waitForHealth();
  return child;
}

async function stopServer(child) {
  child.kill();
  await Promise.race([
    once(child, 'exit'),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
}

let first;
let second;
try {
  first = await startServer();
  const createRes = await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'persistence smoke task', priority: 'P1' }),
  });
  const created = await createRes.json();
  if (!created.ok || !created.task?.id) {
    throw new Error(`Create failed: ${JSON.stringify(created)}`);
  }
  const taskId = created.task.id;
  const patchRes = await fetch(`${baseUrl}/api/tasks/${taskId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'assigned' }),
  });
  if (!patchRes.ok) {
    throw new Error(`Status update failed: ${await patchRes.text()}`);
  }
  const before = await (await fetch(`${baseUrl}/api/tasks`)).json();
  await stopServer(first);
  first = undefined;

  second = await startServer();
  const after = await (await fetch(`${baseUrl}/api/tasks`)).json();
  const paged = await (await fetch(`${baseUrl}/api/tasks?page=1&pageSize=1&sortBy=createdAt&sortOrder=desc`)).json();
  const fetched = await (await fetch(`${baseUrl}/api/tasks/${taskId}`)).json();
  const lifecycle = await (await fetch(`${baseUrl}/api/tasks/${taskId}/lifecycle`)).json();
  const pass =
    before.total === 1 &&
    after.total === 1 &&
    paged.page === 1 &&
    paged.pageSize === 1 &&
    paged.total === 1 &&
    paged.tasks?.length === 1 &&
    fetched.success === true &&
    fetched.task?.title === 'persistence smoke task' &&
    fetched.task?.status === 'assigned' &&
    lifecycle.success === true &&
    lifecycle.events?.length === 1 &&
    lifecycle.events[0]?.from === 'created' &&
    lifecycle.events[0]?.to === 'assigned' &&
    fs.existsSync(dbPath);

  console.log(JSON.stringify({
    pass,
    taskId,
    totalBeforeRestart: before.total,
    totalAfterRestart: after.total,
    extendedQuery: { page: paged.page, pageSize: paged.pageSize, total: paged.total },
    restoredTitle: fetched.task?.title,
    restoredStatus: fetched.task?.status,
    persistedLifecycleEvents: lifecycle.events?.length,
    dbPath,
    dbBytes: fs.statSync(dbPath).size,
  }, null, 2));
  process.exitCode = pass ? 0 : 1;
} finally {
  if (first) await stopServer(first);
  if (second) await stopServer(second);
}
