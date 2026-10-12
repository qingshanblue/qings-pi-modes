# qings-pi-modes

> **Qing 的 pi 权限模式** —— 基于 [wynainfo/pi-permission-modes](https://github.com/wynainfo/pi-permission-modes)
> 的 fork，重构为 **CC 式五模式 + 可解耦的三态边界沙箱 + 独立网络轴 + AI 审批模式**。

[![CI](https://github.com/qingshanblue/qings-pi-modes/actions/workflows/ci.yml/badge.svg)](https://github.com/qingshanblue/qings-pi-modes/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

为 [pi coding agent](https://pi.dev) 提供可切换、**可自定义**的权限模式。每条轴独立可控：

| 轴 | 快捷键 | 内容 |
|---|---|---|
| **审批模式** | `ctrl+q` | 谁来批准 `ask`：人工 / AI 分类器 / 自动接受 |
| **沙箱边界** | `ctrl+m` | OS 级沙箱的**三态**：只管「工作目录之外的读写」|
| **网络** | `ctrl+n` | 域名过滤：`filtered ⇄ open`（独立于沙箱与模式）|

三条轴**完全正交**：切模式不重启沙箱、切沙箱不改审批、切网络不影响其它——footer 状态条是唯一事实来源。

bash 门控使用真正的 **tree-sitter AST**（不是正则），OS 沙箱由
`@anthropic-ai/sandbox-runtime`（Linux 用 bubblewrap）提供。

见 [SECURITY.md](SECURITY.md)（威胁模型）、[CHANGELOG.md](CHANGELOG.md)（变更）、
[CONTRIBUTING.md](CONTRIBUTING.md)（参与开发）、[规划文档](plan/2026-10-11_sandbox-decouple-and-mode-redesign.md)（设计决策）。

---

## 安装

```bash
pi install git:github.com/qingshanblue/qings-pi-modes
```

`pi install` 会自动执行 `npm install`（带入 `@anthropic-ai/sandbox-runtime`、tree-sitter 等运行时依赖）；pi SDK 作为 peer dependency 由宿主提供。常用变体：

- `pi install git:github.com/qingshanblue/qings-pi-modes@v2.4.1` —— 锁定 tag（`pi update` 不会越过它）
- `pi install -l git:github.com/qingshanblue/qings-pi-modes` —— 项目级安装（`.pi/` 内，可与团队共享）
- `pi update --extensions` —— 之后拉取更新

不写入配置直接试用：

```bash
pi -e ./src/index.ts
```

### 系统依赖

**Linux（含 WSL2）** 需要 `PATH` 上有三个包：

```bash
sudo apt install -y bubblewrap socat ripgrep
```

- `bubblewrap` —— 提供 `bwrap` 可执行文件，用于约束 bash（包名 `bubblewrap`，可执行文件 `bwrap`）；
- `socat` —— 网络过滤；缺失时沙箱初始化失败，沙箱模式降级为弹窗；
- `ripgrep` —— 提供 `rg`。

> **Ubuntu 24.04+**（桌面/服务器；WSL2 镜像通常没有）默认启用
> `kernel.apparmor_restrict_unprivileged_userns`，会剥夺 bubblewrap 与运行时
> seccomp 助手所需的能力，所有沙箱命令都会报 `bwrap: ... Operation not permitted`。
> 处理：`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`
> （持久化到 `/etc/sysctl.d/`），或在 AppArmor 配置里给 `bwrap` 授予 userns。
> WSL1 完全没有 user namespaces，沙箱会报告不支持。

**macOS** 使用内置 `sandbox-exec`，无需额外安装。

> **原生 Windows：无沙箱。** 扩展不做 Windows 沙箱，沙箱模式降级为**仅弹窗**：
> 项目内 `bash` 一律询问确认，网络 allowlist 不生效，`allowWrite` 只参与提示
> 边界。需要真正的隔离请用 **WSL2** 并按 Linux 说明操作。

### 验证

1. 在任意项目启动 pi —— footer 显示模式指示，如 `Ask`；
2. 切到 Edits（`ctrl+q` 直到 `Edits`，或 `/permission edits`）：
   - 沙箱可用 → `Edits · sandbox:on …`；
   - 否则 → `Edits · sandbox:unavailable` + 修复提示；
3. `/sandbox` 打印当前沙箱配置（或不可用的原因）。

---

## 三条轴

### ① 模式（审批自动化级别）

`ctrl+q` 循环（按权限从低到高），`/permission <mode>` 直达，`/permission` 弹出选择器。当前模式随会话持久化
（`/reload`、resume、分支导航都保留），显示在 footer。

| 模式 | 行为 |
|------|------|
| **plan** `⏸` | 规划模式。读免费；**只有 Markdown**（`*.md`/`*.markdown`）能在项目内创建/编辑，其它 `edit`/`write` 阻止。变更类 `bash` 会**弹窗询问**（只读命令走白名单免问）。系统提示引导模型：把计划写到 `plan/<YYYY-MM-DD>_<描述>.md`，用 **`show_plan`** 渲染给你审，然后交接：出现 **Accept / Decline** 卡片（见[批准计划](#批准一个计划)）。 |
| **ask** `●` | 每个变更类操作都问你：`bash`/`edit`/`write`/web 搜索/扩展工具。读免费；白名单内的只读 bash 免问。批准的项目内 `bash` 在**沙箱内**运行。 |
| **edits** `✎` | 项目内 `edit`/`write` **不再确认**（= Claude Code 的 accept-edits）；`bash` 仍逐条询问。项目内 `bash` 在**沙箱内**运行。 |
| **auto** `▶` | 读免费；`bash`/`edit`/`write`、越界访问、web 搜索、扩展工具交给 **AI 安全分类器**判定而非逐条问你（见 [AI auto 模式](#ai-auto-模式)）。在**沙箱内**运行。 |
| **accept** `⚡` | **从不询问**（自动接受所有策略决定）——但仍**受沙箱边界约束**：`ctrl+m` 决定它能触达什么。无保护路径兜底。 |

- 循环顺序 = 权限从低到高：`plan → ask → edits → auto → accept`。
- 模式是**数据**：可在 `permission-mode.json` 里调整或新增（见[配置](#配置)）。

### ② 沙箱边界（三态，只管「工作目录外」）

沙箱只有一个职责：**项目边界**。`ctrl+m` 循环三档（`/sandbox off|on|strict` 直达，`/sandbox status` 看详情）：

| 档 | 外路径读 | 外路径写 | 项目内 | 越界处理 |
|---|---|---|---|---|
| **off** | ✅ | ✅ | 原样 | 不做逃逸检测（审批策略仍然生效）|
| **on**（默认）| ✅ | ⛔ OS 拦 | 原样 | **弹窗**（批准后该命令脱离沙箱执行）|
| **strict** | ⛔ | ⛔ | 原样 | **直接 block**，不弹窗（见下）|

- `strict` 的「外读也拦」由**策略层**实现（dispatcher 对越界访问直接拒绝）——
  bubblewrap 必须让 bash 读系统库（`/usr`、`/lib`…），OS 层无法把项目外的读全部
  遮蔽，否则 shell 本身都跑不起来。对模型而言效果等同：碰不到外路径。
- `off` **不改变** in-bounds 集合：scratch 目录与 `/tmp/pi` 仍算"项目内"，
  文件工具不会把它们当越界（沙箱 `off` = 一切照旧，只是没有 OS 约束）。
- 会话状态持久化（`/reload`、resume、分支导航都保留），并转发给子 agent
  （`PI_PERMISSION_SANDBOX`）；headless 子进程无转发值时默认 `on`。
- 模式可用 `sandboxPin` 钉住某档（覆盖 `ctrl+m`，离开该模式恢复会话状态）；
  内置模式都不使用它，保留给自定义模式。

### ③ 网络（独立轴）

见[网络](#network)。域名 allowlist 与「谁审批」「沙箱档」都无关，`ctrl+n` 随时切换。

### ④ AI 审批（auto 模式的闸门）

见 [AI auto 模式](#ai-auto-模式)。

---

## 批准一个计划

Plan 模式（任何 `systemPrompt` 为 `"@plan"` 的模式）里用 `show_plan` 渲染了计划后，
实施只需一步。其它模式里的 `show_plan` 只做展示。模型的交接话术一上屏，就会出现：

```
Plan ready: plan/2026-09-24_feature.md
  > Accept: switch to Edits and implement it
    Decline: keep refining in Plan Mode
```

- **Accept** 切换到批准模式（默认 `edits`），并发送一条真实的用户消息：
  `plan/… 中的计划已批准，立即实施。`——实施回合在 Edits 的系统提示下开始，
  而不是还挂在 Plan 提示下。这条消息和手打的一样可见于记录。
- 批准只覆盖**你看到的内容**：计划文件在展示后被改动过，批准会被拒绝，
  直到模型重新 `show_plan`。
- **Decline**（或 Esc）零成本：你留在 Plan 模式继续打磨。计划保持 pending，
  下次 `show_plan` 才会再次提供。

两条兜底路径覆盖其它入口：

- 计划 pending 期间手动切进批准模式（`ctrl+q`、`/permission edits`）会问
  `Implement plan/... now?`；No 留在 Edits，什么都不发。
- **`/plan approve`** 直接切换并发送，不再询问；**`/plan status`** 显示 pending 的计划。

pending 计划在 `/reload`、resume、分支导航后依然保留（`perm-plan` 会话条目；
已批准的计划不会再提供）。headless 会话没有弹窗、也不会自动切换。两个可选的
全局配置项：

```jsonc
"plan": {
  "approveMode": "edits",                                           // 任何已定义的模式
  "approveMessage": "plan/`{path}` 中的计划已批准，立即实施。"  // {path} = 计划路径
}
```

项目配置不能设置它们。`approveMode` 指向不存在的模式时，批准功能关闭并给出一次性警告。

## 会话 scratch 目录

每个会话有自己的**临时目录**：Linux/macOS 为 `/tmp/pi/<session-id>/`，Windows 为
`<os.tmpdir()>/pi/<session-id>/`（可用 `PI_PERMISSION_TMPDIR` 环境变量覆盖 base，
例如 `/tmp` 挂了 `noexec` 时）。awareness 段落会提到它；bash 内的 `TMPDIR`
指向那里（沙箱内、沙箱外都生效；Windows 另有 `TEMP`/`TMP`）；它**始终**
可写且在 in-bounds 内——即使全局或项目配置把共享的 `/tmp/pi` 从 `allowWrite`
里去掉，这句话依然成立。`/sandbox` 显示路径。

沙箱层面，宿主机上所有 pi 会话共享 `/tmp/pi` base（它在出厂 `allowWrite` 里；
base 以 sticky + world-writable 创建，类似 `/tmp`，各会话目录为 `0700`）。
指令层面，每个会话被告知只用自己的目录——包括 accept 模式（它从不询问，
但也会拿到一个简短的 scratch 指针）。Plan 模式对变更类 bash 走审批，所以
bash 写不进去（和其它模式一样）——但 Write/Edit 工具仍可使用它。

关机时不删除——`/reload` 与会话恢复能再次找到文件（目录以 pi 的 session id
为键）。改为在每次会话启动时，**清理 7 天未动的兄弟目录**；当前目录会在启动时
touch，长会话不会被并发会话清扫掉。base 下的文件与符号链接永不触碰。

## 网络

沙箱开启的模式里，bash 的网络流量按**域名 allowlist** 过滤（默认：npm/pypi/GitHub）。
这不是一堵静默的墙——访问 allowlist 之外的主机时**会暂停并询问你**
（*Allow for session / Allow forever / Deny*），然后放行或失败：

- **`ctrl+n`** 切换本会话的过滤：footer 上 `net:limit`（黄）⇄ `net:free`（绿）；
- **`/network`** —— `status`（allowlist、会话授权/拒绝）、`allow <domain…>`（会话级授权）、
  `open` / `restrict`（同 `ctrl+n`）、`reset`（清空会话授权/拒绝）；
- 模型有 **`request_network_access`** 工具：它列出域名与理由，你批准或拒绝——
  一次可覆盖多个域名（比如一次安装需要的所有主机）。被拒的主机本会话保持拒绝
  （避免安装器反复重试造成的弹窗风暴），被拦的主机会在命令输出里报告，
  模型不用猜代理发生了什么。
- "Allow forever" 把域名持久化到全局配置的 allowlist。把 `network.askOnBlockedHost`
  设为 `false` 可恢复静默拒绝。

授权/拒绝/开关都是**会话级**的（"Allow forever" 除外），即时生效——不重启沙箱。

> ⚠️ 网络过滤由沙箱运行时的 socat 代理实现，因此**沙箱 `off` 时无法过滤**
> （footer 显示 `net:open`）。这是运行时的硬约束。

## AI auto 模式

`auto` 模式把 `ask` 级决定交给 **AI 安全分类器**，而不是人工弹窗——最接近
Claude Code auto mode 的形态。它是唯一带 `"classifier": true` 的内置模式。

**审批流水线**（每条 `ask` 依次经过）：

```
硬拦     保护路径 / 策略 deny            → 直接 block（AI 看不到）
Tier 0   permission.allow 规则           → 放行
Tier 1   只读命令白名单（内置）           → 放行（无重定向/命令替换才合格）
Tier 2   其余 ask                        → 模型审批
旁路     逃逸（越界路径/提权）            → 模型审批（strict 沙箱态下直接 block）
```

- 分类器**进程内**运行，走 pi 的模型层（`ctx.modelRegistry`），复用你真实的
  请求鉴权（models.json、OAuth、环境变量密钥），无需额外配置。
- 模型默认 **`"current"`**——跟随当前会话模型，`/model` 切换它也跟着换，零配置。
  用 **`/classifier-model <provider/model>`** 更换（`/classifier-model current` 切回）；
  持久化到全局配置的 `classifier.model`。
- **看得到你的请求**：审查时会把**你最近一条消息**（截断）一并交给分类器——
  否则它只看操作本身，无法区分"合法编辑"与"越权操作"，会大量误拦。
- **Tier 1 白名单**：已知只读命令（`ls`、`cat`、`grep`、`git status`…）且无
  重定向/命令替换 → **不调用模型**直接放行。`ask` 与 `edits` 共享这份白名单，
  只读命令在哪都不烦你。逃逸永远不合格。
- **fail-closed 默认**：分类器出错/超时/返回不可解析 → **该操作被拦**。全局配置
  `"classifier": { "failClosed": false }` 可改为降级人工弹窗。
- 连续拒绝达 `classifier.maxConsecutiveDenials`（默认 3）→ 转人工一次，避免卡死。
- footer 显示 `AI:current-model`（或 `AI:<模型>`）。

全局 `permission-mode.json` 中的分类器配置：

```json
{
  "classifier": {
    "enabled": true,
    "model": "current",
    "timeoutMs": 15000,
    "failClosed": true,
    "maxConsecutiveDenials": 3
  }
}
```

分类器配置**仅全局**——项目配置不能把审查者换成更弱的模型。要自定义 AI 模式，
给任意模式加 `"classifier": true` 即可。

## 双端审批（Telegram 镜像）

装了 [@kdejaeger/pi-telegram-plus](https://www.npmjs.com/package/@kdejaeger/pi-telegram-plus)
时，所有人工审批（`ask`/`edits`/`plan` 下的弹窗、网络白名单询问）**双面呈现**：

```
笔记本发起的运行 ──→ 终端 overlay + Telegram 按钮卡，两边竞速，先答的赢
手机发起的运行   ──→ Telegram 按钮卡（现状不变）
```

- **终端侧**：自绘 overlay（↑/↓ 或数字键选择，Esc=拒绝）。
- **Telegram 侧**：按钮卡（Allow once / Allow for session / Always / Deny），
  先在终端答过会自动标注「✅ Answered in terminal」并撤下按钮；反之亦然。
- 未连接 Telegram 或无 UI（headless）时自动降级，行为与之前完全一致。

机制上复用 telegram-plus 的双面 `custom()` 桥（guardrails 兼容的 payload 协议），
零 fork、零额外配置。两个已知限制（源于上游按钮集）：TG 侧暂无
「Deny and block path」按钮（TG 的 Deny 即普通拒绝，不封锁路径）；
「Allow forever（持久化到配置）」仅对路径类询问出现在 TG 卡上。

## 快捷键

| 快捷键 | 作用 |
|---|---|
| `ctrl+q` | 循环审批模式：`plan → ask → edits → auto → accept` |
| `ctrl+m` | 循环沙箱态：`off → on → strict` |
| `ctrl+n` | 切换网络过滤：`filtered ⇄ open` |

## 命令

| 命令 | 作用 |
|---|---|
| `/permission [mode]` | 设置模式（无参数：交互式选择器）；`/permission init` 生成全局配置副本；`clear-approvals`、`blocks`、`unblock <path>` |
| `/classifier-model [current \| <provider/model>]` | 查看/切换 auto 审批模型（持久化）|
| `/plan approve` · `/plan status` | 批准并实施 pending 的计划 / 查看 |
| `/network status` · `allow <domain…>` · `open/restrict` · `reset` | 网络过滤（无参数：交互式选择 limit/free）；会话状态与授权 |
| `/sandbox [off\|on\|strict\|status]` | 设置沙箱边界档（无参数：交互式选择器）；`status` 看详情 |

启动旗标：`--perm <mode>`（指定初始模式）、`--no-sandbox`（禁用 OS 沙箱，
降级为 AST/启发式门控 + 弹窗）。

---

## 保护是如何工作的

两层独立机制叠加：

1. **策略引擎**（`allow` / `ask` / `deny`）：每次工具调用按当前模式的策略解析其
   surface（`bash`、`read`/`write`/`edit`/…、横切的 `path` 门、`external_directory`、
   `web_search`、`tool`、`skill`）。`deny` 直接拦、`ask` 走审批（人工或 AI）、
   `allow` 放行。
   **bash** 的命令行用 **tree-sitter**（真 AST）解析，其中每条命令——包括
   `$(...)`、反引号、子 shell、`sh|bash|… -c '…'` 脚本（递归重析）里的嵌套命令——
   分别裁决：匹配 `bash` 模式**与** `path` 门（对拼接命令与每个 token 各匹配一次，
   所以 `"path": { "*.env": "deny" }` 能拦住任何位置的 `cat .env`），并结构化检测
   项目外路径与提权（`env`/`nice`/`xargs` 包装、`bash -c '…'` 脚本都能识破）。
   tree-sitter 语法加载失败时，用整串 token 扫描启发式兜底（局限见
   [SECURITY.md](SECURITY.md)）。
2. **OS 沙箱**（`@anthropic-ai/sandbox-runtime`）：bash 的真正执行约束。模式沙箱
   开启时，项目内 bash 被 `sandbox-exec`（macOS）/ `bubblewrap`（Linux）包装，
   **写**被限制在 `allowWrite`（项目 + `/tmp/pi` + 会话 scratch 目录）内，
   `denyRead` 的密钥路径读起来像不存在——无论命令写了什么。`ctrl+s` 的状态
   决定哪些模式跑在沙箱里（`off` = 不沙箱）；`strict` 额外在策略层拒绝一切越界访问。

所以：策略说 `allow` 的 `bash` 仍在**沙箱内**运行；`ask` 弹窗后沙箱内执行——
越界逃逸或你批准的提权则**脱离沙箱**执行（你亲自授权的）；`deny` 永不执行。

> 注意：只有模型的 `bash` 工具被 OS 沙箱约束。文件工具（`read`/`edit`/`write`/…）
> 由策略引擎与路径检查管，不走 bubblewrap——Plan 的 Markdown-only 规则与保护路径
> 兜底因此都在工具层执行。沙箱内的读保持宽松（仅 `denyRead` 密钥在内核层被拦），
> 沙箱 `off` 时不约束任何东西。完整威胁模型见 [SECURITY.md](SECURITY.md)。

**沙箱感知。** 沙箱模式激活时，每回合向系统提示注入一段事实性的
`## Sandbox & permissions`：合并后 profile 的可写路径、拒绝读、网络 allowlist
（含项目 overlay），以及询问流程如何工作。模型因此会选真正可行的路径与域名
——项目内安装而不是 `~/.npm`，allowlist 内的主机而不是死链——并且知道越界命令
尽管发（你会被问到）。`strict` 态会额外注明"项目外读写被直接拦截"。沙箱降级时
该段会说明并指向确认弹窗。用 `"injectSandboxInfo": false` 让某模式不注入；
沙箱 `off` 的模式不注入。

**工具隐藏。** 模式的 `hideTools` 列表会在模型推理**之前**把这些工具从可用集
移除（走 active-tools allowlist），模型根本不会尝试。它只会**移除**：你自己关掉的
工具（`settings.json` 的 `defaultTools`、`--exclude-tools`）保持关闭，切模式时
精确恢复上一个模式隐藏的部分。列表按字面生效，包括本扩展的 `show_plan`——
不做规划的配置可以去掉它；带 `"@plan"` 提示的模式若隐藏它，加载时会告警
（那个提示让模型调用它）。

**技能与扩展工具。** 技能在 `/skill:<name>` 处按名门控（`skill` surface）；
任何非内置/扩展工具（包括宿主添加的 MCP-as-tool）按工具名门控（`tool` surface）。
在 **ask** 与 **plan** 模式，宿主新加的、还没有规则的工具/技能**首次使用时弹窗**——
*Allow once / Allow this session / Allow forever / Deny*。"Allow forever" 把
`<mode>.permission.<tool|skill>.<name>: "allow"` 持久化到全局配置，之后不再问。
**Accept** 对所有工具/技能免问。（把某模式的 `tool`/`skill` 设为 `"allow"` 可退出
首次询问，设为 `"deny"` 可整体禁止。）

**保护路径。** 除非模式设置 `bypassProtectedPaths`（只有 accept 这么做），
对保护路径的 `edit`/`write` 一律硬拦——按路径段匹配（不是宽松子串），同时匹配
字面目标**和**其符号链接解析后的规范路径（指向 `.git/` 或 dotfile 的链接无法
走私写入）。集合与沙箱运行时的强制拒绝清单一致：`.git/`、`node_modules/`、
`.vscode/`、`.idea/`、`.env`/`.env.*`、`.claude/{commands,agents}/`、常见 dotfile
（`.bashrc`、`.zshrc`、`.profile`、`.gitconfig`、`.npmrc`…）。这在 **edits** 模式
最重要——文件工具不受 OS 沙箱约束。

---

## 配置

模式是数据，按此顺序叠加：

1. **出厂默认** —— `permission-mode.defaults.json`，随扩展发布（五个内置模式）。
   与你编辑的格式相同；复制一份即可自定义，或用 **`/permission init`** 在下面的全局
   路径生成一份副本。
2. `~/.pi/agent/permission-mode/permission-mode.json`（**全局，完全权威**）：
   重定义内置模式、新增模式、设置 `defaultMode` / `cycleOrder` / `sandbox` /
   `network` / `classifier` / `statusFormat`。（路径稳定，与 `pi install` 的安装
   位置无关。）
3. `<项目>/.pi/permission-mode.json`（**项目级，只能收紧**）：只能让已有模式
   *更严格*。其权限策略作为最严格 overlay 叠加（只能更多地 `ask`/`deny`，
   绝不放宽——无论用什么模式写），沙箱按更严格方向 intersect/union，`network`
   同理。项目配置**不能**新增模式、改默认值或放宽任何东西。打开不信任的仓库
   永远不会削弱你的保护。

### 形状

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/qingshanblue/qings-pi-modes/main/schemas/permission-mode.schema.json",
  "defaultMode": "ask",
  "cycleOrder": ["plan", "ask", "edits", "auto", "accept"],
  "sandbox": {                         // 共享 OS 沙箱 profile（一处定义；仅全局）
    "allowWrite": [".", "/tmp/pi"],    // ctrl+s 的三态围绕这份 profile 切换启停
    "denyRead": ["~/.ssh", "~/.aws", "~/.gnupg"],
    "allowRead": [],                   // 在 denyRead 内重新可读（见下方"Strict home"）
    "denyWrite": []
  },
  "network": {                         // 网络边界 —— 独立轴（ctrl+n）
    "allowedDomains": ["github.com", "*.github.com"],
    "deniedDomains": [],
    "askOnBlockedHost": true           // allowlist 外的主机实时询问（false = 静默拒绝）
  },
  "statusFormat": "compact",           // footer 详细度："compact"（默认）或 "verbose"
  "classifier": {                      // AI 安全分类器（供带 "classifier": true 的模式使用）
    "model": "current",                // "current" = 当前会话模型；否则 "provider/model"
    "timeoutMs": 15000,
    "failClosed": true                 // 出错/超时 → 拦截（false = 降级为人工弹窗）
  },
  "modes": {
    "ask": {                           // 这里是示意 —— /permission init 可拿到真实默认值
      "label": "Ask",
      "color": "muted",                // muted | mdLink | accent | error | warning
      "systemPrompt": "@plan",         // 可选；"@plan" = 带日期的 Plan 模式提示
      "injectSandboxInfo": true,       // 把本模式的沙箱边界注入系统提示（默认 true）
      "classifier": false,             // true = 本模式的 ask 交给 AI 分类器
      "sandboxPin": "on",              // 可选：本模式激活期间强制沙箱态（off|on|strict）
      "permission": {
        "path": { "*": "allow", "*.env": "deny" },  // 横切门（deny 覆盖逐工具 allow）
        "external_directory": "ask",                // 项目外边界
        "read": "allow", "grep": "allow", "find": "allow", "ls": "allow",
        "write": "ask", "edit": "ask",
        "bash": { "*": "ask", "sudo*": "deny" },     // 按命令（名 + 参数）匹配
        "web_search": "ask",
        "tool": "allow",                            // 任何非内置/扩展工具，按名
        "skill": "allow"                            // 技能，按名
      },
      "hideTools": []                               // 本模式下对模型隐藏的工具
    }
  }
}
```

**动作**：`allow`（放行）、`ask`（询问）、`deny`（阻止）。surface 的值可以是单个
动作，也可以是 `{ "<glob>": <action> }` 映射：**`*` 匹配包括 `/` 在内的任意字符**、
`?` 匹配单字符、`~`/`$HOME` 会展开、**后匹配的模式获胜**（把 `"*"` 放在最前作默认）；
跨 `path` / `external_directory` / 各 surface 层时**最严格者获胜**。

### 保持全局配置不过期

`/permission init` 会写入一份**完整**的出厂默认副本供你就地修改。副本里的每个值都会
覆盖出厂默认，这意味着之后默认值的变更（例如 2.3.0 把 `allowWrite` 从 `/tmp`
收紧到 `/tmp/pi`）不会到达仍带旧值的副本。两个机制兜底：

- **过期默认告警，每次会话启动。** 全局文件里的每个值都会与当前默认、以及
  自 2.0.0 以来发布过的每个旧默认（`defaults-history.json`，带版本区间的明文
  副本）比对：等于当前默认 → 无事；不同于当前默认但等于某个旧默认 → 按字段
  报告（含两侧值与所属版本区间）；不等于任何默认 → 是你的自定义，保持静默。
  自定义模式永不触发。
- **升级后的一次性提示。** 扩展版本变化且两个版本间默认值有变时，持有全局配置
  的用户会被告知哪些字段变了——重定制的文件即使没有任何值命中旧默认也会被
  提醒去比对。最后见过的版本记录在 `~/.pi/agent/permission-mode/state.json`。

想保留过期值，设 `"acknowledgeDefaults": "<版本>"`（你比对时所针对的版本；
`/permission init` 会在 `$comment` 里记录副本来源）。在出厂默认再次变化前告警静默。
更简单的做法是删掉你无意修改的值：文件是 overlay，省略的项跟随默认。

### 自定义模式

在全局配置的 `modes` 下新增模式，并（可选）加入 `cycleOrder`。示例——一个
"review" 模式：web 搜索关闭、`edit`/`write` 工具整体隐藏：

```jsonc
{
  "cycleOrder": ["plan", "ask", "edits", "auto", "accept", "review"],
  "modes": {
    "review": {
      "label": "Review", "color": "mdLink",
      "sandboxPin": "on",
      "permission": { "read": "allow", "bash": "ask", "web_search": "deny", "write": "deny", "edit": "deny" },
      "hideTools": ["edit", "write"]
    }
  }
}
```

> **Linux glob 限制（仅沙箱文件系统）。** 沙箱运行时在 Linux 上会丢弃
> `allowWrite`/`denyRead`/`denyWrite` 里的 glob 模式——这些列表请用字面路径
> （macOS 支持 glob）。这只影响**沙箱**列表；`permission` 的策略 glob 由本扩展
> 匹配，不受影响。

> **Strict home（可选）。** 项目外的读是"deny 列表"式而非"allow 列表"式：沙箱只拦
> `denyRead`（默认是密钥文件/目录，见出厂默认），`~` 下其余内容都可读以便工具链
> 工作。`allowRead` 可以反转某个模式：先 deny 整个 home，再只放行工具链需要的
> 路径（deny-then-allow；carve-out 内更具体的 `denyRead` 或会话 block 仍然获胜）。
> 粘贴到模式的 `sandbox` 并按需精简：
>
> ```jsonc
> "denyRead": ["~"],
> "allowRead": [".", "/tmp/pi", "~/.gitconfig",
>               "~/.cache", "~/.config", "~/.local", "~/.npm", "~/.nvm",
>               "~/.cargo", "~/.rustup", "~/go", "~/.pyenv", "~/.gem"]
> ```
>
> `.` 必须保留：否则项目本身在沙箱内会读成空。`~/.gitconfig` 也要保留，否则
> 沙箱内每次 `git commit` 都会报 "Author identity unknown"（沙箱把该文件报告为
> 不存在而非拒绝，其它信息不会告诉你原因）。扩展会自动重新放行自己的运行时目录
> （沙箱的 seccomp 助手位于 `~/.pi/agent/...` 下）；运行 pi 的解释器也无需列出，
> 需要列出的只是 agent 命令会执行的东西（`~/.nvm`、`~/.cargo`、项目外的 venv）。
> `~` 下未列出的路径在 bash 内读作**不存在**（Linux 在其上挂一个空目录；无报错、
> 无弹窗），漏掉的工具所需路径会静默失败；`/sandbox` 显示清单，awareness 段落
> 也会告诉模型什么被遮蔽。`~/.config` 与 `~/.local` 是大多数 CLI 存放配置与令牌
> 的地方（`gh` 等）；只有当 agent 完全不需要那些工具时才省略。项目配置可以
> 移除 carve-out，不能新增。
> 注意默认 `denyRead` 里的 `~/.pi/agent/auth.json` 意味着从沙箱内启动的嵌套 `pi`
> 无法鉴权；如果你那样嵌套 pi 会话，请把它移出 denyRead。

> **各平台的临时目录。** 运行时*总是*允许写自己的 `/tmp/claude`，与 `allowWrite`
> 无关；macOS 上 `/tmp` 是 `/private/tmp`，两种写法都处理。macOS 的用户级临时目录
> `/var/folders/…` **不可写**（runtime 0.0.26 时代可以）；沙箱内 bash 的 `TMPDIR`
> 指向会话 scratch 目录。Windows 无 OS 沙箱，那里的 `allowWrite` 只参与提示边界。
> 硬编码 `/tmp` 且无视 `TMPDIR` 的工具在沙箱内会**静默失败**（无弹窗——内核直接拒）；
    需要就把 `/tmp` 加回该模式的 `allowWrite`，代价是与宿主机共享 `/tmp`
    （并设置 `acknowledgeDefaults` 让过期默认告警安静，见上文）。

---

## 禁用

- 临时：`--no-extensions` 启动 pi（禁用全部扩展），或 `--no-sandbox`
  （保留模式但去掉 OS 沙箱）。
- 永久：`pi remove git:github.com/qingshanblue/qings-pi-modes`（与安装方式一致）
  —— 或从 pi 设置里移除对应条目。

---

## 与上游的差异

本 fork 相对 [wynainfo/pi-permission-modes](https://github.com/wynainfo/pi-permission-modes)
的变更（完整清单见 [CHANGELOG.md](CHANGELOG.md)）：

- **模式重划为 CC 式五档**：`plan / ask / edits / auto / accept`（原 default/build/
  automode/yolo 重命名并重定界；`edits` = accept-edits，`accept` 不再强制关沙箱）；
- **新增 `auto` 的 AI 分类器**（`safe-command.ts` 只读白名单 + 用户请求上下文 +
  fail-closed + 连续拒绝转人工）；
- **沙箱解耦为独立三态**（`off/on/strict`，`ctrl+s`），profile 上提为顶层共享块；
  新增顶层 `network` 块与 `statusFormat`；
- **分类器可见用户请求**（修复无上下文导致的误拦）；
- 切换不再弹通知，footer 状态条为唯一事实来源（token 化 + 三态配色）；
- `plan` 的只读改走策略层（bash 变更弹窗 + 白名单），不再依赖沙箱 ro。

---

## 开发

```bash
git clone https://github.com/qingshanblue/qings-pi-modes.git
cd qings-pi-modes
npm install
npm test          # node --test ./src/*.test.ts
npm run typecheck # tsc --noEmit
```

设计决策与实施记录见 [plan/](plan/)；本地加载调试：

```bash
pi install /path/to/qings-pi-modes   # 本地安装（改代码即时生效）
pi -e ./src/index.ts                 # 单次加载
```

---

## License

MIT —— 见 [LICENSE](LICENSE)。基于 wynainfo/pi-permission-modes（MIT）。
