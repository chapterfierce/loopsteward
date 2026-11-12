# 公开发布流程

这份文档定义“从私有开发目录到公开仓库 / npm 包”的标准动作。原则只有一句：**公开物是重新装配的发布产物，不是开发目录的快照。**

## 0. 三条硬规则

1. **身份唯一**：产品名 `LoopSteward`，包名 / CLI `loopsteward`，功能名 `Open Loops`，技能名 `open-loops`。公开物里不再出现 `claw-task-service`、`Claw Task Service`、`X-Claw-`。
2. **资产分级**：运行时文件、公开文档、内部资料、密钥四类分开。内部资料不进公开仓库，密钥连历史都不进。
3. **版本可信**：新包从 `0.1.0` 或 `1.0.0` 起步；此后只由 release-please 按 Conventional Commits 递增，同一天连续补发必须写清原因。

## 1. 开发环境与打包环境分离

不是把开发目录复制一份改名，而是三层分开。

### 1.1 配置分离

- `.env.example` 入库，`.env.local` 忽略；真实密钥只留在本机，不进 Git。
- 本地可以连自己的网关；公开包不写默认地址或模型，运行时只读 `LOOPSTEWARD_*` 环境变量或 `~/.loopsteward/config.json`。
- 优先级固定为：命令行参数 > 环境变量 > 本地配置文件；`LOOPSTEWARD_CONFIG` 可以改配置文件路径。
- 旧 `MAGPIE_*` 只作兼容别名，不作为公开文档的主配置。

### 1.2 构建分离

- 本地只开发与自测：`npm run check`、`npm test`、`npm run release:audit`。
- 发布必须在 CI 的干净检出上执行 `npm ci && npm run build:open-loops`，从 tag 出包。
- 不在本地脏工作区 `npm pack` 或 `npm publish`；同一版本不覆盖，修复发新的补丁版本。
- 发布物是不可变 tarball，带 provenance；失败时回滚 tag 与 npm 版本，而不是重新打同一个包。

### 1.3 仓库分离

- 历史已经干净：一个公开仓即可，`main` 就是发布源。
- 历史仍有内部资料：用“私有开发仓 + 公开发布仓”，或从私有仓按白名单导出。
- 首次公开建议用孤儿提交重建历史；已经泄露的历史先轮换凭据，再用 `git filter-repo` 清理，只删当前文件不算清除。

### 1.4 成熟节奏

主干开发 + 短分支 + PR；CI 跑 lint、测试、构建；release-please 开版本 PR 并打 tag；CI 从 tag 干净构建、跑发布门禁、产出不可变 tarball；带 provenance 发布；临时目录安装并跑真实读写；失败可回滚。

### 1.5 本项目落地

- `claw-task-service` 继续作为开发仓；`data/`、`.env.local`、内部 docs 只在本地保留。
- 公开仓只放运行时、公开文档和 skill；`docs/HANDOFF*`、调研、草稿图不进公开历史。
- 本地配置写到 `~/.loopsteward/config.json` 或用户环境变量；公开包保持无默认。

## 2. 发布物白名单

npm 包只允许：

- `dist/src/loops/`、`dist/src/magpie/`、`dist/src/mcp/`
- `skills/open-loops/`
- `scripts/` 中运行时需要的包装脚本
- `docs/MCP.md`、`docs/RELEASE_PROCESS.md`
- `README.md`、`LICENSE`、`package.json`

禁止：`dist/intent-engine/`、`dist/src/index.*`、`.map`、`tests/`、`data/`、`.tmp/`、`*.tgz`、其他 `docs/`。

公开仓库另外禁止：`docs/HANDOFF*`、`docs/market-landscape*`、`docs/requirements-retrospective*`、`docs/cleanup-review*`、`docs/superpowers/`、`assets/drafts/`、`assets/concepts/`。

## 3. 九道发布门

1. **干净检出**：发布从 tag 对应的干净检出开始，`git status` 干净；不在本地脏树上打包。
2. **身份检查**：产品名、包名、CLI、技能名、仓库名、README 标题一致；旧名零命中。
3. **隐私扫描**：本机绝对路径、内网地址、真实邮箱、私有项目名、API key、token、私钥零命中。
4. **内部资料检查**：HANDOFF、调研、草稿、清理单、开发里程碑不进入公开树。
5. **包面检查**：`npm pack --dry-run` 的文件清单与白名单一致，无 source map、无 legacy 构建产物。
6. **文档检查**：README 只讲用户能用的功能；安装、快速开始、配置、限制、License 齐全；开发史移到内部文档。
7. **质量门**：`npm run check`、`npm test`、`npm run build`、`npm run verify:package` 全绿。
8. **版本门**：`package.json`、`.release-please-manifest.json`、`CHANGELOG.md`、git tag 四处一致；CHANGELOG 由 release-please 生成。
9. **发布与回验**：OIDC 发布并生成 provenance；临时目录安装 tarball，跑 `--help`、MCP 握手和一次真实读写；记录版本、tag、provenance、回滚方式。

## 4. 工具选型

| 工具 | 覆盖 | 适用 | 缺口 |
|------|------|------|------|
| `becerra-alberto/oss-prep` | 10 阶段审计：密钥、PII、依赖、文档、CI、命名、历史、发布 | 最接近完整流程，适合私有仓库首次开源 | Claude Code skill；需要逐阶段人工确认 |
| `xsoway/oss-release-prep` | 敏感信息红线、README 双语、GitHub About/topics、发布检查表 | 中文项目、README 重写、发布前逐项核对 | 偏文档与检查表，不做包内容校验 |
| `ysyecust/everything-claude-code` 的 `opensource-pipeline` | Fork → Sanitize → Package 三阶段 | 快速复制一份脱敏仓库 | 偏通用项目，不覆盖 npm 包面与版本策略 |
| `gitleaks` / `git filter-repo` | 密钥扫描、历史清理 | 任何公开前的最后一道隐私门 | 不检查命名、文档、包内容 |
| `release-please` + npm provenance | 版本、CHANGELOG、tag、可信发布 | 已进入正常发版节奏之后 | 不负责首次脱敏与身份统一 |

推荐组合：`oss-prep` 做首次开源审计 → 本仓库 `release:audit` 做确定性门禁 → `release-please` 管后续版本。

## 5. 本项目当前节奏

```powershell
npm run release:audit
npm run release:audit -- --json
npm run release:audit -- --published <version>
```

`--published` 会下载 registry 上的 tarball 再查一遍，用来确认“实际发出去的包”而不是本地目录。

本地只做自测与审计，不产出发布物：

```powershell
npm run check
npm test
npm run release:audit
npm run release:check
```

真正的发布由 CI 在 tag 上执行：`npm ci` → `npm run build:open-loops` → `release:audit` → `release:check` → `npm publish --provenance`。

`release:audit` 有 error 时不得发布；只有 warning 时需要在发布记录里逐条写明接受理由。

版本号不要手工领先于已发布 tag：本地 `package.json` 和 `.release-please-manifest.json` 保持在上一个已发布版本，提交使用 `feat!:` / `BREAKING CHANGE:` 描述破坏性变更，由 release-please 生成下一个版本 PR。合并版本 PR 后，release 工作流才会打 tag、创建 GitHub Release 并执行 OIDC 发布。
