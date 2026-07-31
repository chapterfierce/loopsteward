/**
 * Claw Task Service — Structured JSON Logger with Request Context (M3)
 *
 * Extends the intent-engine logger with request_id and trace_id
 * propagation via AsyncLocalStorage. Every log entry automatically
 * includes the current request context when available.
 *
 * Log format (JSON):
 *   {
 *     "timestamp": "2026-07-31T12:00:00.000Z",
 *     "epochMs": 1753958400000,
 *     "level": "INFO",
 *     "message": "Request processed",
 *     "requestId": "550e8400-e29b-41d4-a716-446655440000",
 *     "traceId": "abcdef0123456789abcdef0123456789",
 *     "method": "GET",
 *     "path": "/api/tasks",
 *     "latencyMs": 15,
 *     "statusCode": 200,
 *     ...custom fields
 *   }
 */

import { getRequestContext, type RequestContext } from './request-context.js';

// ─── Types ─────────────────────────────────────────────────────────

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
};

export interface StructuredLogEntry {
  timestamp: string;
  epochMs: number;
  level: LogLevel;
  message: string;
  requestId?: string;
  traceId?: string;
  method?: string;
  path?: string;
  latencyMs?: number;
  statusCode?: number;
  error?: string;
  [key: string]: unknown;
}

// ─── Configuration ─────────────────────────────────────────────────

function parseLogLevel(): LogLevel {
  const envLevel = process.env['LOG_LEVEL']?.toUpperCase().trim();
  if (!envLevel) return 'INFO';
  if (envLevel === 'TRACE') return 'DEBUG';
  if (envLevel === 'SILENT') return 'ERROR';
  if (LEVEL_PRIORITY[envLevel as LogLevel] !== undefined) return envLevel as LogLevel;
  return 'INFO';
}

// ─── Service Logger ────────────────────────────────────────────────

class ServiceLogger {
  private minLevel: number;
  private startTime: number;

  constructor() {
    this.minLevel = LEVEL_PRIORITY[parseLogLevel()];
    this.startTime = Date.now();
  }

  setLevel(level: LogLevel): void {
    this.minLevel = LEVEL_PRIORITY[level];
  }

  getLevel(): LogLevel {
    for (const [name, priority] of Object.entries(LEVEL_PRIORITY)) {
      if (priority === this.minLevel) return name as LogLevel;
    }
    return 'INFO';
  }

  getUptimeMs(): number {
    return Date.now() - this.startTime;
  }

  // ─── Log Methods ───────────────────────────────────────────────

  debug(message: string, fields?: Partial<StructuredLogEntry>): void {
    this.log('DEBUG', message, fields);
  }

  info(message: string, fields?: Partial<StructuredLogEntry>): void {
    this.log('INFO', message, fields);
  }

  warn(message: string, fields?: Partial<StructuredLogEntry>): void {
    this.log('WARN', message, fields);
  }

  error(message: string, fields?: Partial<StructuredLogEntry>): void {
    this.log('ERROR', message, fields);
  }

  // ─── Request Logging ──────────────────────────────────────────

  /**
   * Log an HTTP request completion with full context.
   */
  request(
    message: string,
    ctx: RequestContext,
    statusCode: number,
    latencyMs: number,
    extra?: Record<string, unknown>,
  ): void {
    this.log(statusCode >= 400 ? 'WARN' : 'INFO', message, {
      requestId: ctx.requestId,
      traceId: ctx.traceId,
      method: ctx.method,
      path: ctx.path,
      statusCode,
      latencyMs,
      ...extra,
    });
  }

  // ─── Core ─────────────────────────────────────────────────────

  private log(level: LogLevel, message: string, fields?: Partial<StructuredLogEntry>): void {
    const priority = LEVEL_PRIORITY[level];
    if (priority < this.minLevel) return;

    const ctx = getRequestContext();
    const entry: StructuredLogEntry = {
      timestamp: new Date().toISOString(),
      epochMs: Date.now(),
      level,
      message,
      ...fields,
    };

    // Auto-inject request context if available and not explicitly set
    if (ctx) {
      if (entry.requestId === undefined) entry.requestId = ctx.requestId;
      if (entry.traceId === undefined) entry.traceId = ctx.traceId;
      if (entry.method === undefined) entry.method = ctx.method;
      if (entry.path === undefined) entry.path = ctx.path;
    }

    const jsonLine = JSON.stringify(entry);
    if (level === 'ERROR') {
      process.stderr.write(jsonLine + '\n');
    } else {
      process.stdout.write(jsonLine + '\n');
    }
  }
}

// ─── Singleton ─────────────────────────────────────────────────────

export const serviceLogger = new ServiceLogger();

export { ServiceLogger };
