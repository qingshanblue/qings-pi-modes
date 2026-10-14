/**
 * Mode schema — the declarative vocabulary a permission mode is built from.
 *
 * A MODE is data: a named bundle of a sandbox profile, an allow/ask/deny
 * permission policy keyed by surface, plus UI metadata (label/color), an
 * optional system-prompt injection, and a hidden-tools list. The built-in
 * modes ship in `permission-mode.defaults.json`; users override or extend them in
 * `permission-mode.json`.
 *
 * This module is pure and SDK-free (string-literal unions, not enums, for Node's
 * strip-only TS) so the resolution engine and loader can be unit-tested without
 * the host.
 */

import type { PlanApprovalConfig } from "./plan-approval.ts";
import type { ClassifierConfig } from "./classifier.ts";

/** Three-state permission outcome (opencode-compatible semantics). */
export type Action = "allow" | "ask" | "deny";

/** A glob pattern → action map. The `"*"` key is the universal fallback. */
export type PatternMap = Record<string, Action>;

/** A surface value is either a shorthand action or a pattern-map. */
export type SurfaceValue = Action | PatternMap;

/**
 * The gateable surfaces.
 *   path                cross-cutting gate over ALL file access (incl. bash args);
 *                       a `path` deny overrides any per-tool allow.
 *   external_directory  the out-of-project (CWD-escape) boundary.
 *   read/write/edit/grep/find/ls   per-file-tool, matched against `input.path`.
 *   bash                per-command patterns, matched against each extracted
 *                       command name (+ path-like args via path/external_directory).
 *   web_search          the web_search tool.
 *   tool                generic surface for any non-builtin (extension) tool, by name.
 *   skill               skills, matched by skill name (gated via the input event).
 */
export type Surface =
  | "path"
  | "external_directory"
  | "read"
  | "write"
  | "edit"
  | "grep"
  | "find"
  | "ls"
  | "bash"
  | "web_search"
  | "tool"
  | "skill";

/** The set of valid surface names, for loader validation. */
export const SURFACES: Surface[] = [
  "path",
  "external_directory",
  "read",
  "write",
  "edit",
  "grep",
  "find",
  "ls",
  "bash",
  "web_search",
  "tool",
  "skill",
];

/** Surfaces that resolve against a filesystem path (subject to the `path` gate). */
export const FILE_SURFACES: Surface[] = ["read", "write", "edit", "grep", "find", "ls", "bash"];

/** Footer label colors (semantic theme tokens, no icons). The shipped modes map
 *  them to a risk gradient: plan=success(绿，只读最安全) → ask=muted(人工把关) →
 *  edits=mdLink(自动改文件) → auto=warning(AI 判定) → accept=error(无审批，最高风险). */
export type ModeColor = "muted" | "mdLink" | "accent" | "error" | "warning" | "success";

/** The runtime sandbox state: `off` (no OS sandbox), `on` (outside write-blocked,
 *  outside reads allowed), `strict` (outside read AND write blocked at the
 *  policy layer — the OS cannot mask system reads without breaking the shell). */
export type SandboxState = "off" | "on" | "strict";

/**
 * The OS-sandbox profile for a mode. `enabled:false` runs bash unsandboxed
 * (an unsandboxed mode); `writable:false` confines bash to reads (Plan). The filesystem/network
 * fields feed @anthropic-ai/sandbox-runtime.
 *
 * As of the sandbox decoupling, the profile is normally the TOP-LEVEL
 * `PermissionModeConfig.sandbox`; a mode's own `sandbox` is a legacy override
 * (still honored) and `sandboxPin` is the supported way to force a state.
 */
export interface SandboxProfile {
  enabled: boolean;
  writable: boolean;
  allowWrite?: string[];
  denyWrite?: string[];
  denyRead?: string[];
  /**
   * Paths readable again inside a `denyRead` region (deny-then-allow). A
   * more specific `denyRead` inside an `allowRead` entry still wins, and so
   * does a session block. Project configs may only remove entries.
   */
  allowRead?: string[];
  network?: { allowedDomains?: string[]; deniedDomains?: string[] };
  /**
   * Ask the user live when bash tries to reach a host outside the allowlist
   * (the connection waits while they decide). Defaults to true; false denies
   * silently as before. Project configs may set it to false (stricter), never
   * back to true.
   */
  askOnBlockedHost?: boolean;
}

/** One named mode. */
export interface ModeDef {
  label: string;
  color: ModeColor;
  /**
   * Optional system-prompt injected via before_agent_start while this mode is
   * active. The sentinel `"@plan"` is resolved at runtime to the date-stamped
   * `planModeSystemPrompt(today)`; any other string is injected verbatim.
   */
  systemPrompt?: string;
  /**
   * Inject a factual description of this mode's sandbox boundaries (writable
   * paths, denied reads, network allowlist, prompt flow) into the system
   * prompt each turn, so the model picks paths/domains that work instead of
   * discovering the sandbox through failed commands. Defaults to true; set
   * false to opt out. Modes with `sandbox.enabled: false` never inject.
   */
  injectSandboxInfo?: boolean;
  sandbox?: SandboxProfile;
  /**
   * Force the sandbox state while this mode is active (`off` | `on` | `strict`).
   * Overrides the session's `alt+s` state, restored when the mode is left.
   * No built-in mode ships one; absent = use the session state.
   */
  sandboxPin?: SandboxState;
  permission: Partial<Record<Surface, SurfaceValue>>;
  /** Tool names hidden from the model while this mode is active. */
  hideTools?: string[];
  /**
   * Skip the hard protected-path backstop (`.git`, `.env`, dotfiles) for file
   * tools. Defaults to false — the backstop applies in every mode unless a mode
   * explicitly trusts everything. Only a mode that opts in sets this true.
   */
  bypassProtectedPaths?: boolean;
  /**
   * Route this mode's `ask` decisions through the AI safety classifier instead
   * of the human prompt (see `classifier.ts`). The model, timeout and
   * fail-closed policy come from the top-level `classifier` config block. The
   * shipped `automode` is the only built-in that sets it.
   */
  classifier?: boolean;
  /**
   * Internal (NOT part of the JSON schema): a project config's tighten-only
   * permission overlay, set by the loader. The resolver folds it in as an extra
   * most-restrictive layer, so it can only tighten the base policy, never loosen
   * it — regardless of the patterns it contains.
   */
  projectOverlay?: Partial<Record<Surface, SurfaceValue>>;
}

/** The network boundary: an independent axis (does not follow the sandbox state). */
export interface NetworkConfig {
  allowedDomains?: string[];
  deniedDomains?: string[];
  /** Ask the user live when bash reaches a host outside the allowlist (default true); false = silent deny. */
  askOnBlockedHost?: boolean;
}

/** Top-level config: the mode registry plus cycle/default metadata. */
export interface PermissionModeConfig {
  $schema?: string;
  defaultMode: string;
  /** `alt+m` cycle order; also the display order. */
  cycleOrder: string[];
  modes: Record<string, ModeDef>;
  /**
   * The shared OS-sandbox profile (allowWrite / denyRead / …). The per-mode
   * `sandbox` is a legacy override; `sandboxPin` forces a state. Global-only
   * authority; a project may only tighten it.
   */
  sandbox?: SandboxProfile;
  /**
   * The network boundary — an INDEPENDENT axis with its own `alt+n` toggle.
   * Global-only authority; a project may only tighten it. NOTE: the filter is
   * implemented by the sandbox runtime's proxy, so it only applies while the
   * sandbox state is not `off`.
   */
  network?: NetworkConfig;
  /** One-step plan approval settings (plan-approval.ts). Global config only. */
  plan?: PlanApprovalConfig;
  /**
   * AI safety classifier settings (classifier.ts). Global config only — a
   * project must not be able to point the reviewer at a weaker model.
   */
  classifier?: Partial<ClassifierConfig>;
  /** Footer status verbosity: "compact" (default) or "verbose". Global config only. */
  statusFormat?: "compact" | "verbose";
}

/** Sentinel a mode's `systemPrompt` can use to request the Plan-mode prompt. */
export const PLAN_PROMPT_SENTINEL = "@plan";

// The shipped default modes live in `permission-mode.defaults.json` at the package
// root (loaded by config-load.ts), so the defaults are data in the same format
// users edit. The emergency in-code fallback lives in config-load.ts.

/**
 * System-prompt addition injected while Plan is active (resolved from the
 * `"@plan"` sentinel). `today` is an ISO date (YYYY-MM-DD) stamped at call time
 * so the suggested plan filename uses the current date.
 */
export function planModeSystemPrompt(today: string): string {
  return [
    "## Plan is active",
    "",
    "In this mode only Markdown files can be created or edited (with the Write/Edit",
    "tools); bash commands that would change anything are not permitted here, so do",
    "not change code now.",
    "",
    "If the user asks you to plan a task (a feature, refactor, investigation, or any",
    "multi-step change):",
    `1. Use the **Write** tool to create the plan file at \`plan/${today}_<short-kebab-description>.md\`.`,
    "   Write creates the `plan/` directory automatically — do NOT run `mkdir` or any",
    "   other bash command to make the folder (mutating bash is not permitted in this",
    "   mode).",
    "2. Keep it concise but actionable — context, approach, the files to change, and",
    "   how to verify.",
    "3. Then call the **show_plan** tool with that file path — it renders the plan in",
    "   the terminal for the user. Do NOT paste the plan text into your reply; show_plan",
    "   displays it.",
    "4. After show_plan, do NOT summarize, recap, or describe the plan, and add no other",
    "   commentary. Your entire reply must be a single short line: ask the user to review",
    "   the plan and accept it in the prompt that follows (or press `alt+m` / run `/plan approve`).",
    "",
    "For quick questions that aren't planning tasks, just answer normally.",
  ].join("\n");
}
