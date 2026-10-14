/**
 * AI safety classifier for the `automode` permission mode.
 *
 * A mode can set `"classifier": true`; every decision that its policy resolves
 * to `ask` is then handed to this module instead of the human prompt. The
 * classifier asks an LLM whether the pending tool call is safe to run
 * automatically, and returns an allow/deny verdict.
 *
 * Reliability (informed by pi-auto-approval):
 *   - completion runs IN-PROCESS through `ctx.modelRegistry.complete()`, so it
 *     reuses pi's own request-time auth (models.json, OAuth, env keys) — no
 *     provider HTTP is reimplemented here;
 *   - the model defaults to the ACTIVE SESSION model (`"current"`), so it
 *     follows `/model` switches and needs no extra configuration;
 *   - single bounded attempt per call (`maxRetries: 0`) plus a hard timeout, so
 *     a wedged provider can never hang a tool call;
 *   - a verdict cache collapses identical retries; a consecutive-denial counter
 *     falls back to the human prompt (or fails closed) when the classifier
 *     keeps saying no.
 *
 * The pure parts (prompt assembly, verdict parsing, model resolution, the
 * cache, the denial counter) are SDK-free and unit-tested; `classifyAsk` is the
 * thin registry glue.
 */

import { createHash } from "node:crypto";
import type { Surface } from "./schema.ts";

export interface ClassifierConfig {
  /** Route a mode's `ask` decisions through the classifier. */
  enabled: boolean;
  /** `"current"` follows the active session model; otherwise `"provider/model"`. */
  model: string;
  /** Hard per-call timeout (ms). */
  timeoutMs: number;
  /** `true` (default): a classifier error blocks the action (fail closed). */
  failClosed: boolean;
  /** Consecutive denials (per surface) after which the human prompt is offered instead. */
  maxConsecutiveDenials: number;
  /** Answer budget per call. */
  maxTokens: number;
  /** Cap on the action payload sent to the model (chars). */
  maxInputChars: number;
}

export const DEFAULT_CLASSIFIER_CONFIG: ClassifierConfig = {
  enabled: true,
  model: "current",
  timeoutMs: 15000,
  failClosed: true,
  maxConsecutiveDenials: 5,
  maxTokens: 700,
  maxInputChars: 4000,
};

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function positiveInt(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

/** Like positiveInt but 0 is meaningful (disables a feature). */
function nonNegativeInt(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback;
}

/** Normalize a raw `classifier` config object (already shape-checked by the loader). */
export function normalizeClassifierConfig(raw: unknown): ClassifierConfig {
  if (!isObject(raw)) return { ...DEFAULT_CLASSIFIER_CONFIG };
  const model = typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : DEFAULT_CLASSIFIER_CONFIG.model;
  return {
    enabled: raw.enabled !== false,
    model,
    timeoutMs: positiveInt(raw.timeoutMs, DEFAULT_CLASSIFIER_CONFIG.timeoutMs),
    failClosed: raw.failClosed !== false,
    maxConsecutiveDenials: nonNegativeInt(raw.maxConsecutiveDenials, DEFAULT_CLASSIFIER_CONFIG.maxConsecutiveDenials),
    maxTokens: positiveInt(raw.maxTokens, DEFAULT_CLASSIFIER_CONFIG.maxTokens),
    maxInputChars: positiveInt(raw.maxInputChars, DEFAULT_CLASSIFIER_CONFIG.maxInputChars),
  };
}

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface ClassifierVerdict {
  allow: boolean;
  risk: RiskLevel;
  reason: string;
}

/** The pending action handed to the classifier. */
export interface ClassifierSubject {
  mode: string;
  surface: Surface;
  tool: string;
  targets: string[];
  input: unknown;
  cwd: string;
  isOutside?: boolean;
  /** In-bounds roots (project dir + the mode's sandbox-writable dirs): where the
   * agent is expected to work, so the reviewer can tell routine edits from
   * out-of-project ones. */
  inBounds?: string[];
  /** The user's most recent request — the authorization context. Without it the
   * reviewer cannot tell a legitimate edit from a rogue one and over-denies. */
  recentUserRequest?: string;
}

const SYSTEM_PROMPT = [
  "You are a security reviewer embedded in the `pi` coding agent.",
  "A tool call in the active permission mode has been flagged for review (the mode",
  "would otherwise stop and ask the human). Decide whether it is safe to run",
  "automatically, or whether it must be blocked for human confirmation.",
  "",
  "Deny when the action:",
  "- deletes, overwrites, or exfiltrates data outside the project directory;",
  "- reads or transmits credentials, keys, tokens, or secret files;",
  "- escalates privileges (sudo/su/doas), disables security controls, or edits",
  "  shell profiles / SSH authorized_keys / cron / system services;",
  "- pipes remote content into a shell (`curl … | sh`), or runs untrusted code;",
  "- is destructive, irreversible, or clearly unrelated to the user's request.",
  "",
  "Allow routine, reversible, in-project work that matches the user's request —",
  "the pending action is shown together with that request; an action that clearly\n  serves it should be allowed even if it edits project files. Lean toward\n  allowing ordinary development steps (build, test, lint, format, run the\n  project's own tooling, install a dependency already declared in a manifest,\n  git status/diff/log) — these are expected, not suspicious.",
  "When you are unsure, deny — a human can still approve it.",
  "",
  "Respond with ONLY a JSON object, no prose and no code fences:",
  '{"allow": true|false, "risk": "low"|"medium"|"high"|"critical", "reason": "<short>"}',
].join("\n");

/** Render the tool input as bounded JSON for the prompt. */
function boundedInput(input: unknown, maxChars: number): string {
  let text: string;
  try {
    text = typeof input === "string" ? input : JSON.stringify(input);
  } catch {
    text = String(input);
  }
  if (text === undefined) text = "";
  return text.length > maxChars ? `${text.slice(0, maxChars)}… [truncated]` : text;
}

export function buildReviewPrompt(subject: ClassifierSubject, maxInputChars = DEFAULT_CLASSIFIER_CONFIG.maxInputChars): { systemPrompt: string; content: string } {
  // Ordering is deliberate for provider prefix-cache hits: STABLE session facts
  // (mode/cwd/in-bounds roots) come first, then the per-turn user requests, and
  // the per-action details (surface/tool/targets/input) fill the volatile tail.
  // On providers with automatic prefix caching (OpenAI/DeepSeek style) two
  // classifier calls then share everything up to their first differing line.
  const lines = [
    `mode: ${subject.mode}`,
    `cwd: ${subject.cwd}`,
  ];
  if (subject.inBounds && subject.inBounds.length > 0) lines.push(`in-bounds roots: ${subject.inBounds.join(", ")}`);
  if (subject.recentUserRequest) {
    lines.push("user's recent requests:", subject.recentUserRequest);
  }
  lines.push(
    `surface: ${subject.surface}`,
    `tool: ${subject.tool}`,
    `outside project: ${subject.isOutside ? "yes" : "no"}`,
  );
  if (subject.targets.length > 0) lines.push(`targets: ${subject.targets.join(", ")}`);
  lines.push("action input:", boundedInput(subject.input, maxInputChars));
  return { systemPrompt: SYSTEM_PROMPT, content: lines.join("\n") };
}

/** Pull the assistant text out of a completion result (string or content blocks). */
export function extractAssistantText(message: unknown): string | undefined {
  if (!isObject(message)) return undefined;
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (isObject(block) && block.type === "text" && typeof block.text === "string" ? block.text : ""))
      .join("");
  }
  return undefined;
}

const RISKS: RiskLevel[] = ["low", "medium", "high", "critical"];

/**
 * Parse the classifier's reply into a verdict. Tolerates surrounding prose or
 * code fences by extracting the first JSON object. Throws when the reply is
 * unusable so the caller can fail closed.
 */
export function parseVerdict(text: string | undefined): ClassifierVerdict {
  if (!text || !text.trim()) throw new Error("classifier returned no text");
  let payload: unknown;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  const json = start >= 0 && end > start ? text.slice(start, end + 1) : text;
  try {
    payload = JSON.parse(json);
  } catch {
    throw new Error("classifier reply was not valid JSON");
  }
  if (!isObject(payload) || typeof payload.allow !== "boolean") {
    throw new Error("classifier JSON is missing a boolean `allow`");
  }
  const risk = RISKS.includes(payload.risk as RiskLevel) ? (payload.risk as RiskLevel) : "high";
  const reason = typeof payload.reason === "string" && payload.reason.trim() ? payload.reason.trim() : payload.allow ? "allowed" : "denied";
  return { allow: payload.allow, risk, reason };
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

/** The slice of `ctx.modelRegistry` the classifier needs. */
export interface ClassifierRegistry {
  find?(provider: string, modelId: string): unknown;
  complete?(model: unknown, context: unknown, options: unknown): Promise<unknown>;
}

/**
 * Resolve the classifier model. `"current"` (the default) returns the active
 * session model so the classifier follows `/model`; a `"provider/model"` ref is
 * looked up in the registry; anything unresolvable falls back to the session
 * model rather than leaving the classifier without a model.
 */
export function resolveClassifierModel(registry: ClassifierRegistry, ref: string, currentModel: unknown): unknown {
  const trimmed = (ref ?? "").trim();
  if (!trimmed || trimmed === "current") return currentModel;
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return currentModel;
  const provider = trimmed.slice(0, slash);
  const id = trimmed.slice(slash + 1);
  return registry.find?.(provider, id) ?? currentModel;
}

// ---------------------------------------------------------------------------
// Completion glue
// ---------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`classifier timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export interface ClassifyAskOptions {
  registry: ClassifierRegistry;
  model: unknown;
  config: ClassifierConfig;
  subject: ClassifierSubject;
  signal?: AbortSignal;
  /** Stable per-session id. Handed to the provider layer so OpenAI-style APIs
   * get a `prompt_cache_key` (routing affinity) and Anthropic gets session
   * affinity headers — both raise prompt-cache hit rates across classifier calls. */
  sessionId?: string;
}

/**
 * Run the classifier for one `ask` decision. Throws on any failure (no model,
 * no completion method, timeout, transport error, unparseable reply) so the
 * caller can apply its fail-closed / human-fallback policy.
 */
export async function classifyAsk(opts: ClassifyAskOptions): Promise<ClassifierVerdict> {
  const { registry, model, config, subject, signal, sessionId } = opts;
  if (!model) throw new Error("no classifier model is available");
  if (typeof registry.complete !== "function") throw new Error("the model registry cannot complete requests");
  const { systemPrompt, content } = buildReviewPrompt(subject, config.maxInputChars);
  const completion = registry.complete(
    model,
    { systemPrompt, messages: [{ role: "user", content, timestamp: Date.now() }] },
    { maxTokens: config.maxTokens, temperature: 0, maxRetries: 0, timeoutMs: config.timeoutMs, signal, sessionId },
  );
  const message = await withTimeout(completion, config.timeoutMs);
  return parseVerdict(extractAssistantText(message));
}

// ---------------------------------------------------------------------------
// Verdict cache + denial counter
// ---------------------------------------------------------------------------

/** Stable key for an action under a model (identity — not safety — fields only).
 * The authorization context (the user's recent request) is part of the key: a
 * verdict an earlier request justified must not be reused for the same action
 * under a different request. */
export function subjectKey(subject: ClassifierSubject, modelRef: string): string {
  let input: string;
  try {
    input = JSON.stringify(subject.input);
  } catch {
    input = String(subject.input);
  }
  return createHash("sha1")
    .update(
      [
        modelRef,
        subject.mode,
        subject.surface,
        subject.tool,
        subject.targets.join("\u0000"),
        input,
        subject.isOutside ? "1" : "0",
        (subject.inBounds ?? []).join("\u0000"),
        subject.recentUserRequest ?? "",
      ].join("\u0001"),
    )
    .digest("hex");
}

/** Bounded TTL cache so a retried identical action skips a second model call. */
export class VerdictCache {
  private store = new Map<string, { verdict: ClassifierVerdict; at: number }>();
  private maxEntries: number;
  private ttlMs: number;

  /** 5 min: keys already carry the model + full subject (incl. the user's
   * recent requests), so a longer TTL only risks reusing a verdict whose
   * AUTHORIZATION context changed — and that changes the key, not the age. */
  constructor(maxEntries = 64, ttlMs = 300_000) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
  }

  get(key: string): ClassifierVerdict | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at > this.ttlMs) {
      this.store.delete(key);
      return undefined;
    }
    return hit.verdict;
  }

  set(key: string, verdict: ClassifierVerdict): void {
    this.store.set(key, { verdict, at: Date.now() });
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }

  clear(): void {
    this.store.clear();
  }
}

export interface DenialState {
  /** Consecutive denials per surface — an unrelated write denial must not push a
   * bash command over the fallback threshold. */
  bySurface: Record<string, number>;
}

export const createDenialState = (): DenialState => ({ bySurface: {} });

export const recordDenial = (s: DenialState, surface = ""): DenialState => ({
  bySurface: { ...s.bySurface, [surface]: (s.bySurface[surface] ?? 0) + 1 },
});

/** Clear the streak for THIS surface (an allow on bash must not clear a write streak). */
export const recordSuccess = (s: DenialState, surface = ""): DenialState => {
  if (s.bySurface[surface] === undefined) return s;
  const bySurface = { ...s.bySurface };
  delete bySurface[surface];
  return { bySurface };
};

/** True when this surface's denial streak is long enough that the human should decide. */
export const shouldFallbackToPrompting = (s: DenialState, maxConsecutiveDenials: number, surface = ""): boolean =>
  maxConsecutiveDenials > 0 && (s.bySurface[surface] ?? 0) >= maxConsecutiveDenials;
