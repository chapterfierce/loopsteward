# Claw Task Service

A TypeScript-based task management service with a built-in intent classification engine. The service parses natural language input (Chinese and English), classifies user intent, extracts entities, and routes requests to the appropriate task management handlers.

**Version:** 2.5.0  
**Status:** Phase 3 (M1–M6 complete)

---

## Table of Contents

- [Overview](#overview)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Milestones (M1–M6)]#milestones-m1m6)
- [Installation](#installation)
- [Running](#running)
- [Testing](#testing)
- [Architecture](#architecture)

---

## Overview

Claw Task Service combines two core subsystems:

1. **Intent Engine** — A rule-based NLP pipeline that classifies free-text user messages into 11 intent categories (e.g., `create_task`, `query_status`, `modify_task`, `delete_task`, `schedule`, `debug`, `development`, `research`, `review`, `planning`, `other`). It supports multi-language input (Chinese + English), custom intent registration, LRU caching, structured logging, metrics collection, and LLM fallback for low-confidence cases.

2. **Task Manager** — A task entity model with a lifecycle state machine that enforces valid status transitions (`created → assigned → in_progress → completed/cancelled`), along with query and operation result types.

The service is designed to be embedded in the OpenClaw agent ecosystem, providing natural-language-driven task management.

---

## Tech Stack

| Component        | Technology                          |
|------------------|-------------------------------------|
| Language         | TypeScript 5.3 (ES2022, NodeNext)   |
| Runtime          | Node.js ≥ 20                        |
| HTTP Framework   | Express 4.18                        |
| Schema Validation| Zod 3.22                            |
| Dev Runner       | tsx 4.7                             |
| Test Runner      | tsx (custom assertion framework)    |
| Build            | tsc (TypeScript compiler)           |

No external NLP or ML dependencies — the intent engine is a pure TypeScript rule-based system with optional LLM fallback via OpenAI-compatible API.

---

## Project Structure

```
claw-task-service/
├── package.json                  # Project manifest (v2.5.0)
├── tsconfig.json                 # TypeScript config (ES2022, NodeNext)
├── .gitignore
├── docs/
│   └── phase2.5-integration-plan.md   # Phase 2.5 integration design doc
│
├── src/                          # Task Manager (core service)
│   └── task-manager/
│       ├── task-types.ts         # Task entity types, status, priority, query types
│       └── task-lifecycle.ts     # State machine: transition validation, lifecycle logger
│
├── intent-engine/                # Intent Classification Engine
│   ├── types.ts                  # Intent categories, entity types, rule types, result types
│   ├── patterns.ts               # 22 Chinese classification rules (44+ triggers)
│   ├── classifier.ts             # Core classifier (preprocess → rule match → disambiguate → score)
│   ├── pipeline.ts               # Integration pipeline (cache + metrics + LLM fallback)
│   ├── preprocessor.ts           # Text normalization (full-width, case, abbreviations, time)
│   ├── entity-extractor.ts       # Entity extraction (task_name, deadline, priority, assignee, etc.)
│   ├── disambiguation.ts         # 6-step conflict resolution strategy
│   ├── regex-pool.ts             # Pre-compiled RegExp cache for O(1) pattern matching
│   ├── lru-cache.ts              # LRU cache with FNV-1a hash (default 1000 entries, 5min TTL)
│   ├── metrics.ts                # Metrics collector (per-category, cache, errors, timeline)
│   ├── monitor.ts                # HTTP handlers for monitoring dashboard endpoints
│   ├── health.ts                 # Health check endpoint handler
│   ├── logger.ts                 # Structured JSON logger (DEBUG/INFO/WARN/ERROR)
│   ├── llm-fallback.ts           # LLM fallback classifier (OpenAI-compatible API)
│   ├── schema.json               # Intent classification JSON schema
│   ├── tsconfig.m5.json          # Separate tsconfig for i18n module
│   │
│   ├── custom-intent-types.ts    # Custom intent rule types and priority levels
│   ├── custom-intent-registry.ts # Runtime custom intent registration + hot-loading
│   │
│   ├── i18n/                     # Internationalization
│   │   ├── pattern-loader.ts     # Locale-aware pattern resolver (zh-CN default, en supported)
│   │   ├── en-patterns.ts        # English rule set (22 rules, functionally equivalent to Chinese)
│   │   └── m5-test.ts            # i18n test suite (12 cases: 6 Chinese + 6 English)
│   │
│   ├── test.ts                   # Phase 2.5 unit tests (20+ cases, all categories)
│   ├── perf-test.ts              # M1 performance benchmarks (cold-start vs hot-path)
│   ├── custom-intent-test.ts     # M2 custom intent tests (22+ cases)
│   └── m3-observability-test.ts  # M3 observability integration tests
│
└── tests/                        # Integration & E2E tests
    ├── integration-test.ts       # M6 full integration test (7 scenarios, 100+ assertions)
    └── phase25-integration-verify.js  # Phase 2.5 E2E accuracy verification (43 cases)
```

---

## Milestones (M1–M6)

The project follows a phased development roadmap. M1–M2 were implemented as part of Phase 3 infrastructure, and M3–M6 were delivered as separate milestones with dedicated git commits.

### M1 — Performance Optimization (2026-07-15)

- **LRU Cache Layer** (`lru-cache.ts`): O(1) get/set cache with FNV-1a 32-bit hash keys, configurable capacity (default 1000) and TTL (default 5 minutes).
- **RegExp Pre-Compilation Pool** (`regex-pool.ts`): Global RegExp cache eliminating per-call construction overhead. Up to 105 compiled patterns.
- **Performance Benchmark** (`perf-test.ts`): Cold-start vs hot-path latency benchmarks validating the < 1ms hot-path target.

### M2 — Custom Intent Extension (2026-07-17)

- **Custom Intent Types** (`custom-intent-types.ts`): Priority levels — `OVERRIDE`, `HIGH`, `NORMAL`, `LOW`, `BUILTIN`.
- **Custom Intent Registry** (`custom-intent-registry.ts`): Runtime registration, unregistration, enable/disable, hot-loading from JSON config, and priority queue management.
- **Test Suite** (`custom-intent-test.ts`): 22+ test cases covering registration, priority conflicts, hot-loading, unregistration, toggle, validation, and edge cases.

### M3 — Observability Integration (2026-07-20)

- **Metrics Collector** (`metrics.ts`): Per-category statistics (call count, hit rate, latency), cache metrics (hit/miss/eviction/expiration), error statistics, and in-memory timeline ring buffer.
- **Structured Logger** (`logger.ts`): JSON-formatted logs with four levels (DEBUG/INFO/WARN/ERROR), configurable via `LOG_LEVEL` environment variable.
- **Health Check** (`health.ts`): HTTP handler returning service status, uptime, version, and runtime statistics.
- **Monitor Dashboard API** (`monitor.ts`): HTTP handlers for `GET /monitor/stats` and `GET /monitor/timeline`.
- **Git commit:** `99eb00e` — `feat(M3): observability integration — metrics recording in pipeline + 40/40 tests pass + 48/48 regression pass`

### M4 — Task Entity & Lifecycle (2026-07-24)

- **Task Types** (`src/task-manager/task-types.ts`): `Task` entity with `TaskStatus` (6 states), `TaskPriority` (P0–P3), `TaskCategory` (7 types), query types, and operation result types. Defines `VALID_TRANSITIONS` state machine and `PRIORITY_WEIGHT` mapping.
- **Task Lifecycle** (`src/task-manager/task-lifecycle.ts`): State machine validator with `isValidTransition()`, `validateTransition()`, terminal status checks, convenience helpers (`canCancel`, `canComplete`, `canStart`, `canAssign`), and `LifecycleLogger` for audit trails.
- **Git commit:** `d4d0abd` — `feat(M4): task entity types + lifecycle state machine`

### M5 — i18n Framework (2026-07-21)

- **Pattern Loader** (`i18n/pattern-loader.ts`): Locale-aware rule resolution with `PatternLoader.resolve(locale)`. Falls back to `zh-CN` as default.
- **English Pattern Set** (`i18n/en-patterns.ts`): 22 English rules functionally equivalent to the Chinese rule set. Trigger words are natural English expressions, not literal translations.
- **Locale-Aware Classifier**: `classifyTextWithLocale(text, locale)` routes to the correct rule set.
- **Git commit:** `71268a6` — `feat(M5): i18n framework — English pattern set + locale-aware classifier`

### M6 — LLM Fallback & Integration Tests (2026-07-25)

- **LLM Fallback Classifier** (`llm-fallback.ts`): When regex confidence falls below threshold (default 0.5), calls an OpenAI-compatible LLM API (`POST http://localhost:28789/v1/chat/completions`). Includes 10s timeout, graceful degradation to regex results when LLM is unavailable, and configurable endpoint/model/threshold.
- **Full Integration Test** (`tests/integration-test.ts`): 7 scenarios with 100+ assertions covering end-to-end pipeline, Task Manager integration, multi-language classification, cache hit/miss, observability metrics, custom intent registration, and LLM fallback degradation.
- **Git commit:** `55949c8` — `feat(M6): LLM Fallback classifier + integration tests (7 scenarios, 571 lines)`

---

## Installation

### Prerequisites

- **Node.js** ≥ 20
- **npm** ≥ 10

### Steps

```bash
# Clone the repository
git clone <repo-url> claw-task-service
cd claw-task-service

# Install dependencies
npm install
```

### Dependencies

The `npm install` command will install:

- **Runtime:** `express`, `zod`
- **Dev:** `tsx`, `typescript`, `@types/express`, `@types/node`

---

## Running

### Type Check (no emit)

```bash
npm run check
```

Runs `tsc --noEmit` to validate TypeScript compilation without producing output files.

### Development Server

```bash
npm run dev
```

Runs the service via `tsx src/index.ts` with hot TypeScript transpilation.

### Production Build

```bash
npx tsc
node dist/index.js
```

Compiles to `dist/` and runs the compiled JavaScript.

---

## Testing

The project includes 6 test suites covering unit tests, performance benchmarks, observability, i18n, custom intents, and full integration.

### Run All Tests

```bash
# Phase 2.5 unit tests (20+ cases, all 6 intent categories)
npm test

# Phase 2.5 E2E accuracy verification (43 cases, target ≥ 60%)
npm run test:integration
```

### Individual Test Suites

```bash
# M1 — Performance benchmarks (cold-start vs hot-path latency)
npx tsx intent-engine/perf-test.ts

# M2 — Custom intent extension tests (22+ cases)
npx tsx intent-engine/custom-intent-test.ts

# M3 — Observability integration tests (metrics, health, monitor)
npx tsx intent-engine/m3-observability-test.ts

# M5 — i18n test suite (12 cases: 6 Chinese + 6 English)
npx tsx intent-engine/i18n/m5-test.ts

# M6 — Full integration tests (7 scenarios, 100+ assertions)
npx tsx tests/integration-test.ts

# Phase 2.5 — E2E accuracy verification (43 cases)
npx tsx tests/phase25-integration-verify.js
```

### Test Framework

Tests use a lightweight custom assertion framework (no external test runner dependency). The framework provides:

- `assert(condition, message)` — boolean assertion
- `assertEqual(actual, expected, message)` — deep equality via JSON serialization
- `assertApprox(actual, expected, delta, message)` — numeric approximation
- `assertTruthy(value, message)` / `assertFalsy(value, message)`
- `describe(name, fn)` — test grouping with console output

Results are printed to stdout with pass/fail counts and failure details. Exit code is `0` on all-pass, `1` on any failure.

---

## Architecture

### Intent Pipeline Flow

```
User Input
    │
    ▼
┌─────────────┐
│ Preprocessor │  Full-width → half-width, lowercase, tokenize, time detection
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  LRU Cache  │  FNV-1a hash lookup (O(1), 1000 entries, 5min TTL)
└──────┬──────┘
       │ cache miss
       ▼
┌─────────────────┐
│  Rule Engine     │  22 rules × 44+ triggers, pre-compiled RegExp pool
│  (patterns.ts)   │  Locale-aware (zh-CN default, en supported)
└──────┬──────────┘
       │
       ▼
┌─────────────────┐
│  Disambiguation  │  6-step strategy: priority → entities → density →
│                  │  specificity → negation → context
└──────┬──────────┘
       │ confidence < threshold (0.5)
       ▼
┌─────────────────┐
│  LLM Fallback    │  OpenAI-compatible API call, 10s timeout,
│  (optional)      │  graceful degradation to regex result
└──────┬──────────┘
       │
       ▼
┌─────────────────┐
│  Entity Extractor│  task_name, deadline, priority, assignee, status, category
└──────┬──────────┘
       │
       ▼
┌─────────────────┐
│  Metrics + Log   │  Per-category stats, cache metrics, timeline, JSON logger
└──────┬──────────┘
       │
       ▼
   IntentResult
   (category, subCategory, confidence, entities, alternatives, rationale)
```

### Task Lifecycle State Machine

```
created ──→ assigned ──→ in_progress ──→ completed
   │            │            │
   │            │            ├──→ on_hold ──→ in_progress
   │            │            │
   └──→ cancelled    └──→ cancelled
                         └──→ cancelled
```

Terminal states: `completed`, `cancelled` (no further transitions allowed).

### Intent Categories (11 total)

| Category        | Sub-categories                                              | Rules |
|-----------------|-------------------------------------------------------------|-------|
| `create_task`   | general, bugfix, feature, refactor, doc                     | 5     |
| `query_status`  | single, all, filtered, summary                              | 4     |
| `modify_task`   | deadline, priority, assignee, status, description           | 4     |
| `delete_task`   | single, cancel, archive                                     | 3     |
| `schedule`      | view, create, conflict, modify                              | 3     |
| `debug`         | crash, error_log, performance, data_issue, environment      | 3     |
| `development`   | feature_impl, bugfix, refactor, api_design, architecture    | 3     |
| `research`      | investigation, spike, comparison, documentation_lookup      | 3     |
| `review`        | code_review, design_review, pr_review, test_review          | 3     |
| `planning`      | sprint_planning, estimation, roadmap, task_breakdown        | 3     |
| `other`         | fallback                                                    | 1     |

### Configuration

The pipeline accepts a `PipelineConfig` with the following key options:

| Option                    | Default       | Description                              |
|---------------------------|---------------|------------------------------------------|
| `enableCache`             | `true`        | Enable LRU cache for classifications     |
| `cacheCapacity`           | `1000`        | Maximum cache entries                    |
| `cacheTtlMs`              | `300000`      | Cache TTL in ms (5 minutes)              |
| `enableLLMFallback`       | `false`       | Enable LLM fallback for low confidence   |
| `llmFallbackThreshold`    | `0.5`         | Confidence below this triggers LLM       |
| `enableEntityExtraction`  | `true`        | Extract entities in pipeline output      |
| `directExecutionThreshold`| `0.85`        | Min confidence for direct execution      |
| `maxAlternatives`         | `3`           | Max alternative intents to return        |

### Environment Variables

| Variable     | Default | Description                        |
|--------------|---------|------------------------------------|
| `LOG_LEVEL`  | `INFO`  | Log level: DEBUG, INFO, WARN, ERROR|

---

## License

Internal project — AI Engineering Team.
