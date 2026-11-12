# LoopSteward（守环）

> Open Loops tracker for parallel AI sessions

LoopSteward（守环）是并行 AI 会话的开放循环追踪器。它从 Codex、Claude Code、Claude Desktop（Code/Cowork）、Qoder、ZCode、WorkBuddy、Hermes、DeepSeek Harness（DSH）、Antigravity（CLI）的最近会话尾部提取未闭环事项，落到本机 SQLite，通过 skill 在之后的工作会话里回访，并用独立核对命令关闭已经完成的事项。

**Version:** 2.9.0
**Status:** Open Loops M1–M152 + MCP phase 1 (read-only) complete; package and global-install path verified; legacy HTTP task service deprecated

---

## Table of Contents

- [Overview](#overview)
- [MCP（只读）](#mcp只读)
- [Open Loops（主线）](#open-loops主线)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Legacy Milestones (M1–M11)](#legacy-milestones-m1m11)
- [Installation](#installation)
- [Running](#running)
- [Testing](#testing)
- [Architecture](#architecture)

---

## Overview

当前主线是 Open Loops，解决“并行开很多 AI 会话，有价值但未闭环的事被遗忘”的问题：

1. **采集** — 只读各 Agent 的本地会话库/JSONL，默认取最近 7 天、已静置 30 分钟的会话尾部。
2. **提取** — 调用本机 Magpie 模型，只提取未完成任务、未解决 bug、承诺的下一步和待拍板决定；来源消息必须过白名单。
3. **回访** — `skills/open-loops` 在会话开始展示最多 3 条；7 天没做完整周回顾时，首批额外带 1 条活动窗口外的旧库存预览，不占这 3 条预算；每日 3 条用完后，“今天提过”摘要仍会带最多 1 条近期核对出的“可能已完成”，不占预算，同一候选 24 小时内不重复；用户明确回答“确实忘了”的条目还会跨项目补 1 条，不占预算，同一条 24 小时内不重复；周回顾展示 10–20 条，真实项目优先、临时会话最多 5 条，页脚把临时工作区收成一行，每条只给标题、置信度、挂起天数和 ref，要细节再按 ref 查，说“继续看”翻下一批并显示本轮剩余条数，看完才回卷，说“看待确认”单独看把握不高的一页，说“做第 N 条”可直接让当前 Agent 接着做这条的下一步；周回顾开头会单列用户明确回答“确实忘了”的条目，不占 15 个名额；后台每 2 小时刷新缓存。
4. **闭环** — `loops:reconcile` 用后续会话证据列出“已完成”候选，默认只读，确认后才关闭。

**回复方式**（看到回访后直接说）：

- `1 忘了` / `2 噪音` / `3 已完成`：记录判断或关闭。
- `做第 3 条`：让当前 Agent 接着做这条的下一步，做完再问你关不关。
- `周回顾` / `继续看` / `看待确认`：看全量清单、翻页、看低把握项。

旧 HTTP 任务服务（Express + 规则式意图引擎 + 任务 CRUD）仍保留在仓库里，但已不是入口，也没有真实消费者；生产镜像只打包 Open Loops，旧服务和 express 都不进镜像。

---

## MCP（只读）

MCP phase 1 提供 stdio MCP server，让 Codex、Claude Code、Cursor 通过 MCP 读取本机 Open Loops。只暴露四个工具，全部 `readOnlyHint: true`，不提供创建、修改、关闭、反馈或写回访记录的工具。

| 工具 | 用途 | 参数 |
|------|------|------|
| `loops_context` | 返回指定项目最多 3 条未闭环事项 | `projectDir?`、`limit?`（上限 3） |
| `loops_search` | 按文本、状态、项目搜索 | `query?`、`status?`、`project?`、`limit?` |
| `loops_get` | 按稳定 ref 取详情和来源消息摘录 | `ref`、`limit?` |
| `loops_closing` | 列出已展示但未关闭的循环，按展示次数排序 | `projectDir?`、`limit?`（默认 10，上限 20） |

先构建，再直接运行：

```bash
npm run build
npm run mcp -- --db data/loops.db
```

安装到本机客户端配置（非破坏合并，改前备份）：

```bash
npm run loops:install-mcp -- --json
npm run loops:install-mcp -- --dry-run --json
npm run loops:install-mcp -- --uninstall --json
```

默认目标：Codex `~/.codex/config.toml`、Claude 当前项目 `.mcp.json`、Cursor `~/.cursor/mcp.json`。可用 `--project-dir`、`--codex-config`、`--claude-config`、`--cursor-config` 覆盖；`--agents codex,claude,cursor` 限定客户端。详细协议说明见 `docs/MCP.md`。

这一层不改变现有数据库 schema，不写回访、展示、反馈或循环状态；`loops_closing` 只读展示「已展示但未关闭」的清单，真正关闭仍需用户确认。

---

## Open Loops（主线）

跟踪并行 AI 会话里未闭环、容易被遗忘的事项。数据只落本机：会话尾部 → Magpie 模型提取 → SQLite → skill 回访。

统计会忽略晚于当前时间的展示记录，`doctor` 会单独提示；确认是测试或导入数据后，用 `loops:presentations -- --apply` 清理，默认 dry-run。这样测试数据或系统时钟回拨不会把成功率抬高。

已接入 8 类 Agent、10 条本地会话链路：Codex、Claude Code、Claude Desktop Code、Claude Desktop Cowork、Qoder、ZCode、WorkBuddy、Hermes、DeepSeek Harness（DSH）、Antigravity（CLI）。Claude Desktop Code 的 transcript 仍在 `~/.claude/projects`；Cowork 的 transcript 在 `%LOCALAPPDATA%\Claude-3p\local-agent-mode-sessions\...\.claude\projects\session\*.jsonl`，只接入 `userSelectedFolders` 绑定了真实项目目录的会话，纯闲聊不进入项目回访。ZCode 读 `~/.zcode/cli/db/db.sqlite`，WorkBuddy 读 `~/.workbuddy/projects/*/*.jsonl`，Hermes 读 `%LOCALAPPDATA%\hermes\state.db`，DSH 读 `~/.dsh/sessions/*/*/session.v4.jsonl.zstd`，Antigravity 读 `~/.gemini/antigravity-cli/conversation_summaries.db`，并从 `brain/<uuid>/.system_generated/logs/transcript_full.jsonl` 解析用户输入与助手回复。Hermes 只取顶层用户会话，排除 cron、subagent 和 oneshot；DSH 只取顶层会话，`parentSession/delegationDepth` 标记的子代理跳过，goal 模式的 objective 去重后作为用户意图保留；Antigravity 跳过子会话、嵌套会话和没有助手回复的半截会话。home 目录下的 Hermes/DSH/Antigravity 会话会拆成独立临时工作区，避免不同话题被合并成一个项目。默认覆盖最近 7 天最多 120 个会话，避免新增来源把较早但仍未闭环的事项挤掉。Codex 侧边聊天和分页续写会复用主会话 `session_id`、各自写成 rollout 文件；摄入按 `session_id` 合并内容，标题保留最早的主片段，带 `parent_thread_id` 的子代理仍排除。侧聊没有独立会话 id，不能单独按会话回访。

会话标题如果是助手口吻（例如以“我没有…”“你指的是…”开头），展示名会回退到真实用户请求；`未命名会话` 只作占位，不伪造项目名。

Cowork 数据根目录可用 `--claude-desktop-root` 覆盖；默认从 `%LOCALAPPDATA%` 推导。

```bash
npm run loops:sessions -- --days 7 --limit 120
npm run loops:ingest -- --days 7 --limit 120 --concurrency 4
npm run loops:list -- --status open
npm run loops:list -- --project "<项目目录>" --status all
npm run loops:pending -- --limit 10
npm run loops:digest -- --json
npm run loops:digest -- --skill
npm run loops:digest -- --no-mark
npm run loops:digest -- --recap-cooldown-minutes 60
npm run loops:digest -- --revisit-days 3
npm run loops:digest -- --force
npm run loops:digest -- --project "<项目目录>"
npm run loops:digest -- --no-project-focus
npm run loops:digest -- --review --limit 15
npm run loops:digest -- --review --limit 15 --skill
npm run loops:projects -- --days 7 --limit 500
npm run loops:coverage -- --days 7 --limit 500
npm run loops:reconcile -- --days 7 --limit 120 --concurrency 4
npm run loops:reconcile -- --days 7 --limit 120 --refresh
npm run loops:reconcile -- --days 7 --limit 120 --cache-days 30
npm run loops:reconcile -- --days 7 --limit 120 --apply --min-confidence 0.9
npm run loops:stats -- --days 30
npm run loops:doctor -- --json
npm run loops:presentations -- --json
npm run loops:audit -- --stale-days 14
npm run loops:audit -- --stale-days 14 --apply-weak
npm run loops:audit -- --stale-days 14 --apply-self-generated
npm run loops:show -- --ref <code>
npm run loops:show -- --match "错误提示"
npm run loops:update -- --ref <code> --status resolved --note "已处理"
npm run loops:update -- --id <loop_id> --status resolved --note "已处理"
npm run loops:update -- --match "错误提示" --status resolved --note "已处理"
npm run loops:update -- --refs <code1>,<code2> --status snoozed --snooze-hours 24
npm run loops:update -- --shown --status snoozed --snooze-hours 24
npm run loops:feedback -- --ref <code> --verdict forgotten --note "确实忘了"
npm run loops:feedback -- --refs <code1>,<code2> --verdict forgotten --note "这几条都有用"
npm run loops:feedback -- --match "错误提示" --verdict forgotten --note "确实忘了"
npm run loops:update -- --refs <code1>,<code2> --status resolved --note "确认完成"
npm run loops:backup -- --json
npm run loops:restore -- --backup data/archive/loops-20261111.db --dry-run --json
npm run loops:install-skill
```

`ingest` 默认并发 4 个会话；12 个会话实测 22.4 秒，并发上限可用 `--concurrency` 调整。

回访入口是 `skills/open-loops/SKILL.md`，已同步到 Codex、Claude Code、Qoder、WorkBuddy、Hermes、Antigravity 的 skills 目录。安装器会把当前包根写入 skill 里的命令路径，所以全局安装不依赖仓库检出。它只读缓存，不在会话里现场跑模型。

skill 也内置了只读健康检查：用户问“为什么回访不更新/本地是否正常”时，会调用 `doctor --json`，报告数据库、摄入、反馈、周回顾轮次、缓存、构建产物、归档和 skill 副本状态。`dist` 缺失或比 `src` 里的 TypeScript 源码旧时，会直接提示运行 `npm run build`。

回访入口在 Windows PowerShell 5.1、7 和 Git Bash 下都实测可执行；skill 统一用 `powershell -File` 调用 `scripts/open-loops.ps1`，脚本自己固定 UTF-8 输出，避免 `cmd /c` 在 Git Bash 里被路径转换、或终端代码页把中文弄坏。正文保持纯 ASCII，只读降级提示由 CLI 输出。只读回退不写回访时间，但会按本地日期轮转候选，避免每天重复同一批 3 条。

热区默认每个自然日最多回访 3 条，避免一天开很多会话时反复推新条目；`--daily-limit <n>` 可改上限（`0` 关闭），`--force` 只绕过本次上限，周回顾不受影响。同一自然日内 3 条用完后不再推新条目，但会重提这 3 条还没判断的条目，不占新预算，避免后续并行会话只看到“明天再继续”。如果还有用户明确回答“确实忘了”的条目，摘要会额外带 1 条跨项目确认项，不占预算，同一条 24 小时内不重复；30 分钟 recap 节流时也保留这条兜底。普通 `digest` 和 `digest --skill` 走同一套重提逻辑，不会只在 skill 入口显示。周回顾里，用户明确回答“确实忘了”的条目会单独成区，排在普通 15 条之前，不占轮转名额，也不计入页脚待确认数。跨到第二天会重新计算预算；条目和项目都按上次回访时间轮转，没回访过的先出，回访过的排到队尾，避免同一批高置信度条目或大项目天天占满名额。

当新条目足够填满 3 条时，热区会先给用户已经回答“确实忘了 / 挺有用”的条目保留 1 个名额，再按 `--revisit-days`（默认 3 天）轮到期的旧条目。新条目不足 3 条时，剩余名额自然回填旧条目，不浪费每日预算；24 小时冷却仍是硬下限。用户确认过有用的条目即使所在项目超过 3 天没有新会话，也会继续留在热区候选池，直到关闭或标噪音；输出里会标“已确认有用”，避免把跨项目提醒误认为新事项。额度用完后，确认项会以“你确认忘了 · 跨项目”单独补 1 条，不受当前项目过滤，仍受 snooze 和噪音约束。周回顾先排真实项目，只有会话标题、没有真实目录的工作区后置补位，避免 Hermes/Qoder/ZCode 会话把真实项目挤出 15 个名额；用户确认忘了的条目另起一区，不占普通名额。

如果 7 天内没有做过周回顾，当天第一批新条目末尾会额外带 1 条“本周回顾”旧库存：优先选活动窗口外、从未回访过、挂得最久的条目，24 小时内不重复；它不占热区 3 条预算，也不会在 recap 里重复。这个预览只解决“旧事项永远排不到”的触达问题，完整周回顾仍按“周回顾”查看。每条热区条目第一次出现就带“若已完成，直接说关闭这条”，页脚同时给出“已完成 / 确实忘了 / 噪音”三个出口；CLI 只负责提示和定位，不会自动替用户关闭。

会话开始时，`scripts/open-loops.ps1` 会把调用方当前目录传给 CLI，回访优先展示当前项目的未闭环：当前项目有足够条目时最多拿 3 个名额，但存在到期复访时会保留 1 条给旧事项；不足 3 条再补其他项目。当前项目没有到期条目时会在开头说明“本项目暂无可回访条目”，不会把别的项目伪装成本项目。唯一例外是用户明确确认“确实忘了”的跨项目条目：额度用完后会单独补 1 条，并标明来源项目。`--project <dir>` 可显式指定项目，`--no-project-focus` 恢复原来的全局排序；周回顾始终是全局回顾，不受当前目录影响。

每日新条目用完后，recap 也只重提当前项目今天已经提过的条目；本项目今天没有提过，就只留一行说明，不再把别的项目塞进来。说明里的数字是本项目未闭环数，不是全局库存。30 分钟 recap 节流从“全局任何一次 recap”改成“与本次条目有重叠才算”，在 A 项目看过的 recap 不会压住 B 项目的 recap。

同一批条目在 30 分钟内被任一并行会话再次触发时（即使中间穿插了其他项目的 recap），`digest --skill` 只输出一行式标题、项目与 ref，不重复“下一步/为什么”，也不写新的展示记录，避免把节流本身当成一次回访、把冷却窗口无限续期；判断依据是这批条目里任意一条在冷却期内被 recap 过，而不是只看最近一条 recap 记录。30 分钟后恢复完整重提。窗口可用 `--recap-cooldown-minutes <n>` 调整，`0` 关闭；节流输出不再重复“校准提示”，完整重提和周回顾仍保留。节流只减少重复文案，不代表用户已读或已判断，反馈和关闭入口不变。同一循环连续 3 次出现在 recap / candidate / teaser 里且没有更新证据时，会自动 snooze 7 天；有新证据则从 1 重新计数，周回顾不计入这套疲劳计数。用户最新一条反馈是“确实忘了”的条目不计入自动疲劳 snooze，避免把用户明确要跟的事项静默压掉；用户手动 snooze 仍然生效。

换机或重装后，用安装器同步 skill；它会先备份旧版本，只复制 `SKILL.md`，自动把会重复加载的嵌套 `open-loops\open-loops\SKILL.md` 移出扫描路径，并按当前包根重写命令路径。全局安装、仓库改名后不会继续指向旧目录。

```powershell
npm run loops:install-skill -- --all --json
npm run loops:install-skill -- --agents codex,claude,qoder,workbuddy,hermes,antigravity --json
```

`--all` 只装到本机已检测到的 Agent；`--agents` 可指定子集。默认不带参数时仍只装 Codex，保持兼容。实际安装位置：

```powershell
~/.codex/skills/open-loops/SKILL.md
~/.claude/skills/open-loops/SKILL.md
~/.qoder/skills/open-loops/SKILL.md
~/.workbuddy/skills/open-loops/SKILL.md
%LOCALAPPDATA%/hermes/skills/open-loops/SKILL.md
~/.gemini/config/skills/open-loops/SKILL.md
```

命令会校验安装副本的 SHA256；目标已是最新时显示 `unchanged`，不会重复覆盖。

skill 只在被模型选中时才会执行；要保证每个新工作会话都自动回访一次，再安装会话入口策略：

```powershell
npm run loops:install-policy -- --agents codex,claude,zcode,dsh,antigravity,hermes --json
npm run loops:install-policy -- --dry-run --json
npm run loops:install-policy -- --uninstall --json
```

它把一段带 `open-loops` 标记的规则写进 Codex `~/.codex/AGENTS.md`、Claude `~/.claude/CLAUDE.md`、ZCode `~/.zcode/AGENTS.md`、DSH `~/.dsh/AGENTS.md`、Antigravity `~/.gemini/config/GEMINI.md`、Hermes `SOUL.md`，只管理标记之间的内容，重复执行幂等；改前在同目录留 `.bak-<时间>` 备份，`--uninstall` 只移除这段规则。策略明确要求先把回访摘要原样作为开场，再回答用户当前的请求；摘要不是最终回答，不能只打印清单独占一轮。策略块带 `open-loops-policy:v2` 标记，doctor 的“会话入口策略”一项会检查这些文件是否已安装、是否仍指向当前仓库路径，以及规则版本是否过旧。

`loops:reconcile` 默认只读：它把最近会话与已有循环对照，列出“看起来已经完成”的候选；加 `--apply` 才会关闭，默认置信度门槛 0.9。核对默认并发 4 个会话（`--concurrency` 可调，上限 16），并把未变会话的结果缓存在 SQLite；同一批会话第二次核对会直接命中缓存，`--refresh` 强制重查并写回新结果。缓存默认保留 30 天（`--cache-days` 可调），核对结束时自动清理过期行；缓存指纹同时覆盖尾部消息与长历史，历史单独变化也会重查。长会话不只看最后几条消息：核对会保留尾部，并从更早的历史里检索与当前循环相关、或带明确状态更新的消息，避免几小时前的完成证据被后续对话挤出窗口；该历史检索已覆盖全部八类 Agent，数据库类在核对时取“最近 500 条 + 最早 200 条”，日常摄入仍只取 20 条。核对输出只接受输入消息里的证据 ID；Qoder 这类带 `assistant:` 前缀的 ID 会做保守别名映射，无法映射的单项证据会被丢弃，保留仍有有效证据的候选。周回顾会附带最多 3 条最近 24 小时内核对出的“可能已完成”，只作提示，不会自动关闭；后台刷新每天最多跑一次核对，失败只记日志，不阻断摄入。`loops:stats` 输出完成率、中位关闭耗时、首次展示等待、展示后关闭数、窗口内反馈有效率和陈旧未闭环；同时区分“展示过”和“成功标记回访”，只读会话的展示不会丢。项目分布按 `projectDir` 归组，避免同名项目串账；文本只展开真实项目，临时会话工作区汇总成一行，JSON 保留 `sessionOnly` 标记和 `projectSummary` 汇总。

热区当天第一批新条目也会附带最多 1 条“可能已完成”：优先当前项目，证据置信度至少 0.9，且不会和已经展示的 3 条重复。它只给 ref、标题、置信度和依据，确认后才关闭；没有候选就不显示。

`loops:doctor` 是只读健康检查：一次核对数据库 integrity 与循环/信号计数、最近摄入新鲜度、真实反馈样本、周回顾轮次进度、核对缓存保留期、备份归档体积、Windows 后台刷新任务状态、6 个 Agent 的 skill 副本哈希，以及 Codex/Claude/ZCode/DSH/Antigravity 的会话入口策略。存在阻塞性问题时退出码为 1；只有告警时仍为 0。`loops:presentations` 默认只列出晚于当前时间的展示记录；加 `--apply` 才会删除，执行前应先跑 `loops:backup`。

`loops:feedback` 记录用户对回访质量的明确判断：`forgotten` 表示这条确实被忘了，`noise` 表示误报或不需要跟。反馈只追加，不改循环状态；`noise` 会在出现更新证据前压掉这条回访，新证据到达后自动恢复。新证据只取候选实际引用消息的有效时间，空时间戳、时区偏移和同一项目里的无关会话活动都不会把旧循环的 `lastSeen` 推新；历史库首次打开会自动回填一次证据时间，摘要写入 `schema_meta`。`loops:stats` 同时报历史反馈和最近窗口内的反馈；没有样本时 `usefulRate` / `usefulRateInWindow` 为 `null`，不会把“还没样本”算成 0%。

当累计回访达到 10 条、真实反馈仍是 0 时，每日上限后的回访和周回顾末尾会多一行“校准提示”，引导做 5 条抽样校准；给出第一条真实判断后自动消失。它只提示，不写反馈、不改变排序。

`loops:calibrate` 生成一份 5 条校准清单：优先选从未回访过的条目，按项目分散，跳过已判断和暂停中的循环；不写回访时间、不影响每日预算。skill 收到“校准回访”时直接运行 `calibrate --limit 5 --json`，不再从 digest JSON 里自行挑条目。

`loops:closing` 是收尾清单：只列已经展示过、但仍 open/pending 的循环，按展示次数降序、最近展示时间升序，默认 10 条。它只读，不改状态、不写展示记录；用户回“完成 / 稍后 / 不要了”后，skill 按 ref 批量更新。没说的一律保持原状，展示次数多不等于已完成。

每条回访末尾都会显示一个稳定的短编号 `[ref xxxxxxxx]`；用户回“1 确实忘了 / 2 噪音”时，按那条的 ref 用 `feedback --ref <code>` 或 `update --ref <code>` 定位。ref 取自循环 id 的前 8 位十六进制，跨 digest、跨并行会话都不变；另一个会话重新跑 digest 不会把它指到别的条目。`--index` 仍保留，但它只指向最近一次展示记录，48 小时后过期，适合单会话内的快速回复；`--ref`、`--index`、`--id`、`--match` 互斥。

用户说“今天先别提醒 / 晚点再说”时，优先用 `loops:update -- --refs <code1>,<code2> --status snoozed --snooze-hours 24` 暂停刚才看到的条目。同一批回访也可以批量记判断或批量关闭：`feedback -- --refs ... --verdict forgotten`、`update -- --refs ... --status resolved`；所有 `--refs` 命令都是全有或全无，任一 ref 不存在或有歧义就整批不写。批量“有用”只记反馈，不等于完成，不会关闭条目。默认暂停 24 小时，不写反馈、不算噪音，也不改变 `usefulRate`，到期后条目会重新参与回访。`--shown` 仍保留为兜底，但它只作用于最近一次 digest，并行会话下可能暂停到另一批。到期后的条目在读取层按 `open` 处理，统计和项目积压不会再把它们算作暂停中；数据库行会在下一次写入时顺带清理。

循环的首见/末见时间带来源标记：`first_seen_source`、`last_seen_source` 为 `message` 时代表引用消息的真实 min/max，为 `session` 时代表会话时间兜底。后续同一信号升级出真实消息时间后，合并会按证据重算边界，不会让兜底值把区间钉死。

同一循环收到更新证据时，标题、下一步和原因会刷新到最新候选（候选置信度 ≥0.6）；旧会话重放、没有更新证据时不会覆盖已有描述。提取输出超长时按句子或分句边界截断，避免停在“、”中间；存量条目不会自动重写，等新证据到达或人工关闭。

`loops:projects` 列出最近 N 天所有活跃项目，包含“没有未闭环”的项目；会话数按同一时间窗口统计，不是累计值。真实项目与只有会话标题的临时工作区分开显示，临时工作区最多展开积压最大的 5 个，其余汇总 open/pending，不把两者混成一个“项目”计数。自身没有 open/pending 循环、且至少包含两个活跃子项目目录的工作区容器（例如 `C:\Users\you\Desktop\project`）不单独算一个项目；它一旦自己产生未闭环，会重新出现在列表里。周回顾的 `digest` 也会附带最近 7 天活跃项目，避免只看有循环的项目而漏掉“最近在做但没提取出待办”的项目。

热区按项目积压排序，并在项目名后标出该项目全部未闭环数量（例如“未闭环共 23 条”），避免只看到 1 条就误以为项目只剩这一件事。需要看某个项目的全部积压时，先用 `loops:projects -- --json` 找到 `projectDir`，再运行 `loops:list -- --project "<projectDir>" --status all`；查看库存不会写入 `lastSurfacedAt`。

`loops:coverage` 是只读体检：读取 Magpie 本地会话索引 `~/.cache/magpie/sessions.json`，与本地实际发现的会话按 Agent + sessionId 对照，区分“已支持但本地漏读”和“尚未接入的 Agent”。Codex subagent、ZCode side chat、Hermes cron/subagent、DSH subagent/空会话、WorkBuddy 只有错误消息的会话、Antigravity 没有助手回复的半截会话会按策略过滤，不当作漏读。它只报覆盖情况，不写库、不生成循环；漏读列表是待核对线索，不等于内容一定丢失。

`loops:audit` 默认只读：列出弱证据（来源只有“继续”“好”等确认语）、自摄入（来源全部是追踪器自己生成的 `# 今天提过` / `# 每周回顾` / `# 回访` / `# 回访校准` / `# 开放循环审计` 摘要）、缺少来源、挂得过久、重复候选和无法稳定识别的项目名。弱证据按 open/pending 分开计数，降级后不会再把 pending 误读成仍在热区。审计按来源拆成 user / assistant / mixed，并单列“助手来源”：这类循环的证据只有助手消息，未经用户确认，不等于用户任务。提取时，如果某条循环的所有来源都只是确认语，会自动把置信度降到 0.55，进入待确认，不占热区；助手自己的进度汇报、测试计数、反馈计数、提交状态（如“仍为 0”“只到 M65”“未提交”“全绿”）不会被当成新的未闭环事项，除非同一段话里明确写出未完成动作或待拍板决定。存量条目可显式加 `--apply-weak` 降级为 pending；`--apply-self-generated` 只丢弃自摄入循环，两者都不会动正常用户事项。`stats` 会把自摄入清理单独计数，不把它算成用户闭环。`sessionOnlyProjects` 是 Qoder/ZCode/WorkBuddy/Hermes/DSH/Antigravity 没有真实项目目录、只能用会话标题命名的工作区，属于已知限制，不是脏数据。

`loops:pending` 是只读的待确认首页：默认 10 条，按置信度降序、首次出现升序，每条只给标题、置信度、项目和 ref；JSON 同时给 `total`、`shown`、`noiseSuppressed`。用户明确把某条标为噪音后，它立即从待确认页消失，等出现更新证据才自动回来；反馈仍只追加，不改状态。

`loops:show` 用 `--ref`、`--id`、`--index` 或唯一标题匹配查看单条循环的时间线、回访状态和来源消息；`--limit` 控制最多展示几条证据，默认 12。关闭前先看证据，不确定就继续保留。

`loops:digest` 的 JSON 包含 `activeTotal`、`eligibleTotal`、`coolingDown`、`reviewPick`，以及 M96 的 `revisitDays`、`revisitReady`、`revisitWaiting`、`confirmedIds`，周回顾还包含 `reviewConfirmed`。`reviewPick` 是本周回顾预览的那 1 条旧库存，没有时省略；`revisitReady` 是已到期、可参与复访的条数；`revisitWaiting` 是回访过但还没到 3 天节奏的条数；`confirmedIds` 是最新反馈为 `forgotten` 的活跃条目；`reviewConfirmed` 是周回顾单独区里的确认项。当条目都在 24 小时冷却中时，输出会说明“今天已回访过”，不再误报“没有需要回访的循环”。

`loops:digest -- --skill` 直接输出 skill 可原样展示的最终文案：热区条目、下一步、反馈邀请、每日上限原因和“最近活跃”行都由 CLI 生成，会话模型不再自行拼字段。文件库使用 SQLite `DELETE` 日志模式，Codex 只读沙箱可以直接读取，不需要创建 WAL 的 `-shm` 侧文件。

后台刷新：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/refresh-open-loops.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-refresh-task.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-refresh-task.ps1 -Uninstall
```

安装脚本会注册 Windows 计划任务 `OpenLoopsRefresh`，每 2 小时跑一次；卸载用最后一条命令。

每轮刷新会先跑摄入；随后如果当天还没有 `data/logs/reconcile-YYYY-MM-DD.log`，会跑一次只读核对并把候选写入该日志，失败只记 `reconcile failed`，不阻断本轮刷新。之后只在 CLI 产物缺失、或 `src` 下有源码比 `dist/src/loops/cli.js` 新时才重新构建，源码没变会跳过构建并写入日志。如果当天还没有 `data/archive/loops-YYYYMMDD.db`，会顺手生成一份当日快照，并自动只保留最近 30 份每日快照。

备份用 `npm run loops:backup`：它通过 SQLite `VACUUM INTO` 生成一致性快照，默认写到 `data/archive/loops-<时间>.db`，并对副本执行 `PRAGMA integrity_check`。`--out` 可指定路径，目标已存在时拒绝覆盖；加 `--keep 30` 会统一清理旧的自动备份（`loops-YYYYMMDD.db` 和 `loops-YYYYMMDD-HHMMSS.db`），不会碰带语义标签的迁移备份或手工备份。

恢复用 `npm run loops:restore -- --backup <path> [--db data/loops.db] [--dry-run] [--json]`：先校验备份的 `integrity_check` 和 Open Loops 表结构，再给当前库做一份 `loops-before-restore-<时间>.db` 安全备份，最后用同目录临时文件原子替换。当前库损坏时会保留为 `*.corrupt-<时间>` 而不是静默覆盖；`--dry-run` 只报告目标、条数和计划中的安全备份路径，不改文件。恢复是单文件替换，不合并两份库。

脱敏用 `npm run loops:redact -- [--db <path>] [--apply] [--keep <n>] [--json]`（全局安装后为 `loopsteward redact`）：新写入的会话文本在入库前会先去掉私钥块、URL 内嵌密码、Bearer、OpenAI/GitHub/Slack/AWS token、JWT，以及 `api_key` / `password` / `token` 这类赋值。存量库默认只预览命中条数；`--apply` 会先做一致性备份，再改写 signals、循环标题/下一步/原因和已关闭备注，`--keep` 控制备份保留数。

默认窗口：热区 3 天、活跃 7 天；会话开始最多 3 条，周回顾 10–20 条；低置信度只进待确认。未闭环不会因为超过 30 天没有新证据而被丢掉：项目重新活跃时老循环会回到热区，周回顾不设时间门槛、也不受热区 24 小时冷却限制。热区和周回顾都优先没回访过、挂得更久的循环，避免高置信度条目或大项目长期占住名额；周回顾额外把真实项目排在会话工作区之前。

---

## Tech Stack

| Component        | Technology                          |
|------------------|-------------------------------------|
| Language         | TypeScript 5.3 (ES2022, NodeNext)   |
| Runtime          | Node.js ≥ 22.15 (node:sqlite + zstd) |
| HTTP Framework   | Express 4.22（仅旧服务，devDependency，不进生产镜像） |
| Dev Runner       | tsx 4.7                             |
| Test Runner      | Vitest 4 + tsx                      |
| Build            | tsc (TypeScript compiler)           |

Open Loops 不引入新的运行时依赖：SQLite 用 `node:sqlite`，模型只走本机 Magpie 网关。

---

## Project Structure

```
claw-task-service/
├── src/
│   ├── loops/                    # 会话采集、提取、SQLite、回访、核对、统计、质量审计
│   ├── magpie/                   # Magpie memory/distill 只读接入
│   ├── index.ts                  # 旧 HTTP 入口：tasks, intent, webhooks, health, metrics
│   ├── routes/                   # Webhook REST routes
│   ├── notifications/            # Webhook dispatcher + DingTalk/WeCom/Email channels
│   ├── observability/            # Logging, metrics, tracing, health checks
│   ├── task-manager/             # Task entity, lifecycle, memory/SQLite stores
│   └── benchmark/                # M9 quantization benchmark
├── skills/open-loops/            # 回访 skill（只读缓存）
├── scripts/                      # 后台刷新 + Windows 计划任务安装
├── intent-engine/                # Rule-based intent engine + i18n + LLM fallback
├── tests/                        # Milestone, HTTP and webhook integration tests
├── docs/                         # Design and API reference documents
├── API.md                        # HTTP API documentation
├── tsconfig.json                 # Type-check config
├── tsconfig.build.json           # Full build (includes legacy, for traceability)
├── tsconfig.open-loops.json      # Production build (Open Loops only)
└── Dockerfile
```

---

## Legacy Milestones (M1–M11)

以下记录属于旧 HTTP 任务服务，不是 Open Loops 的主线。保留用于兼容和追溯，不再扩展。

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

### M7 — Persistence Layer (2026-08-02)

- **`SQLiteStore`** (`src/task-manager/task-persistence.ts`): durable tasks + lifecycle events using Node's built-in `node:sqlite`, with indexes for status/priority/category/assignee/time.
- **Extended queries**: pagination, sorting, time-range and intent-category filters, also exposed by `GET /api/tasks`.
- **Store selection**: `TASK_STORE=sqlite|memory`; production defaults to SQLite at `TASK_DB_PATH` (default `./data/tasks.db`).

### M8/M9 — Webhooks & Notifications (2026-08-10)

- **Webhook API** (`/api/v1/webhooks`): register/list/update/delete, HMAC-SHA256 signatures (`X-Claw-Signature`), exponential-backoff retries, delivery history.
- **Channels**: DingTalk, WeCom and Email adapters.
- **Note**: HTTP rate limiting is not implemented in-process; enforce it at the gateway or reverse proxy.

### M10 — Observability (2026-08-14)

- **Prometheus `/metrics`**: HTTP, intent, cache, task lifecycle and webhook delivery metrics.
- **Tracing**: request IDs and W3C `traceparent` propagation on every request.
- **Access logs**: one structured line per request with method/path/status/duration.

### M11 — LLM Reliability (2026-08-01)

- **Retry + circuit breaker + multi-endpoint fallback** for the LLM classifier, with result caching and regex fallback.

---

## Installation

### Prerequisites

- **Node.js** ≥ 22.15 (required by `node:sqlite` and DSH's zstd frames)
- **npm** ≥ 10

### Prebuilt package

```bash
npm pack
npm install -g .\loopsteward-2.9.0.tgz
loopsteward --help
```

`prepack` 会清理 `dist` 并只重建 `src/loops` + `src/magpie`；tarball 只含 `dist/`、`skills/`、`scripts/`、`docs/MCP.md`、`README.md` 和 `package.json`，不包含 `tests/`、`src/`、其他 `docs/` 或本机数据库。全局安装不依赖 devDependencies。

全局安装后运行 `loopsteward setup` 安装 skill 和会话入口策略。当前重构阶段默认只装 Hermes，其他 Agent 需显式 `--agents` 才安装；skill 的命令路径会指向全局包，不需要保留仓库目录。

如果默认的 Hermes 目录还不存在，`setup` 会明确失败并提示先启动一次 Hermes，不再静默跳过；`--dry-run` 也按实际结果返回是否可执行。

提取步骤调用 OpenAI 兼容的 `POST {baseURL}/chat/completions`，默认 `http://127.0.0.1:11434/v1`。用 `MAGPIE_BASE_URL`、`MAGPIE_MODEL`、`MAGPIE_API_KEY` 指向任意兼容服务；未设置 key 时不发送 `Authorization` 头。

```powershell
$env:MAGPIE_BASE_URL = "https://api.openai.com/v1"
$env:MAGPIE_MODEL = "gpt-4o-mini"
$env:MAGPIE_API_KEY = "<your key>"
```

`setup` 只有在步骤和 doctor 健康检查都通过时才返回成功；目标库损坏这类阻塞问题会直接失败，不再只报“步骤完成”。

`loopsteward doctor` 默认也只检查 Hermes 的 skill 和会话入口策略；加 `--all` 才检查全部 Agent。

`doctor` 还会核对 `OpenLoopsRefresh` 实际指向的刷新脚本；从仓库检出切到全局安装后，如果计划任务仍跑旧仓库，会给出警告并提示重新注册。

### 从仓库检出迁移到全局安装

全局安装默认使用用户数据目录，不会读取 `<repo>/data/loops.db`。旧库用 `setup --import-db` 一条命令导入：

```powershell
loopsteward setup --import-db "C:\path\to\claw-task-service\data\loops.db" --dry-run
loopsteward setup --import-db "C:\path\to\claw-task-service\data\loops.db"
```

`setup` 会在构建后、安装 skill 前校验源库，给当前目标库做安全备份，再原子替换；它不合并两份库。默认目标就是全局安装的用户数据目录。`--dry-run` 只报告将导入的 loops / signals 条数，不改文件；底层单文件恢复仍可用 `restore`。

### Steps

```bash
# Clone the repository
# 目录名先保持兼容，避免现有 skill 的绝对路径失效
git clone <repo-url> claw-task-service
cd claw-task-service

# Install dependencies
npm install

# Build the CLI and link the local command
npm run build:open-loops
npm link
loopsteward --help
```

品牌已切换为 LoopSteward（守环），但仓库目录、`data/loops.db`、`skills/open-loops` 和现有 skill 安装路径保持不变；旧的 `loops:*` npm scripts 继续可用。

仓库检出默认继续使用仓库内的 `data/loops.db`。全局安装默认写到用户数据目录：Windows 为 `%LOCALAPPDATA%\LoopSteward\loops.db`，macOS 为 `~/Library/Application Support/LoopSteward/loops.db`，Linux 为 `~/.local/share/loopsteward/loops.db`；可用 `LOOPSTEWARD_DATA` 覆盖，显式 `--db` 仍然优先。

### Dependencies

The `npm install` command will install:

- **Runtime:** 无生产运行时依赖；`express` 只在 devDependencies，供旧 HTTP 服务本地追溯
- **Dev:** `tsx`, `typescript`, `vitest`, `@types/express`, `@types/node`

### One-command bootstrap

```powershell
# 仓库检出
npm run loops:setup -- --dry-run
npm run loops:setup -- --schedule --ingest

# 全局安装
loopsteward setup --dry-run
loopsteward setup --schedule --ingest

# 从旧仓库库导入并完成初始化
loopsteward setup --import-db "C:\path\to\claw-task-service\data\loops.db" --schedule --ingest
```

`loops:setup` 会按需构建、把 skill 装到 Hermes（默认）、写入 Hermes 的 `SOUL.md` 会话入口策略，然后跑一次 doctor。`--agents` 可显式扩展到其他 Agent；`--import-db` 可选地在装 skill 前导入旧库；`--schedule` 额外注册每 2 小时的后台刷新任务；`--ingest` 立即摄入最近 7 天会话。这些开关都可省略，命令幂等，失败步骤会单独标出。

---

## Running

### Type Check (no emit)

```bash
npm run check
```

Runs `tsc --noEmit` to validate TypeScript compilation without producing output files.

### LoopSteward CLI

```bash
npm run dev
# after npm run build:open-loops
npm start
# after npm link
loopsteward --help
```

Both print CLI usage. LoopSteward is a command-line tool, not a long-running server; use `loopsteward digest`, `loopsteward doctor`, and the other subcommands. The `npm run loops:*` scripts remain as development aliases.

### Build

```bash
npm run build:open-loops
npm run build        # 可选：连旧 HTTP 服务一起构建
```

`build:open-loops` 生成生产 CLI，`build` 保留完整构建供旧服务追溯。`npm pack` 会自动执行 `prepack`，把 `dist` 收敛到生产产物后再打包。

### Legacy HTTP Service (deprecated)

```bash
npm run legacy:dev
# after npm run build
npm run legacy:start
```

Runs the old `src/index.ts` Express service. It has no known consumers; keep it only for traceability. In production the task store defaults to SQLite; point `TASK_DB_PATH` at a mounted volume for durable storage. The `Dockerfile` now starts the Open Loops CLI and builds only `src/loops` + `src/magpie`; the legacy service is only reachable through a local full build (`npm run build`) plus `npm run legacy:dev` / `legacy:start`, and its `express` dependency is dev-only.

### Magpie Source Scan

```bash
npm run magpie:scan
npm run magpie:scan -- --json
```

Reads the local Magpie home (default `~/.config/magpie`, override with `--home <dir>`) and prints a read-only summary of cross-agent memory candidates and distill progress. It never writes to Magpie.

---

## Testing

The project includes unit, API/observability, persistence, i18n, LLM-resilience, webhook and end-to-end integration suites.

Open Loops 主线的测试在 `tests/loop-*.test.ts`、`tests/session-source.test.ts` 和 `tests/project-map.test.ts`；`npm test` 默认跑完整 Vitest 套件，旧意图引擎保留为 `npm run test:legacy`。

GitHub Actions 现在同时跑 Ubuntu 和 `windows-latest`；Windows 任务会真正执行 PowerShell 5.1 解析、`.cmd` 入口和 Open Loops 全量测试。Docker job 构建后会加载镜像并运行默认 CLI，构建成功不再等于启动可用。独立的 `audit` job 直接读 `package-lock.json`，用官方 npm registry 跑全量依赖审计，moderate 及以上告警会让流水线失败。

测试工具链固定在已修复版本：`vitest 4.1.12`、`vite 8.3.8`；`npm audit` 全量（含 dev）为 0 漏洞，生产依赖同样为 0。

### Run All Tests

```bash
# Open Loops + main Vitest suite (default)
npm test

# Legacy intent-engine regression (48 cases)
npm run test:legacy

# Open Loops only
npx vitest run tests/loop-*.test.ts tests/session-source.test.ts tests/project-map.test.ts

# Milestone integration suites
npm run test:m4 && npm run test:m5 && npm run test:m7
npm run test:m10 && npm run test:m11

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

| Variable       | Default           | Description |
|----------------|-------------------|-------------|
| `PORT`         | `3000`            | HTTP listen port |
| `LOG_LEVEL`    | `INFO`            | Log level: DEBUG, INFO, WARN, ERROR |
| `NODE_ENV`     | `development`     | `production` switches the default task store to SQLite |
| `TASK_STORE`   | `sqlite` in prod  | `sqlite` or `memory` |
| `TASK_DB_PATH` | `./data/tasks.db` | SQLite file path (parent directory auto-created) |

---

## License

MIT
