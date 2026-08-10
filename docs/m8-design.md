# M8 — Webhook Notifications & Rate Limiting

**Status:** Proposed  
**Author:** AI架构师 (小算)  
**Date:** 2026-08-10  
**Milestone:** Phase 3 M8

---

## 背景与目标

**已有能力（M1-M7, M9-M11）：**
- M1 性能优化（M3 缓存、Regex 池）
- M2 自定义意图扩展（热加载）
- M3 可观测性（Metrics/Log/Health/Tracing）
- M4 任务实体 + 状态机（M4）
- M5 国际化（zh-CN + en）
- M6 LLM Fallback
- M7 持久化层（SQLite + 分页查询）
- M9 量化模拟器
- M10 Prometheus Metrics API
- M11 熔断器

**最大缺口：** 服务已具备完整的内部能力，但**对外部系统完全无感知**。TaskManager 状态变更后没有任何外部通知机制，也没有 API 层面的流量防护（熔断器 M11 保护的是 LLM fallback，不是 HTTP 流量本身）。

**M8 目标：** 让 claw-task-service 成为一个对外部系统"有输出"的活跃服务节点——Webhook 驱动外部系统联动，Rate Limiting 保护自身不被滥用。

---

## 目标

1. **Webhook 通知**：任务创建/状态变更/删除时，自动向已注册的 URL 发送 HTTP POST 通知。
2. **Rate Limiting**：基于 IP + API Key 的滑动窗口限流，防止滥用和保护下游。
3. **可观测性增强**：Webhook 投递指标 + Rate Limit 命中指标入 Prometheus /metrics。

---

## 接口设计

### Webhook 注册与查询

```
POST /api/v1/webhooks              — 注册 Webhook（URL + 触发事件类型）
GET  /api/v1/webhooks              — 列出所有 Webhook
GET  /api/v1/webhooks/:id          — 获取单个 Webhook
DELETE /api/v1/webhooks/:id        — 删除 Webhook
```

**POST /api/v1/webhooks 请求体：**
```json
{
  "url": "https://notify.example.com/hook",
  "events": ["task.created", "task.status_changed", "task.deleted"],
  "secret": "optional-hmac-secret",
  "metadata": { "channel": "ops-alerts" }
}
```

**事件类型：**
- `task.created`
- `task.status_changed`
- `task.deleted`
- `task.lifecycle.invalid_transition`

**Webhook 投递请求体：**
```json
{
  "id": "evt-xxxx",
  "event": "task.status_changed",
  "timestamp": "2026-08-10T12:00:00.000Z",
  "data": {
    "task": { "id": "task-xxx", "title": "...", "status": "completed", ... },
    "previousStatus": "in_progress",
    "actor": "auto-assign on create"
  }
}
```
带 `X-Claw-Signature: sha256=<hmac>` header（当 secret 非空时）。

**Webhook 投递规则：**
- 异步投递，不阻塞主请求。
- 超时 5s，失败最多重试 3 次（指数退避：1s, 2s, 4s）。
- 重试队列在进程内存中（重启丢失，可接受）。

### Rate Limiting

```
GET  /api/v1/ratelimit/status      — 查询当前限流状态
```

**限流维度（滑动窗口，60s 窗口）：**
| 维度 | 限制 | 说明 |
|------|------|------|
| IP | 100 req/min | 未认证请求 |
| API Key | 1000 req/min | 带 `X-API-Key` header |
| 全局 | 5000 req/min | 所有请求 |

**Rate Limit Response Header（所有响应均带）：**
```
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 847
X-RateLimit-Reset: 1374567890
```
**触发限流时：**
- HTTP 429 Too Many Requests
- `Retry-After: 60`（秒）

### 内置健康检查增强

```
GET /healthz/extended              — 扩展健康检查（含 Redis/DB 连接状态）
```

---

## 数据结构

### Webhook 配置存储（InMemoryStore 或 SQLite M7）

```typescript
interface WebhookConfig {
  id: string;
  url: string;
  events: WebhookEventType[];
  secret?: string;       // HMAC 密钥，不返回给 GET
  metadata: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface WebhookDelivery {
  id: string;
  webhookId: string;
  event: WebhookEventType;
  payload: object;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  lastAttemptAt?: string;
  responseCode?: number;
  error?: string;
}

type WebhookEventType =
  | 'task.created'
  | 'task.status_changed'
  | 'task.deleted'
  | 'task.lifecycle.invalid_transition';
```

### Rate Limit 滑动窗口

```typescript
interface RateLimitBucket {
  key: string;          // ip:xxx 或 key:xxx
  requests: number[];
  // sliding window: 过滤掉 60s 之前的请求
}
```

---

## 验收标准

- [ ] `POST /api/v1/webhooks` 创建 Webhook 成功
- [ ] 任务状态变更触发 Webhook 投递（验证实际 HTTP POST 到达）
- [ ] 带 secret 的 Webhook 投递含正确 HMAC 签名
- [ ] Webhook 投递失败时正确重试（可 mock URL 验证）
- [ ] 全局 Rate Limit 100/min 触发 429（压测工具）
- [ ] IP Rate Limit 正确计入 IP
- [ ] API Key 限流独立于 IP 限流
- [ ] `X-RateLimit-*` header 在所有响应中正确返回
- [ ] `npx tsx tests/m8-webhook-test.ts` 全部通过
- [ ] `npx tsc -b --noEmit` 0 errors
- [ ] Prometheus `/metrics` 包含 `webhook_deliveries_total` 和 `ratelimit_hits_total` 指标

---

## 工作量估算

| 模块 | 估算 |
|------|------|
| WebhookStore（内存 + 持久化接口）| 2h |
| WebhookService（投递 + 重试队列）| 3h |
| TaskManager → Webhook 集成点 | 1h |
| RateLimitMiddleware（滑动窗口）| 2h |
| HTTP API（/api/v1/webhooks + /api/v1/ratelimit）| 1h |
| Prometheus 指标集成 | 1h |
| 测试套件（mock HTTP + 限流边界）| 3h |
| 文档 + 代码审查 | 1h |
| **总计** | **~14h（2 人天）** |
