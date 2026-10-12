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
 *   net:limit | free     (the domain-allowlist toggle — ctrl+n; only while the
 *                         sandbox is enforcing; the NETWORK itself is never off)
 *   AI:inherit | AI:<model>   (only in classifier modes)
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

  if (compact) {
    // The three sandbox states are color-coded so they read at a glance:
    // off = red (no boundary) · on = green (the default boundary) ·
    // strict = accent (the hard boundary) · unavailable = warning.
    const state = sandboxState ?? (sb.enabled ? "on" : "off");
    const sbx = !sb.enabled ? "off" : !enforcing ? "unavailable" : state;
    const sbColor = !sb.enabled ? "error" : !enforcing ? "warning" : state === "strict" ? "accent" : "success";
    const sep = t.fg("dim", "-");
    let status = t.fg(mode.color, mode.label);
    status += sep + t.fg(sbColor, `box:${sbx}`);
    if (netEnabled) status += sep + (networkOpen ? t.fg("warning", "net:free") : t.fg("success", "net:limit"));
    if (mode.classifier && classifierLabel) status += sep + t.fg(mode.color, classifierLabel);
    ctx.ui.setStatus("perm", status);
    return;
  }

  // Verbose: the spelled-out form.
  let status = t.fg(mode.color, mode.label);
  status += " " + t.fg("dim", enforcing ? "(sandboxed in project dir, ctrl+q)" : "(ctrl+q)");
  if (degraded) status += " " + t.fg("error", `(!) ${sandbox.warn}`);
  if (netEnabled) {
    status += "  " + (networkOpen ? t.fg("warning", "Network: open (ctrl+n)") : t.fg("success", "Network: filtered (ctrl+n)"));
  } else if (enforcing) {
    status += "  " + t.fg("dim", "Network: unrestricted");
  } else {
    status += "  " + t.fg("dim", "Network: open");
  }
  if (classifierLabel && mode.classifier) status += "  " + t.fg(mode.color, classifierLabel);
  ctx.ui.setStatus("perm", status);
}
