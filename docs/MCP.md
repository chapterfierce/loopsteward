# LoopSteward MCP Server

MCP phase 1：只读接入。服务通过 stdio 暴露三个工具，复用现有 `LoopStore`、`buildDigest`、`buildLoopDetail`，不新增数据库 schema，也不提供任何写工具。

## 启动

```bash
npm run build
node dist/src/mcp/server.js --db data/loops.db
```

不传 `--db` 时使用 `resolveDefaultDbPath()`：仓库检出使用 `data/loops.db`，全局安装使用用户数据目录。

服务器只把协议消息写到 stdout；诊断信息写 stderr，避免破坏 JSON-RPC 流。

## 工具

### `loops_context`

返回指定项目最多 3 条未闭环事项。`projectDir` 省略时使用 MCP server 的工作目录。

```json
{
  "projectDir": "C:\\Users\\me\\Desktop\\repo",
  "limit": 3
}
```

返回 `project`、`loops[]`、`total`。每条 loop 包含 `id`、`ref`、`title`、`status`、`confidence`、`projectName`、`projectDir`、`nextAction`、`why`、`firstSeen`、`lastSeen`。

### `loops_search`

按标题、下一步和原因做大小写不敏感搜索，可按状态和项目过滤。

```json
{
  "query": "webhook",
  "status": "open",
  "project": "C:\\repo",
  "limit": 20
}
```

`status` 可选 `open`、`pending`、`snoozed`、`resolved`、`dropped`、`all`，默认 `all`；`limit` 上限 100。

### `loops_get`

按稳定 ref 取一条 loop 的详情和来源消息摘录。ref 来自 digest 的 `[ref xxxxxxxx]`，也接受唯一的 loop id 前缀。

```json
{
  "ref": "a555ebf3",
  "limit": 12
}
```

返回 `ref`、`loop`、`signals[]`、`missingSignalIds`、`omittedSignalCount`、`latestFeedback`。找不到 ref 或 ref 有歧义时返回 `isError: true`；歧义结果附带 `matches[]`，不会任选一条。

## 只读保证

- `loops_context` 调用 `buildDigest({ markSurfaced: false })`，不写 `last_surfaced_at`、presentation 或每日预算。
- `loops_search` 只调用 `LoopStore.listLoops()`。
- `loops_get` 只调用 `LoopStore.findLoopsByRef()` 和 `buildLoopDetail()`。
- 服务器不注册 create / update / close / feedback 工具。
- 工具清单中的每个工具都带 `annotations.readOnlyHint: true`。

## 安装到客户端

```bash
npm run loops:install-mcp -- --json
```

默认写入：

| 客户端 | 文件 |
|--------|------|
| Codex | `~/.codex/config.toml` |
| Claude Code | `<当前项目>/.mcp.json` |
| Cursor | `~/.cursor/mcp.json` |

可用参数：

- `--dry-run`：只报告动作，不写文件。
- `--uninstall`：只移除 `loopsteward` 条目，保留其他 MCP server。
- `--agents codex,claude,cursor`：限定客户端。
- `--project-dir <dir>`：改变 Claude 项目级 `.mcp.json` 的位置。
- `--codex-config`、`--claude-config`、`--cursor-config`：显式指定文件。
- `--server-path`、`--node-command`：覆盖 server 路径和启动命令。

合并规则：

- JSON 按 key 合并，保留顶层其他 key 和 `mcpServers` 里的其他 server。
- TOML 只替换 `[mcp_servers.loopsteward]` 表，保留其他表、注释和键。
- 文件无效时拒绝覆盖并返回 `action: "error"`。
- 有改动时先在同目录写 `.bak-<时间>` 备份。

生成的条目形如：

```json
{
  "mcpServers": {
    "loopsteward": {
      "command": "node",
      "args": ["C:\\path\\to\\dist\\src\\mcp\\server.js"]
    }
  }
}
```

```toml
[mcp_servers.loopsteward]
command = "node"
args = ["C:\\path\\to\\dist\\src\\mcp\\server.js"]
```

## 非目标

- M2 的类型化 ledger 不在本阶段。
- M3 的 closing ceremony 不在本阶段。
- 本阶段不写回 Magpie，不修改 loop 状态，不生成反馈。
