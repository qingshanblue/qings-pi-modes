import { canonicalPath } from "./paths.ts";
import { expandHome } from "./resolve.ts";
import type { ScriptReview } from "./bash-parse.ts";
import type { Surface } from "./schema.ts";

/** Facts the human/AI router needs about a pending `ask` (route.ts). */
export interface AskReview {
  /** Tool name as the model should see it (e.g. `bash`, or `skill:<name>`). */
  tool: string;
  /** The tool input payload (the classifier bounds it before sending). */
  input: unknown;
  /** True when the target lies outside the project. */
  isOutside?: boolean;
  /** The command would run outside an enforcing sandbox. */
  unsandboxed?: boolean;
  /** True for privilege escalation — always human. */
  privilege?: boolean;
  /** True for a genuine escape from an enforcing sandbox — always human. */
  sandboxEscape?: boolean;
  /** False when the reviewer cannot fully inspect the payload. */
  inspectable?: boolean;
  /** Direct script payloads included in the classifier context. */
  scripts?: ScriptReview[];
  /** The action would run outside containment. */
  escalateToHuman?: boolean;
  /** Outside file-tool write/edit: never AI, even with aiGatesUnsandboxed. */
  neverAI?: boolean;
}

export interface BashReviewInput {
  command: string;
  outsideReason: string | undefined;
  sandboxReady: boolean;
  sandboxEnabled: boolean;
  unsandboxed: boolean;
  scriptReview: { inspectable: boolean; scripts: ScriptReview[] };
}

export function buildBashAskReview(input: BashReviewInput): AskReview {
  return {
    tool: "bash",
    input: { command: input.command },
    isOutside: Boolean(input.outsideReason),
    escalateToHuman: input.unsandboxed,
    privilege: input.outsideReason?.startsWith("privilege escalation") === true,
    sandboxEscape: Boolean(input.outsideReason) && input.sandboxReady && input.sandboxEnabled,
    inspectable: input.scriptReview.inspectable,
    scripts: input.scriptReview.scripts,
    unsandboxed: input.unsandboxed,
  };
}

export interface FileToolReviewInput {
  tool: string;
  path: string;
  outside: boolean;
  surface: Surface;
}

export function buildFileToolAskReview(input: FileToolReviewInput): AskReview {
  const outsideWrite = input.outside && (input.surface === "write" || input.surface === "edit");
  return {
    tool: input.tool,
    input: { path: input.path },
    isOutside: input.outside,
    escalateToHuman: outsideWrite,
    neverAI: outsideWrite,
    inspectable: true,
    unsandboxed: outsideWrite,
  };
}

/** `alt+m` cycles only the chosen order; named-only modes are appended for help text. */
export function allModeNames(cycleOrder: readonly string[], modes: Record<string, unknown>): string[] {
  return [...cycleOrder, ...Object.keys(modes).filter((name) => !cycleOrder.includes(name))];
}

/** Picker entries for the cycle modes only (`edits` stays named-only when omitted). */
export function modePickerOptions(cycleOrder: readonly string[], labels: Record<string, string | undefined>, current: string): string[] {
  return cycleOrder.map((name) => `${name === current ? "✓" : " "} ${labels[name] ?? name}`);
}

/** Static outside-project write grants for file tools. */
export function fileToolAllowedRoots(root: string, surface: Surface, outsideWriteRoots: readonly string[] = []): string[] {
  if (surface !== "write" && surface !== "edit") return [];
  return outsideWriteRoots.map((raw) => canonicalPath(root, expandHome(raw)));
}
