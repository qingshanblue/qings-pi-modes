# 规划 v4（最终）：沙箱解耦 · CC 式模式 · 状态精简

> 2026-10-11 · qings-pi-modes（fork of wynainfo/pi-permission-modes）
> 状态：**已实现**（P1–P4，分支 `feat/sandbox-decouple`）
>
> ⚠️ 设计记录，非现状说明。部分细节已过时：快捷键最终只用 `alt+m / alt+s / alt+n`
> （下文 `ctrl+*` 未采用）；「逃逸永不交给分类器」（commit 3648298）已取代文中
> 「auto：bash 逃逸→AI」。现状以 `README.md` / `SECURITY.md` 为准。

## 0. 最终形态：三条正交轴

| 轴 | 快捷键 | 取值 | 职责 |
|---|---|---|---|
| **审批模式** | `ctrl+q`（`alt+m` 别名）| `plan → ask → edits → auto → accept`（按权限从低到高）| 谁批准 `ask`：人工 / AI / 自动 |
| **沙箱边界** | `ctrl+s`（`alt+s` 别名）| `off / on / strict` | **只管项目边界**：外路径的读写 |
| **网络** | `ctrl+n`（`alt+n` 别名）| `net:filtered ⇄ net:open` | 域名过滤（独立轴）|

切换**不输出任何通知**——footer 状态条是唯一事实来源。

## 1. 沙箱：只管项目边界（三态）

| 档 | 外路径读 | 外路径写 | 项目内 | 越界处理 |
|---|---|---|---|---|
| **off** | ✅ | ✅ | 原样 | 不检测（策略层说了算）|
| **on**（默认）| ✅ | ⛔ OS 拦 | 原样 | 弹窗（批准后非沙箱执行）|
| **strict** | ⛔ | ⛔ | 原样 | **直接 block**，不弹窗 |

- **实现说明**：`strict` 的"外读也拦"走**策略层**（dispatcher 对越界访问直接 block）——bubblewrap 必须让 bash 读系统库，OS 层无法遮蔽全部外读。
- `off` 时**不改变** in-bounds 集合：scratch 与 `/tmp/pi` 仍是"项目内"（`sandboxAllowedRoots` 不再依赖 `enabled`）。
- 配置：顶层 `sandbox` 块 = 共享 profile（`allowWrite/denyWrite/denyRead/allowRead`）；`network` 独立成顶层块（见 §3）。
- 模式可用 `sandboxPin` 钉住状态（内置模式不再使用；保留为高级用法）。
- 会话状态持久化（`perm-sandbox` 条目）+ 子进程转发（`PI_PERMISSION_SANDBOX`）；headless 默认 `on`。
- **废弃**：`SandboxProfile.writable`（"项目内只读"能力随 `ro` 档移除；Plan 改走策略层，见 §2）。遗留配置里的 `writable` 被忽略。

## 2. 模式（CC 对齐，按权限从低到高）

| 模式 | CC 对应 | 读 | 项目内 write/edit | 项目内 bash | 越界/保护路径 |
|---|---|---|---|---|---|
| **plan** | plan | allow | 仅 `*.md`/`*.markdown`，其余 deny | **ask**（只读命令走白名单免问）| 人工/硬拦 |
| **ask** | default | allow | 人工 | 人工 | 人工/硬拦 |
| **edits** | acceptEdits | allow | **自动** | 人工 | 人工/硬拦 |
| **auto** | auto mode | allow | 白名单/规则→放行，否则 **AI** | 白名单→放行，否则 **AI** | 文件→AI；bash 逃逸→AI |
| **accept** | bypassPermissions | allow | 自动 | 自动 | **放行/不拦** |

- `accept`（原 bypass 改名）：**自动接受所有策略决定**，但仍受沙箱边界约束（`strict` 下越界照样 block；`on` 下外写被 OS 拦）。`bypassProtectedPaths: true` 保留（保护路径也接受）。
- `plan` 的只读改走**策略层**（不再用沙箱 ro）：bash 变更命令弹窗、只读命令走白名单；`write/edit` 仅 Markdown；`@plan` 提示词已同步。
- `plan.approveMode` 默认 `edits`。

## 3. 网络：独立轴

- 顶层 `network` 块：`allowedDomains / deniedDomains / askOnBlockedHost`（全局权威；项目只能收紧）。
- `ctrl+n`（`alt+n` 别名）切 `net:filtered ⇄ net:open`，会话级。
- ⚠️ 过滤由沙箱运行时的 socat 代理实现 → **沙箱 `off` 时无法过滤**（显示 `net:open`）。运行时硬约束。

## 4. auto 分类器

- **流水线**：硬拦（保护路径/策略 deny）→ Tier0 `permission.allow` → **Tier1 只读白名单**（`safe-command.ts`，无重定向/命令替换）→ Tier2 模型审批。
- **上下文**：分类器看到**用户最近一条请求**（截断注入）——否则无法区分"合法编辑"与"越权操作"，会大量误拦（实测教训：一个会话 8 次人工审批）。
- 判定**一切** `ask`（包括会脱离沙箱运行的命令）——`auto` 的语义就是"AI 是闸门"。
- fail-closed（模型失败→拒绝）；连续拒绝达上限转人工；裁决缓存。
- `/classifier-model [current | <provider/model>]`；`current` = 跟随会话模型。

## 5. footer 状态（紧凑，默认）

`Auto · sandbox:on · net:filtered · AI:current-model`

- 模式标签着色；沙箱 token 按态配色：`off`=红 · `on`=绿 · `strict`=accent · `unavailable`=黄。
- `net:filtered`(绿) / `net:open`(橙)，仅当沙箱在执行网络过滤时显示。
- `AI:current-model`（跟随会话模型）或 `AI:<provider/model>`。
- `"statusFormat": "verbose"` 可切回长格式。单键 `setStatus("perm", …)`，footer-manager 可管理。

## 6. 实现清单（已落地）

- `schema.ts`：`SandboxState = off|on|strict`；`NetworkConfig`；顶层 `sandbox`/`network`/`statusFormat`；`ModeDef.sandboxPin`；去掉 `writable` 语义。
- `safe-command.ts`（新增）：只读白名单 + 链式安全判定。
- `classifier.ts`：`recentUserRequest` 上下文注入。
- `config-load.ts`：顶层 sandbox/network 校验合并（项目只能收紧）、`sandboxPin` 校验、`persistModeDomains` 写顶层 network。
- `index.ts`：`sessionSandboxState` + `ctrl+s`/`ctrl+q`/`ctrl+n`、`/sandbox off|on|strict`、strict 硬拦、去 trust-all、`lastUserRequest`、去切换通知。
- `awareness.ts`：三态边界文案（strict 行）。
- `status.ts`：token + 三态配色。
- `permission-mode.defaults.json`：五模式（plan/ask/edits/auto/accept）+ 顶层 sandbox/network。
- 测试：258 项（256 通过；2 个为环境性既有失败）。

## 7. 遗留 / 可选

- `classifier.failClosed` 默认 `true`（模型失败→全拦）。备选：`false`（降级人工弹窗，交互式更可用）。**待定**。
- `SandboxProfile.writable` 字段保留但**已忽略**（遗留配置兼容）；后续可从 schema 移除。
- npm 发布（`qings-pi-modes`）与分支合并 push：**待用户定**。
