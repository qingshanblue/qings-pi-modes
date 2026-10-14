# 重新设计：沙箱 × 网络 × 模式 × AI 自动模式（clean-room）

- 日期：2026-10-14
- 状态：设计草案（不改代码，仅对比现有实现）
- 假设：忽略现有的 `plan/ask/edits/auto/accept`、`off/on/strict`、`AI:no-box`、Tier 0/1/2 等既有概念与约定；只保留 pi 扩展宿主的接口现实（`tool_call` 钩子、`ctx.ui.select`、`ctx.modelRegistry`、会话事件）。

## 1. 目标与非目标

**目标**

1. 三个正交轴：**执行环境**（沙箱）、**出站访问**（网络）、**审批策略**（模式）。任意一轴变化不改变另外两轴的语义。
2. 自动模式（auto）由 **AI 分类器**裁决"看得懂、不越权"的动作；人只处理分类器无权裁决的动作。
3. 安全边界落在**可执行的代码检查和内核沙箱**里，不落在提示词里。
4. 决策逻辑是**纯函数**：同样的输入永远得到同样的路由，可以穷举测试。

**非目标**

- 不做通用的权限语言（不引入 DSL）。
- 不替代 OS 沙箱；沙箱关闭时我们明确承认"没有容器"，只是改变路由。
- 不试图完整解析任意 shell 语义；无法审查的内容一律上交人工。

## 2. 核心模型

### 2.1 三轴

| 轴 | 回答的问题 | 取值 | 由谁设置 |
|---|---|---|---|
| **Containment（执行环境）** | 这个动作能不能被内核限制住？ | `enforced`（沙箱生效）、`none`（无沙箱/不可用） | 会话级：用户开关 + 运行时探测 |
| **Egress（出站）** | 网络请求能去哪？ | `allowlist` / `open` | 会话级 + 全局配置的域名表 |
| **Policy（模式）** | 对某类动作默认怎么处理？ | 一张策略表，见 2.3 | 会话级选择，纯数据 |

三轴**只通过一个纯函数**相遇（见 §3）。模式不得读写沙箱配置；沙箱不得知道模式名；网络表不得知道模式。

### 2.2 动作描述（Action）

每个待裁决的工具调用先被归一化为一个不可变描述：

```ts
type Action = {
  tool: string;              // read | write | edit | bash | web_search | <extension tool>
  op: string;                // 归一化操作类：read / write / exec / net / other
  targets: Target[];         // 路径或域名，已 realpath 解析
  scope: "inside" | "outside" | "protected" | "none";  // 相对项目根与保护路径
  privileged: boolean;       // 提权（sudo/doas/su、wrapper 内嵌）
  readOnly: boolean;         // 已知只读（白名单命令或只读工具）
  inspectable: boolean;      // 审查者能否看到完整 payload（脚本、eval、替换、截断）
  payload: string;           // 给人/AI 看的原文（有界）
  escapesContainment: boolean; // 在 containment=enforced 时是否需要越过内核限制
};
```

`Action` 由**确定性代码**生成（bash AST 分析、路径规范化、白名单、提权正则）。AI 只能在这个描述上给判断，不能修改它。

### 2.3 策略表（Policy）

模式就是一张表：`(op, scope) → verdict`，其中 verdict ∈ {`allow`, `ask`, `deny`}。`ask` 的含义由 §3 决定，**不是**"弹人工"。

```jsonc
// 示例：自动模式的全部策略
{
  "read":  { "inside": "allow", "outside": "ask" },
  "write": { "inside": "allow", "outside": "ask" },
  "exec":  { "inside": "ask",   "outside": "ask" },
  "net":   { "inside": "ask",   "outside": "ask" },
  "other": { "*": "ask" }
}
```

- `protected` 不出现在表里：它是硬规则，永远 `deny`。
- 模式可以覆盖 `exec` 的具体命令族（如 `npm test*`→`allow`），但覆盖只能作用于**已 inspectable 且非 privileged** 的 Action。

## 3. 路由（唯一的决策函数）

```ts
route(action, policy, containment, egress, grants): "allow" | "block" | "human" | "ai"
```

按顺序求值，**第一条命中即返回**：

1. `scope == protected` → `block`（硬拦，任何模式、任何授权都不能放行）。
2. `privileged` → `human`（提权永不交 AI）。
3. `containment == enforced && escapesContainment` → `human`（沙箱开启时的逃逸永不交 AI）。
4. 策略查表得 `deny` → `block`；`allow` → `allow`（若 `grants` 已覆盖则同 `allow`）。
5. 策略为 `ask`：
   - `containment == none`（动作将在无沙箱下执行）且 `!inspectable` → `human`。
   - 否则若 `scope == outside` 且 `op == write` 且 `tool` 是**文件工具**（沙箱不适用于文件工具）→ `human`。
   - 否则 classifier 启用 → `ai`；未启用 → `human`。

**不变量**（每条都要有穷举测试）：

- I1 `protected` 永远 `block`。
- I2 `privileged` 永远不是 `ai`/`allow`。
- I3 `enforced` 下的 `escapesContainment` 永远不是 `ai`/`allow`。
- I4 `ai` 只出现在 `inspectable == true` 的 Action 上。
- I5 `allow` 只来自策略表或显式授权；分类器的错误/超时只能导致 `block`（fail-closed，可配置为 `human`）。

Containment 与模式是**两个独立的输入**：切换模式不改变 containment；切换沙箱不改变策略表。这正是解耦的落点。

### 3.1 与"无沙箱 AI 裁决"的关系

沙箱关闭时，`containment == none`，第 5 步决定了非提权、可审查的动作交 AI。这是**显式的信任声明**，应当作为 `containment=none` 下的一个独立开关（全局配置、非项目可设），而不是模式的隐含属性。默认值建议为 `human`（保守），由用户显式打开。

## 4. AI 分类器

- **输入**：`Action` 的结构化字段 + 有界 payload + 用户最近一条请求（截断）+ 项目根与 in-bounds 列表。不输入 secrets（`denyRead` 命中的内容不读取）。
- **输出**：JSON `{allow, risk, reason}`；不可解析 → 拒绝。
- **模型**：全局配置，默认跟随会话模型；项目配置不可指定。
- **缓存**：键 = 模型 + 模式 + Action 的规范化哈希 + 用户请求哈希；TTL 有界。
- **连续拒绝**：按 `(op, scope)` 分桶计数，达到阈值后转 `human` 一次，避免卡死。
- **边界声明**：分类器是**启发式闸门**，不是安全边界。它的输入含模型生成的文本，可被诱导。所以它只能裁决 `inspectable` 且非特权的动作，并且所有硬规则都在它之前。

## 5. 网络轴

- Egress 是独立的域名表（allowlist + denylist）+ 模式无关的会话开关。
- 对 `net` 类 Action：目标域名不在 allowlist → 视为 `op=net, scope=outside`，走 §3 路由（通常 `ask`）。
- Containment 不影响网络判定（即使沙箱关闭，域名表仍生效——这是"网络限制"与"沙箱"解耦的关键）。
- 对 bash 中的网络命令，域名从参数与 URL 中提取；提取不到时标记 `inspectable=false`，走人工。

## 6. 模式切换

- 模式是数据（JSON），内置出厂集合 + 用户自定义；模式名不编码行为之外的任何东西。
- 切换是会话状态；默认不持久化（或持久化为"上次选择"，可配置）。
- 切换模式会重算"已记住的授权"的有效范围：会话授权不跨模式，永久授权按 `(op, scope, 目标)` 存储，与模式名无关。
- 切换 containment 与 egress 不清空授权，但重新路由。

## 7. 配置分层

1. **出厂 defaults**（随包发布，版本化，有 `defaults-history` 审计）。
2. **用户全局**（完全权威）。
3. **项目**（只能收紧：可以加 deny、改 ask 更严格，不能放宽、不能设分类器、不能设 `aiGatesUnsandboxed` 类信任声明）。

schema 严格（`additionalProperties: false`），所有字段在一处定义并有一致性测试。

## 8. 与现有实现的对比

| 维度 | 现有实现（qings-pi-modes 1.2.0） | 重新设计 | 评价 |
|---|---|---|---|
| **轴的正交性** | 模式可携带 `sandbox` 覆盖字段；`box:off` 会改变 auto 的 bash 路由；`alt+s` 与 `alt+m` 各自独立，但模式语义仍部分依赖沙箱状态 | 模式不含沙箱字段；containment 只是路由的一个输入 | 现有：部分耦合。新：完全解耦 |
| **路由逻辑位置** | 分散：`bash-enforce.ts`（bashGate）、`index.ts`（autoDecide、各分支）、`resolve.ts`（策略） | 单一纯函数 `route()` + 穷举表 | 新设计可测性更好 |
| **"是否交 AI / 人"判定** | 调用点各自设置 `escalateToHuman`、`privilege`、`sandboxEscape`、`inspectable`、`neverAI`、`unsandboxed` 等布尔字段，由 `autoDecide` 解读 | 由 `Action` 字段派生，调用点只描述事实 | 现有布尔组合多，漏设即是安全缺口（1.2.0 中 `neverAI` 就是为此补的） |
| **逃逸语义** | `escalateToHuman` 在多处设置；`aiGatesUnsandboxed` 为模式开关，默认影响整个 auto | `escapesContainment` 由 containment + scope 派生；无沙箱是 containment 的一个取值 | 新设计把"逃逸"定义为单一事实 |
| **无沙箱 AI 裁决** | 1.2.0 出厂 auto 默认开启 `aiGatesUnsandboxed`；自定义模式默认关 | 全局开关，默认 `human`，模式不能隐含授予 | 新设计把信任声明从模式里移出 |
| **沙箱** | OS 级（bubblewrap/sandbox-exec），三态 `off/on/strict`，`denyRead` / `allowWrite` 列表 | 相同（这部分现有实现做得好，保留） | 保留 |
| **网络** | 独立 `network.allowedDomains`，`alt+n` 切换；`askOnBlockedHost` | 相同思路，但明确"与沙箱无关"，并纳入 Action 分类 | 基本一致 |
| **分类器** | `classifier.ts` 纯模块 + `index.ts` 接线；缓存、连续拒绝、failClosed、prompt 有界 | 同一套机制，输入改为结构化 Action | 大体保留，输入更规整 |
| **Tier 0/1** | 内置只读白名单 `safe-command.ts` + 策略 `allow` | 合并为策略表 + 只读标记 | 等价 |
| **受保护路径** | `paths.ts` 硬拦，与沙箱 denyWrite 对齐 | 同（`scope=protected` → block） | 保留 |
| **文件工具** | 不走沙箱；出项目写入 → 人工（1.2.0 修复） | 同，显式规则 | 保留 |
| **模式数量** | 五个（plan/ask/edits/auto/accept） | 策略表可任意组合；出厂集合可更少 | 设计上允许减少模式，降低心智负担 |
| **配置分层** | global 权威 / project 只能收紧 / stock + history | 同 | 保留 |
| **测试** | 282 项，多为 dispatcher harness；2 个 NixOS 环境性失败 | 路由表穷举 + 不变量属性测试 + harness 只测接线 | 新设计的安全论证更直接 |

### 8.1 现有实现明确优于重设计的地方

- 沙箱执行路径、denyRead/allowWrite 对齐、strict 态处理，已经过实测，不应为"解耦"而重写。
- 提权检测（AST + 包装命令展开）比正则更稳，应直接复用。
- 配置分层与 defaults-history 审计是防止"旧默认值静默留存"的必要机制，保留。

### 8.2 重设计需要承认的代价

- 路由函数更"正规"，但需要一次性迁移所有调用点；迁移期间两套逻辑并存的风险要用对比测试（同一输入两条路径结果一致）来控制。
- 策略表的表达力弱于现有的 `permission` 映射（现有可写 `bash` 的通配命令映射）；需要保留这种覆盖语法，只是限定在 inspectable 非特权动作上。
- 无沙箱 AI 裁决作为独立开关后，用户需要多做一步配置才能获得 1.2.0 的默认体验。

## 9. 残余风险（设计无法消除）

1. **分类器可被诱导**：只要它看到模型生成的文本，就存在 prompt injection 面。缓解：只裁决 inspectable 动作；硬规则前置。
2. **两步间接执行**：先写脚本、再执行。缓解：执行时对项目内脚本做内容审查；无法审查则 `human`。
3. **未知工具**：扩展工具的副作用不可知。缓解：默认 `ask`→分类器，且其 payload 为 JSON 输入（有界）。
4. **只读越界读**：沙箱本身不拦读取（只拦 denyRead）。设计上接受这一点，并在文档中声明为"尽力而为"。
5. **无沙箱 + AI**：AI 成为唯一闸门。这是用户的显式信任选择，不是安全边界。

## 10. 迁移路径（若采纳）

1. 先实现纯函数 `route()` + `Action` 类型 + 穷举测试，不接线。
2. 在现有 `autoDecide` 旁边并行计算 `route()`，记录分歧（只记录，不影响行为），跑一段真实会话。
3. 分歧为零后切换接线，删除布尔字段组合。
4. 配置 schema 变更走 `defaults-history` 流程；出厂 auto 的 `aiGatesUnsandboxed` 迁移为独立 containment 开关。

## 11. 已拍板的决策与落地状态（2026-10-14）

1. **无沙箱 AI 裁决**：保留在模式上（`aiGatesUnsandboxed`），auto 出厂为 `true`。暂不迁移为全局开关；路由函数已把它作为输入，迁移只需改配置来源。
2. **项目外文件写入**：默认人工；新增全局 `outsideWriteRoots` 静态白名单（不经 AI，受保护路径仍拦）。
3. **模式**：`alt+m` 循环为 `plan → ask → auto → accept`；`accept` 保留；`edits` 保留为具名模式但移出循环。
4. **迁移**：直接切换，不做影子模式。`src/route.ts` 取代 `autoDecide` 中的布尔标记组合，并由穷举测试约束。

**尚未迁移（后续）**：bash 的 `bashGate` 与文件工具的 `decide` 仍是原有路径，只有"人/AI"裁决统一到 `routeAsk`；完整的 `Action` 归一化与三轴纯函数尚未实现。

## 12. 需要你拍板的决策（已由 §11 回答，保留作记录）

1. **无沙箱 AI 裁决**是全局开关（默认 human）还是保留在 auto 模式上（默认 on）？本设计建议全局开关，因为它是信任声明而非模式属性。
2. **文件工具出项目写入**：人工（当前）还是 AI（你最初描述的行为）？本设计保持人工，理由见 §3 第 5 步。
3. **模式数量**：保留五个出厂模式，还是收敛为更少（如 `read-only` / `ask` / `auto`）？
4. **是否采纳迁移路径**（先并行计算、记录分歧，再切换），还是直接重写？
