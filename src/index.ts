/**
 * Claw Task Service — Main Server Entry Point (M3 + M10)
 *
 * Wires together:
 *   1. Express HTTP server with JSON body parsing
 *   2. Observability middleware (logging + metrics + tracing + health)
 *   3. Task Manager REST API (CRUD + query)
 *   4. Intent → Task bridge endpoint (POST /api/intent)
 *   5. /health, /ready, /metrics endpoints
 *   6. Intent classification API (POST /api/v1/intent/classify)
 *   7. Intent statistics API (GET /api/v1/intent/stats)
 *
 * M10 additions:
 *   - Prometheus-format /metrics endpoint
 *   - POST /api/v1/intent/classify — classify text, return result + trace
 *   - GET  /api/v1/intent/stats   — classification statistics
 *   - Request-id propagation through pipeline via tracing middleware
 *   - Full observability integration (tracer + metrics on every request)
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
// M10: Import pipeline + metrics for intent API endpoints
import { classifyIntent, getCacheStats, collectStats, type PipelineResult } from '../intent-engine/pipeline.js';
import { metrics as intentMetrics } from '../intent-engine/metrics.js';
import { tracer } from '../intent-engine/tracer.js';

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

// ─── Prometheus-format /metrics override (M10) ───────────────────
//
// The setupObservability() call above already registers a JSON /metrics
// endpoint. We override it with a Prometheus text-format handler so that
// Prometheus can scrape standard metric names.
//
app.get('/metrics', (req: any, res: any) => {
  const httpSnapshot = httpMetrics.getMetrics();
  const intentSnapshot = intentMetrics.getMetrics();
  const cacheStats = getCacheStats();

  const lines: string[] = [];

  // ── HTTP metrics ────────────────────────────────────────────
  lines.push('# HELP http_requests_total Total HTTP requests processed');
  lines.push('# TYPE http_requests_total counter');
  lines.push(`http_requests_total ${httpSnapshot.totalRequests}`);

  lines.push('# HELP http_errors_total Total HTTP errors (4xx + 5xx)');
  lines.push('# TYPE http_errors_total counter');
  lines.push(`http_errors_total ${httpSnapshot.totalErrors}`);

  lines.push('# HELP http_request_duration_ms Average HTTP request latency in ms');
  lines.push('# TYPE http_request_duration_ms gauge');
  lines.push(`http_request_duration_ms ${httpSnapshot.averageLatencyMs.toFixed(2)}`);

  lines.push('# HELP http_request_duration_p95_ms P95 HTTP request latency in ms');
  lines.push('# TYPE http_request_duration_p95_ms gauge');
  lines.push(`http_request_duration_p95_ms ${httpSnapshot.p95LatencyMs.toFixed(2)}`);

  lines.push('# HELP http_in_flight_requests Current in-flight HTTP requests');
  lines.push('# TYPE http_in_flight_requests gauge');
  lines.push(`http_in_flight_requests ${httpSnapshot.inFlightRequests}`);

  // Per-route metrics
  lines.push('# HELP http_route_requests_total Per-route HTTP request count');
  lines.push('# TYPE http_route_requests_total counter');
  for (const route of httpSnapshot.routes) {
    const label = `method="${route.method}",route="${route.route}"`;
    lines.push(`http_route_requests_total{${label}} ${route.count}`);
  }

  // Latency histogram
  lines.push('# HELP http_request_duration_bucket Latency histogram buckets');
  lines.push('# TYPE http_request_duration_bucket histogram');
  for (const bucket of httpSnapshot.latencyHistogram) {
    lines.push(`http_request_duration_bucket{le="${bucket.upperBoundMs}"} ${bucket.count}`);
  }

  // ── Intent classification metrics ──────────────────────────
  lines.push('# HELP intent_classifications_total Total intent classifications');
  lines.push('# TYPE intent_classifications_total counter');
  lines.push(`intent_classifications_total ${intentSnapshot.totalClassifications}`);

  lines.push('# HELP intent_average_confidence Average intent classification confidence');
  lines.push('# TYPE intent_average_confidence gauge');
  lines.push(`intent_average_confidence ${intentSnapshot.averageConfidence.toFixed(4)}`);

  lines.push('# HELP intent_average_latency_ms Average intent classification latency in ms');
  lines.push('# TYPE intent_average_latency_ms gauge');
  lines.push(`intent_average_latency_ms ${intentSnapshot.averageLatencyMs.toFixed(2)}`);

  lines.push('# HELP intent_ambiguous_total Total ambiguous classifications');
  lines.push('# TYPE intent_ambiguous_total counter');
  lines.push(`intent_ambiguous_total ${intentSnapshot.ambiguousCount}`);

  // Per-category metrics
  lines.push('# HELP intent_category_total Per-category classification count');
  lines.push('# TYPE intent_category_total counter');
  for (const [cat, stats] of Object.entries(intentSnapshot.categories)) {
    lines.push(`intent_category_total{category="${cat}"} ${stats.count}`);
  }

  // ── Cache metrics ──────────────────────────────────────────
  lines.push('# HELP intent_cache_hits_total Cache hit count');
  lines.push('# TYPE intent_cache_hits_total counter');
  lines.push(`intent_cache_hits_total ${intentSnapshot.cache.hits}`);

  lines.push('# HELP intent_cache_misses_total Cache miss count');
  lines.push('# TYPE intent_cache_misses_total counter');
  lines.push(`intent_cache_misses_total ${intentSnapshot.cache.misses}`);

  lines.push('# HELP intent_cache_hit_rate Cache hit rate (0-1)');
  lines.push('# TYPE intent_cache_hit_rate gauge');
  lines.push(`intent_cache_hit_rate ${intentSnapshot.cache.hitRate.toFixed(4)}`);

  lines.push('# HELP intent_cache_evictions_total Cache eviction count');
  lines.push('# TYPE intent_cache_evictions_total counter');
  lines.push(`intent_cache_evictions_total ${intentSnapshot.cache.evictions}`);

  lines.push('# HELP intent_cache_size Current cache size');
  lines.push('# TYPE intent_cache_size gauge');
  lines.push(`intent_cache_size ${cacheStats.size}`);

  // ── Error metrics ───────────────────────────────────────────
  lines.push('# HELP intent_errors_total Total intent classification errors');
  lines.push('# TYPE intent_errors_total counter');
  lines.push(`intent_errors_total ${intentSnapshot.errors.total}`);

  // ── Tracer metrics ──────────────────────────────────────────
  lines.push('# HELP tracer_active_traces Active trace count');
  lines.push('# TYPE tracer_active_traces gauge');
  lines.push(`tracer_active_traces ${tracer.getActiveTraceCount()}`);

  lines.push('# HELP tracer_total_traces Total traces created');
  lines.push('# TYPE tracer_total_traces counter');
  lines.push(`tracer_total_traces ${tracer.getTotalTraceCount()}`);

  lines.push('# HELP tracer_total_spans Total spans created');
  lines.push('# TYPE tracer_total_spans counter');
  lines.push(`tracer_total_spans ${tracer.getTotalSpanCount()}`);

  // ── Process metrics ─────────────────────────────────────────
  const mem = process.memoryUsage();
  lines.push('# HELP process_resident_memory_bytes Resident memory in bytes');
  lines.push('# TYPE process_resident_memory_bytes gauge');
  lines.push(`process_resident_memory_bytes ${mem.rss}`);

  lines.push('# HELP process_heap_used_bytes Heap used in bytes');
  lines.push('# TYPE process_heap_used_bytes gauge');
  lines.push(`process_heap_used_bytes ${mem.heapUsed}`);

  lines.push('# HELP process_heap_total_bytes Heap total in bytes');
  lines.push('# TYPE process_heap_total_bytes gauge');
  lines.push(`process_heap_total_bytes ${mem.heapTotal}`);

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(lines.join('\n'));
});

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

// ─── Intent API (v0 — legacy) ─────────────────────────────────────

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

// ─── Intent API (v1 — M10) ─────────────────────────────────────────

/**
 * POST /api/v1/intent/classify — Classify text and return structured result.
 * Body: { text: string, context?: IntentContext }
 *
 * Returns the full PipelineResult including category, subCategory,
 * confidence, entities, alternatives, recommendedAction, routeHandler,
 * and trace metadata.
 */
app.post('/api/v1/intent/classify', (req, res) => {
  const { text, context } = req.body as { text: string; context?: any };
  if (!text || typeof text !== 'string') {
    res.status(400).json({
      success: false,
      message: 'text is required',
      requestId: req.requestContext?.requestId,
    });
    return;
  }

  // Run classification through the pipeline (tracer + metrics are integrated)
  const result: PipelineResult = classifyIntent(text, context);

  // Get trace summary if available
  const traceId = req.requestContext?.traceId;
  let traceSummary: any = undefined;
  if (traceId) {
    // The pipeline creates its own internal trace; we expose the request-level trace
    traceSummary = {
      traceId: req.requestContext.traceId,
      requestId: req.requestContext.requestId,
    };
  }

  res.json({
    success: true,
    requestId: req.requestContext?.requestId,
    result,
    trace: traceSummary,
  });
});

/**
 * GET /api/v1/intent/stats — Classification statistics.
 *
 * Returns metrics snapshot including:
 *   - Total classifications, per-category breakdown
 *   - Cache hit/miss stats
 *   - Average confidence + latency
 *   - Error counts
 *   - Recent timeline entries
 */
app.get('/api/v1/intent/stats', (req, res) => {
  const metricsSnapshot = intentMetrics.getMetrics();
  const cacheStats = getCacheStats();
  const tracerStats = {
    activeTraces: tracer.getActiveTraceCount(),
    totalTraces: tracer.getTotalTraceCount(),
    totalSpans: tracer.getTotalSpanCount(),
  };

  res.json({
    success: true,
    requestId: req.requestContext?.requestId,
    metrics: metricsSnapshot,
    cache: cacheStats,
    tracer: tracerStats,
  });
});

/**
 * GET /api/v1/intent/timeline — Recent classification timeline.
 * Query param: limit (default 50, max 500)
 */
app.get('/api/v1/intent/timeline', (req, res) => {
  const limit = Math.min(parseInt(req.query['limit'] as string, 10) || 50, 500);
  const timeline = intentMetrics.getTimeline(limit);
  res.json({
    success: true,
    requestId: req.requestContext?.requestId,
    timeline,
  });
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
      'GET    /health',
      'GET    /ready',
      'GET    /metrics (Prometheus format)',
      'POST   /api/tasks',
      'GET    /api/tasks',
      'GET    /api/tasks/:id',
      'PATCH  /api/tasks/:id',
      'DELETE /api/tasks/:id',
      'GET    /api/tasks/:id/lifecycle',
      'POST   /api/intent',
      'POST   /api/v1/intent/classify',
      'GET    /api/v1/intent/stats',
      'GET    /api/v1/intent/timeline',
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
