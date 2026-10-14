/**
 * CallFacts — the facts a routing decision is made from, for one tool call.
 *
 * Builders here are PURE: the caller does the I/O (bash AST analysis, script
 * reads) and passes the results in. The routing itself lives in verdict.ts and
 * reads nothing but these facts plus the Axes snapshot. SDK-free.
 */

import type { BashCommand, ScriptReview } from "./bash-parse.ts";
import { escapeTargetFromReason, escapingPaths } from "./bash-parse.ts";
import { normalizeDomain } from "./network.ts";
import { canonicalPath, isOutside, isProtectedWrite } from "./paths.ts";
import { decide, decideBashChain, mostRestrictive } from "./resolve.ts";
import type { Action, ModeDef, Surface } from "./schema.ts";

export type CallKind = "bash" | "file" | "web" | "tool";

export interface CallFacts {
  kind: CallKind;
  /** Tool name as pi reports it. */
  tool: string;
  /** Policy surface used for the session store and the prompt. */
  surface: Surface | "web_search" | "tool";
  /** Display target (path, command, query, tool name). */
  target: string;
  modeLabel: string;
  /** The policy action for this call (bash: already folded for the sandbox state). */
  policy: Action;
  /** The call's path/command lies outside the project (file or bash reason). */
  isOutside: boolean;
  /** The file path is protected (hard block for write/edit). */
  protectedPath: boolean;
  /** The canonical path, for the session block list (file tools). */
  canonicalPath?: string;
  /** Policy for a Markdown-only write mode (friendlier deny message). */
  markdownOnly: boolean;
  /** Writes outside the project: the file tools have no containment, so never AI. */
  writeOutside: boolean;
  /** Tool input for classifier review. */
  input: unknown;
  // ---- bash only ----
  command: string;
  names: string[];
  outsideReason: string | undefined;
  privileged: boolean;
  safeChain: boolean;
  usedFallback: boolean;
  /** Paths the command reaches outside the project (for "Deny and block"). */
  escapeTargets: string[];
  /** Hosts named explicitly in the command (URLs). */
  hosts: string[];
  inspectable: boolean;
  scripts: ScriptReview[];
}

const EMPTY_BASH: Pick<CallFacts, "command" | "names" | "outsideReason" | "privileged" | "safeChain" | "usedFallback" | "escapeTargets" | "hosts" | "inspectable" | "scripts"> = {
  command: "",
  names: [],
  outsideReason: undefined,
  privileged: false,
  safeChain: false,
  usedFallback: false,
  escapeTargets: [],
  hosts: [],
  inspectable: true,
  scripts: [],
};

/** Explicit hosts in a command line: `scheme://host…` authorities. */
export function hostsInCommand(command: string): string[] {
  const out = new Set<string>();
  for (const m of command.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/([^\s/'"`;|&)<>]+)/gi)) {
    const host = normalizeDomain(m[1]);
    if (host) out.add(host);
  }
  return [...out];
}

export interface BashFactsInput {
  command: string;
  root: string;
  bounds: readonly string[];
  mode: ModeDef;
  modeLabel: string;
  /** The mode's sandbox profile is enabled (bash runs under the OS sandbox). */
  sandboxed: boolean;
  commands: BashCommand[];
  outsideReason: string | undefined;
  usedFallback: boolean;
  safeChain: boolean;
  scriptReview: { inspectable: boolean; scripts: ScriptReview[] };
}

export function bashFacts(i: BashFactsInput): CallFacts {
  const { command, mode, commands, outsideReason } = i;
  const own = decide(mode, "bash", command);
  let policy: Action;
  if (i.sandboxed) {
    policy = commands.length > 0 ? decideBashChain(mode, commands) : own;
  } else {
    // Without the OS sandbox the out-of-project layer is the `external_directory`
    // policy, folded in most-restrictively.
    policy = outsideReason
      ? mostRestrictive(own, decide(mode, "external_directory", command, { isOutside: true })) ?? own
      : own;
  }
  const escapeTargets = outsideReason?.startsWith("path outside project")
    ? i.usedFallback
      ? [escapeTargetFromReason(outsideReason, i.root)].filter((t): t is string => t !== undefined)
      : escapingPaths(commands, i.root, i.bounds)
    : [];
  return {
    kind: "bash",
    tool: "bash",
    surface: "bash",
    target: command,
    modeLabel: i.modeLabel,
    policy,
    isOutside: Boolean(outsideReason),
    protectedPath: false,
    markdownOnly: false,
    writeOutside: false,
    input: { command },
    ...EMPTY_BASH,
    command,
    names: [...new Set(commands.map((c) => c.name).filter(Boolean))],
    outsideReason,
    privileged: outsideReason?.startsWith("privilege escalation") === true,
    safeChain: i.safeChain,
    usedFallback: i.usedFallback,
    escapeTargets,
    hosts: hostsInCommand(command),
    inspectable: i.scriptReview.inspectable,
    scripts: i.scriptReview.scripts,
  };
}

export interface FileFactsInput {
  tool: string;
  surface: Surface;
  path: string;
  root: string;
  /** Sandbox-writable roots + outsideWriteRoots (write/edit only) — in-bounds. */
  inBounds: readonly string[];
  mode: ModeDef;
  modeLabel: string;
  /** The mode trusts everything (no protected-path hard block). */
  bypassProtectedPaths: boolean;
}

export function fileFacts(i: FileFactsInput): CallFacts {
  const isWrite = i.tool === "write" || i.tool === "edit";
  const outside = isOutside(i.root, i.path, i.inBounds);
  const protectedPath = !i.bypassProtectedPaths && isWrite && isProtectedWrite(i.root, i.path);
  const policy = decide(i.mode, i.surface, i.path, { isOutside: outside });
  const sfPolicy = i.mode.permission[i.surface];
  const markdownOnly =
    (i.surface === "edit" || i.surface === "write") && typeof sfPolicy === "object" && sfPolicy !== null && sfPolicy["*"] === "deny";
  return {
    kind: "file",
    tool: i.tool,
    surface: i.surface,
    target: i.path,
    modeLabel: i.modeLabel,
    policy,
    isOutside: outside,
    protectedPath,
    canonicalPath: canonicalPath(i.root, i.path),
    markdownOnly,
    writeOutside: outside && isWrite,
    input: { path: i.path },
    ...EMPTY_BASH,
  };
}

/** `query` is the raw tool input: undefined is policy-matched as "(empty)", an empty string as "". */
export function webFacts(query: string | undefined, mode: ModeDef, modeLabel: string): CallFacts {
  const text = query ?? "";
  return {
    kind: "web",
    tool: "web_search",
    surface: "web_search",
    target: text,
    modeLabel,
    policy: decide(mode, "web_search", query ?? "(empty)"),
    isOutside: false,
    protectedPath: false,
    markdownOnly: false,
    writeOutside: false,
    input: { query: text },
    ...EMPTY_BASH,
  };
}

export function toolFacts(name: string, input: unknown, mode: ModeDef, modeLabel: string): CallFacts {
  return {
    kind: "tool",
    tool: name,
    surface: "tool",
    target: name,
    modeLabel,
    policy: decide(mode, "tool", name),
    isOutside: false,
    protectedPath: false,
    markdownOnly: false,
    writeOutside: false,
    input,
    ...EMPTY_BASH,
  };
}
