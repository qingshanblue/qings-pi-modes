/**
 * verdict(facts, axes) — THE routing decision for a tool call.
 *
 * Pure and total: the same facts and axes always give the same verdict, and no
 * branch performs I/O. The dispatcher gathers facts (facts.ts), builds the Axes
 * snapshot, calls `verdict`, and carries out the result (prompt, block, notice,
 * session grant). Order and invariants are in plan/2026-10-14_architecture-v2.md
 * §1.3 (N0–N6) and are property-tested in verdict.test.ts.
 *
 * SDK-free.
 */

import { bashTitle, buildBashAskReview, buildFileToolAskReview, compactTitle, FILE_TOOL_VERB, jsonTitle, type AskReview } from "./action.ts";
import { bashGate, isBenignOutsideRead } from "./bash-enforce.ts";
import type { CallFacts } from "./facts.ts";
import { canonicalPath, displayPath } from "./paths.ts";
import { routeAsk } from "./route.ts";
import type { SandboxState, Surface } from "./schema.ts";

/** The non-policy inputs a decision needs. Built by the dispatcher from live state. */
export interface Axes {
  root: string;
  /** The mode's sandbox profile is enabled (bash runs under the OS sandbox). */
  sandboxEnabled: boolean;
  sandboxState: SandboxState;
  /** The runtime is initialized and enforcing (not merely configured). */
  sandboxReady: boolean;
  /** The mode uses the classifier AND the global classifier is enabled. */
  classifierOn: boolean;
  /** The mode opted in to AI review of unsandboxed actions (`aiGatesUnsandboxed`). */
  unsandboxedAI: boolean;
  /** An allowlist applies to hosts named by bash (the mode declares one; not `/net open`). */
  egressFiltered: boolean;
  /** `/net open`: every host allowed for the session. */
  egressOpen: boolean;
  hostAllowed: (host: string) => boolean;
  hostDenied: (host: string) => boolean;
  /** The session has blocked this canonical path ("Deny and block"). */
  blocked: (canonical: string) => boolean;
}

export type Verdict =
  | { kind: "allow" }
  | { kind: "block"; reason: string; notice?: string }
  | {
      kind: "ask";
      /** Who decides: the human prompt, or the AI classifier (no further routing). */
      via: "human" | "ai";
      /** Session-store surface and target (the approval is remembered under these). */
      surface: string;
      target: string | string[];
      title: string;
      /** Message returned when the human declines. */
      reason: string;
      /** Escape targets offered for "Deny and block". */
      denyTargets: string[];
      /** Approval runs the command outside the sandbox. */
      unsandboxed: boolean;
      /** Offer "Allow forever" (extension tools). */
      learnForever: boolean;
      /** After approval, grant this host for the network session. */
      grantHost?: string;
      /** Classifier context (absent for human-only asks). */
      review: AskReview | undefined;
    };

const block = (reason: string, notice?: string): Verdict => (notice ? { kind: "block", reason, notice } : { kind: "block", reason });

export function verdict(f: CallFacts, a: Axes): Verdict {
  // N0: a protected path is never allowed, whatever the mode or the grants.
  if (f.protectedPath) return block(`Path "${f.target}" is protected`, `Blocked write to protected path: ${f.target}`);
  if (f.kind === "file") return fileVerdict(f, a);
  if (f.kind === "bash") {
    const net = networkVerdict(f, a);
    if (net) return net;
    return a.sandboxEnabled ? sandboxedBash(f, a) : unsandboxedBash(f, a);
  }
  if (f.kind === "web") return webVerdict(f, a);
  return toolVerdict(f, a);
}

/** Human-or-AI for an ask, from the pure rule (route.ts). */
function viaFor(a: Axes, facts: Parameters<typeof routeAsk>[0]): "human" | "ai" {
  return routeAsk({ ...facts, classifierEnabled: a.classifierOn }) === "classifier" ? "ai" : "human";
}

function fileVerdict(f: CallFacts, a: Axes): Verdict {
  // N4 + session blocks come before policy.
  if (f.canonicalPath && a.blocked(f.canonicalPath)) {
    return block(`Path "${f.target}" is blocked for this session (Deny and block); /perm unblock lifts it`);
  }
  if (a.sandboxState === "strict" && f.isOutside) {
    return block(`Sandbox strict: outside-project access is blocked (${f.target})`);
  }
  if (f.policy === "deny") {
    if (f.markdownOnly) {
      const message = `${f.modeLabel} allows editing Markdown files only`;
      return block(message, `${message}: ${f.target}`);
    }
    return block(`Path "${f.target}" is blocked by ${f.modeLabel}`);
  }
  if (f.policy === "allow") return { kind: "allow" };
  const verb = FILE_TOOL_VERB[f.tool] ?? f.tool;
  const title = f.isOutside ? `Outside project - allow ${verb} ${compactTitle(f.target, 120)}?` : `Allow ${verb} ${compactTitle(f.target, 120)}?`;
  return {
    kind: "ask",
    via: viaFor(a, {
      escalateToHuman: f.writeOutside,
      privilege: false,
      sandboxEscape: false,
      neverAI: f.writeOutside,
      inspectable: true,
      unsandboxedAI: a.unsandboxedAI,
      classifierEnabled: a.classifierOn,
    }),
    surface: f.surface,
    target: f.target,
    title,
    reason: f.isOutside ? "Access outside project blocked" : "blocked",
    denyTargets: f.isOutside ? [f.target] : [],
    unsandboxed: f.writeOutside,
    learnForever: false,
    review: buildFileToolAskReview({ tool: f.tool, path: f.target, outside: f.isOutside, surface: f.surface as Surface }),
  };
}

/**
 * A host named explicitly by a bash command. Rules:
 *   - `/net open` lifts all host questions for the session;
 *   - a denied host is blocked;
 *   - an allowlisted host passes (a mode with no allowlist leaves it to the sandbox
 *     when one is enforcing);
 *   - anything else is a HUMAN decision, never the AI (N2/N5): outbound data is
 *     not something the reviewer approves on the command text alone.
 */
function networkVerdict(f: CallFacts, a: Axes): Verdict | undefined {
  if (a.egressOpen || f.hosts.length === 0) return undefined;
  const contained = a.sandboxEnabled && a.sandboxReady;
  for (const host of f.hosts) {
    if (a.hostDenied(host)) return block(`Network host "${host}" is denied`);
    if (a.egressFiltered ? a.hostAllowed(host) : contained) continue;
    return {
      kind: "ask",
      via: "human",
      surface: "bash",
      target: `net:${host}`,
      title: `Allow network access to ${host}?`,
      reason: `Network host ${host} is not in the allowlist`,
      denyTargets: [],
      unsandboxed: false,
      learnForever: false,
      grantHost: host,
      review: undefined,
    };
  }
  return undefined;
}

function sandboxedBash(f: CallFacts, a: Axes): Verdict {
  // Tier 1: a known read-only in-bounds command runs silently.
  if (f.policy === "ask" && !f.outsideReason && f.safeChain) return { kind: "allow" };
  // A read-only, non-privilege out-of-project read under an enforcing sandbox is not an escape.
  const benign = isBenignOutsideRead({
    outsideReason: f.outsideReason,
    safeChain: f.safeChain,
    usedFallback: f.usedFallback,
    sandboxEnabled: true,
    sandboxState: a.sandboxState,
    sandboxReady: a.sandboxReady,
  });
  const escape = Boolean(f.outsideReason) && !benign;
  if (a.sandboxState === "strict" && f.outsideReason) {
    return block(`Sandbox strict: outside-project access is blocked (${f.outsideReason})`);
  }
  const gate = bashGate(f.policy, escape ? f.outsideReason : undefined, true, a.sandboxReady);
  if (gate.kind === "block") return block(gate.reason);
  if (gate.kind === "allow") return { kind: "allow" };
  const title = benign ? `Allow bash? (${f.outsideReason}; runs inside the sandbox)` : gate.title;
  const targets = escape ? f.escapeTargets : [];
  const hit = targets.map((t) => canonicalPath(a.root, t)).find((t) => a.blocked(t));
  if (hit) return block(`Path ${displayPath(hit)} is blocked for this session (Deny and block); /perm unblock lifts it`);
  return {
    kind: "ask",
    via: viaFor(a, {
      escalateToHuman: gate.onApproveUnsandboxed,
      privilege: f.privileged,
      sandboxEscape: Boolean(f.outsideReason) && a.sandboxReady,
      neverAI: false,
      inspectable: f.inspectable,
      unsandboxedAI: a.unsandboxedAI,
      classifierEnabled: a.classifierOn,
    }),
    surface: "bash",
    // Without an AST parse, the escape key is the exact command; normal asks key on names.
    target: escape ? [`escape:${f.command}`] : f.names.length > 0 ? f.names : [f.command],
    title: bashTitle(title, f.command),
    reason: gate.reason,
    denyTargets: targets,
    unsandboxed: gate.onApproveUnsandboxed,
    learnForever: false,
    review: buildBashAskReview({
      command: f.command,
      outsideReason: f.outsideReason,
      sandboxReady: a.sandboxReady,
      sandboxEnabled: true,
      unsandboxed: gate.onApproveUnsandboxed,
      scriptReview: { inspectable: f.inspectable, scripts: f.scripts },
    }),
  };
}

function unsandboxedBash(f: CallFacts, a: Axes): Verdict {
  if (f.policy === "ask" && !f.outsideReason && f.safeChain) return { kind: "allow" };
  const gate = bashGate(f.policy, f.outsideReason, false, a.sandboxReady);
  if (gate.kind === "block") return block(gate.reason);
  if (gate.kind === "allow") return { kind: "allow" };
  return {
    kind: "ask",
    via: viaFor(a, {
      escalateToHuman: gate.onApproveUnsandboxed,
      privilege: f.privileged,
      sandboxEscape: false,
      neverAI: false,
      inspectable: f.inspectable,
      unsandboxedAI: a.unsandboxedAI,
      classifierEnabled: a.classifierOn,
    }),
    surface: "bash",
    target: [f.command],
    title: bashTitle(gate.title, f.command),
    reason: gate.reason,
    denyTargets: [],
    unsandboxed: gate.onApproveUnsandboxed,
    learnForever: false,
    review: buildBashAskReview({
      command: f.command,
      outsideReason: f.outsideReason,
      sandboxReady: false,
      sandboxEnabled: false,
      unsandboxed: gate.onApproveUnsandboxed,
      scriptReview: { inspectable: f.inspectable, scripts: f.scripts },
    }),
  };
}

function webVerdict(f: CallFacts, a: Axes): Verdict {
  if (f.policy === "deny") return block(`web search blocked by ${f.modeLabel}`);
  if (f.policy === "allow") return { kind: "allow" };
  const query = f.target;
  return {
    kind: "ask",
    via: viaFor(a, { escalateToHuman: false, privilege: false, sandboxEscape: false, neverAI: false, inspectable: true, unsandboxedAI: a.unsandboxedAI, classifierEnabled: a.classifierOn }),
    surface: "web_search",
    target: "*",
    title: query.trim() ? `Allow web search? — ${compactTitle(query, 160)}` : "Allow web search?",
    reason: "web search blocked",
    denyTargets: [],
    unsandboxed: false,
    learnForever: false,
    review: { tool: "web_search", input: { query }, unsandboxed: false, isOutside: false },
  };
}

function toolVerdict(f: CallFacts, a: Axes): Verdict {
  if (f.policy === "deny") return block(`Tool "${f.target}" blocked by ${f.modeLabel}`);
  if (f.policy === "allow") return { kind: "allow" };
  return {
    kind: "ask",
    via: viaFor(a, { escalateToHuman: false, privilege: false, sandboxEscape: false, neverAI: false, inspectable: true, unsandboxedAI: a.unsandboxedAI, classifierEnabled: a.classifierOn }),
    surface: "tool",
    target: f.target,
    title: `Tool "${f.target}" — first use in ${f.modeLabel}; allow?\n${jsonTitle(f.input, 240)}`,
    reason: "tool blocked",
    denyTargets: [],
    unsandboxed: false,
    learnForever: true,
    review: { tool: f.target, input: f.input, unsandboxed: false, isOutside: false },
  };
}
