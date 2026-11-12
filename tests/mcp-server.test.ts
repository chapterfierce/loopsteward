import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LoopStore } from '../src/loops/loop-store.js';
import { loopRef } from '../src/loops/loop-ref.js';

const dirs: string[] = [];
const clients: McpStdioClient[] = [];

interface Fixture {
  dir: string;
  dbPath: string;
  alpha: string;
  beta: string;
  loopIds: string[];
}

class McpStdioClient {
  private child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private stderr = '';

  constructor(dbPath: string) {
    const server = path.join(process.cwd(), 'src', 'mcp', 'server.ts');
    this.child = spawn(process.execPath, ['--import', 'tsx', server, '--db', dbPath], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      this.stderr += chunk;
    });
    this.child.on('exit', (code) => {
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`MCP server exited (${code}): ${this.stderr}`));
      }
      this.pending.clear();
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (typeof message.id !== 'number') continue;
      const entry = this.pending.get(message.id);
      if (!entry) continue;
      clearTimeout(entry.timer);
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    }
  }

  request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}; stderr=${this.stderr}`));
      }, 20_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method: string, params?: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async initialize(): Promise<any> {
    const result = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'loopsteward-test', version: '1.0.0' },
    });
    this.notify('notifications/initialized');
    return result;
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => {
      if (this.child.exitCode !== null) {
        resolve();
        return;
      }
      this.child.once('exit', () => resolve());
    });
    this.child.stdin.end();
    this.child.kill();
    const timedOut = await Promise.race([
      exited.then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 2000)),
    ]);
    if (timedOut) {
      this.child.kill('SIGKILL');
      await Promise.race([
        exited,
        new Promise<void>((resolve) => setTimeout(resolve, 2000)),
      ]);
    }
  }
}

async function removeDir(dir: string): Promise<void> {
  const deadline = Date.now() + 4000;
  for (;;) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== 'EPERM' && code !== 'EBUSY' && code !== 'ENOTEMPTY') || Date.now() >= deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

function tempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `loops-mcp-${label}-`));
  dirs.push(dir);
  return dir;
}

function addLoop(
  store: LoopStore,
  projectDir: string,
  projectName: string,
  title: string,
  text: string,
): string {
  const signalId = `sig-${projectName}-${title}`;
  store.saveSignal({
    id: signalId,
    source: 'session',
    sourceId: `session-${projectName}`,
    messageId: `message-${title}`,
    agent: 'codex',
    role: 'user',
    text,
    projectDir,
    capturedAt: '2026-11-10T10:00:00.000Z',
    contentHash: `hash-${projectName}-${title}`,
  });
  return store.saveLoop(
    {
      title,
      nextAction: `finish ${title}`,
      why: `why ${title}`,
      confidence: 0.8,
      sourceSignalIds: [signalId],
    },
    {
      projectDir,
      projectName,
      firstSeen: '2026-11-10T10:00:00.000Z',
      lastSeen: '2026-11-10T10:00:00.000Z',
    },
  ).loop.id;
}

function fixture(label = 'base'): Fixture {
  const dir = tempDir(label);
  const alpha = path.join(dir, 'alpha');
  const beta = path.join(dir, 'beta');
  const dbPath = path.join(dir, 'loops.db');
  const store = new LoopStore(dbPath);
  try {
    const loopIds = [
      addLoop(store, alpha, 'alpha', 'Alpha login', '登录页还差错误提示没补'),
      addLoop(store, alpha, 'alpha', 'Alpha export', '导出按钮还没接'),
      addLoop(store, alpha, 'alpha', 'Alpha billing', '账单筛选还没做'),
      addLoop(store, alpha, 'alpha', 'Alpha search', '搜索框为空时没有提示'),
      addLoop(store, beta, 'beta', 'Beta deploy', '部署脚本还没更新'),
    ];
    return { dir, dbPath, alpha, beta, loopIds };
  } finally {
    store.close();
  }
}

async function connect(dbPath: string): Promise<McpStdioClient> {
  const client = new McpStdioClient(dbPath);
  clients.push(client);
  await client.initialize();
  return client;
}

function payload(result: any): any {
  return JSON.parse(result.content[0].text);
}

async function callTool(client: McpStdioClient, name: string, args: Record<string, unknown>) {
  return client.request('tools/call', { name, arguments: args });
}

afterEach(async () => {
  while (clients.length > 0) await clients.pop()!.close();
  while (dirs.length > 0) await removeDir(dirs.pop()!);
}, 30000);

describe('LoopSteward MCP server', () => {
  it('completes the initialize handshake and exposes only read-only tools', async () => {
    const { dbPath } = fixture('list');
    const client = await connect(dbPath);
    const result = await client.request('tools/list');
    expect(result.tools.map((tool: any) => tool.name).sort()).toEqual([
      'loops_closing',
      'loops_context',
      'loops_get',
      'loops_search',
    ]);
    for (const tool of result.tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.name).not.toMatch(/create|update|close|delete|write/i);
    }
  });

  it('returns at most 3 loops from the requested project', async () => {
    const { dbPath, alpha } = fixture('context');
    const client = await connect(dbPath);
    const data = payload(await callTool(client, 'loops_context', { projectDir: alpha, limit: 10 }));
    expect(data.total).toBe(3);
    expect(data.loops).toHaveLength(3);
    for (const loop of data.loops) {
      expect(loop.projectDir.toLowerCase()).toBe(alpha.toLowerCase());
      expect(loop.ref).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  it('searches by query, status, project, and limit', async () => {
    const { dbPath, alpha } = fixture('search');
    const client = await connect(dbPath);
    const byQuery = payload(await callTool(client, 'loops_search', { query: 'billing' }));
    expect(byQuery.total).toBe(1);
    expect(byQuery.loops[0].title).toBe('Alpha billing');

    const byProject = payload(await callTool(client, 'loops_search', {
      project: alpha,
      status: 'open',
      limit: 2,
    }));
    expect(byProject.total).toBe(2);

    const resolved = payload(await callTool(client, 'loops_search', { status: 'resolved' }));
    expect(resolved.total).toBe(0);
  });

  it('gets a loop by ref with source message excerpts', async () => {
    const { dbPath, loopIds } = fixture('get');
    const client = await connect(dbPath);
    const data = payload(await callTool(client, 'loops_get', {
      ref: loopRef(loopIds[0]),
      limit: 1,
    }));
    expect(data.loop.title).toBe('Alpha login');
    expect(data.signals).toHaveLength(1);
    expect(data.signals[0].excerpt).toContain('错误提示');
  });

  it('lists shown-but-open loops for a closing review', async () => {
    const { dbPath, alpha, loopIds } = fixture('closing');
    const store = new LoopStore(dbPath);
    try {
      store.recordPresentation([loopIds[0]], '2026-11-10T11:00:00.000Z', 'hot', 'hot');
      store.recordPresentation([loopIds[0]], '2026-11-10T12:00:00.000Z', 'hot', 'recap');
      store.recordPresentation([loopIds[4]], '2026-11-10T13:00:00.000Z', 'hot', 'hot');
    } finally {
      store.close();
    }

    const client = await connect(dbPath);
    const all = payload(await callTool(client, 'loops_closing', { limit: 10 }));
    expect(all.total).toBe(2);
    expect(all.items[0].ref).toBe(loopRef(loopIds[0]));
    expect(all.items[0].presentationCount).toBe(2);

    const alphaOnly = payload(await callTool(client, 'loops_closing', { projectDir: alpha }));
    expect(alphaOnly.total).toBe(1);
    expect(alphaOnly.items[0].title).toBe('Alpha login');
  });

  it('reports an ambiguous ref instead of picking one loop', async () => {
    const { dbPath, loopIds } = fixture('ambiguous');
    const store = new LoopStore(dbPath);
    const firstId = 'loop_abcd000000000001';
    const secondId = 'loop_abcd000000000002';
    try {
      const db = (store as any).db;
      db.prepare('UPDATE loops SET id = ? WHERE id = ?').run(firstId, loopIds[0]);
      db.prepare('UPDATE loops SET id = ? WHERE id = ?').run(secondId, loopIds[1]);
    } finally {
      store.close();
    }
    const client = await connect(dbPath);
    const result = await callTool(client, 'loops_get', { ref: 'abcd' });
    expect(result.isError).toBe(true);
    expect(payload(result).error).toContain('ambiguous');
    expect(payload(result).matches).toHaveLength(2);
  });

  it('returns an empty result for an empty database', async () => {
    const dir = tempDir('empty');
    const client = await connect(path.join(dir, 'loops.db'));
    const context = payload(await callTool(client, 'loops_context', { projectDir: dir }));
    expect(context.total).toBe(0);
    expect(context.loops).toEqual([]);
    const search = payload(await callTool(client, 'loops_search', {}));
    expect(search.total).toBe(0);
  });

  it('does not change loop state or surfacing counters', async () => {
    const { dbPath, alpha, loopIds } = fixture('readonly');
    const before = new LoopStore(dbPath);
    const snapshot = new Map(before.listAllLoops().map((loop) => [loop.id, {
      status: loop.status,
      lastSurfacedAt: loop.lastSurfacedAt ?? null,
      presentationCount: loop.presentationCount ?? 0,
      resolvedAt: loop.resolvedAt ?? null,
    }]));
    const feedbackBefore = before.getFeedbackCounts();
    before.close();

    const client = await connect(dbPath);
    await callTool(client, 'loops_context', { projectDir: alpha });
    await callTool(client, 'loops_search', { query: 'alpha' });
    await callTool(client, 'loops_get', { ref: loopRef(loopIds[0]) });
    await callTool(client, 'loops_closing', { projectDir: alpha });
    await client.close();

    const after = new LoopStore(dbPath);
    try {
      for (const loop of after.listAllLoops()) {
        expect({
          status: loop.status,
          lastSurfacedAt: loop.lastSurfacedAt ?? null,
          presentationCount: loop.presentationCount ?? 0,
          resolvedAt: loop.resolvedAt ?? null,
        }).toEqual(snapshot.get(loop.id));
      }
      expect(after.getFeedbackCounts()).toEqual(feedbackBefore);
    } finally {
      after.close();
    }
  });
});
