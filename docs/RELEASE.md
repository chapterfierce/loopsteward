# 发布检查

当前版本：`2.9.1`。发布前先跑一条命令：

```powershell
npm run release:check
```

它会依次执行 `check`、全量 `npm test`、`build`、`verify:package` 和旧套件 `test:legacy`。任何一步失败都 stop，不继续打包。

## 发布前人工确认

1. 撤销 `2026-11-12` 发布 `2.9.0` 时出现在会话记录里的 granular npm token（loop ref `a97af231`）。默认 registry 是 npmmirror，直接 `npm whoami` 会报未登录，容易误判；指定官方源后当前身份是 `chapterfierce`，`npm token list --registry=https://registry.npmjs.org` 仍有 1 枚 `2026-11-12` 创建的 token（id `5928de`，掩码 `npm_L9mR…IqEG…`），且已比对会话记录前缀确认就是泄露那枚。运行 `npm token revoke 5928de --registry=https://registry.npmjs.org` 后 npm 会要求 OTP：在浏览器打开它给出的 `npmjs.com/auth/cli/...` 完成 2FA，CLI 不能绕过。撤销后当前登录态失效，发布前重新 `npm login`。
2. `git status` 干净，改动已提交；不要只用 `git commit -am`，先确认新增的运行时文件都已 `git add`：`src/loops/session-archive.ts`、`scripts/verify-package.mjs`、`tests/session-archive.test.ts`、`tests/loop-closing-cli.test.ts`、`docs/RELEASE.md`。漏掉 `session-archive.ts` 会让 `cli.ts` 的导入直接失败。远端 CI 已绿。
3. `package.json` 的 `version` 与 `CHANGELOG.md` 顶部一致。

## 发布

```powershell
npm login --registry=https://registry.npmjs.org
npm publish --registry=https://registry.npmjs.org
npm view loopsteward version --registry=https://registry.npmjs.org
```

发布后在一个临时目录安装并确认入口：

```powershell
npm install loopsteward@2.9.1 --registry=https://registry.npmjs.org
npx loopsteward --help
```

## 发布后

1. 立即在 npm Access Tokens 页面撤销本次使用的 granular token。
2. 打标签并推送：`git tag v2.9.1`、`git push origin v2.9.1`。github.com 主域在当前网络不可达时，用 SSH 远端或镜像站。
3. 在 GitHub 创建 release，正文引用 `CHANGELOG.md` 的 `2.9.1` 段。

## 回滚

- 发布 72 小时内：`npm unpublish loopsteward@2.9.1 --registry=https://registry.npmjs.org`
- 超过 72 小时：`npm deprecate loopsteward@2.9.1 "原因" --registry=https://registry.npmjs.org`，再发补丁版本。

## 已知阻塞

- 泄露的 granular token 未撤销。
- 工作树仍有未提交改动，远端 CI 未跑。
