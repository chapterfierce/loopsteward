# LoopSteward（守环）

> 并行 AI 会话的开放循环追踪器

[![CI](https://github.com/chapterfierce/loopsteward/actions/workflows/ci.yml/badge.svg)](https://github.com/chapterfierce/loopsteward/actions/workflows/ci.yml)

用 AI 处理事务时，等待时间会让人不断开新会话。话题一散，真正有价值的未完成事项就容易被遗忘。LoopSteward 从 Codex、Claude Code、Qoder、ZCode、WorkBuddy、Hermes、DSH、Antigravity 等 Agent 的本地会话里提取未闭环事项，存进本机 SQLite，再通过 skill 在之后的工作会话里回访。

它不会自动替你关闭事项，也不会把你的会话上传到第三方服务。提取只调用你配置的 OpenAI 兼容模型端点。

## 安装

需要 Node.js ≥ 22.15。

```bash
npm install -g loopsteward
loopsteward --help
loopsteward setup
```

`setup` 会做三件事：

- 探测本机已安装的 Agent，只把 skill 和会话入口规则装到存在的目录。
- 一个 Agent 都没探测到时跳过并提示，不会创建空目录。
- 最后跑一次 `loopsteward doctor`，报告数据库、skill、策略和构建状态。

也可以分步安装：

```bash
loopsteward install-skill              # 默认只装探测到的 Agent
loopsteward install-policy             # 会话开始自动回访的规则
loopsteward install-mcp                # 只写已存在的 MCP 客户端
```

显式指定 Agent 时，目录不存在会直接报错，不会自动创建：

```bash
loopsteward install-skill --agents codex,claude
loopsteward install-policy --agents codex,claude,hermes
loopsteward install-mcp --agents codex,claude,cursor
```

## 配置模型

提取只需要一个 OpenAI 兼容的 `POST {baseURL}/chat/completions` 端点。没有内置地址或模型，必须显式配置：

```bash
export LOOPSTEWARD_BASE_URL="https://api.openai.com/v1"
export LOOPSTEWARD_MODEL="gpt-4o-mini"
export LOOPSTEWARD_API_KEY="<your key>"
```

PowerShell：

```powershell
$env:LOOPSTEWARD_BASE_URL = "https://api.openai.com/v1"
$env:LOOPSTEWARD_MODEL = "gpt-4o-mini"
$env:LOOPSTEWARD_API_KEY = "<your key>"
```

数据默认写入用户数据目录：

- Windows：`%LOCALAPPDATA%\LoopSteward\loops.db`
- macOS：`~/Library/Application Support/LoopSteward/loops.db`
- Linux：`~/.local/share/loopsteward/loops.db`

用 `LOOPSTEWARD_DATA` 覆盖，或在单条命令里传 `--db <path>`。

## 快速开始

首次摄入最近 7 天会话：

```bash
loopsteward ingest --days 7 --limit 120 --concurrency 4
```

看当前回访摘要：

```bash
loopsteward digest
loopsteward digest --skill        # skill 可直接原样展示的版本
loopsteward digest --review --limit 15 --skill
```

Windows 上可以注册每 2 小时后台刷新：

```bash
loopsteward setup --schedule --ingest
```

回访后的常用回复：

- `1 忘了` / `2 噪音` / `3 已完成`
- `做第 3 条`
- `周回顾` / `继续看` / `看待确认`
- `只看完成证据` / `只看我的`

## 工作方式

1. **采集**：只读本地会话文件或 SQLite，默认取最近 7 天、已静置 30 分钟的会话尾部。
2. **提取**：调用你配置的模型，只提取未完成任务、未解决 bug、承诺的下一步和待拍板决定。来源消息必须通过白名单校验。
3. **回访**：skill 读取预生成的本地缓存，在会话开始展示最多 3 条；7 天没做完整周回顾时，额外带 1 条旧库存预览。
4. **闭环**：`loopsteward reconcile` 用后续会话证据列出“可能已完成”，默认只读；用户确认后才关闭。

提取前会对每条消息做脱敏，私钥、URL 内嵌密码、Bearer、常见 token、JWT、`api_key` / `password` / `token` 赋值都会替换为 `[REDACTED]` 后再发送给模型，也以脱敏形式入库。

## 常用命令

```bash
loopsteward sessions --days 7 --limit 120
loopsteward list --status open
loopsteward list --project "<项目目录>" --status all
loopsteward pending --limit 10
loopsteward projects --days 7 --limit 500
loopsteward show --ref <code>
loopsteward update --ref <code> --status resolved --note "已处理"
loopsteward update --refs <code1>,<code2> --status snoozed --snooze-hours 24
loopsteward feedback --ref <code> --verdict forgotten --note "确实忘了"
loopsteward closing --limit 10 --json
loopsteward reconcile --days 7 --limit 120
loopsteward reconcile --days 7 --limit 120 --apply --min-confidence 0.9
loopsteward stats --days 30
loopsteward doctor --json
loopsteward coverage --days 7 --limit 500
loopsteward audit --stale-days 14
loopsteward backup --json
loopsteward restore --backup data/archive/loops-20261111.db --dry-run
loopsteward redact --db data/loops.db
```

`update` 和 `feedback` 的批量 `--refs` 是全有或全无：任一 ref 未知或有歧义就整批不写。`resolved` 必须由用户明确确认，不能因为“展示过很多次”就自动关闭。

## MCP（只读）

包内附带 stdio MCP server，暴露四个只读工具，全部 `readOnlyHint: true`：

| 工具 | 用途 |
|------|------|
| `loops_context` | 指定项目最多 3 条未闭环事项 |
| `loops_search` | 按文本、状态、项目搜索 |
| `loops_get` | 按 ref 取详情和来源消息摘录 |
| `loops_closing` | 已展示但未关闭的循环，有完成证据的优先 |

配置客户端：

```bash
loopsteward install-mcp --dry-run --json
loopsteward install-mcp
loopsteward install-mcp --uninstall
```

默认只写已存在的 Codex / Claude / Cursor 配置。也可以直接运行 `loopsteward-mcp --db <path>`。完整协议见 [docs/MCP.md](docs/MCP.md)。

## 支持的 Agent

已接入 8 类 Agent、10 条本地会话链路：

- Codex
- Claude Code
- Claude Desktop Code / Cowork
- Qoder
- ZCode
- WorkBuddy
- Hermes
- DeepSeek Harness（DSH）
- Antigravity（CLI）

各 Agent 的会话根目录、过滤规则和已知限制不同，细节见源码 `src/loops/session-source.ts`。子代理、cron、空会话等会按策略排除，不算漏读。

## 可选集成

- **Windows 计划任务**：`loopsteward setup --schedule` 注册 `OpenLoopsRefresh`，每 2 小时刷新缓存。非 Windows 平台跳过，可用 cron 自行调度 `loopsteward ingest`。
- **MCP 客户端**：Codex、Claude Code、Cursor 可只读查询本机循环。

## 数据与隐私

- 所有数据默认只落本机 SQLite，不上传云端。
- 发给模型前先脱敏；入库也保存脱敏后的文本。
- MCP 层只读，不提供创建、修改、关闭或反馈工具。
- `redact --apply` 可清理存量库，执行前会自动备份。
- `backup` 使用 `VACUUM INTO` 生成一致性快照，并做 `PRAGMA integrity_check`。

## 限制

- 提取依赖模型质量；低置信度条目进入待确认，不占热区。
- 只读取会话尾部与部分相关历史，不保证覆盖整段超长会话。
- skill 只有被模型选中时才执行；要保证每个新会话自动回访，需要 `install-policy`。
- 默认窗口是 7 天；更早的会话需要显式调大 `--days`。
- 不会自动关闭事项；`reconcile` 只给候选，确认后才写状态。

## 从源码开发

```bash
git clone https://github.com/chapterfierce/loopsteward.git
cd loopsteward
npm install
npm run build:open-loops
npm link
loopsteward --help
```

常用校验：

```bash
npm run check
npm test
npm run release:check
```

`release:check` 串联类型检查、全量测试、构建、包验证和旧套件。发布流程见 [docs/RELEASE_PROCESS.md](https://github.com/chapterfierce/loopsteward/blob/main/docs/RELEASE_PROCESS.md)。

## License

MIT
