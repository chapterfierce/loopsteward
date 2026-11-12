# API Reference — Claw Task Service

**Version:** 2.5.0 (Phase 3 M1–M11)
**Last Updated:** 2026-11-10

This document covers the in-process TypeScript APIs. The HTTP API is documented in [`../API.md`](../API.md).

---

## 目录

1. [Overview](#overview)
2. [Intent Classification API](#intent-classification-api)
3. [Intent Pipeline API](#intent-pipeline-api)
4. [Entity Extraction API](#entity-extraction-api)
5. [Date Parser API](#date-parser-api)
6. [i18n / Pattern Loader API](#i18n--pattern-loader-api)
7. [Language Detection API](#language-detection-api)
8. [Task Manager API](#task-manager-api)
9. [Cache Management API](#cache-management-api)
10. [Metrics & Monitoring API](#metrics--monitoring-api)
11. [Custom Intent API](#custom-intent-api)
12. [LLM Fallback API](#llm-fallback-api)
13. [Error Codes](#error-codes)
14. [Examples](#examples)

---

## Overview

All APIs are exported as TypeScript functions and classes. No HTTP server is required for core classification — the pipeline runs in-process. HTTP endpoints are provided by the monitoring module for observability only.

### Import Convention

```typescript
// Core classifier
import { classify, classifyText, classifyBatch } from './intent-engine/classifier.js';

// Pipeline (with cache + metrics)
import { classifyIntent, classifyIntentAsync } from './intent-engine/pipeline.js';

// Types
import { IntentResult, IntentRequest, TaskIntentCategory } from './intent-engine/types.js';
```

---

## Intent Classification API

### `classify(request: IntentRequest): IntentResult`

Classify a user message into task management intent categories.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `request.text` | `string` | ✅ | User's raw input text |
| `request.userId` | `string` | ❌ | Optional user identifier |
| `request.context` | `IntentContext` | ❌ | Context for disambiguation |
| `request.locale` | `string` | ❌ | Locale (e.g. `'en'`, `'zh-CN'`). Auto-detected if omitted. |

**Returns:** `IntentResult`

**Example:**

```typescript
const result = classify({
  text: '创建登录页重构任务',
  locale: 'zh-CN',
  context: { previousIntent: 'query_status' },
});

// result:
// {
//   category: 'create_task',
//   subCategory: 'general',
//   confidence: 1.0,
//   entities: [...],
//   alternatives: [],
//   rationale: 'Explicit task creation keyword detected',
//   ambiguous: false,
//   meta: {
//     processingTimeMs: 2,
//     inputLength: 9,
//     rulesEvaluated: 22,
//     rulesMatched: 3,
//     disambiguationTriggered: false,
//     contextUsed: false,
//     source: 'rule_engine',
//     locale: 'zh-CN',
//     localeSource: 'explicit'
//   }
// }
```

---

### `classifyText(text: string): IntentResult`

Quick classify with just text. Locale is auto-detected.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `text` | `string` | ✅ | User's raw input text |

**Returns:** `IntentResult`

```typescript
const result = classifyText('创建任务');
// result.category === 'create_task'
```

---

### `classifyTextWithLocale(text: string, locale: string): IntentResult`

Quick classify with text and explicit locale.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `text` | `string` | ✅ | User's raw input text |
| `locale` | `string` | ✅ | Locale string (e.g. `'en'`, `'zh-CN'`) |

**Returns:** `IntentResult`

```typescript
const result = classifyTextWithLocale('create a task', 'en');
// result.category === 'create_task'
// result.meta.locale === 'en'
```

---

### `classifyBatch(texts: string[], context?: IntentContext, locale?: string): IntentResult[]`

Classify multiple texts in batch.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `texts` | `string[]` | ✅ | Array of user input texts |
| `context` | `IntentContext` | ❌ | Shared context for all texts |
| `locale` | `string` | ❌ | Shared locale for all texts |

**Returns:** `IntentResult[]`

```typescript
const results = classifyBatch(['创建任务', '删除任务', '查看状态'], undefined, 'zh-CN');
// results.length === 3
```

---

### `debugClassify(text: string, locale?: string)`

Get detailed debugging information for a classification.

**Returns:**

```typescript
{
  input: string;
  locale: SupportedLocale;
  preprocessed: PreprocessResult;
  result: IntentResult;
  ruleDetails: Array<{
    ruleId: string;
    category: string;
    subCategory: string;
    matched: boolean;
    score: number;
    matchedKeywords: string[];
    conditions: Array<{ type: string; value: string; matched: boolean }>;
  }>;
  allRules: (typeof ruleDetails)[];
  regexPoolStats: { compiledCount: number; cacheHits: number; cacheMisses: number };
}
```

---

## Intent Pipeline API

### `classifyIntent(text: string, context?: IntentContext, config?: Partial<PipelineConfig>): PipelineResult`

Full pipeline classification with caching, metrics, and routing.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `text` | `string` | ✅ | User's raw input text |
| `context` | `IntentContext` | ❌ | Context for disambiguation |
| `config` | `Partial<PipelineConfig>` | ❌ | Pipeline configuration override |

**PipelineConfig Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enableEntityExtraction` | boolean | `true` | Extract entities in output |
| `enableDisambiguationLog` | boolean | `false` | Log disambiguation decisions |
| `directExecutionThreshold` | number | `0.70` | Min confidence for direct execution |
| `enableContext` | boolean | `true` | Enable context-aware classification |
| `maxAlternatives` | number | `3` | Max alternative intents to return |
| `enableCache` | boolean | `true` | Enable LRU cache |
| `cacheCapacity` | number | `1000` | Cache max entries |
| `cacheTtlMs` | number | `300000` | Cache TTL in ms (5 min) |
| `enableLLMFallback` | boolean | `false` | Enable LLM fallback |
| `llmFallbackThreshold` | number | `0.5` | Confidence below this triggers LLM |

**Returns:** `PipelineResult` (extends `IntentResult`)

| Field | Type | Description |
|-------|------|-------------|
| `...IntentResult` | — | All fields from IntentResult |
| `recommendedAction` | `ConfidenceAction` | Recommended action based on confidence |
| `routeHandler` | `string` | Route handler name (e.g. `'task.create'`) |
| `contextInfluenced` | `boolean` | Whether context affected the result |
| `pipelineVersion` | `string` | Pipeline version (`'3.0.0'`) |
| `cacheHit` | `boolean` | Whether result came from LRU cache |
| `llmFallbackUsed` | `boolean` | Whether LLM fallback was used |

---

### `classifyIntentAsync(text, context?, config?): Promise<PipelineResult>`

Async pipeline with LLM fallback support.

```typescript
const result = await classifyIntentAsync('页面崩溃了', undefined, {
  enableLLMFallback: true,
  llmFallbackThreshold: 0.5,
});
```

---

### `classifyAndRoute(text: string, context?: IntentContext)`

Classify and get route in one call.

**Returns:**

```typescript
{
  result: PipelineResult;
  handler: string;        // e.g. 'task.create'
  action: ConfidenceAction; // e.g. 'execute_directly'
}
```

---

### Route Handler Mapping

| Intent Category | Route Handler |
|-----------------|---------------|
| `create_task` | `task.create` |
| `query_status` | `task.query` |
| `modify_task` | `task.modify` |
| `delete_task` | `task.delete` |
| `schedule` | `schedule.manage` |
| `debug` | `dev.debug` |
| `development` | `dev.execute` |
| `research` | `dev.research` |
| `review` | `dev.review` |
| `planning` | `plan.manage` |
| `other` | `fallback.help` |

---

## Entity Extraction API

### `extractEntities(preprocessed: PreprocessResult): TaskEntity[]`

Extract structured entities from preprocessed text.

**Entity Types:**

| Type | Description | Example |
|------|-------------|---------|
| `task_name` | Task being referenced | `"登录页重构"` |
| `deadline` | Time constraints | `"下周五"`, `"2026-07-30"` |
| `priority` | P0-P3 priority levels | `"P0"`, `"紧急"` |
| `assignee` | Person assigned | `"@张三"`, `"转给张三"` |
| `status` | Target status | `"已完成"`, `"进行中"` |
| `category` | Task category | `"bug"`, `"feature"` |

**TaskEntity Structure:**

```typescript
interface TaskEntity {
  type: 'task_name' | 'deadline' | 'priority' | 'assignee' | 'status' | 'category';
  value: string;
  position: number;    // Start position in original text
  confidence: number;  // [0, 1]
}
```

---

## Date Parser API

### Chinese Date Parser

```typescript
import { parseChineseDate, extractChineseDates } from './intent-engine/i18n/date-parser-zh.js';

// Parse first date expression
const result = parseChineseDate('明天下午3点', new Date(2026, 6, 28));
// → { matched: '明天', isoDate: '2026-07-29', kind: 'tomorrow', confidence: 1.0 }

// Extract all date expressions
const all = extractChineseDates('今天开会，明天也有会', new Date(2026, 6, 28));
// → [{ matched: '今天', isoDate: '2026-07-28' }, { matched: '明天', isoDate: '2026-07-29' }]
```

### English Date Parser

```typescript
import { parseEnglishDate, extractEnglishDates } from './intent-engine/i18n/date-parser-en.js';

const result = parseEnglishDate('finish by next Monday', new Date(2026, 6, 28));
// → { matched: 'next Monday', isoDate: '2026-08-03', kind: 'next_weekday', confidence: 0.95 }
```

---

## i18n / Pattern Loader API

### `normalizeLocale(input: string | undefined | null)`

Normalize locale strings to supported locales.

```typescript
const { locale, recognized, fellBack } = normalizeLocale('en-US');
// → { locale: 'en', recognized: true, fellBack: false }
```

### `resolveRules(locale?: string): ClassificationRule[]`

Get all rules for a locale (unsorted).

### `resolveRulesByPriority(locale?: string): ClassificationRule[]`

Get rules sorted by priority descending.

### `getSupportedLocales(): SupportedLocale[]`

```typescript
getSupportedLocales(); // → ['zh-CN', 'en']
```

### `isLocaleSupported(locale: string): boolean`

```typescript
isLocaleSupported('en');    // → true
isLocaleSupported('fr');    // → false
```

### `PatternLoader` Class

Injectable pattern loader:

```typescript
const loader = new PatternLoader('en');
loader.getLocale();           // → 'en'
loader.getRules();            // → ClassificationRule[]
loader.getRulesByPriority(); // → sorted rules
loader.getStats();           // → { totalRules, totalTriggerWords, byCategory, categories }
loader.setLocale('zh-CN');   // switch locale
```

---

## Language Detection API

### `detectLanguage(text: string): LangDetectionResult`

```typescript
const result = detectLanguage('修复登录bug');
// → {
//   lang: 'mixed',
//   dominant: 'zh',
//   zhCount: 4,
//   enCount: 3,
//   zhRatio: 0.727,
//   enRatio: 0.273,
//   signalCount: 7
// }
```

### `detectLang(text: string): DetectedLang`

Convenience function returning just the language class:

```typescript
detectLang('create a task');     // → 'en'
detectLang('创建任务');           // → 'zh'
detectLang('修复bug');            // → 'mixed'
detectLang('12345');             // → 'unknown'
```

### `resolveRequestLocale(text: string, explicitLocale?: string): RouteResult`

```typescript
resolveRequestLocale('create a task');
// → { locale: 'en', source: 'detected' }

resolveRequestLocale('create a task', 'zh-CN');
// → { locale: 'zh-CN', source: 'explicit' }

resolveRequestLocale('12345');
// → { locale: 'zh-CN', source: 'fallback' }
```

---

## Task Manager API

### Task Entity

```typescript
interface Task {
  id: string;
  name: string;
  status: 'created' | 'assigned' | 'in_progress' | 'completed' | 'cancelled' | 'on_hold';
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  category: 'bug' | 'feature' | 'refactor' | 'doc' | 'optimization' | 'design' | 'test';
  assignee?: string;
  deadline?: Date;
  createdAt: Date;
  updatedAt: Date;
}
```

### Lifecycle State Machine

```
created ──→ assigned ──→ in_progress ──→ completed
   │            │            │
   │            │            ├──→ on_hold ──→ in_progress
   │            │            │
   └──→ cancelled    └──→ cancelled
                         └──→ cancelled
```

**Valid Transitions:**

| From | To |
|------|-----|
| `created` | `assigned`, `cancelled` |
| `assigned` | `in_progress`, `cancelled` |
| `in_progress` | `completed`, `on_hold`, `cancelled` |
| `on_hold` | `in_progress`, `cancelled` |
| `completed` | (terminal) |
| `cancelled` | (terminal) |

### Lifecycle Functions

```typescript
isValidTransition(from: TaskStatus, to: TaskStatus): boolean;
validateTransition(from: TaskStatus, to: TaskStatus): { valid: boolean; reason: string };
canCancel(status: TaskStatus): boolean;
canComplete(status: TaskStatus): boolean;
canStart(status: TaskStatus): boolean;
canAssign(status: TaskStatus): boolean;
```

---

## Cache Management API

### `getCacheStats(): CacheStats`

```typescript
const stats = getCacheStats();
// → {
//   size: 42,
//   capacity: 1000,
//   hits: 156,
//   misses: 42,
//   hitRate: 0.788,
//   evictions: 0,
//   expirations: 3
// }
```

### `clearCache(): void`

Clear all LRU cache entries.

### `resetCacheStats(): void`

Reset hit/miss/eviction counters (does not clear entries).

---

## Metrics & Monitoring API

### Metrics Collector

```typescript
import { metrics } from './intent-engine/metrics.js';

// Metrics are recorded automatically by the pipeline.
// Access snapshots:
metrics.getStats();
// → { totalClassifications, byCategory, cacheHits, cacheMisses, ... }
```

### Health Check Endpoint

```typescript
import { healthCheck } from './intent-engine/health.js';

// Returns: { status, uptime, version, stats }
```

### Monitor Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `GET /monitor/stats` | GET | Classification statistics |
| `GET /monitor/timeline` | GET | Recent classification timeline |

---

## Custom Intent API

### Register a Custom Intent

```typescript
import { CustomIntentRegistry } from './intent-engine/custom-intent-registry.js';

const registry = new CustomIntentRegistry();

registry.register({
  id: 'deploy-request',
  category: 'development',
  subCategory: 'feature_impl',
  priority: 'HIGH',
  conditions: [
    { type: 'keyword', value: 'deploy', weight: 1.0 },
    { type: 'keyword', value: '发布', weight: 0.9 },
  ],
  confidence: 0.85,
  minConfidence: 0.6,
  rationale: 'Deployment request detected',
});
```

### Custom Intent Priority Levels

| Level | Description |
|-------|-------------|
| `OVERRIDE` | Replaces built-in rule with same id |
| `HIGH` | Evaluated before built-in rules |
| `NORMAL` | Evaluated with built-in rules |
| `LOW` | Evaluated after built-in rules |
| `BUILTIN` | Built-in rule (cannot be overridden) |

---

## LLM Fallback API

### `LLMFallbackClassifier`

```typescript
import { LLMFallbackClassifier } from './intent-engine/llm-fallback.js';

const classifier = new LLMFallbackClassifier({
  endpoint: 'http://localhost:28789/v1/chat/completions',
  model: 'gpt-4',
  confidenceThreshold: 0.5,
  timeoutMs: 10_000,
  maxRetries: 0,
});

const result = await classifier.classify({ text: '页面崩溃了' });
// → IntentResult with meta.source === 'llm'
```

### Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `endpoint` | `string` | `http://localhost:28789/v1/chat/completions` | LLM API endpoint |
| `model` | `string` | (from env) | Model identifier |
| `confidenceThreshold` | `number` | `0.5` | Min confidence to accept LLM result |
| `timeoutMs` | `number` | `10_000` | Request timeout |
| `maxRetries` | `number` | `0` | Retry attempts |

### `fallbackToRegex(result, reason)`

Graceful degradation — returns the original regex result when LLM is unavailable.

---

## Error Codes

The service does not use numeric error codes. Instead, errors are communicated through:

### 1. Classification Fallback

When no rules match, the result is a fallback `other` intent:

```json
{
  "category": "other",
  "subCategory": "fallback",
  "confidence": 0.3,
  "rationale": "No classification rule matched the input",
  "meta": {
    "rulesMatched": 0,
    "source": "rule_engine"
  }
}
```

### 2. LLM Fallback Unavailable

When LLM is enabled but unavailable (timeout, network error, HTTP error):

```json
{
  "llmFallbackUsed": false,
  "rationale": "LLM Fallback 不可用或超时",
  "meta": {
    "source": "rule_engine"
  }
}
```

### 3. Invalid Task Transition

When attempting an invalid status transition:

```typescript
const result = validateTransition('completed', 'in_progress');
// → { valid: false, reason: "Cannot transition from 'completed' to 'in_progress'" }
```

### 4. Confidence-Based Actions

| Confidence Range | Action | Description |
|-------------------|--------|-------------|
| ≥ 0.85 | `execute_directly` | High confidence — execute without confirmation |
| 0.70 – 0.84 | `execute_with_log` | Medium confidence — execute with logging |
| 0.50 – 0.69 | `confirm_with_user` | Low confidence — ask user to confirm |
| 0.30 – 0.49 | `offer_alternatives` | Minimal confidence — show alternatives |
| < 0.30 | `fallback_help` | Below threshold — fallback to help |

### 5. LLM HTTP Error Codes

| HTTP Status | Behavior |
|-------------|----------|
| 200 | Success — parse LLM response |
| 401 | Unauthorized — return `null`, fallback to regex |
| 429 | Rate limited — return `null`, fallback to regex |
| 500 | Server error — return `null`, fallback to regex |
| Timeout | AbortError — return `null`, fallback to regex |
| Network error | Connection refused — return `null`, fallback to regex |

---

## Examples

### Example 1: Basic Classification

```typescript
import { classifyText } from './intent-engine/classifier.js';

const result = classifyText('帮我创建登录页重构任务');
console.log(result.category);     // 'create_task'
console.log(result.subCategory);  // 'general'
console.log(result.confidence);   // 1.0
console.log(result.entities);     // [{ type: 'category', value: '重构', ... }]
```

### Example 2: Pipeline with Cache

```typescript
import { classifyIntent, getCacheStats } from './intent-engine/pipeline.js';

// First call — cache miss
const r1 = classifyIntent('创建任务');
console.log(r1.cacheHit); // false

// Second call — cache hit
const r2 = classifyIntent('创建任务');
console.log(r2.cacheHit); // true

console.log(getCacheStats().hitRate); // 0.5
```

### Example 3: Multi-Language

```typescript
import { classifyText } from './intent-engine/classifier.js';

// Chinese — auto-detected
const zh = classifyText('创建一个新任务');
console.log(zh.meta.locale); // 'zh-CN'

// English — auto-detected
const en = classifyText('create a new task');
console.log(en.meta.locale); // 'en'

// Mixed zh-dominant
const mixed = classifyText('帮我deploy一下');
console.log(mixed.meta.locale); // 'zh-CN'
```

### Example 4: Batch with Locale

```typescript
import { classifyBatch } from './intent-engine/classifier.js';

const results = classifyBatch(
  ['create a task', 'delete this', 'show status'],
  undefined,
  'en'
);

for (const r of results) {
  console.log(`${r.category} (conf: ${r.confidence})`);
}
```

### Example 5: Entity Extraction

```typescript
import { preprocess, extractEntities } from './intent-engine/index.js';

const pre = preprocess('把截止时间改到周五下午3点');
const entities = extractEntities(pre);

// entities: [
//   { type: 'deadline', value: '周五', confidence: 0.9 },
//   { type: 'deadline', value: '3点', confidence: 0.8 },
//   { type: 'deadline', value: '下午', confidence: 0.8 },
//   { type: 'task_name', value: '把截止时间改到周五下午3点', confidence: 0.5 }
// ]
```

### Example 6: Async with LLM Fallback

```typescript
import { classifyIntentAsync } from './intent-engine/pipeline.js';

const result = await classifyIntentAsync('页面崩溃了', undefined, {
  enableLLMFallback: true,
  llmFallbackThreshold: 0.5,
});

if (result.llmFallbackUsed) {
  console.log('LLM classified this:', result.category);
} else {
  console.log('Regex classified this:', result.category);
}
```

### Example 7: Date Parsing

```typescript
import { parseChineseDate } from './intent-engine/i18n/date-parser-zh.js';

const now = new Date(2026, 6, 28); // 2026-07-28

// Relative
parseChineseDate('明天', now)?.isoDate;     // '2026-07-29'
parseChineseDate('3周后', now)?.isoDate;    // '2026-08-18'

// Absolute
parseChineseDate('8月20日', now)?.isoDate;  // '2026-08-20'
parseChineseDate('2026-12-01', now)?.isoDate; // '2026-12-01'

// Time of day
parseChineseDate('下午3点', now)?.isoDateTime; // '2026-07-28T15:00:00'
```

### Example 8: Debug Classification

```typescript
import { debugClassify } from './intent-engine/classifier.js';

const debug = debugClassify('创建任务');
console.log(debug.preprocessed.tokens);    // ['创', '建', '任', '务', ...]
console.log(debug.allRules.length);          // 22
console.log(debug.ruleDetails);              // matched rules with scores
console.log(debug.regexPoolStats);          // { compiledCount: 105, ... }
```
