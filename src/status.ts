/**
 * Footer status indicator rendering for the current permission mode.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModeDef, SandboxProfile } from "./schema.ts";
import { networkFiltered, type SandboxController } from "./sandbox.ts";

/** Used only when a caller passes a mode without a sandbox profile (the extension always passes the effective one). */
const NO_SANDBOX: SandboxProfile = { enabled: false, writable: true };

/**
 * Render the `perm` status chip:
 *
 *   Build (sandboxed in project dir, alt+m)  Network: filtered (alt+n)
 *   YOLO (alt+m)  Network: open
 *
 * The shortcut hints are always shown — toggling is the least discoverable
 * part of the extension. The network state is color-coded: green while the
 * domain allowlist filters bash traffic, orange when it's open (via alt+n /
 * `/net open`, or because nothing sandboxes in this mode). A degraded sandbox
 * additionally shows a `(!)` warning.
 */
export function updateStatus(
  ctx: Pick<ExtensionContext, "ui">,
  mode: ModeDef,
  sandbox: Pick<SandboxController, "ready" | "warn" | "disabled">,
  networkOpen: boolean,
  classifierLabel?: string,
): void {
  const t = ctx.ui.theme;
  const sb = mode.sandbox ?? NO_SANDBOX;
  const enforcing = sb.enabled && sandbox.ready;
  let status = t.fg(mode.color, mode.label);
  status += " " + t.fg("dim", enforcing ? "(sandboxed in project dir, alt+m)" : "(alt+m)");
  if (sb.enabled && sandbox.warn && !sandbox.disabled) status += " " + t.fg("error", `(!) ${sandbox.warn}`);
  if (enforcing && networkFiltered(sb)) {
    status +=
      "  " + (networkOpen ? t.fg("warning", "Network: open (alt+n)") : t.fg("success", "Network: filtered (alt+n)"));
  } else if (enforcing) {
    status += "  " + t.fg("dim", "Network: unrestricted"); // no allowlist configured: the runtime does not filter
  } else {
    status += "  " + t.fg("dim", "Network: open");
  }
  if (classifierLabel && mode.classifier) status += "  " + t.fg(mode.color, classifierLabel);
  ctx.ui.setStatus("perm", status);
}
