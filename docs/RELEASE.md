# 发布检查

当前版本：`2.9.1`。日常发布走 GitHub Actions，不再保存 npm token。

## 自动发布

1. 正常合并改动到 `main`，提交信息用 Conventional Commits（`feat:`、`fix:`、`chore:`）。
2. `Release` 工作流自动运行 `release-please`，更新版本号、`package-lock.json` 和 `CHANGELOG.md`，并开一个 `chore: release X.Y.Z` PR。
3. 检查这个 PR 里的 CHANGELOG，合并它。这是整个流程唯一需要人工点的一次同意。
4. 合并后流水线自动打 tag、建 GitHub release，并用 npm trusted publishing（OIDC）发布，同时生成 provenance。不需要 npm 密码或长期 token。

发布任务只在 `release_created == true` 时执行；普通提交只更新发布 PR，不会发版。

## 一次性配置

npm 包 `loopsteward` 绑定可信发布者：GitHub 仓库 `chapterfierce/loopsteward`、工作流文件 `release.yml`、允许 `npm publish`。绑定走 OIDC，仓库里不存 `NPM_TOKEN`。

重新绑定或换仓库时：

```powershell
npm login --registry=https://registry.npmjs.org
npm trust github loopsteward --file release.yml --repo chapterfierce/loopsteward --allow-publish -y --registry=https://registry.npmjs.org
npm trust list loopsteward --registry=https://registry.npmjs.org
npm logout --registry=https://registry.npmjs.org
```

## 本地检查

发布前仍可跑一条命令：

```powershell
npm run release:check
```

它会依次执行 `check`、全量 `npm test`、`build`、`verify:package` 和旧套件 `test:legacy`。流水线里也会再跑一遍，失败就停，不会发布。

## 应急手动发布

仅在 Actions 不可用时使用；不要创建长期 token。

```powershell
npm login --registry=https://registry.npmjs.org
npm run release:check
npm publish --provenance --access public --registry=https://registry.npmjs.org
npm logout --registry=https://registry.npmjs.org
```

手动发布不会自动改版本号或 CHANGELOG，先确认 `package.json` 与 `CHANGELOG.md` 一致。

## 回滚

- 发布 72 小时内：`npm unpublish loopsteward@X.Y.Z --registry=https://registry.npmjs.org`
- 超过 72 小时：`npm deprecate loopsteward@X.Y.Z "原因" --registry=https://registry.npmjs.org`，再发补丁版本。

## 发布记录

### 2.9.1（2026-11-12）

- npm 版本：`loopsteward@2.9.1`，`latest` 已指向该版本。
- 标签：`v2.9.1`，指向 `c531029`。
- GitHub release：https://github.com/chapterfierce/loopsteward/releases/tag/v2.9.1
- 泄露 token `5928de`（`npm_L9mR…IqEG…`）已撤销；`npm token list` 为空。
- 发布前 `npm run release:check` 通过：535/535 测试、旧套件 48/48、`verify:package` 正常。
- 发布后在临时目录安装 `loopsteward@2.9.1` 并运行 `npx loopsteward --help`，入口正常。

## 已知阻塞

- 无。
