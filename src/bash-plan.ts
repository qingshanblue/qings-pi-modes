/**
 * Pure planner for a bash tool call (the decision half of the `bash` branch in
 * index.ts). It takes the already-computed facts — the policy action, the AST
 * analysis, the sandbox state — and returns what the dispatcher should do:
 * allow silently, block with a reason, or prompt with a title, session keys,
 * and the escape targets to offer "Deny and block" for. No I/O, no SDK.
 */

import { bashGate, isBenignOutsideRead } from "./bash-enforce.ts";
import { type BashCommand, escapeTargetFromReason, escapingPaths } from "./bash-parse.ts";
import { canonicalPath, displayPath } from "./paths.ts";
import type { Action, SandboxState } from "./schema.ts";

export interface BashAnalysisFacts {
  commands: BashCommand[];
  outsideReason: string | undefined;
  usedFallback: boolean;
}

export interface BashPlanFacts {
  command: string;
  root: string;
  bounds: string[];
  /** The policy action for the command (already most-restrictive folded for unsandboxed modes). */
  action: Action;
  analysis: BashAnalysisFacts;
  /** Every extracted command is on the Tier-1 read-only whitelist, with no redirects/substitutions. */
  safeChain: boolean;
  sandboxEnabled: boolean;
  sandboxState: SandboxState;
  sandboxReady: boolean;
  /** True when the session has blocked this canonical path ("Deny and block"). */
  isBlocked: (canonicalTarget: string) => boolean;
}

export type BashPlan =
  | { kind: "allow" }
  | { kind: "block"; reason: string }
  | {
      kind: "prompt";
      /** Title before the command is appended (see bashTitle in index.ts). */
      title: string;
      /** Session-grant keys: names for a normal command, exact command for escapes. */
      keys: string[];
      /** Escape targets offered for "Deny and block". */
      targets: string[];
      /** Message returned when the human declines. */
      reason: string;
      /** Approval runs the command UNSANDBOXED (a real escape or a degraded fallback). */
      unsandboxed: boolean;
      outsideReason: string | undefined;
      sandboxEnabled: boolean;
      sandboxReady: boolean;
    };

/** Planner for a sandbox-capable mode (the enforcing path with an AST analysis). */
export function planSandboxedBash(f: BashPlanFacts): BashPlan {
  const { command, analysis, root, bounds, action } = f;
  // Tier 1 fast path: a known read-only command in-bounds runs without prompting
  // or classifier review. Escapes never qualify.
  if (action === "ask" && !analysis.outsideReason && f.safeChain) return { kind: "allow" };

  // A read-only, non-privilege out-of-project access under a sandbox that WILL
  // enforce is not a real escape: keep it sandboxed and let policy/classifier gate it.
  const benign = isBenignOutsideRead({
    outsideReason: analysis.outsideReason,
    safeChain: f.safeChain,
    usedFallback: analysis.usedFallback,
    sandboxEnabled: f.sandboxEnabled,
    sandboxState: f.sandboxState,
    sandboxReady: f.sandboxReady,
  });
  const escape = Boolean(analysis.outsideReason) && !benign;

  // `strict`: the boundary is hard — outside access is blocked outright.
  if (f.sandboxState === "strict" && analysis.outsideReason) {
    return { kind: "block", reason: `Sandbox strict: outside-project access is blocked (${analysis.outsideReason})` };
  }

  const gate = bashGate(action, escape ? analysis.outsideReason : undefined, f.sandboxEnabled, f.sandboxReady);
  if (gate.kind === "block") return { kind: "block", reason: gate.reason };
  if (gate.kind !== "prompt") return { kind: "allow" };

  // A benign outside read says WHY it prompts and that it stays sandboxed.
  const title = benign ? `Allow bash? (${analysis.outsideReason}; runs inside the sandbox)` : gate.title;

  // Session keys: ALL names in a chain must be granted for it to pass silently.
  // An escape is keyed on the exact command string (it runs unsandboxed).
  const names = [...new Set(analysis.commands.map((c) => c.name).filter(Boolean))];
  const keys = escape ? [`escape:${command}`] : names.length > 0 ? names : [command];
  const targets =
    escape && analysis.outsideReason?.startsWith("path outside project")
      ? analysis.usedFallback
        ? [escapeTargetFromReason(analysis.outsideReason, root)].filter((t): t is string => t !== undefined)
        : escapingPaths(analysis.commands, root, bounds)
      : [];
  const hit = targets.map((t) => canonicalPath(root, t)).find((t) => f.isBlocked(t));
  if (hit) {
    return { kind: "block", reason: `Path ${displayPath(hit)} is blocked for this session (Deny and block); /perm unblock lifts it` };
  }
  return {
    kind: "prompt",
    title,
    keys,
    targets,
    reason: gate.reason,
    unsandboxed: gate.onApproveUnsandboxed,
    outsideReason: analysis.outsideReason,
    sandboxEnabled: f.sandboxEnabled,
    sandboxReady: f.sandboxReady,
  };
}

export interface UnsandboxedBashFacts {
  command: string;
  /** Policy action after folding in the mode's `external_directory` policy. */
  effective: Action;
  outsideReason: string | undefined;
  safeChain: boolean;
  sandboxReady: boolean;
}

/** Planner for a mode whose sandbox is off: there is no OS confinement at all. */
export function planUnsandboxedBash(f: UnsandboxedBashFacts): BashPlan {
  // Tier 1 whitelist still applies: a read-only command is safe to auto-run.
  if (f.effective === "ask" && !f.outsideReason && f.safeChain) return { kind: "allow" };
  const gate = bashGate(f.effective, f.outsideReason, false, f.sandboxReady);
  if (gate.kind === "block") return { kind: "block", reason: gate.reason };
  if (gate.kind !== "prompt") return { kind: "allow" };
  return {
    kind: "prompt",
    title: gate.title,
    keys: [f.command],
    targets: [],
    reason: gate.reason,
    unsandboxed: gate.onApproveUnsandboxed,
    outsideReason: f.outsideReason,
    sandboxEnabled: false,
    sandboxReady: f.sandboxReady,
  };
}
