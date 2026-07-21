# Claw Task Service Phase 2.5 集成方案

> 文档版本：v1.0  
> 创建日期：2026-07-09  
> 作者：AI工程组

---

## 1. 集成目标

Phase 2.5 是 Claw Task Service 从独立服务向平台化演进的关键过渡阶段。核心目标如下：

### 1.1 业务目标

- **统一任务编排**：将 Phase 2 中分散的任务创建、分配、执行、回调流程整合为统一编排管线，支持多步骤任务链。
- **外部系统对接**：完成与飞书日历、腾讯会议、IM 通知渠道的双向集成，实现任务生命周期事件的外部触达与回写。
- **子任务派发能力**：支持主任务拆解为子任务并并行派发至不同执行器（agent / 外部 API / 人工节点），聚合结果后统一回调。

### 1.2 技术目标

- **接口标准化**：定义任务服务的 REST + WebSocket 双协议接口规范，对外提供稳定的 API 契约。
- **解耦中间件**：引入消息队列（Redis Streams）作为任务事件总线，解除任务创建与任务执行之间的同步耦合。
- **可观测性增强**：集成结构化日志 + 链路追踪（trace-id 贯穿创建→分配→执行→回调全链路）。

### 1.3 范围边界

| 在范围内 | 不在范围内 |
|---------|-----------|
| 任务编排引擎 v1 | 分布式调度（Phase 3） |
| 飞书/腾讯会议适配器 | 第三方 SaaS 开放接入 |
| 子任务并行执行 + 结果聚合 | 跨集群任务迁移 |
| 事件总线（Redis Streams） | 持久化任务存储迁移至 PG |
| 回调重试与死信处理 | 任务优先级队列 |

---

## 2. 接口定义

### 2.1 REST API

#### 2.1.1 创建任务

- **方法**：`POST /api/v2.5/tasks`
- **请求体关键字段**：
  - `task_type`：任务类型（single / composite / scheduled）
  - `priority`：优先级（low / normal / high）
  - `payload`：任务载荷（JSON，按 task_type 不同有不同 schema）
  - `subtasks`：子任务定义数组（仅 composite 类型）
  - `callback_url`：回调地址
  - `metadata`：扩展元数据
- **响应**：`201 Created`，返回 `task_id`、`status`、`created_at`

#### 2.1.2 查询任务状态

- **方法**：`GET /api/v2.5/tasks/{task_id}`
- **响应**：任务详情，包含 `status`、`subtasks[]`（含各自状态）、`result`、`timeline`

#### 2.1.3 取消任务

- **方法**：`POST /api/v2.5/tasks/{task_id}/cancel`
- **行为**：主任务标记为 cancelling，递归取消未完成的子任务，已完成的子任务不回滚。

#### 2.1.4 任务回调（供执行器调用）

- **方法**：`POST /api/v2.5/tasks/{task_id}/callback`
- **请求体**：`subtask_id`、`status`、`result`、`error`
- **行为**：更新子任务状态，检查是否全部子任务完成，如是则触发主任务聚合逻辑并回调 `callback_url`。

#### 2.1.5 外部事件入站

- **方法**：`POST /api/v2.5/events/inbound`
- **用途**：接收飞书日历变更、腾讯会议状态等外部事件，转化为任务事件注入事件总线。
- **请求体**：`source`（feishu / tencent_meeting / im）、`event_type`、`payload`、`signature`

### 2.2 WebSocket API

#### 2.2.1 任务状态推送

- **端点**：`WS /api/v2.5/ws/tasks`
- **订阅模式**：客户端发送 `{ "action": "subscribe", "task_ids": ["..."] }`
- **推送消息**：任务状态变更时推送 `{ "task_id", "status", "changed_at", "detail" }`
- **心跳**：客户端每 30s 发送 ping，服务端 60s 无响应则断开。

### 2.3 事件总线消息格式

所有内部事件通过 Redis Streams 发布，消息体为 JSON：

| 字段 | 说明 |
|------|------|
| `event_id` | 全局唯一事件 ID（UUID v4） |
| `trace_id` | 链路追踪 ID |
| `event_type` | task.created / task.assigned / task.completed / task.failed / task.cancelled |
| `task_id` | 关联任务 ID |
| `subtask_id` | 关联子任务 ID（可空） |
| `timestamp` | 事件产生时间（ISO 8601） |
| `payload` | 事件载荷 |
| `retry_count` | 重试计数 |

---

## 3. 依赖项

### 3.1 内部依赖

| 组件 | 当前版本 | 要求 | 说明 |
|------|---------|------|------|
| Task Core Engine | v2.0 | 升级至 v2.5 | 增加编排引擎模块 |
| Auth Service | v1.2 | 保持 | 提供 API 鉴权 |
| User Service | v1.5 | 保持 | 提供执行器路由所需的用户信息 |

### 3.2 外部依赖

| 组件 | 用途 | 集成方式 |
|------|------|---------|
| Redis ≥ 7.0 | 事件总线 + 缓存 | Redis Streams + Pub/Sub |
| 飞书开放平台 | 日历事件同步、消息通知 | Webhook + REST API |
| 腾讯会议 API | 会议创建/状态查询 | REST API |
| OpenClaw Agent Runtime | 子任务执行器 | 内部 gRPC 调用 |

### 3.3 前置条件

- Redis 7.0+ 已部署且网络可达
- 飞书应用已创建，具备 calendar:read、im:message 权限
- 腾讯会议企业应用已创建，具备会议管理 API 权限
- TLS 证书已配置（外部 Webhook 回调需要 HTTPS）

---

## 4. 实施步骤

### 阶段一：事件总线搭建（预计 3 天）

1. **Redis Streams 初始化**：创建 task-events stream、consumer group（task-orchestrator、task-callback-handler、external-adapter）。
2. **事件发布/消费封装**：实现 EventPublisher（发布）和 EventConsumer（消费）两个基础组件，包含序列化、重试、死信队列写入。
3. **trace-id 透传**：在事件消息中嵌入 trace-id，确保创建→执行→回调全链路可追踪。

### 阶段二：任务编排引擎（预计 5 天）

4. **复合任务模型实现**：实现主任务-子任务的数据模型与状态机。状态机定义如下：
   - 主任务：`pending → running → aggregating → completed / failed / cancelled`
   - 子任务：`pending → assigned → running → completed / failed / cancelled`
5. **子任务派发器**：根据 subtask 定义中的 `executor_type`（agent / external_api / manual），将子任务分发至对应执行器。
6. **结果聚合器**：监听子任务完成事件，当所有子任务终态后触发聚合策略（all_success / any_success / majority），产出主任务结果。

### 阶段三：外部适配器（预计 4 天）

7. **飞书适配器**：实现飞书日历事件监听（Webhook 接收 → 签名验证 → 转化为 inbound event）和消息通知发送（task.completed → 发送飞书消息卡片）。
8. **腾讯会议适配器**：实现会议创建（task 创建时若含会议需求则调用腾讯会议 API）和会议状态回写（会议结束 → 回调 task callback）。
9. **IM 通知适配器**：将任务关键事件（分配、完成、失败）推送至配置的 IM 群组。

### 阶段四：API 层与 WebSocket（预计 3 天）

10. **REST API 实现**：按接口定义实现全部 REST 端点，包含输入校验、鉴权、错误处理。
11. **WebSocket 网关**：实现 WebSocket 端点，订阅事件总线中的任务状态变更事件并推送给已连接客户端。
12. **API 文档生成**：基于接口定义生成 OpenAPI 3.0 规范文档。

### 阶段五：回调与可靠性（预计 2 天）

13. **回调重试机制**：回调失败时按指数退避重试（1s / 5s / 30s / 2min / 10min），最多 5 次。
14. **死信处理**：重试耗尽后写入死信队列，提供手动重放接口 `POST /api/v2.5/admin/deadletter/replay`。
15. **幂等保障**：回调接口基于 `event_id` 做幂等去重，防止重复消费。

### 阶段六：集成测试与验收（预计 3 天）

16. **端到端测试场景**：
    - 场景 A：创建复合任务 → 子任务并行执行 → 全部成功 → 聚合回调
    - 场景 B：创建任务 → 飞书日历同步 → 会议结束触发任务完成
    - 场景 C：子任务部分失败 → 聚合策略判定 → 主任务失败 → 通知 IM
    - 场景 D：任务执行中取消 → 子任务递归取消 → 回调通知
17. **性能基线测试**：单实例下 100 TPS 任务创建、500 并发 WebSocket 连接稳定性。
18. **文档验收**：确认 API 文档、部署手册、运维 runbook 完整。

---

## 5. 验收标准

### 5.1 功能验收

| 编号 | 验收项 | 验收标准 |
|------|--------|---------|
| F-01 | 复合任务创建 | 创建 composite 类型任务返回 task_id，子任务列表完整 |
| F-02 | 子任务并行执行 | 多个子任务可同时分配至不同执行器，互不阻塞 |
| F-03 | 结果聚合 | 所有子任务终态后 5s 内完成聚合并回调 |
| F-04 | 任务取消 | 取消请求后 3s 内所有未完成子任务进入 cancelled 状态 |
| F-05 | 飞书日历同步 | 任务创建后 10s 内飞书日历出现对应日程 |
| F-06 | 腾讯会议集成 | 含会议需求的任务创建后会议链接返回在 task result 中 |
| F-07 | IM 通知 | 任务完成/失败事件 5s 内送达配置的 IM 群组 |
| F-08 | WebSocket 推送 | 任务状态变更后 2s 内 WebSocket 客户端收到推送 |
| F-09 | 回调重试 | 回调失败后按指数退避重试，最多 5 次 |
| F-10 | 死信重放 | 死信队列中的消息可通过 admin API 手动重放 |

### 5.2 非功能验收

| 编号 | 验收项 | 验收标准 |
|------|--------|---------|
| NF-01 | 链路追踪 | 任意任务可通过 trace-id 追踪完整生命周期 |
| NF-02 | 幂等性 | 同一 event_id 重复回调不会产生副作用 |
| NF-03 | 性能基线 | 单实例 100 TPS 任务创建，P99 延迟 < 200ms |
| NF-04 | WebSocket 稳定性 | 500 并发连接下 30min 无异常断开 |
| NF-05 | 错误处理 | 所有外部 API 调用有超时、重试、降级处理 |
| NF-06 | 日志规范 | 结构化 JSON 日志，包含 trace-id、task-id、event-type |

### 5.3 交付物清单

- [ ] API 接口文档（OpenAPI 3.0）
- [ ] 事件总线消息格式文档
- [ ] 部署手册（含 Redis、飞书/腾讯会议配置项）
- [ ] 运维 Runbook（常见故障处理、死信重放流程）
- [ ] 集成测试报告

---

## 6. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 飞书/腾讯会议 API 限流 | 外部事件丢失 | 实现令牌桶限流器 + 事件缓冲队列 |
| Redis Streams 消费积压 | 任务状态延迟 | 监控 lag 指标，积压超阈值告警 + 自动扩容 consumer |
| 子任务执行器不可用 | 任务卡死 | 设置子任务超时时间，超时自动标记 failed |
| 回调目标不可达 | 回调失败堆积 | 重试 + 死信 + 人工重放，回调积压告警 |

---

## 7. 时间线总览

| 阶段 | 内容 | 工期 | 里程碑 |
|------|------|------|--------|
| 一 | 事件总线搭建 | 3 天 | M1: 事件收发可用 |
| 二 | 任务编排引擎 | 5 天 | M2: 复合任务可运行 |
| 三 | 外部适配器 | 4 天 | M3: 飞书/会议/IM 打通 |
| 四 | API + WebSocket | 3 天 | M4: 接口对外可用 |
| 五 | 回调与可靠性 | 2 天 | M5: 回调重试+死信就绪 |
| 六 | 集成测试 | 3 天 | M6: 验收通过 |

**总工期：20 个工作日（4 周）**

---

*本文档为 Phase 2.5 集成方案，实施过程中如有变更需更新文档版本并通知相关方。*
