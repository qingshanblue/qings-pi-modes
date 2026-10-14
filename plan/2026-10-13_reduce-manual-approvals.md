# 方案：在安全范围内降低人工审批概率

- 日期：2026-10-13
- 状态：待评审
- 关联：`AGENTS.md` 安全约定、`SECURITY.md`、commit `3648298`（逃逸不交分类器）

## 0. 目标与红线

**目标**：在不降低实际约束力的前提下，减少 `auto`（以及 `ask`/`edits`）模式中的人工弹窗。

**红线（本方案不动）**：
- 任何**会脱离沙箱执行**的 ask（提权、写越界、`sandbox off`/不可用）→ 永远人工；headless 即拒。
- 受保护路径硬拦、`denyRead` 秘密、网络 deny-by-default。
- 项目配置只能收紧。

## 1. 现状：人工审批触发点

| # | 触发 | 代码位置 | 可否安全降低 |
|---|---|---|---|
| 1 | **只读命令读项目外**（`cat /etc/x`、`ls ~/.npm`、`find /nix/store`） | `bashGate` outside 分支 + `escalateToHuman`（`index.ts:1418,1445-1449`） | ✅ 本方案核心 |
| 2 | 提权（`sudo`/`doas`，含 wrapper 内） | 同上，reason=`privilege escalation` | ❌ 红线 |
| 3 | 写越界 / `cd` 到项目外 | 同上 | ❌ 红线 |
| 4 | 分类器连续拒绝 ≥ `maxConsecutiveDenials`（默认 3） | `classifier.ts`、`index.ts:430` | ✅ 调参 |
| 5 | 分类器报错且 `failClosed:false` | `index.ts:417-423` | ⚠️ 默认（true）不弹窗而是拦截 |
| 6 | `sandbox off` 时的 ask bash | `bashGate` `!sandboxEnabled` 分支 | ❌ 红线（可加提示） |
| 7 | **网络域名不在白名单** | `network.ts` + 出厂白名单 | ✅ 预设/白名单 |
| 8 | 受保护路径 | 硬拦（非弹窗） | ❌ |

**关键洞察（#1）**：沙箱 `on` 本来就允许项目外**读**（`denyRead` 之外），但当前实现把「只读越界读」判为 escape → 人工 → 批准后**脱离沙箱执行**。这类命令本可留在沙箱内，却被当成最强授权。修正它**同时**减少人工并收紧权限。

## 2. 方案总览

| 编号 | 改动 | 人工降幅 | 风险 | 复杂度 |
|---|---|---|---|---|
| **P1** | 只读越界读 → 留在沙箱内 + 分类器/白名单 | 高 | 低（更安全） | 中 |
| **P2** | 分类器降级阈值提高 + 按 surface 计拒 | 中 | 低 | 低 |
| **P3** | 分类器提示词/上下文优化，减少误拒 | 中 | 低 | 低 |
| **P4** | 网络：预设/白名单（决策点） | 高 | 中（exfil 面） | 低–中 |
| **P5** | 修正注释 + 状态提示 | — | 极低 | 极低 |

## 3. 详细设计

### P1（核心）— 只读越界读：留在沙箱内，不再走人工

**准入条件（需全部满足）**
- `modeSandbox(m).enabled === true` 且 `effectiveSandboxState(m) === "on"` 且 `sandbox.ready === true`；
- `outsideReason` 以 `path outside project` 开头（**排除** `privilege escalation`）；
- `isSafeBashChain(analysis.commands, command) === true`（整条链均为只读白名单命令，且无重定向 / 命令替换）；
- `!analysis.usedFallback`（tree-sitter AST 解析成功，避免启发式误判）。

**处理**
- 视为 in-bounds ask：以 `outsideReason = undefined` 调 `bashGate` → 得到 `onApproveUnsandboxed=false`；
- `promptAllow(..., review)` **不设** `escalateToHuman` → 走分类器（分类器看到 `isOutside:true`，可拒）；
- **不**把该 toolCallId 加入 `approvedUnsandboxed` → `bashExecPlan` 保持 `sandboxed:true`；
- 若 policy 直接解析为 `allow`，则静默允许（仍在沙箱内）。

**安全性论证**
- 命令始终在 OS 沙箱内运行；`denyRead` 秘密仍被内核拦截；分类器仍可拒绝；
- 沙箱本已允许项目外读，故**未扩大实际可达范围**；
- 相对现状反而**减少**一次「无沙箱」授权（现状批准后 unsandboxed）。
- 提权、写越界、`strict`/`off`、沙箱未就绪的路径**完全不受影响**。

**实现**
- 在 `bash-enforce.ts` 新增纯函数
  `isBenignOutsideRead(outsideReason, isSafeChain, usedFallback, sandboxEnabled, state, ready): boolean`，单测覆盖全矩阵；
- `index.ts` 的 sandboxed bash 分支用它决定是否将越界折为 in-bounds；
- 保持 `bashGate`/`promptAllow` 接口不变，降低回归面。

### P2 — 分类器降级更钝
- `classifier.maxConsecutiveDenials` 默认 `3 → 5`；
- 拒绝计数**按 surface 分别计**（写/编辑的拒绝不再累加到 bash 上），任何一次 allow 仍将其清零；
- 纯改动在 `classifier.ts`（`DenialState` 由计数改为按 surface 的 map）+ 相应单测。

### P3 — 分类器提示词 / 上下文
- system prompt 增补：对**常规开发操作**（build/test/lint/format、在项目内安装已声明的依赖、可逆编辑）倾向 allow；
- subject 增加 in-bounds roots 列表，让 reviewer 明确「哪里算项目内」；
- 不改动安全骨架：「不确定则拒」与「仅返回 JSON、不可解析即拒」。

### P4 — 网络（**待决策**）
默认白名单仅有 npm / yarn / pypi / github。可选：
- **(a) 扩展出厂默认**：加入主流注册表类域名（`crates.io`、`static.crates.io`、`index.crates.io`、`proxy.golang.org`、`sum.golang.org`、`rubygems.org`、`files.pythonhosted.org`、`repo.maven.apache.org` …）。需走「出厂默认三件套」：`defaults-history.json` + CHANGELOG（schema 通常不变）。
- **(b) 保持默认**，仅新增 `/net preset <ecosystem>` 或文档化 `/net allow` 批量授权，把决定权交给用户。

权衡：默认放宽 = 全体用户的 exfil 面变大。**倾向 (b)**；本机可先 `/net allow …` / “Allow forever”。

### P5 — 注释与状态提示
- `index.ts:359-362` 的函数注释与实际（`escalateToHuman`）对齐（当前自相矛盾）；
- `auto` + `sandbox off`/不可用时，在 footer/awareness 明示「此组合下 bash 会逐条询问」，避免误解为 bug。

## 4. 明确不做
- 把提权 / 写越界 / `sandbox off` 的 ask 交给分类器（红线）。
- 为单次分类器拒绝增加「绕过」入口（会增加人工面，与目标相反）。
- 放宽受保护路径或 `denyRead`。

## 5. 测试计划
- **纯单测**：`isBenignOutsideRead` 全矩阵；`DenialState` 按 surface 计数；`buildReviewPrompt` 新字段。
- **harness（`index.test.ts`）**：
  - `auto`：只读越界读（`cat /etc/hostname`）→ **不进人工**、**仍在沙箱内**、分类器被调用；
  - `auto`：写越界 / 提权 / `strict` / `sandbox off` → **仍进人工**；
  - 分类器允许越界读但**不得**置 `approvedUnsandboxed`。
- **parity**：确认既有各模式行为不回退。

## 6. 落地顺序与验收
`P5 → P1 → P2 → P3 → P4(可选)`。每步：`npm test` 全绿（除既有 2 个 NixOS 环境失败）+ `npm run typecheck` 干净 + CHANGELOG 条目。

## 7. 待你决策（已定）
1. **P4**：✅ 采用出厂白名单（扩展默认网络 allowlist）。
2. **P2**：✅ 阈值提到 5，且按 surface 分开计数。
3. **P1**：✅ 同步落地（不单独先行）。

## 8. 落地结果（2026-10-14）

全部落地，版本 `1.0.0 → 1.1.0`。

- **P1** — `src/bash-enforce.ts` 新增 `isBenignOutsideRead`；`src/index.ts` 沙箱 bash 分支据此把「只读、非提权、AST 成功、sandbox `on` 且就绪」的越界读折为 in-bounds（不设 `escalateToHuman`、不进 `approvedUnsandboxed` → 保持 sandboxed）。提权/写越界/`strict`/`off`/不可用不受影响。
- **P2** — `maxConsecutiveDenials` 默认 `3 → 5`；`DenialState` 改为按 surface 计数，`recordDenial/recordSuccess/shouldFallbackToPrompting` 带 `surface`。
- **P3** — SYSTEM_PROMPT 增加「常规开发步骤倾向放行」；`ClassifierSubject.inBounds` + 提示词 `in-bounds roots` 行。
- **P4** — 出厂 `network.allowedDomains` 增加 crates.io / Go / RubyGems / files.pythonhosted.org / Maven；`defaults-history.json` 追加改前默认值（`1.0.0..1.0.0`）；`configLeaves` 扩展到顶层 `sandbox`/`network`（否则网络默认变更对审计不可见）；CHANGELOG 新建 `1.1.0` 段。
- **P5** — 修正 `autoDecide` 注释；分类器 chip **始终显示**（`AI:<model>`）——分类器对文件/扩展/网络 ask 照常工作，沙箱未生效时只有会脱离沙箱的 `bash` 转人工（verbose 额外注明）。

**测试**：`npm test` 288 项 / 286 通过 / 2 个环境性失败（`blockablePath`@`paths.test.ts`、`bare-word symlink`@`index.test.ts:1305`——均在基线 `git stash` 下同样失败）；`npm run typecheck` 干净。新增测试：`isBenignOutsideRead` 全矩阵、按 surface 计数、`inBounds` 提示词、顶层审计 leaf、状态 chip 保持，以及 auto 下 unbounded escape（只读/提权/写越界）仍走人工。
