# 存量清理确认单（2026-11-12）

只读整理，未改数据库。确认后再执行文末命令；执行前先备份。

> 2026-11-12 M165 后，`loops:closing --project .` 会把 6 条中的 4 条（`bc5c3359`、`09be903a`、`60d1f7f0`、`47ea7214`）标为“可能已完成”并给出依据；仍不会自动关闭，需要你确认。

## 1. 状态快照候选（建议 dropped）

这些条目是助手对自己进度的自述或过期状态，不是用户承诺。`60d1f7f0` 是用户来源，但问题已在会话里直接回答，也属于过期项。

| ref | 标题 | 项目 | 状态 | 来源 |
|-----|------|------|------|------|
| `10df02a0` | M66 交接记录缺失且 58 个文件未提交 | loopsteward | open | assistant |
| `91a9d2ef` | open-loops digest 查询因只读沙箱失败，未取得未闭环事项 | loopsteward | open | assistant |
| `bc5c3359` | Docker CI 尚未在真实远端跑过 | loopsteward | open | assistant |
| `09be903a` | 真实反馈仍为 0，5 条候选循环待你判定后算 usefulRate | loopsteward | open | assistant |
| `60d1f7f0` | 用户问“回复语是什么含义”未直接解释 | loopsteward | open | user |
| `47ea7214` | 回访缺少重复提醒配额，repeated=0 与持续跟进承诺冲突 | loopsteward | open | assistant |

## 2. 完成候选（建议 resolved，需逐条确认）

以下 21 条来自最近 30 天的 reconcile 缓存，置信度均不低于 0.9。`bc5c3359`、`47ea7214`、`60d1f7f0`、`09be903a` 同时出现在上面的状态快照里；这 4 条二选一：按状态快照 dropped，或按完成候选 resolved，不要两条命令都跑。下面的候选命令已排除这 4 条。

| ref | 置信度 | 项目 | 标题 | 依据摘要 |
|-----|--------|------|------|----------|
| `09be903a` | 0.98 | loopsteward | 真实反馈仍为 0，5 条候选循环待你判定后算 usefulRate | 5 条候选已按 forgotten 写入，0 noise |
| `4b000891` | 0.98 | FamilyCam-v2 | 第二轮门禁 19 条派生子进程用例失败被判为环境故障，待复跑确认 | 整条门禁复跑全绿 |
| `99701859` | 0.97 | Qoder · Magpie 插件使用指南 | 运行中的 exe 含未提交改动，发布源不一致 | 提交后重建并重启，工作区干净 |
| `bc5c3359` | 0.97 | loopsteward | Docker CI 尚未在真实远端跑过 | CI 7/7 全绿，包含 Docker |
| `47ea7214` | 0.96 | loopsteward | 回访缺少重复提醒配额，repeated=0 与持续跟进承诺冲突 | M96 已加入重复回访配额 |
| `2a1d560e` | 0.96 | task-keeper | 把「用 AI 解释（PRO）」死按钮做成真功能 | AI 解读已接线并端到端验证 |
| `60d1f7f0` | 0.95 | loopsteward | 用户问“回复语是什么含义”未直接解释 | 已解释回复语示例 |
| `40a272ff` | 0.95 | focusflow | HabitEditScreen 无效 id 永久卡加载态 | 已拆 Loading/NotFound/Ready |
| `b475c6de` | 0.95 | focusflow | AC8.2 任务关联推送形态未拍板 | 已实现并验收 |
| `2d86c611` | 0.95 | Qoder · Magpie 插件使用指南 | 点击悬浮窗各区域跳转仍停留上次页面 | 真机四类跳转已修复 |
| `c6c03045` | 0.95 | FamilyCam-v2 | 新用例未补 RED 档，实现前失败证据缺失 | 改前树复跑 7 条均失败 |
| `23ae4c3d` | 0.95 | focusflow | npm run verify / e2e / check:contract 本轮未复跑 | 第 71 轮复跑全过 |
| `d7e60c5b` | 0.92 | Qoder · Magpie 插件使用指南 | 11 日复盘需回答动效、标题热区、最近一次的手感 | 用户答“全部没问题” |
| `3935f317` | 0.92 | Hermes · 排查同型号大模型回答差异 | 「Claude 走 Magpie/15721 中转」说法未实测 | 已实测并改回只写已验证事实 |
| `3ad5f9ff` | 0.92 | ZCode · 能把本地easyclaw agent | 用户回忆 00:35 与 00:43 是否添加或同步过模型 | 用户确认是 GUI 手动修改 |
| `c8926352` | 0.92 | focusflow | 首页卡片堆叠与统计页「完成率」主视觉待拍板 | 已改为过程导向并落 RB-1.1 |
| `01e78ce4` | 0.92 | focusflow | backend 安全修复仍待 commit | 后端 commit 6332767 已落库 |
| `45a72a01` | 0.90 | focusflow | round 83 六态输入逐屏走查清单仍未跑 | 逐屏走查已完成 |
| `4c8a8c52` | 0.90 | FamilyCam-v2 | 整条 scripts/verify.ps1 未跑，留给收口会话 | 完整门禁全绿 |
| `dcbf1b13` | 0.90 | FamilyCam-v2 | 设置页「保存检索条件」失败仍宣称已保存 | 已修复失败不再谎报 |
| `53d9e6d2` | 0.90 | focusflow | 冷启动约 4.5s：runBlocking DataStore 首读 | 已改异步读取并带单测 |

## 3. 助手来源分布（只读统计）

活跃循环 234 条：用户待办 77 条，助手来源 157 条。助手来源不等于噪音，M157 已不让它们进热区，M158 已单独计数；清理前先按项目抽样，不要直接批量标 noise。

已展示未关闭的条目里，当前可用 `npm run loops:closing -- --origin assistant` 只看助手来源（38 条）；该命令只读，不会关条目。先看再决定，不要直接批量标 noise。

| 项目 | 活跃总数 | 助手来源 |
|------|----------|----------|
| focusflow | 26 | 22 |
| loopsteward | 13 | 12 |
| Hermes · Magpie搭建中转站可行性 | 7 | 7 |
| claudio | 8 | 7 |
| task-keeper | 7 | 6 |
| ZCode · 能把本地easyclaw agent | 6 | 6 |
| FamilyCam-v2 | 23 | 6 |
| Hermes · 排查聊天图片消失原因 | 4 | 4 |
| pj01 | 6 | 4 |
| 其余项目 | 134 | 83 |

## 4. 确认后执行的命令

先备份：

```powershell
npm run loops:backup -- --json
```

状态快照（确认全部可 dropped 后）：

```powershell
npm run loops:update -- --refs 10df02a0,91a9d2ef,bc5c3359,09be903a,60d1f7f0,47ea7214 --status dropped --note "confirmed stale snapshot 2026-11-12"
```

完成候选（建议先删掉上一条已 dropped 的 ref，避免对同一 ref 重复操作；保留后按 resolved 处理）：

```powershell
npm run loops:update -- --refs 4b000891,99701859,2a1d560e,40a272ff,b475c6de,2d86c611,c6c03045,23ae4c3d,d7e60c5b,3935f317,3ad5f9ff,c8926352,01e78ce4,45a72a01,4c8a8c52,dcbf1b13,53d9e6d2 --status resolved --note "confirmed reconcile candidate 2026-11-12"
```

上述命令均未执行；本文件只是确认单。
