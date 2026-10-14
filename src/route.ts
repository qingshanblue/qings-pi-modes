/**
 * Pure routing for an `ask` that the classifier may or may not judge.
 *
 * `autoDecide` (index.ts) used to decide "human or AI" from a pile of boolean
 * flags set at several call sites. The rule now lives here, as a total function
 * over plain facts, so the whole matrix is exhaustively testable and the safety
 * invariants are checked in one place (route.test.ts). SDK-free.
 *
 * Invariants (each one is tested):
 *   I1  privilege escalation is never judged by the AI;
 *   I2  an escape from an enforcing sandbox is never judged by the AI;
 *   I3  a file-tool write/edit outside the project is never judged by the AI;
 *   I4  an action that would run with no containment is judged by the AI only
 *       when the mode opted in AND the payload is fully inspectable;
 *   I5  with no classifier configured, everything goes to the human.
 */

export type AskRoute = "human" | "classifier";

export interface AskFacts {
  /** The classifier is enabled in the global config. */
  classifierEnabled: boolean;
  /** The action would run OUTSIDE the sandbox (no containment) — see index.ts `escalateToHuman`. */
  escalateToHuman: boolean;
  /** Privilege escalation (sudo/su/doas, incl. wrapped). */
  privilege: boolean;
  /** Escape from an enforcing sandbox (the sandbox is on and would be bypassed). */
  sandboxEscape: boolean;
  /** Outside file-tool write/edit: the file tools have no containment at all. */
  neverAI: boolean;
  /** The reviewer can see the whole payload. `false` = opaque/truncated/unresolvable. */
  inspectable: boolean | undefined;
  /** The mode opted in to AI review of unsandboxed actions (`aiGatesUnsandboxed`). */
  unsandboxedAI: boolean;
}

export function routeAsk(f: AskFacts): AskRoute {
  if (!f.classifierEnabled) return "human"; // I5
  if (f.privilege) return "human"; // I1 — regardless of containment
  if (f.sandboxEscape) return "human"; // I2
  if (f.neverAI) return "human"; // I3
  if (!f.escalateToHuman) return "classifier"; // contained: the sandbox bounds it
  if (!f.unsandboxedAI) return "human"; // I4 — opt-in required
  if (f.inspectable === false) return "human"; // I4 — must be fully reviewable
  return "classifier";
}
