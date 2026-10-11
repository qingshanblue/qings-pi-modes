# 规划 v3（最终）：沙箱解耦 · CC 式模式 · 状态精简

> 2026-10-11 · qings-pi-modes（fork of wynainfo/pi-permission-modes）
> 决策已定：**CC 式模式**、保留 Plan、auto 补白名单、最高档命名 `bypass`。状态：**P1 进行中**。

## 0. 最终模式集（CC 对齐）

| 模式 | CC 对应 | 读 | 项目内 write/edit | 项目内 bash | 越界/保护路径 | 门 |
|---|---|---|---|---|---|---|
| **ask** | default | allow | 人工 | 人工 | 人工 / 硬拦 | 人工 |
| **edits** | acceptEdits | allow | **自动** | 人工 | 人工 / 硬拦 | 人工(部分) |
| **auto** | auto mode | allow | 白名单/规则→放行，否则 **AI** | 白名单→放行，否则 **AI** | 文件→AI；bash 逃逸→人工 | AI |
| **bypass** | bypassPermissions | allow | 自动 | 自动 | **放行 / 不拦** | 无 |
| **plan** | plan | allow | 仅 `*.md` | 允许（**pin ro** 保证只读） | 人工 / 硬拦 | 人工(部分) |

- 循环：`ask → plan → auto → edits → bypass`（Restrictive → Permissive，可配）。
- `bypass` = **免审批**，但沙箱由 `alt+s` **独立**生效（"旧 YOLO" = `bypass` + `alt+s off`）。

## 1. 两条正交轴

- **审批模式**（`alt+m` / `/perm <mode>`）：只描述「谁批准 ask」+ 系统提示 + 工具可见性。
- **沙箱状态**（`alt+s` / `/sandbox off|on|ro`）：`off` / `on`(项目可写) / `ro`(只读)。
- 网络过滤属于沙箱 profile；`alt+n` 保留。

## 2. 沙箱解耦

### 2.1 配置
- 顶层 `sandbox`（全局权威；项目只能收紧）= 原各 mode.sandbox 的公共部分：
  `writable / allowWrite / denyWrite / denyRead / allowRead / network / askOnBlockedHost`。
- 模式去掉自带 `sandbox`；可选 **`sandboxPin?: "off" | "on" | "ro"`**（仅 Plan 用 `ro`）。
- 兼容：模式里残留的 `sandbox` 作为 legacy override 合并（弃用警告）；旧 `enabled:false`/`writable:false` 映射为 pin。

### 2.2 优先级（R1–R4）
- **R1** 有效档 = `mode.sandboxPin ?? sessionSandboxState`
- **R2** `alt+s` 更新 `sessionSandboxState`；模式 pin 时提示"离开后生效"
- **R3** pin 无法满足（`--no-sandbox`/运行时不可用）→ **降级为询问**，绝不静默放行
- **R4** 进出带 pin 的模式只覆盖/恢复有效值，不改 `sessionSandboxState`

### 2.3 运行时
- `sessionSandboxState` 随会话持久化（`appendEntry("perm-sandbox")`）。
- 换模式**不再重启沙箱**；仅**有效档变化**才 `applyProfile()`。
- 子进程转发 `PI_PERMISSION_SANDBOX`；headless 缺省 `on`；`--no-sandbox` 强制 `off`。

## 3. auto 流水线（补白名单）

```
旁路   保护路径/危险模式              → 硬拦
Tier0  permission.allow 规则          → 放行
Tier1  只读/已知安全命令白名单(内置)   → 放行（仅沙箱开启时生效）
Tier2  其余 ask                       → 模型审批
旁路   逃逸 / 会脱沙箱                → 人工（不交模型）
```
- 白名单**窄且偏只读**（`ls/cat/git status/rg…`；禁收 `rm/npm install/git commit`）。
- 共享层：`ask` 也用 Tier1 放行只读 bash，避免"每条 `ls` 都问"。
- 模型 fail-closed；连续拒绝达上限转人工；裁决缓存。

## 4. footer 精简

`Auto ⛨ ▣ ✻`（模式着色 + 沙箱 `⛨`on/`⛨r`ro/`∅`off/`⚠`不可用 + 网络 `▣` + 分类器 `✻`）。
快捷键提示移出常驻状态；新增 `statusFormat: compact|verbose`；仍单键 `setStatus("perm", …)`。

## 5. 分阶段

| 阶段 | 内容 |
|---|---|
| **P1（进行中）** | 解耦沙箱：顶层 profile + 三态 state + `sandboxPin` + `alt+s` + `/sandbox` + 子进程转发 + legacy 迁移。**模式名/边界先不动** |
| P2 | 模式边界重划 + 改名（ask/plan/auto/edits/bypass）+ defaults/history/audit/测试/文档 |
| P3 | footer 紧凑 + `statusFormat` + `/perm status` |
| P4 | README/CHANGELOG、smoke、push |

## 6. 待办小项
- `edits` 命名（暂定 `edits`，可改 `accept`）。
- `bypass + alt+s off` 首次一次性警告。
