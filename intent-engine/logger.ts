/**
 * Claw Task Service — Structured JSON Logger (Phase 3 M3)
 *
 * Provides structured JSON logging with:
 *   - Four log levels: DEBUG, INFO, WARN, ERROR
 *   - Configurable via LOG_LEVEL environment variable
 *   - JSON output with: timestamp, level, message, and custom fields
 *   - Intent-engine specific fields: category, latency, cacheHit
 *   - No external dependencies — pure Node.js console + JSON.stringify
 *
 * Log level hierarchy: DEBUG < INFO < WARN < ERROR
 * Messages below the configured level are silently dropped.
 *
 * Environment:
 *   LOG_LEVEL=DEBUG|INFO|WARN|ERROR  (default: INFO)
 *
 * Usage:
 *   import { logger } from './logger.js';
 *   logger.info('Classification complete', { category: 'create_task', latency: 5 });
 *   logger.error('Parse failed', { error: 'Invalid JSON', input: rawText });
 *
 * Based on: Phase 3 M3 task spec (2026-07-16)
 */

// ─── Types ─────────────────────────────────────────────────────────

/** Log severity levels in ascending order of priority */
export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

/** Numeric priority for level comparison (higher = more important) */
const LEVEL_PRIORITY: Record<LogLevel, number> = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
};

/** String values for level name parsing */
const VALID_LEVELS = new Set(['DEBUG', 'INFO', 'WARN', 'ERROR', 'TRACE', 'SILENT']);

/** A structured log entry as it appears in JSON output */
export interface LogEntry {
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Epoch milliseconds */
  epochMs: number;
  /** Log level */
  level: LogLevel;
  /** Human-readable log message */
  message: string;
  /** Intent category (if applicable) */
  category?: string;
  /** Processing latency in ms (if applicable) */
  latencyMs?: number;
  /** Whether this was a cache hit (if applicable) */
  cacheHit?: boolean;
  /** Sub-category (if applicable) */
  subCategory?: string;
  /** Confidence score [0,1] (if applicable) */
  confidence?: number;
  /** Error details (for error-level logs) */
  error?: string;
  /** Additional metadata fields */
  [key: string]: unknown;
}

// ─── Logger Configuration ──────────────────────────────────────────

/**
 * Parse the LOG_LEVEL environment variable.
 * Falls back to INFO if not set or invalid.
 */
function parseLogLevel(): LogLevel {
  const envLevel = process.env['LOG_LEVEL']?.toUpperCase().trim();
  if (!envLevel) return 'INFO';

  // Allow TRACE as an alias for DEBUG, SILENT as a higher-than-ERROR
  if (envLevel === 'TRACE') return 'DEBUG';
  if (envLevel === 'SILENT') return 'ERROR';

  if (LEVEL_PRIORITY[envLevel as LogLevel] !== undefined) {
    return envLevel as LogLevel;
  }

  // Invalid value — warn and default
  return 'INFO';
}

// ─── Logger Class ──────────────────────────────────────────────────

/**
 * Structured JSON logger.
 *
 * Writes JSON-formatted log entries to stdout (INFO/WARN/ERROR)
 * or stderr (ERROR only by default, configurable).
 * Each log call produces a single JSON line for easy log aggregation.
 */
class Logger {
  private minLevel: number;
  private startTime: number;

  constructor() {
    this.minLevel = LEVEL_PRIORITY[parseLogLevel()];
    this.startTime = Date.now();
  }

  /**
   * Dynamically update the minimum log level.
   * @param level - The new minimum log level
   */
  setLevel(level: LogLevel): void {
    this.minLevel = LEVEL_PRIORITY[level];
  }

  /**
   * Get the current minimum log level.
   */
  getLevel(): LogLevel {
    for (const [name, priority] of Object.entries(LEVEL_PRIORITY)) {
      if (priority === this.minLevel) return name as LogLevel;
    }
    return 'INFO';
  }

  /**
   * Get the process uptime in milliseconds.
   */
  getUptimeMs(): number {
    return Date.now() - this.startTime;
  }

  // ─── Log Methods ───────────────────────────────────────────────

  /**
   * Log a DEBUG-level message.
   * Use for detailed diagnostic information (only visible when LOG_LEVEL=DEBUG).
   */
  debug(message: string, fields?: Partial<LogEntry>): void {
    this.log('DEBUG', message, fields);
  }

  /**
   * Log an INFO-level message.
   * Use for general operational information.
   */
  info(message: string, fields?: Partial<LogEntry>): void {
    this.log('INFO', message, fields);
  }

  /**
   * Log a WARN-level message.
   * Use for potentially harmful situations that don't prevent operation.
   */
  warn(message: string, fields?: Partial<LogEntry>): void {
    this.log('WARN', message, fields);
  }

  /**
   * Log an ERROR-level message.
   * Use for error events that may prevent continued operation.
   */
  error(message: string, fields?: Partial<LogEntry>): void {
    this.log('ERROR', message, fields);
  }

  // ─── Core Logging ──────────────────────────────────────────────

  /**
   * Core logging method. Builds a LogEntry and writes it if the level permits.
   *
   * @param level - The log level
   * @param message - The log message
   * @param fields - Additional structured fields to include
   */
  private log(level: LogLevel, message: string, fields?: Partial<LogEntry>): void {
    const priority = LEVEL_PRIORITY[level];
    if (priority < this.minLevel) {
      return; // Silently drop below-threshold messages
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      epochMs: Date.now(),
      level,
      message,
      ...fields,
    };

    // ERROR goes to stderr, everything else to stdout
    const jsonLine = JSON.stringify(entry);
    if (level === 'ERROR') {
      process.stderr.write(jsonLine + '\n');
    } else {
      process.stdout.write(jsonLine + '\n');
    }
  }

  // ─── Convenience Methods ───────────────────────────────────────

  /**
   * Log a classification event with structured fields.
   * Convenience wrapper that extracts common intent-engine fields.
   *
   * @param message - Log message
   * @param category - Intent category
   * @param latencyMs - Processing latency
   * @param cacheHit - Whether result was from cache
   * @param confidence - Confidence score
   * @param subCategory - Sub-category
   * @param extra - Additional fields
   */
  classification(
    message: string,
    opts: {
      category?: string;
      subCategory?: string;
      latencyMs?: number;
      cacheHit?: boolean;
      confidence?: number;
      extra?: Record<string, unknown>;
    },
  ): void {
    const fields: Partial<LogEntry> = {};
    if (opts.category !== undefined) fields.category = opts.category;
    if (opts.subCategory !== undefined) fields.subCategory = opts.subCategory;
    if (opts.latencyMs !== undefined) fields.latencyMs = opts.latencyMs;
    if (opts.cacheHit !== undefined) fields.cacheHit = opts.cacheHit;
    if (opts.confidence !== undefined) fields.confidence = opts.confidence;
    if (opts.extra) {
      for (const [k, v] of Object.entries(opts.extra)) {
        fields[k] = v;
      }
    }

    // Use INFO level for normal classifications, WARN for low confidence
    const level: LogLevel = opts.confidence !== undefined && opts.confidence < 0.5
      ? 'WARN'
      : 'INFO';
    this.log(level, message, fields);
  }

  /**
   * Log a cache event.
   * @param event - 'hit' | 'miss' | 'eviction' | 'expiration'
   * @param details - Optional additional fields
   */
  cacheEvent(
    event: 'hit' | 'miss' | 'eviction' | 'expiration',
    details?: Record<string, unknown>,
  ): void {
    const level: LogLevel = event === 'eviction' || event === 'expiration' ? 'DEBUG' : 'DEBUG';
    this.log(level, `Cache ${event}`, {
      cacheEvent: event,
      ...details,
    });
  }
}

// ─── Singleton Export ──────────────────────────────────────────────

/**
 * Global singleton logger instance.
 *
 * Usage:
 *   import { logger } from './logger.js';
 *   logger.info('Service started');
 *   logger.error('Failed to classify', { error: 'No rules matched' });
 */
export const logger = new Logger();

/**
 * Get the singleton Logger instance.
 */
export function getLogger(): Logger {
  return logger;
}

// ─── Export the class for testing ──────────────────────────────────

export { Logger };
