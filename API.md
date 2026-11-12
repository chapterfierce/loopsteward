# API Documentation — Claw Task Service

**Version:** 2.5.0  
**Base URL:** `http://localhost:3000`  
**Last Updated:** 2026-11-10

---

## Overview

Claw Task Service is an intent classification and task management HTTP API. It provides:
- Natural language intent classification with multi-language support (zh-CN, en)
- Task CRUD operations with lifecycle state machine
- LRU caching for classification results
- Prometheus metrics and observability endpoints
- LLM fallback for low-confidence classifications

---

## MCP Server (read-only)

Open Loops phase 1 adds a stdio MCP server. It is separate from the legacy HTTP API and exposes only read-only tools:

| Tool | Description |
|------|-------------|
| `loops_context` | Return up to 3 unfinished loops for one project directory |
| `loops_search` | Search loops by text, status, project, and limit |
| `loops_get` | Return one loop and its source message excerpts by stable ref |
| `loops_closing` | List shown-but-unclosed loops, optionally filtered by project directory |

Start it with `npm run build && node dist/src/mcp/server.js --db data/loops.db`. Install client configuration with `npm run loops:install-mcp -- --json`. Full protocol and configuration details are in [`docs/MCP.md`](docs/MCP.md).

---

## Table of Contents

1. [Health & Monitoring](#health--monitoring)
2. [Intent Classification API](#intent-classification-api)
3. [Task Manager API](#task-manager-api)
4. [Webhook API](#webhook-api)
5. [Error Responses](#error-responses)
6. [Examples](#examples)

---

## Health & Monitoring

### GET /health

Health check endpoint for load balancers and monitoring systems.

**Response:**

```json
{
  "status": "ok",
  "uptime": 3600,
  "timestamp": "2026-08-01T07:05:00.000Z"
}
```

**Status Codes:**
- `200 OK` — Service is healthy

---

### GET /ready

Readiness probe for Kubernetes deployments. Checks if the service is ready to accept traffic.

**Response:**

```json
{
  "ready": true,
  "checks": {
    "memory": "ok",
    "cache": "ok"
  }
}
```

**Status Codes:**
- `200 OK` — Service is ready
- `503 Service Unavailable` — Service is not ready

---

### GET /metrics

Prometheus-format metrics endpoint for monitoring.

**Response Format:** `text/plain; charset=utf-8`

**Metrics Exposed:**

| Metric | Type | Description |
|--------|------|-------------|
| `http_requests_total` | counter | Total HTTP requests processed |
| `http_errors_total` | counter | Total HTTP errors (4xx + 5xx) |
| `http_request_duration_ms` | gauge | Average HTTP request latency |
| `http_request_duration_p95_ms` | gauge | P95 HTTP request latency |
| `http_in_flight_requests` | gauge | Current in-flight requests |
| `http_route_requests_total` | counter | Per-route request count |
| `intent_classifications_total` | counter | Total intent classifications |
| `intent_average_confidence` | gauge | Average classification confidence |
| `intent_average_latency_ms` | gauge | Average classification latency |
| `intent_cache_hits_total` | counter | Cache hit count |
| `intent_cache_misses_total` | counter | Cache miss count |
| `intent_cache_hit_rate` | gauge | Cache hit rate (0-1) |
| `process_resident_memory_bytes` | gauge | Resident memory in bytes |
| `tracer_active_traces` | gauge | Active trace count |

---

## Intent Classification API

### POST /api/v1/intent/classify

Classify natural language text into intent categories with full pipeline processing (caching, metrics, tracing).

**Request:**

```http
POST /api/v1/intent/classify
Content-Type: application/json

{
  "text": "创建登录页重构任务",
  "context": {
    "previousIntent": "query_status"
  }
}
```

**Parameters:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `text` | string | ✅ | User's raw input text |
| `context` | object | ❌ | Context for disambiguation |

**Response:**

```json
{
  "success": true,
  "requestId": "req_abc123",
  "result": {
    "category": "create_task",
    "subCategory": "general",
    "confidence": 1.0,
    "entities": [
      { "type": "category", "value": "重构", "position": 5, "confidence": 0.9 }
    ],
    "alternatives": [],
    "recommendedAction": "execute_directly",
    "routeHandler": "task.create",
    "cacheHit": false,
    "pipelineVersion": "3.0.0"
  },
  "trace": {
    "traceId": "trace_xyz789",
    "requestId": "req_abc123"
  }
}
```

**Intent Categories:**

| Category | Description | Route Handler |
|----------|-------------|---------------|
| `create_task` | Create a new task | `task.create` |
| `query_status` | Query task status | `task.query` |
| `modify_task` | Modify existing task | `task.modify` |
| `delete_task` | Delete/cancel task | `task.delete` |
| `schedule` | Schedule management | `schedule.manage` |
| `debug` | Debug operations | `dev.debug` |
| `development` | Development tasks | `dev.execute` |
| `research` | Research tasks | `dev.research` |
| `review` | Code review | `dev.review` |
| `planning` | Planning activities | `plan.manage` |
| `other` | Fallback intent | `fallback.help` |

**Confidence Actions:**

| Confidence Range | Action | Description |
|------------------|--------|-------------|
| ≥ 0.85 | `execute_directly` | High confidence, execute without confirmation |
| 0.70 – 0.84 | `execute_with_log` | Medium confidence, execute with logging |
| 0.50 – 0.69 | `confirm_with_user` | Low confidence, ask user to confirm |
| 0.30 – 0.49 | `offer_alternatives` | Minimal confidence, show alternatives |
| < 0.30 | `fallback_help` | Below threshold, fallback to help |

**Status Codes:**
- `200 OK` — Classification successful
- `400 Bad Request` — Missing or invalid `text` parameter

---

### GET /api/v1/intent/stats

Get classification statistics including metrics, cache stats, and tracer stats.

**Response:**

```json
{
  "success": true,
  "requestId": "req_def456",
  "metrics": {
    "totalClassifications": 1523,
    "averageConfidence": 0.87,
    "averageLatencyMs": 12.5,
    "ambiguousCount": 42,
    "categories": {
      "create_task": { "count": 520, "avgConfidence": 0.95 },
      "query_status": { "count": 380, "avgConfidence": 0.92 }
    },
    "cache": {
      "hits": 890,
      "misses": 633,
      "hitRate": 0.58,
      "evictions": 12
    },
    "errors": {
      "total": 5
    }
  },
  "cache": {
    "size": 633,
    "capacity": 1000
  },
  "tracer": {
    "activeTraces": 3,
    "totalTraces": 1523,
    "totalSpans": 4569
  }
}
```

---

### GET /api/v1/intent/timeline

Get recent classification timeline entries.

**Query Parameters:**

| Parameter | Type | Default | Max | Description |
|-----------|------|---------|-----|-------------|
| `limit` | integer | 50 | 500 | Number of entries to return |

**Response:**

```json
{
  "success": true,
  "requestId": "req_ghi789",
  "timeline": [
    {
      "timestamp": "2026-08-01T07:00:00.000Z",
      "text": "创建任务",
      "category": "create_task",
      "confidence": 1.0,
      "cacheHit": false,
      "latencyMs": 8
    }
  ]
}
```

---

### POST /api/intent (Legacy v0)

Legacy intent classification endpoint. Classifies text and executes the corresponding action.

**Request:**

```json
{
  "text": "删除任务123",
  "context": {}
}
```

**Response:**

```json
{
  "success": true,
  "message": "Intent processed",
  "intent": {
    "category": "delete_task",
    "confidence": 0.95
  },
  "result": {
    "taskDeleted": true
  }
}
```

---

## Task Manager API

### POST /api/tasks

Create a new task.

**Request:**

```json
{
  "title": "Implement user authentication",
  "description": "Add JWT-based auth to the API",
  "priority": "P1",
  "category": "feature",
  "assignee": "user_123",
  "deadline": "2026-08-15T18:00:00Z",
  "tags": ["backend", "security"]
}
```

**Parameters:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | ✅ | Task title |
| `description` | string | ❌ | Detailed description |
| `priority` | string | ❌ | Priority: `P0`, `P1`, `P2`, `P3` (default: `P2`) |
| `category` | string | ❌ | Category: `bugfix`, `feature`, `refactor`, `doc`, `test`, `design`, `general` |
| `assignee` | string | ❌ | Assigned user ID |
| `deadline` | string | ❌ | ISO 8601 deadline |
| `tags` | string[] | ❌ | Tags for categorization |

**Response:**

```json
{
  "ok": true,
  "message": "Task created successfully",
  "task": {
    "id": "task_abc123",
    "title": "Implement user authentication",
    "status": "created",
    "priority": "P1",
    "category": "feature",
    "assignee": "user_123",
    "createdAt": "2026-08-01T07:05:00.000Z",
    "updatedAt": "2026-08-01T07:05:00.000Z",
    "deadline": "2026-08-15T18:00:00Z",
    "tags": ["backend", "security"],
    "archived": false
  }
}
```

**Status Codes:**
- `201 Created` — Task created successfully
- `400 Bad Request` — Missing required `title` field

---

### GET /api/tasks

Query tasks with optional filters.

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `status` | string | Filter by status: `created`, `assigned`, `in_progress`, `on_hold`, `completed`, `cancelled` |
| `priority` | string | Filter by priority: `P0`, `P1`, `P2`, `P3` |
| `category` | string | Filter by category |
| `assignee` | string | Filter by assignee ID |
| `archived` | boolean | Include archived tasks (`true`/`false`) |
| `page` | number | Page number (1-based); enables paginated response |
| `pageSize` | number | Items per page (default 20, max 500) |
| `sortBy` | string | `createdAt`, `updatedAt`, `priority`, `status` |
| `sortOrder` | string | `asc` or `desc` |
| `createdAfter` / `createdBefore` | ISO 8601 | Creation-time range |
| `updatedAfter` / `updatedBefore` | ISO 8601 | Update-time range |
| `intentCategory` | string | Filter by originating intent category |

**Response:**

```json
{
  "tasks": [
    {
      "id": "task_abc123",
      "title": "Implement user authentication",
      "status": "in_progress",
      "priority": "P1",
      "category": "feature",
      "assignee": "user_123",
      "createdAt": "2026-08-01T07:05:00.000Z",
      "updatedAt": "2026-08-01T08:30:00.000Z",
      "archived": false
    }
  ],
  "total": 1,
  "filter": {
    "status": "in_progress"
  }
}
```

---

### GET /api/tasks/:id

Get a single task by ID.

**Response:**

```json
{
  "success": true,
  "task": {
    "id": "task_abc123",
    "title": "Implement user authentication",
    "status": "in_progress",
    "priority": "P1",
    "category": "feature",
    "assignee": "user_123",
    "createdAt": "2026-08-01T07:05:00.000Z",
    "updatedAt": "2026-08-01T08:30:00.000Z",
    "archived": false
  }
}
```

**Status Codes:**
- `200 OK` — Task found
- `404 Not Found` — Task not found

---

### PATCH /api/tasks/:id

Modify an existing task.

**Request:**

```json
{
  "status": "in_progress",
  "priority": "P0",
  "assignee": "user_456"
}
```

**Response:**

```json
{
  "ok": true,
  "message": "Task modified successfully",
  "task": {
    "id": "task_abc123",
    "status": "in_progress",
    "priority": "P0",
    "assignee": "user_456",
    "updatedAt": "2026-08-01T09:00:00.000Z"
  }
}
```

**Status Codes:**
- `200 OK` — Task modified successfully
- `400 Bad Request` — Invalid status transition

---

### DELETE /api/tasks/:id

Delete or archive a task.

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `mode` | string | `cancel` (default) or `archive` |

**Response:**

```json
{
  "ok": true,
  "message": "Task cancelled",
  "task": {
    "id": "task_abc123",
    "status": "cancelled",
    "updatedAt": "2026-08-01T10:00:00.000Z"
  }
}
```

**Status Codes:**
- `200 OK` — Task deleted/archived
- `404 Not Found` — Task not found

---

### GET /api/tasks/:id/lifecycle

Get the lifecycle audit trail for a task.

**Response:**

```json
{
  "success": true,
  "events": [
    {
      "timestamp": "2026-08-01T07:05:00.000Z",
      "fromStatus": null,
      "toStatus": "created",
      "actor": "system",
      "reason": "Task created"
    },
    {
      "timestamp": "2026-08-01T08:00:00.000Z",
      "fromStatus": "created",
      "toStatus": "assigned",
      "actor": "user_123",
      "reason": "Assigned to user_456"
    },
    {
      "timestamp": "2026-08-01T08:30:00.000Z",
      "fromStatus": "assigned",
      "toStatus": "in_progress",
      "actor": "user_456",
      "reason": "Work started"
    }
  ]
}
```

---

## Webhook API

Register external URLs to receive task lifecycle events. Deliveries are signed with
`X-Claw-Signature: sha256=<hmac>` when a secret is configured, and retried with
exponential backoff (3 attempts).

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/webhooks` | Register a webhook (`url`, `events`, `secret?`, `metadata?`) |
| `GET` | `/api/v1/webhooks` | List registered webhooks (secrets omitted) |
| `GET` | `/api/v1/webhooks/:id` | Get one webhook |
| `PATCH` | `/api/v1/webhooks/:id` | Update URL/events/secret/metadata/enabled |
| `DELETE` | `/api/v1/webhooks/:id` | Delete a webhook |
| `GET` | `/api/v1/webhooks/:id/deliveries` | Delivery history (`limit` default 20, max 100) |

### Events

`task.created`, `task.status_changed`, `task.deleted`,
`task.lifecycle.invalid_transition`.

### Example

```http
POST /api/v1/webhooks
Content-Type: application/json

{
  "url": "https://notify.example.com/hook",
  "events": ["task.created", "task.status_changed"],
  "secret": "<hmac-secret>"
}
```

---

## Error Responses

All error responses follow this format:

```json
{
  "success": false,
  "message": "Error description",
  "requestId": "req_abc123"
}
```

**Common Status Codes:**

| Status Code | Description |
|-------------|-------------|
| `200 OK` | Request successful |
| `201 Created` | Resource created successfully |
| `400 Bad Request` | Missing or invalid parameters |
| `404 Not Found` | Resource not found |
| `500 Internal Server Error` | Server error |

---

## Examples

### Example 1: Classify Intent

```bash
curl -X POST http://localhost:3000/api/v1/intent/classify \
  -H "Content-Type: application/json" \
  -d '{"text": "创建一个紧急的bug修复任务"}'
```

### Example 2: Create Task

```bash
curl -X POST http://localhost:3000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Fix login page crash",
    "priority": "P0",
    "category": "bugfix",
    "tags": ["urgent", "frontend"]
  }'
```

### Example 3: Query Tasks

```bash
curl "http://localhost:3000/api/tasks?status=in_progress&priority=P0"
```

### Example 4: Get Metrics

```bash
curl http://localhost:3000/metrics
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server listen port |
| `LOG_LEVEL` | `INFO` | Log level: `DEBUG`, `INFO`, `WARN`, `ERROR` |
| `NODE_ENV` | `development` | Environment: `development`, `production` |
| `TASK_STORE` | `sqlite` in production, `memory` otherwise | Task storage backend: `sqlite` or `memory` |
| `TASK_DB_PATH` | `./data/tasks.db` | SQLite database path (used when `TASK_STORE=sqlite`) |

---

## Rate Limiting

Currently no rate limiting is enforced at the API level. Rate limiting should be implemented at the infrastructure level (e.g., nginx, API gateway).

---

## Versioning

- `v0` endpoints (`/api/intent`) — Legacy, maintained for backward compatibility
- `v1` endpoints (`/api/v1/*`) — Current stable version with full observability

---

## License

MIT
