#!/usr/bin/env node

import * as path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { buildDigest } from '../loops/digest.js';
import { buildLoopDetail } from '../loops/detail.js';
import { buildClosingReview } from '../loops/closing.js';
import { loopRef } from '../loops/loop-ref.js';
import { LoopStore } from '../loops/loop-store.js';
import { resolveDefaultDbPath } from '../loops/data-path.js';
import type { LoopRecord, LoopStatus } from '../loops/types.js';

const SERVER_NAME = 'loopsteward';
const SERVER_VERSION = '2.9.0';

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const TOOLS: Tool[] = [
  {
    name: 'loops_context',
    description:
      'Return up to 3 unfinished loops for one project directory. Read-only; never changes loop state.',
    inputSchema: {
      type: 'object',
      properties: {
        projectDir: {
          type: 'string',
          description: 'Absolute project directory. Defaults to the MCP server working directory.',
        },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: 3,
          description: 'Maximum number of loops to return. Capped at 3.',
        },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'loops_search',
    description:
      'Search unfinished loops by text, status, and project. Read-only; never changes loop state.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Case-insensitive text matched against title, next action, and reason.',
        },
        status: {
          type: 'string',
          enum: ['open', 'pending', 'snoozed', 'resolved', 'dropped', 'all'],
          description: 'Loop status filter. Defaults to all.',
        },
        project: {
          type: 'string',
          description: 'Absolute project directory filter.',
        },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: 100,
          description: 'Maximum number of loops to return. Defaults to 20.',
        },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'loops_get',
    description:
      'Get one loop by its stable ref, including source message excerpts. Read-only; never changes loop state.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          description: 'Stable loop ref from a digest, or a unique loop id prefix.',
        },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: 50,
          description: 'Maximum number of source messages to include. Defaults to 12.',
        },
      },
      required: ['ref'],
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'loops_closing',
    description:
      'List loops that were already shown but never closed, ordered by presentation count. Read-only; never changes loop state.',
    inputSchema: {
      type: 'object',
      properties: {
        projectDir: {
          type: 'string',
          description: 'Absolute project directory filter. Omit to include all projects.',
        },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: 20,
          description: 'Maximum number of loops to return. Defaults to 10.',
        },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
];

const STATUS_VALUES: LoopStatus[] = ['open', 'pending', 'snoozed', 'resolved', 'dropped'];

interface ServerArgs {
  dbPath?: string;
  help: boolean;
}

function parseServerArgs(argv: string[]): ServerArgs {
  let dbPath: string | undefined;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--db') {
      dbPath = argv[index + 1];
      index += 1;
    } else if (arg.startsWith('--db=')) {
      dbPath = arg.slice('--db='.length);
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    }
  }
  return { dbPath, help };
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => path.resolve(value).replace(/\\/g, '/').toLowerCase();
  return normalize(left) === normalize(right);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readStatus(args: Record<string, unknown>): LoopStatus | 'all' | undefined {
  const value = readString(args, 'status');
  if (!value) return undefined;
  if (value === 'all') return 'all';
  if ((STATUS_VALUES as string[]).includes(value)) return value as LoopStatus;
  throw new Error(`invalid status: ${value}; expected ${[...STATUS_VALUES, 'all'].join(', ')}`);
}

function loopPayload(loop: LoopRecord) {
  return {
    id: loop.id,
    ref: loopRef(loop.id),
    title: loop.title,
    status: loop.status,
    confidence: loop.confidence,
    projectName: loop.projectName,
    projectDir: loop.projectDir,
    nextAction: loop.nextAction,
    why: loop.why,
    firstSeen: loop.firstSeen,
    lastSeen: loop.lastSeen,
    lastSurfacedAt: loop.lastSurfacedAt,
    snoozeUntil: loop.snoozeUntil,
  };
}

function textResult(payload: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

function errorResult(message: string, details?: Record<string, unknown>): CallToolResult {
  return textResult({ error: message, ...details }, true);
}

function contextTool(store: LoopStore, args: Record<string, unknown>): CallToolResult {
  const projectDir = path.resolve(readString(args, 'projectDir') ?? process.cwd());
  const limit = clamp(Math.floor(readNumber(args, 'limit') ?? 3), 1, 3);
  const digest = buildDigest({
    store,
    now: new Date(),
    focusProjectDir: projectDir,
    hotDays: 3650,
    activeDays: 3650,
    maxProjects: 50,
    maxLoops: limit,
    dailySurfaceLimit: 0,
    cooldownHours: 0,
    recapCooldownMinutes: 0,
    markSurfaced: false,
    readonlyRotation: true,
  });
  const loops = digest.groups
    .filter((group) => samePath(group.projectDir, projectDir))
    .flatMap((group) => group.loops)
    .slice(0, limit)
    .map(loopPayload);
  return textResult({
    projectDir,
    project: digest.focusProject ?? null,
    loops,
    total: loops.length,
  });
}

function searchTool(store: LoopStore, args: Record<string, unknown>): CallToolResult {
  const query = readString(args, 'query')?.toLowerCase();
  const status = readStatus(args) ?? 'all';
  const project = readString(args, 'project');
  const projectDir = project ? path.resolve(project) : undefined;
  const limit = clamp(Math.floor(readNumber(args, 'limit') ?? 20), 1, 100);
  const rows = store.listLoops({
    projectDir,
    status: status === 'all' ? undefined : status,
    includeAll: status === 'all' || status === 'resolved' || status === 'dropped',
    limit: 10_000,
  });
  const filtered = query
    ? rows.filter((loop) => {
        const haystack = `${loop.title}\n${loop.nextAction}\n${loop.why}`.toLowerCase();
        return haystack.includes(query);
      })
    : rows;
  const loops = filtered.slice(0, limit).map(loopPayload);
  return textResult({
    query: readString(args, 'query') ?? null,
    status,
    projectDir: projectDir ?? null,
    loops,
    total: loops.length,
  });
}

function getTool(store: LoopStore, args: Record<string, unknown>): CallToolResult {
  const ref = readString(args, 'ref');
  if (!ref) return errorResult('ref is required');
  const matches = store.findLoopsByRef(ref);
  if (matches.length === 0) {
    return errorResult(`no loop matches ref: ${ref}`);
  }
  if (matches.length > 1) {
    return errorResult(`ambiguous ref: ${ref}`, {
      matches: matches.map((loop) => ({
        ref: loopRef(loop.id),
        title: loop.title,
        projectName: loop.projectName,
        status: loop.status,
      })),
    });
  }
  const limit = clamp(Math.floor(readNumber(args, 'limit') ?? 12), 1, 50);
  const detail = buildLoopDetail(store, matches[0].id, limit);
  if (!detail) return errorResult(`no loop matches ref: ${ref}`);
  return textResult({
    ref: detail.ref,
    loop: loopPayload(detail.loop),
    signals: detail.signals.map((signal) => ({
      id: signal.id,
      agent: signal.agent,
      role: signal.role,
      sessionId: signal.sourceId,
      capturedAt: signal.capturedAt,
      excerpt: signal.text.length > 800 ? `${signal.text.slice(0, 800)}…` : signal.text,
    })),
    missingSignalIds: detail.missingSignalIds,
    omittedSignalCount: detail.omittedSignalCount,
    latestFeedback: detail.latestFeedback ?? null,
    presentationStats: detail.presentationStats ?? null,
  });
}

function closingTool(store: LoopStore, args: Record<string, unknown>): CallToolResult {
  const projectDir = readString(args, 'projectDir');
  const limit = clamp(Math.floor(readNumber(args, 'limit') ?? 10), 1, 20);
  const review = buildClosingReview({ store, projectDir, limit });
  return textResult({
    projectDir: projectDir ? path.resolve(projectDir) : null,
    total: review.total,
    shown: review.shown,
    items: review.items.map((item) => ({
      ...item,
      ref: loopRef(item.id),
    })),
  });
}

async function main(): Promise<void> {
  const parsed = parseServerArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stderr.write(
      'Usage: node dist/src/mcp/server.js [--db <path>]\n'
      + 'Read-only MCP server for LoopSteward. Exposes loops_context, loops_search, loops_get, loops_closing.\n',
    );
    return;
  }

  const store = new LoopStore(parsed.dbPath ?? resolveDefaultDbPath());
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        'Read-only access to LoopSteward open loops. Use loops_context for the current project, '
        + 'loops_search to find loops, loops_get for details and source excerpts, and '
        + 'loops_closing for items already shown but never closed.',
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      if (request.params.name === 'loops_context') return contextTool(store, args);
      if (request.params.name === 'loops_search') return searchTool(store, args);
      if (request.params.name === 'loops_get') return getTool(store, args);
      if (request.params.name === 'loops_closing') return closingTool(store, args);
      return errorResult(`unknown tool: ${request.params.name}`);
    } catch (error) {
      return errorResult((error as Error).message);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const close = () => {
    store.close();
    process.exit(0);
  };
  process.stdin.once('end', close);
  process.stdin.once('close', close);
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

main().catch((error) => {
  process.stderr.write(`loopsteward mcp: ${(error as Error).stack ?? (error as Error).message}\n`);
  process.exitCode = 1;
});
