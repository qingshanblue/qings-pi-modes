/**
 * Dual-surface approval prompts: terminal overlay + Telegram card, first answer wins.
 *
 * Approvals that arise from either surface can be completed from either surface.
 * The mechanism rides on @kdejaeger/pi-telegram-plus's hybrid UI: it dual-surfaces
 * `ctx.ui.custom()` prompts whose payload was announced on the events bus first
 * (the same protocol its guardrails/ask-user bridges use), racing the terminal
 * component against the Telegram inline keyboard. Without telegram-plus the same
 * code path degrades to a plain terminal overlay.
 *
 * Payload protocol (guardrails-compatible so telegram-plus renders buttons):
 *   { prompt: { id }, feature: "pathAccess" | "permissionGate",
 *     action: { command? , path? , origin? }, context: { toolName?, input? }, reason }
 * Telegram answers come back as guardrails string values ("allow", "allow-session",
 * "allow-file-always", "deny", …) which are mapped to the caller's option labels.
 */

import type { ExtensionContext, ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";

export type GuardrailsKind = "pathAccess" | "permissionGate";

export interface GuardrailsPayload {
  prompt: { id: string };
  feature: GuardrailsKind;
  action: { command?: string; path?: string; origin?: string };
  context: { toolName?: string; input?: { command?: string } };
  reason?: string;
}

/** The semantic choices a Telegram answer can express. */
export type AskSemantic = "once" | "session" | "forever" | "deny";

let promptCounter = 0;

/** Build a guardrails-shaped payload describing an ask (tool + subject + why). */
export function guardrailsPayload(kind: GuardrailsKind, opts: {
  tool?: string;
  command?: string;
  path?: string;
  reason?: string;
} = {}): GuardrailsPayload {
  promptCounter += 1;
  return {
    prompt: { id: `pm-ask-${promptCounter}-${process.pid}` },
    feature: kind,
    action: kind === "pathAccess" ? { path: opts.path, origin: opts.tool } : { command: opts.command ?? opts.path },
    context: { toolName: opts.tool, input: opts.command ? { command: opts.command } : undefined },
    reason: opts.reason,
  };
}

/**
 * Map a guardrails button value (the Telegram side) to a semantic choice.
 *
 * EXACT values only — the earlier substring test (`value.includes("session")`)
 * was fail-open: `deny-session`, `no-session`, or `block-always` from any
 * sender would have granted a session or forever approval the label never
 * offered. Anything not in this table denies.
 */
const TG_VALUES: Record<string, AskSemantic> = {
  allow: "once",
  "allow-session": "session",
  "allow-file-once": "once",
  "allow-file-session": "session",
  "allow-file-always": "forever",
  "allow-dir-once": "once",
  "allow-dir-session": "session",
  "allow-dir-always": "forever",
  deny: "deny",
  cancel: "deny",
};

export function tgValueToSemantic(value: string | undefined): AskSemantic {
  if (value === undefined) return "deny";
  return TG_VALUES[value] ?? "deny";
}

/** Which option label each semantic choice resolves to (per call site). */
export type SemanticLabels = Partial<Record<AskSemantic, string>>;

export interface DualSelectUI {
  hasUI: boolean;
  select(title: string, options: string[]): Promise<string | undefined>;
  custom(factory: unknown, options?: unknown): Promise<unknown>;
}

/**
 * Dual-surface select: renders `options` as a terminal overlay AND (when
 * telegram-plus is connected) as a Telegram button card; resolves with the
 * chosen option label, or `undefined` when dismissed. Falls back to a plain
 * `ui.select` when `custom` is unavailable (RPC/print hosts) so behavior is
 * never worse than before.
 */
export async function dualSelect(
  ui: DualSelectUI,
  pi: ExtensionAPI | undefined,
  args: {
    title: string;
    options: string[];
    payload: GuardrailsPayload;
    /** Option label per semantic choice — Telegram answers resolve through this. */
    semantic: SemanticLabels;
  },
): Promise<string | undefined> {
  if (typeof ui.custom !== "function" || !ui.hasUI) return ui.select(args.title, args.options);
  const emit = (event: string) => {
    try {
      pi?.events?.emit(event, args.payload);
    } catch {
      /* the bus is best-effort; the terminal prompt still works */
    }
  };
  emit("guardrails:prompt:opened");
  try {
    const value = (await ui.custom(
      (_tui: unknown, theme: Theme, _kb: unknown, done: (v: string | undefined) => void) =>
        new AskOverlayComponent(args.title, args.options, theme, done),
      { overlay: true },
    )) as string | undefined;
    return resolveAnswer(value, args.options, args.semantic);
  } catch {
    return undefined;
  } finally {
    emit("guardrails:prompt:closed");
  }
}

/** Resolve whichever surface answered (a label, or a guardrails value) into an option label. */
export function resolveAnswer(value: string | undefined, options: string[], semantic: SemanticLabels): string | undefined {
  if (value !== undefined && options.includes(value)) return value; // terminal answer: already a label
  return semantic[tgValueToSemantic(value)]; // Telegram answer: map by meaning
}

const BOX = { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" } as const;

/**
 * Strip C0 control characters (ESC included) from text we did not author: the
 * prompt title and target paths carry tool-call text, and a crafted command
 * must not be able to emit terminal control sequences through the overlay.
 * Display only — the value handed back to the caller is never rewritten.
 */
function sanitize(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]/g, "");
}

/**
 * Terminal side of a dual prompt: an overlay list with the same visual language
 * as pi's menus. ↑/↓ move, Enter picks, Esc denies (dismiss = deny), 1-9 pick directly.
 */
export class AskOverlayComponent {
  readonly width: number;
  focused = false;

  private selected = 0;
  private title: string;
  private options: string[];
  private displayTitle: string;
  private displayOptions: string[];
  private theme: Theme;
  private done: (value: string | undefined) => void;

  constructor(title: string, options: string[], theme: Theme, done: (value: string | undefined) => void) {
    this.title = title;
    this.options = options;
    this.theme = theme;
    this.done = done;
    // Display strings are sanitized (control characters stripped); `options` stays
    // authoritative for the value handed back on selection.
    this.displayTitle = sanitize(title);
    this.displayOptions = options.map(sanitize);
    const longest = Math.max(visibleWidth(this.displayTitle), ...this.displayOptions.map((o) => visibleWidth(o)));
    this.width = Math.min(100, longest + 8);
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) return this.done(undefined);
    if (matchesKey(data, "return")) return this.done(this.options[this.selected]);
    if (matchesKey(data, "up")) this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, "down")) this.selected = Math.min(this.options.length - 1, this.selected + 1);
    else if (/^[1-9]$/.test(data)) {
      const idx = Number(data) - 1;
      if (idx < this.options.length) return this.done(this.options[idx]);
    }
  }

  render(_width: number): string[] {
    const th = this.theme;
    const innerW = this.width - 2;
    const pad = (s: string, len: number) => s + " ".repeat(Math.max(0, len - visibleWidth(s)));
    const row = (content: string) => th.fg("border", BOX.v) + pad(content, innerW) + th.fg("border", BOX.v);

    const lines: string[] = [];
    lines.push(th.fg("border", `${BOX.tl}${BOX.h.repeat(innerW)}${BOX.tr}`));
    lines.push(row(` ${th.fg("accent", this.displayTitle)}`));
    lines.push(row(""));

    this.displayOptions.forEach((option, i) => {
      const selected = i === this.selected;
      const prefix = selected ? " ▶ " : "   ";
      const marker = th.fg("dim", `${i + 1}.`);
      const label = selected ? th.fg("accent", option) : th.fg("text", option);
      lines.push(row(`${prefix}${marker} ${label}`));
    });

    lines.push(row(""));
    lines.push(row(` ${th.fg("dim", "↑/↓ move · Enter confirm · number key picks · Esc deny")}`));
    lines.push(th.fg("border", `${BOX.bl}${BOX.h.repeat(innerW)}${BOX.br}`));
    return lines;
  }
}
