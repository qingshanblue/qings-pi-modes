/**
 * Bash enforcement — composes the policy action for a bash command with the
 * mode's sandbox profile and the live sandbox readiness into a concrete plan.
 *
 * This is the successor to the old `decideBash`: it keeps the same observable
 * behavior (prompt / sandbox / run / block) but derives it from data — the
 * resolved `Action` plus `sandbox.enabled`/`writable` — instead of a per-mode
 * switch. Pure and SDK-free so the whole matrix is parity-tested.
 *
 * Two halves:
 *   - `bashGate`     — the pre-execution decision (allow / prompt / block) the
 *                      `tool_call` handler acts on.
 *   - `bashExecPlan` — how the replaced bash tool wraps execution (sandboxed?
 *                      read-only?), recomputed at run time from the active mode.
 */

import type { Action, SandboxState } from "./schema.ts";

export type BashGateKind = "allow" | "prompt" | "block";

export interface BashGate {
  kind: BashGateKind;
  /** Prompt title (when kind === "prompt"). */
  title: string;
  /** Block reason (when kind === "block"). */
  reason: string;
  /** When prompting: run UNSANDBOXED once approved (escapes & degraded fallback). */
  onApproveUnsandboxed: boolean;
}

/**
 * Decide what to do with a bash command before it runs.
 *
 * @param action         policy action for the in-project command (resolved from
 *                       the `bash` surface, folding path/external_directory)
 * @param outsideReason  escape/privilege reason from `bashConfirmReason`, or
 *                       undefined when the heuristic finds nothing concerning
 * @param sandboxEnabled the active mode's `sandbox.enabled`
 * @param sandboxReady   whether the OS sandbox is initialized and usable
 *
 * Parity with the old decideBash:
 *   - sandbox disabled, action=allow     → allow (runs unsandboxed via execPlan)
 *   - sandbox disabled, action=ask       → prompt, unsandboxed on approval
 *   - escape / privilege (any other mode)→ prompt, unsandboxed on approval
 *   - in-project but sandbox down        → prompt "sandbox unavailable", unsandboxed
 *   - in-project, ready, action=allow    → allow (runs sandboxed via execPlan)
 *   - in-project, ready, action=ask      → prompt, stays sandboxed on approval
 *   - action=deny                        → block (new capability; built-ins never deny)
 */
export function bashGate(
  action: Action,
  outsideReason: string | undefined,
  sandboxEnabled: boolean,
  sandboxReady: boolean,
): BashGate {
  const gate = (kind: BashGateKind, title: string, reason: string, onApproveUnsandboxed: boolean): BashGate => ({
    kind,
    title,
    reason,
    onApproveUnsandboxed,
  });

  // A hard deny blocks regardless of sandbox state.
  if (action === "deny") return gate("block", "", "bash command denied by policy", false);

  // Disabling containment must not silently disable the policy layer. An
  // unsandboxed mode with an explicit `allow` policy still passes here;
  // a custom unsandboxed mode with `ask` continues to require confirmation.
  if (!sandboxEnabled) {
    if (action === "ask") {
      return gate("prompt", "Allow bash? (sandbox disabled; command will run unsandboxed)", "bash blocked", true);
    }
    return gate("allow", "", "", false);
  }

  // Out-of-project / privilege escalation: prompt, run unsandboxed once approved
  // (the sandbox would block a genuine escape anyway).
  if (outsideReason) return gate("prompt", `Allow bash? (${outsideReason})`, "bash blocked", true);

  // In-project but the sandbox is unavailable: never run silently unprotected.
  if (!sandboxReady) return gate("prompt", "Allow bash? (sandbox unavailable)", "bash blocked", true);

  // In-project, sandbox ready: the policy action drives it.
  if (action === "ask") return gate("prompt", "Allow bash?", "bash blocked", false);
  return gate("allow", "", "", false);
}

export interface BenignOutsideReadInput {
  /** The escape/privilege reason from the AST analysis, if any. */
  outsideReason: string | undefined;
  /** The whole chain is a known read-only command line (`isSafeBashChain`). */
  safeChain: boolean;
  /** The AST parse failed, so the reason came from the heuristic fallback. */
  usedFallback: boolean;
  /** The active mode's `sandbox.enabled`. */
  sandboxEnabled: boolean;
  /** The effective per-session sandbox state. */
  sandboxState: SandboxState;
  /** Whether the OS sandbox is initialized and usable. */
  sandboxReady: boolean;
}

/**
 * Whether an out-of-project bash ask is a *benign read*: a read-only chain
 * (Tier-1 safe — no redirect, no substitution) whose only concern is a PATH
 * outside the project, under a sandbox that will actually enforce (state `on`,
 * runtime ready, AST parsed).
 *
 * Such an access is not a real escape: the OS sandbox already permits
 * out-of-project READS (only `denyRead` secrets are masked), so running it
 * inside the sandbox grants nothing the sandbox would not have — whereas the
 * escape path runs it UNSANDBOXED once approved. Treating it as in-bounds lets
 * the policy/classifier gate it while execution stays sandboxed.
 *
 * Never true for privilege escalation, `strict` (which blocks all outside
 * access outright), a disabled/unavailable/fallback sandbox, or a chain that
 * can write (`>`/backtick) or execute (a command outside the read-only list).
 */
export function isBenignOutsideRead(i: BenignOutsideReadInput): boolean {
  return (
    i.sandboxEnabled &&
    i.sandboxState === "on" &&
    i.sandboxReady &&
    !i.usedFallback &&
    i.safeChain &&
    i.outsideReason !== undefined &&
    i.outsideReason.startsWith("path outside project")
  );
}

export interface BashExecPlan {
  sandboxed: boolean;
  readOnly: boolean;
}

/**
 * How to run an approved bash command. Recomputed at execution time from the
 * active mode's sandbox profile and whether the user granted an unsandboxed
 * escape for this call.
 *
 * Parity: sandboxed when the mode sandboxes AND the runtime is ready AND no
 * escape was approved; read-only iff the mode's sandbox is non-writable (Plan).
 */
export function bashExecPlan(
  sandboxEnabled: boolean,
  sandboxWritable: boolean,
  sandboxReady: boolean,
  approvedUnsandboxed: boolean,
): BashExecPlan {
  return {
    sandboxed: sandboxEnabled && sandboxReady && !approvedUnsandboxed,
    readOnly: !sandboxWritable,
  };
}
