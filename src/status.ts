/**
 * Footer status indicator rendering for the current permission mode.
 *
 * Two formats: **compact** (default) is a short glyph line
 * `Ask ⛨ ▣ ✻`; **verbose** keeps the spelled-out form. The mode label is
 * always shown, colored by the mode.
 *
 * Glyphs (compact):
 *   mode      the mode label (colored)
 *   sandbox   ⛨ on (project-writable) · ⛨r read-only · ∅ off · ⚠ unavailable
 *   network   ▣ filtered · ∞ open          (only when the sandbox is enforcing)
 *   ✻         the AI classifier is active   (only in classifier modes)
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModeDef, SandboxProfile } from "./schema.ts";
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
): void {
  const t = ctx.ui.theme;
  const sb = mode.sandbox ?? NO_SANDBOX;
  const enforcing = sb.enabled && sandbox.ready;
  const netEnabled = enforcing && networkFiltered(sb);
  const degraded = sb.enabled && !!sandbox.warn && !sandbox.disabled;

  if (compact) {
    const sandboxGlyph = !sb.enabled ? "∅" : !enforcing ? "⚠" : sb.writable ? "⛨" : "⛨r";
    let status = t.fg(mode.color, mode.label) + " " + t.fg(enforcing ? "success" : "dim", sandboxGlyph);
    if (netEnabled) status += " " + (networkOpen ? t.fg("warning", "∞") : t.fg("success", "▣"));
    if (mode.classifier && classifierLabel) status += " " + t.fg(mode.color, "✻");
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
  if (classifierLabel && mode.classifier) status += "  " + t.fg(mode.color, classifierLabel);
  ctx.ui.setStatus("perm", status);
}
