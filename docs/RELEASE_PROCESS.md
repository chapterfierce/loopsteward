# 公开发布流程

这份文档定义“从私有开发目录到公开仓库 / npm 包”的标准动作。原则只有一句：**公开物是重新装配的发布产物，不是开发目录的快照。**

## 0. 三条硬规则

1. **身份唯一**：产品名 `LoopSteward`，包名 / CLI `loopsteward`，功能名 `Open Loops`，技能名 `open-loops`。公开物里不再出现 `claw-task-service`、`Claw Task Service`、`X-Claw-`。
2. **资产分级**：运行时文件、公开文档、内部资料、密钥四类分开。内部资料不进公开仓库，密钥连历史都不进。
3. **版本可信**：新包从 `0.1.0` 或 `1.0.0` 起步；此后只由 release-please 按 Conventional Commits 递增，同一天连续补发必须写清原因。

## 1. 开发仓库与公开仓库分离

开发仓库可以保留 `docs/HANDOFF.md`、调研、草稿图、测试数据、本机路径。公开仓库只接收通过白名单的文件。

首次公开建议用“孤儿提交”重建历史：

```powershell
git checkout --orphan public-main
git rm -r --cached .
# 按白名单重新 add，确认 git status 后再提交
git commit -m "chore: initial public release"
```

如果敏感内容已经进入公开历史，先轮换凭据，再用 `git filter-repo` 清理；只删当前文件不算清除。

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

1. **干净检出**：从 `main` 新建 release 分支，`git status` 干净；不在本地脏树上打包。
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

发布前顺序固定为：

```powershell
npm run clean
npm run build:open-loops
npm run release:audit
npm run release:check
```

`release:audit` 有 error 时不得发布；只有 warning 时需要在发布记录里逐条写明接受理由。

版本号不要手工领先于已发布 tag：本地 `package.json` 和 `.release-please-manifest.json` 保持在上一个已发布版本，提交使用 `feat!:` / `BREAKING CHANGE:` 描述破坏性变更，由 release-please 生成下一个版本 PR。合并版本 PR 后，release 工作流才会打 tag、创建 GitHub Release 并执行 OIDC 发布。
