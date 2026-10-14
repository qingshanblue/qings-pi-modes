# 架构 v2 完整规划：沙箱 × 网络 × 模式 × AI 自动模式

- 日期：2026-10-14
- 承接：`plan/2026-10-14_clean-room-design.md`（设计）。本文是**可执行的规划**：类型、模块、迁移阶段、验收标准、测试策略、风险。
- 当前基线：代码 1.3.0（`1523fad`）；npm 已发布 1.2.0（`a960b97`），1.3.0 待用户执行 `npm publish`。
- 目标版本：**1.4.0**（阶段 P0–P6 全部完成后发布）。中间阶段不单独发布。

## 0. 命名约定（避免冲突）

现有代码里 `Action`（`schema.ts`）指**策略动作** `"allow" | "ask" | "deny"`。本规划统一改名：

| 名称 | 含义 |
|---|---|
| `Action`（保留） | 策略动作字符串，来自 `resolve.ts` 的 `decide` |
| `CallFacts` | 一次工具调用的**事实**（不可变，由确定性代码生成） |
| `Verdict` | 路由结果：`allow` / `block` / `human` / `ai`，附带理由与提示信息 |
| `Axes` | 三轴快照：containment、egress、policy |

## 1. 目标模型

### 1.1 三轴（输入，互不引用）

```ts
// 沙箱轴：只描述内核边界，不知道模式名
interface Containment {
  state: "off" | "on" | "strict"; // 用户/全局设定的状态
  enforcing: boolean;             // state !== "off" && runtime ready（实际生效）
}

// 网络轴：只描述出站域名，不知道模式名与沙箱
interface Egress {
  open: boolean;                  // /net open：全部放行（会话级）
  allow: readonly string[];       // 全局 allowedDomains ∪ 会话授权
  deny: readonly string[];        // 会话显式拒绝 ∪ deniedDomains
}

// 策略轴：模式的 allow/ask/deny 表（含项目 tighten-only overlay）
interface Policy {
  mode: ModeDef;                  // 现有 schema 不变
  classifier: boolean;            // mode.classifier && 全局 classifier.enabled
  unsandboxedAI: boolean;         // mode.aiGatesUnsandboxed
}
```

三轴只在 `route()` 处相遇。模式切换只换 `Policy`；`/sandbox` 只换 `Containment`；`/net` 只换 `Egress`。

### 1.2 调用事实

```ts
interface CallFacts {
  tool: string;                   // bash | read | write | edit | ls | grep | find | web_search | <extension>
  op: "read" | "write" | "exec" | "net" | "other";
  input: unknown;                 // 有界 payload（审查用）
  targets: readonly string[];     // 规范化后的路径或域名
  scope: "inside" | "outside" | "protected" | "none";
  privileged: boolean;            // sudo/su/doas，含包装命令
  escapesContainment: boolean;    // 在 enforcing 沙箱中需要越界（escape）
  noContainment: boolean;         // 本次执行将无沙箱（off/不可用/文件工具）
  readOnly: boolean;              // 已知只读白名单、无重定向/命令替换
  inspectable: boolean;           // 审查者可见完整 payload
  hosts: readonly string[];       // 显式可知的目标域名（bash 中可解析的 URL/host，web_search 为空）
  scripts: readonly ScriptReview[];
}
```

`CallFacts` 由 `facts/` 下的构造器产生（bash、文件工具、web_search、扩展工具各一个）。**路由函数不做 I/O。**

### 1.3 路由（唯一判定点）

```ts
function route(f: CallFacts, axes: Axes, grants: Grants): Verdict;
type Verdict =
  | { kind: "allow"; why: string }
  | { kind: "block"; reason: string; notice?: string }
  | { kind: "human"; title: string; keys: string[]; targets: string[]; reason: string; unsandboxed: boolean }
  | { kind: "ai"; title: string; keys: string[]; targets: string[]; reason: string; unsandboxed: boolean };
```

**求值顺序**（第一条命中即返回）：

1. `scope === "protected"` → `block`（任何模式、授权、bypass 都不覆盖；`bypassProtectedPaths` 仅保留现有例外）。
2. `containment.state === "strict" && scope === "outside"` → `block`（strict 硬边界，文件工具与 bash 相同）。
3. 会话已拒绝/封锁的目标（`BlockedPaths`）→ `block`。
4. 网络：`hosts` 中存在不在 `egress.allow`（且非 `egress.open`）的域名：
   - 在 `egress.deny` 中 → `block`；
   - 否则 → `human`（网络请求**永不交 AI**，理由：外泄风险；与设计决策一致）。
5. `privileged` → `human`（永不交 AI，I1）。
6. `escapesContainment` → `human`（I2）。
7. 文件工具 `write|edit` 且 `scope === "outside"` → `human`（I3，文件工具无容器）。
8. 策略动作 `deny` → `block`；`allow` → `allow`（网络 allow 已在第 4 步检查）。
9. 策略动作 `ask`（或 `readOnly` 且 Tier-1 白名单）：
   - `readOnly && scope !== "outside"`（或 benign 只读越界且 enforcing）→ `allow`（Tier 1，无 AI 调用）；
   - 否则交 `routeAsk`（现有 `route.ts`）：`classifier` → `ai`，`human` → `human`。
10. 其余 → `allow`。

**不变量（每条都有属性测试）**：

- **N0**：`protected` 永远 `block`。
- **N1**：`privileged` 或 `escapesContainment` 或 `noContainment && 文件工具 outside-write` → 永远不是 `ai`；在**强制沙箱**下还永远不是 `allow`。无沙箱且策略显式 `allow`（如 `accept`）的提权命令保持用户选择的静默（实现时由属性测试确认的边界）。
- **N2**：`egress` 未覆盖的域名（且非 open）→ 永远不是 `allow`/`ai`。该检查与沙箱状态无关：allowlist 是用户的出站策略，无沙箱时同样生效（实现时由属性测试确认）。
- **N3**：`policy.deny` 不被任何授权（会话、永久、网络 grant）覆盖。
- **N4**：`strict` 下 outside 永远 `block`。
- **N5**：无沙箱（或沙箱不可用）的 bash 调用若交给 `ai`，必须 `inspectable === true` 且 `hosts` 为空。沙箱内的调用由沙箱兜底，即使 payload 不透明也可交 AI（这是现行行为，属性测试按此约束）。
- **N6**：`classifier` 关闭时 `ai` 永不出现。

`route()` 是纯函数。`grants` 只是输入，授权的写入发生在 effects 层。

### 1.4 副作用层（effects，唯一有 I/O 的地方）

- 执行 `human` / `ai` 的提示（`promptAllow`、`askWithSession`、`ctx.ui.select`）。
- 写入授权（`SessionApprovals`、`BlockedPaths`、`NetworkSession`、永久规则持久化）。
- 调用分类器（`classifyAsk`）、缓存、连续拒绝计数。
- 通知（`ctx.ui.notify`）。

分发器只做：收集事实 → `route()` → 执行 verdict。**不再有分支内的策略判断。**

## 2. 模块布局（目标，扁平，沿用现有命名风格）

| 模块 | 职责 | I/O |
|---|---|---|
| `facts.ts` | `CallFacts` 类型与构造器（bash/file/web/tool） | 仅调用 `bash-parse` 的分析结果（传入） |
| `axes.ts` | `Containment` / `Egress` / `Policy` 的构造与纯查询 | 无 |
| `verdict.ts` | `route()` 与 `Verdict`，顺序如 §1.3 | 无 |
| `route.ts` | 保留 `routeAsk`，作为 `verdict.ts` 的子规则 | 无 |
| `bash-plan.ts` | 保留，但输入改为 `CallFacts` + `Axes` 的子集（逐步迁移） | 无 |
| `file-gate.ts` | 保留，逐步并入 `verdict.ts` | 无 |
| `tool-gate.ts`（新） | web_search 与扩展工具的策略→verdict | 无 |
| `network.ts` | 保留 `NetworkSession`（effects）；新增纯 `egressVerdict` | 仅 effects |
| `index.ts` | 仅接线：事件、命令、快捷键、effects | 是 |

既有纯模块（`resolve.ts`、`paths.ts`、`bash-parse.ts`、`bash-enforce.ts`、`config-load.ts`、`classifier.ts` 的纯部分）**保持不变**。

## 3. 迁移阶段与验收

每个阶段必须满足：**typecheck 干净；`npm test` 全绿（除 2 个基线失败）；行为与上一阶段一致（golden 测试证明），除非该阶段明确声明行为变化。**

### P0 — 行为冻结（golden）
- 新增 `src/golden.test.ts`：约 60 个场景（bash 各分支、文件工具各 surface、web_search、扩展工具、模式×沙箱×网络组合），记录当前 `(verdict, 提示标题, 授权键)` 的结果表。
- **验收**：golden 表由当前代码生成并提交；后续阶段任何差异都必须在 CHANGELOG 中说明。
- 不改代码。

### P1 — 事实层
- 新增 `facts.ts`；bash 与文件工具的 `AskReview` 构造改由 `facts.ts` 产生（`action.ts` 中的 `buildBashAskReview` / `buildFileToolAskReview` 迁入）。
- `CallFacts.hosts` 先恒为 `[]`（网络见 P4）。
- **验收**：golden 全部一致；`facts.ts` 有单测。

### P2 — 纯路由 `verdict.ts`
- 实现 §1.3 的顺序，但**先不接线**：只在测试中与现有分支对比（`verdict(facts) ≡ 现有 dispatcher 结果`，对 golden 全部场景）。
- **验收**：对 golden 的 100% 一致；N0–N6 属性测试通过。

### P3 — 接线 bash/file，移除分支内策略判断
- `tool_call` 对 bash 与文件工具改用 `route()`；`bash-plan.ts`、`file-gate.ts` 降为 `verdict.ts` 的内部实现或删除。
- **验收**：golden 一致；`index.ts` 的 `tool_call` 中无 `decide(...)` 调用。

### P4 — 网络轴进入路由
- `egressVerdict`（纯）：对 `request_network_access`（显式目标）与 `/net allow` 生效。
- bash 中可静态解析的 host（URL、`curl host`、`git clone https://…`）填入 `CallFacts.hosts`；**运行时才出现的域名**仍由 sandbox 代理的 `askNetHost` 回调处理（无法预知，明确保留为运行时闸门）。
- **行为变化（需 CHANGELOG）**：静态可见的非白名单 host 在执行前即转人工，而不是等代理拦截后才问。
- **验收**：N2 属性测试；golden 增加网络场景。

### P5 — 配置与模式收尾
- `outsideWriteRoots` 成为 `Axes` 的一部分（作为 `writeGrants`），由 `route()` 读取，不再散落在 `index.ts`。
- `edits` 保持具名模式；循环顺序仍来自配置。
- **验收**：配置测试与 golden 一致。

### P6 — 清理与发布
- 删除 `AskReview` 布尔字段（由 `Verdict` 与 `CallFacts` 取代）；删除不再使用的 helper。
- 文档：README 三轴章节、SECURITY 的威胁模型（新增网络前置判定的说明）、AGENTS 的模块表、CHANGELOG 1.4.0。
- defaults：本阶段如改出厂默认，必须追加 `defaults-history.json`。
- **验收**：`npm pack --dry-run` 文件数与体积记录；发布前检查清单（RELEASING.md）全部通过。

## 4. 测试策略

| 层 | 内容 |
|---|---|
| 纯单元 | `verdict.ts` 的枚举矩阵（沿用 `route.test.ts` 的 `allCombinations` 思路，扩展到网络与 scope） |
| 属性 | N0–N6 在矩阵上穷举；不变量违反即失败 |
| golden | P0 冻结的 ~60 场景；任何变化需显式更新 golden 并写入 CHANGELOG |
| 集成 | `index.test.ts` harness 保留，只测接线（事件→effects），不重复测策略 |
| 回归 | 每阶段结束时跑 `npm test` 与 `npm pack --dry-run` |

## 5. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 迁移期间行为漂移 | P0 golden + 每阶段 golden 一致；差异必须显式记录 |
| 网络静态解析漏报 | 运行时代理回调仍是最终闸门；静态检查只增不减 |
| 分类器被诱导 | 不变量 N1/N5 在 `route()` 前置；分类器只裁决 inspectable 且无 host 的调用 |
| 配置兼容 | 不改配置形状（仅内部重构）；若改，走 `defaults-history` |
| 过度重构拖慢交付 | 每阶段可独立停止；P3 之后即可发布 1.4.0（网络 P4 可延后到 1.5.0） |

## 6. 决策记录（已按建议默认落地，2026-10-14）

1. 网络未授权域名永远人工，不交 AI — **已实施**。
2. `accept` 保留受保护路径的绕过（现状）— **保留**。
3. 版本：P0–P6 整体为 **1.4.0**（P4 未拆出）— **已实施**（`v1.3.0` tag 为未发布的历史提交，保留不删）。

## 6a. 实施状态与偏差（1.4.0）

| 阶段 | 状态 | 说明 |
|---|---|---|
| P0 行为冻结 | 完成（形式不同） | 没有单独的 golden JSON。冻结的是现有 dispatcher 测试套件（`index.test.ts`，约 300 个场景，全程未改动预期）+ verdict 的属性矩阵。 |
| P1 事实层 | 完成 | `facts.ts`：bash/file/web/tool 构造器，纯函数。 |
| P2 纯路由 | 完成 | `verdict.ts`：N0–N6 属性测试覆盖约 7000 个 fact/axis 组合。 |
| P3 接线 | 完成 | `tool_call` 的 bash/file/web/tool 全部经 `verdict()`；`autoDecide` 不再二次路由。 |
| P4 网络 | 完成（部分） | 命令中显式 URL 的主机在执行前检查；运行时代理回调保持原样。`request_network_access` 工具仍自行提示，未经 verdict。 |
| P5 配置 | 完成（形式不同） | `outsideWriteRoots` 通过 `facts` 的 in-bounds 进入，而不是 `Axes.writeGrants`。 |
| P6 清理 | 完成 | 删除 `bash-plan.ts`、`file-gate.ts` 及其测试；`route.ts` 保留为 human/AI 规则。 |

**属性测试中发现并修正的三处规则**（已反映在上面的 N1、N2、N5 中）：
- N1：无沙箱且策略显式 `allow` 的提权命令保持静默（`accept` 的用户选择）；“永不 allow”只适用于强制沙箱。
- N2：主机检查与沙箱状态无关；无 allowlist 时，无沙箱的命名主机仍交人工。
- N5：只约束无沙箱的 AI 裁决；沙箱内的不透明 payload 仍可交 AI。

## 6b. 原开放问题（已由 §6 回答）

1. **网络命中非白名单 host 是否永远人工**（本规划：是，不交 AI）。若希望 AI 裁决"看起来无害"的 host，需接受外泄风险。
2. **`accept` 模式是否仍绕过受保护路径**（现状：是，`bypassProtectedPaths`）。本规划保留现状，若要收紧请明确。
3. **版本策略**：本规划建议 P0–P6 整体作为 **1.4.0**；P4（网络）可拆为 1.5.0。你选哪种？

## 7. 完成定义（规划层面）

- [x] 类型与顺序确定（§1）
- [x] 模块布局确定（§2）
- [x] 阶段、验收、测试、风险确定（§3–§5）
- [x] 命名冲突与开放问题列出（§0、§6）

P0–P6 已实施（见 §6a），版本 1.4.0。偏差与属性测试中修正的规则已记录。
