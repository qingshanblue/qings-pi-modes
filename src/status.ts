/**
 * Footer status indicator rendering for the current permission mode.
 *
 * Two formats: **compact** (default) is a short token line
 * `Auto-box:on-net:limit-AI:inherit`; **verbose** keeps the fully-spelled-out
 * form. The mode label is always shown, colored by the mode.
 *
 * Tokens (compact), `-`-separated:
 *   mode                 the mode label (colored)
 *   box:on | strict | off | unavailable   (color-coded per state)
 *   net:limit | free     (the domain-allowlist toggle — alt+n; only while the
 *                         sandbox is enforcing; the NETWORK itself is never off)
 *   AI:inherit | AI:<model>   (only in classifier modes)
 *   AI:no-box                 (classifier mode but the sandbox is off/unavailable:
 *                              the AI cannot gate unsandboxed bash, so those asks
 *                              come to you)
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModeDef, SandboxProfile, SandboxState } from "./schema.ts";
import { networkFiltered, type SandboxController } from "./sandbox.ts";

/** Used only when a caller passes a mode without a sandbox profile (the extension always passes the effective one). */
const NO_SANDBOX: SandboxProfile = { enabled: false, writable: true };

export function updateStatus(
  ctx: Pick<ExtensionContext, "ui">,
  mode: ModeDef,
  sandbox: Pick<SandboxController, "ready" | "warn" | "disabled">,
  networkOpen: boolean,
  classifierLabel?: string,
  compact = true,
  sandboxState?: SandboxState,
): void {
  const t = ctx.ui.theme;
  const sb = mode.sandbox ?? NO_SANDBOX;
  const enforcing = sb.enabled && sandbox.ready;
  const netEnabled = enforcing && networkFiltered(sb);
  const degraded = sb.enabled && !!sandbox.warn && !sandbox.disabled;
  // A classifier mode whose sandbox is not enforcing: the AI can still review
  // file/extension tools, but every bash ask will run unsandboxed once approved,
  // so it is escalated to the human. Surface that instead of the model chip.
  const aiDegraded = !!mode.classifier && !enforcing;

  if (compact) {
    // 颜色即语义（风险/保护梯度）：
    // box: off=红(无边界) on=黄(默认边界) strict=绿(硬边界) unavailable=灰(运行时不可用)
    // net: limit=黄(allowlist 生效) free=绿(本会话不过滤)
    // AI token 不着色（终端默认前景色，通常为白）。
    const state = sandboxState ?? (sb.enabled ? "on" : "off");
    const sbx = !sb.enabled ? "off" : !enforcing ? "unavailable" : state;
    const sbColor = !sb.enabled ? "error" : !enforcing ? "muted" : state === "strict" ? "success" : "warning";
    const sep = " ";
    let status = t.fg(mode.color, mode.label);
    status += sep + t.fg(sbColor, `box:${sbx}`);
    if (netEnabled) status += sep + (networkOpen ? t.fg("success", "net:free") : t.fg("warning", "net:limit"));
    if (mode.classifier) {
      if (aiDegraded) status += sep + t.fg("error", "AI:no-box");
      else if (classifierLabel) status += sep + classifierLabel;
    }
    ctx.ui.setStatus("perm", status);
    return;
  }

  // Verbose: the spelled-out form.
  let status = t.fg(mode.color, mode.label);
  status += " " + t.fg("dim", enforcing ? "(sandboxed in project dir, alt+m)" : "(alt+m)");
  if (degraded) status += " " + t.fg("error", `(!) ${sandbox.warn}`);
  if (netEnabled) {
    status += "  " + (networkOpen ? t.fg("warning", "Network: open (alt+n)") : t.fg("success", "Network: filtered (alt+n)"));
  } else if (enforcing) {
    status += "  " + t.fg("dim", "Network: unrestricted");
  } else {
    status += "  " + t.fg("dim", "Network: open");
  }
  if (mode.classifier) {
    if (aiDegraded) status += "  " + t.fg("error", "AI: without a sandbox, bash asks go to you");
    else if (classifierLabel) status += "  " + t.fg(mode.color, classifierLabel);
  }
  ctx.ui.setStatus("perm", status);
}
