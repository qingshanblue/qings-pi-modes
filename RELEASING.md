# 发布（npm → pi.dev 收录）

本文档记录把本项目发布到 npm、并被 [pi.dev 包画廊](https://pi.dev/packages) 收录的完整流程。
适用于维护者；内容基于 2026-10 的 pi 官方文档与实测。

## 一、pi.dev 收录规则

画廊**就是 npm 的关键词索引**，没有单独的投稿表单：

| 规则 | 说明 |
|---|---|
| **唯一收录条件** | 发布的 npm 包 `keywords` 里含 `pi-package`（本项目已有）|
| 收录方式 | 发布后自动索引，通常几分钟内出现；无需申请、无人工审核 |
| 展示字段 | 包名、`description`、`version`、`repository`（仓库链接）|
| 可选预览 | `pi.image` / `pi.video`（画廊预览图/视频）|
| 用户安装 | `pi install npm:qings-pi-modes` |

包内容规则（官方 `docs/packages.md`）：

- **宿主提供的包**（`@earendil-works/pi-ai`、`pi-agent-core`、`pi-coding-agent`、`pi-tui`、`typebox`）
  必须放 `peerDependencies`（范围 `"*"`），**不得**放进 `dependencies`，也不得打包（否则会出现重复类/重复注册表）。
- **运行时依赖**放 `dependencies`（本项目的 `@anthropic-ai/sandbox-runtime`、`tree-sitter-bash`、`web-tree-sitter`）。
- 扩展可直接以 TypeScript 源码发布；pi 按 `pi.extensions` 清单发现（本项目 `.ts` 直接可用，无需构建步骤）。

## 二、一次性准备

1. **npm 账号 + 登录**
   ```bash
   npm whoami          # 401 = 尚未登录
   npm login           # 交互式；建议同时启用 2FA
   ```
   开了 2FA 时，发布需 `--otp=123456`，或创建 **Automation token** 写进 `~/.npmrc`：
   ```bash
   npm config set //registry.npmjs.org/:_authToken=<token>
   ```
2. **确认包名可用**（2026-10-12 已验证 `qings-pi-modes` 可用；上游 `pi-permission-modes` 已占用）
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" https://registry.npmjs.org/qings-pi-modes   # 404 = 可用
   ```

## 三、发布前准备（每次发布）

1. **元数据**
   - `package.json`：`version` 升号；
   - `author`：fork 后建议改为本人，把上游作者放进 `contributors`（保持 MIT 归属）；
   - `pi.image` / `pi.video`：`package.json` 目前未设置（如需画廊预览图/视频再自行添加）；
   - `repository` / `homepage` / `bugs` 已指向本 fork ✓。
2. **README 安装段**：已含 npm 装法（`pi install npm:qings-pi-modes`）✓；确认没有过时的版本号。
3. **CHANGELOG**：把 `## [Unreleased]` 改为 `## [x.y.z] - YYYY-MM-DD`，并新起一个空的 `## [Unreleased]`。
4. **LICENSE**：已含 fork 版权行 ✓（上游 MIT 版权保留）。

## 四、预检（打包体检）

```bash
npm run typecheck            # 应为干净
npm test                     # 预期 288 项 / 286 通过（2 个 NixOS 环境性失败，见下）
npm pack --dry-run --json    # 校验打包内容
```

`npm pack --dry-run` 期望值（2026-10-12 实测）：

- 共 **32 个文件**：`src/*.ts`（无 `*.test.ts`）、`schemas/`、`permission-mode.defaults.json`、
  `defaults-history.json`、`README.md`、`LICENSE`、`CHANGELOG.md`、`CONTRIBUTING.md`、`SECURITY.md`、`package.json`；
- 无 dotfile、无测试、无敏感文件；
- 体积约 135 kB（解包 ~414 kB）。

> 两个环境性失败（`blockablePath`@`src/paths.test.ts`、`bare-word symlink`@`src/index.test.ts`）是 NixOS 下
> coreutils 路径/symlink 解析导致的既有问题，与代码无关（在 `main` 分支上同样存在）。发布说明里如实注明即可。

## 五、发布

```bash
npm publish                  # 未加 scope 的名字默认 public
npm publish --otp=123456     # 启用 2FA 时
```

想要供应链证明（推荐在有 CI 的场景）：在 GitHub Actions 里执行 `npm publish --provenance`。

## 六、收录验证

```bash
npm view qings-pi-modes keywords     # 应包含 pi-package
```

1. 打开 https://pi.dev/packages 搜包名（自动索引，无表单）；
2. **冒烟测试**（不写配置直接试用）：
   ```bash
   pi -e npm:qings-pi-modes
   ```
   或正式安装 `pi install npm:qings-pi-modes`，检查 footer 出现状态条、`alt+m/alt+s/alt+n` 生效、
   `/permission`、`/network`、`/sandbox` 的交互式选择器可用。

## 七、收尾

```bash
git tag vX.Y.Z && git push origin vX.Y.Z     # 打 tag（pi install npm:...@X.Y.Z 可锁版本）
```

在 GitHub 建 Release，贴 CHANGELOG 摘要。

**回退**：72 小时内可 `npm unpublish qings-pi-modes@X.Y.Z --force`；超时后只能 `npm deprecate`。

## 八、版本策略

- **首次发布为 `1.0.0`**（已定）：fork 自立门户、以自己的版本线编号。注意语义上它与上游 `2.4.1` 无大小关系——
  npm 认为是两个独立包，不会互相升级；从上游迁移的用户需手动改配置（模式名与沙箱档位都变了）。
- 之后遵循语义化：新功能 minor、修复 patch、破坏性变更 major。
- 本包与上游 `pi-permission-modes` 是两个独立的 npm 包，互不冲突；README 的「与上游的差异」一节列出了 fork 后的全部变化。
