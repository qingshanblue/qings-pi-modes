/**
 * Unit tests for the AI safety classifier (classifier.ts) — the pure prompt /
 * verdict / model-resolution logic and the registry glue, driven by a fake
 * `complete` so no provider is contacted.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReviewPrompt,
  classifyAsk,
  createDenialState,
  DEFAULT_CLASSIFIER_CONFIG,
  extractAssistantText,
  normalizeClassifierConfig,
  parseVerdict,
  recordDenial,
  recordSuccess,
  resolveClassifierModel,
  shouldFallbackToPrompting,
  subjectKey,
  VerdictCache,
  type ClassifierSubject,
} from "./classifier.ts";

const subject = (over: Partial<ClassifierSubject> = {}): ClassifierSubject => ({
  mode: "automode",
  surface: "bash",
  tool: "bash",
  targets: ["npm test"],
  input: { command: "npm test" },
  cwd: "/project",
  ...over,
});

test("normalizeClassifierConfig: defaults and overrides", () => {
  assert.deepEqual(normalizeClassifierConfig(undefined), DEFAULT_CLASSIFIER_CONFIG);
  const c = normalizeClassifierConfig({ model: "anthropic/claude-haiku-4-5", timeoutMs: 2000, failClosed: false, maxConsecutiveDenials: 0 });
  assert.equal(c.model, "anthropic/claude-haiku-4-5");
  assert.equal(c.timeoutMs, 2000);
  assert.equal(c.failClosed, false);
  assert.equal(c.maxConsecutiveDenials, 0);
  // garbage falls back
  assert.equal(normalizeClassifierConfig({ timeoutMs: -5 }).timeoutMs, DEFAULT_CLASSIFIER_CONFIG.timeoutMs);
  assert.equal(normalizeClassifierConfig({ model: "   " }).model, "current");
});

test("buildReviewPrompt: includes action fields and truncates long input", () => {
  const { systemPrompt, content } = buildReviewPrompt(subject({ isOutside: true }), 40);
  assert.match(systemPrompt, /security reviewer/i);
  assert.match(systemPrompt, /ordinary development steps/i);
  assert.match(content, /mode: automode/);
  assert.match(content, /surface: bash/);
  assert.match(content, /outside project: yes/);
  assert.match(content, /targets: npm test/);
  const withBounds = buildReviewPrompt(subject({ inBounds: ["/project", "/tmp/pi"] }), 40);
  assert.match(withBounds.content, /in-bounds roots: \/project, \/tmp\/pi/);
  const noBounds = buildReviewPrompt(subject(), 40);
  assert.ok(!noBounds.content.includes("in-bounds roots"), "in-bounds line omitted when unknown");
  const long = buildReviewPrompt(subject({ input: { command: "x".repeat(500) } }), 40);
  assert.match(long.content, /truncated/);
});

test("parseVerdict: strict JSON, fenced JSON, and failures", () => {
  assert.deepEqual(parseVerdict('{"allow":true,"risk":"low","reason":"fine"}'), { allow: true, risk: "low", reason: "fine" });
  // surrounding prose / code fence
  assert.equal(parseVerdict('```json\n{"allow":false,"risk":"high","reason":"secret"}\n```').allow, false);
  // missing risk coerces to high, missing reason gets a default
  const v = parseVerdict('{"allow":true}');
  assert.equal(v.risk, "high");
  assert.equal(v.reason, "allowed");
  assert.throws(() => parseVerdict("no json here"), /valid JSON/);
  assert.throws(() => parseVerdict('{"risk":"low"}'), /boolean `allow`/);
  assert.throws(() => parseVerdict(undefined), /no text/);
});

test("extractAssistantText: string and content-block shapes", () => {
  assert.equal(extractAssistantText({ content: "hello" }), "hello");
  assert.equal(extractAssistantText({ content: [{ type: "text", text: "a" }, { type: "thinking", text: "b" }, { type: "text", text: "c" }] }), "ac");
  assert.equal(extractAssistantText(null), undefined);
});

test("resolveClassifierModel: current, provider/model, and fallback", () => {
  const current = { provider: "coding-plan", id: "deepseek" };
  const found = { provider: "anthropic", id: "claude-haiku-4-5" };
  const registry = { find: (p: string, id: string) => (p === "anthropic" && id === "claude-haiku-4-5" ? found : undefined) };
  assert.equal(resolveClassifierModel(registry, "current", current), current);
  assert.equal(resolveClassifierModel(registry, "", current), current);
  assert.equal(resolveClassifierModel(registry, "anthropic/claude-haiku-4-5", current), found);
  // unknown ref falls back to the session model rather than nothing
  assert.equal(resolveClassifierModel(registry, "nope/missing", current), current);
  assert.equal(resolveClassifierModel(registry, "malformed", current), current);
});

test("classifyAsk: completes in-process and parses the verdict", async () => {
  let seen: { context: any; options: any } | undefined;
  const registry = {
    complete: async (_model: unknown, context: any, options: any) => {
      seen = { context, options };
      return { content: [{ type: "text", text: '{"allow":true,"risk":"low","reason":"ok"}' }] };
    },
  };
  const verdict = await classifyAsk({ registry, model: { id: "m" }, config: DEFAULT_CLASSIFIER_CONFIG, subject: subject() });
  assert.equal(verdict.allow, true);
  assert.equal(seen?.options.maxRetries, 0); // single bounded attempt
  assert.equal(seen?.options.temperature, 0);
  assert.match(seen?.context.systemPrompt, /security reviewer/i);
});

test("classifyAsk: failures throw (so the caller can fail closed)", async () => {
  await assert.rejects(
    () => classifyAsk({ registry: { complete: async () => ({ content: "not json" }) }, model: {}, config: DEFAULT_CLASSIFIER_CONFIG, subject: subject() }),
    /valid JSON/,
  );
  await assert.rejects(
    () => classifyAsk({ registry: {}, model: {}, config: DEFAULT_CLASSIFIER_CONFIG, subject: subject() }),
    /cannot complete/,
  );
  await assert.rejects(
    () => classifyAsk({ registry: { complete: async () => ({ content: "{}" }) }, model: undefined, config: DEFAULT_CLASSIFIER_CONFIG, subject: subject() }),
    /no classifier model/,
  );
});

test("VerdictCache: stores, bounds, and clears", () => {
  const c = new VerdictCache(2);
  c.set("a", { allow: true, risk: "low", reason: "" });
  assert.equal(c.get("a")?.allow, true);
  assert.equal(c.get("missing"), undefined);
  c.set("b", { allow: false, risk: "high", reason: "" });
  c.set("c", { allow: true, risk: "low", reason: "" });
  assert.equal(c.get("a"), undefined); // evicted (max 2)
  c.clear();
  assert.equal(c.get("b"), undefined);
});

test("subjectKey: stable per action, differs by surface/input", () => {
  const a = subjectKey(subject(), "current");
  assert.equal(a, subjectKey(subject(), "current"));
  assert.notEqual(a, subjectKey(subject(), "anthropic/x"));
  assert.notEqual(a, subjectKey(subject({ surface: "write" }), "current"));
  assert.notEqual(a, subjectKey(subject({ input: { command: "rm -rf /" } }), "current"));
  // The authorization context is part of the identity: a verdict justified by one
  // request must not be reused for the same action under a different request.
  assert.notEqual(a, subjectKey(subject({ recentUserRequest: "unrelated request" }), "current"));
});

test("denial counter: per-surface streak, resets on success, trips at the limit", () => {
  let s = createDenialState();
  assert.equal(shouldFallbackToPrompting(s, 3), false);
  s = recordDenial(s);
  s = recordDenial(s);
  assert.equal(shouldFallbackToPrompting(s, 3), false);
  s = recordDenial(s);
  assert.equal(shouldFallbackToPrompting(s, 3), true);
  assert.equal(shouldFallbackToPrompting(recordSuccess(s), 3), false);
  // 0 disables the fallback (never offer the human prompt)
  assert.equal(shouldFallbackToPrompting(recordDenial(createDenialState()), 0), false);
});

test("denial counter: denials are counted per surface", () => {
  // Two bash denials and two write denials: neither surface is at 3, so no
  // fallback — an unrelated write denial must not trip the bash threshold.
  let s = createDenialState();
  for (let i = 0; i < 2; i++) s = recordDenial(s, "bash");
  for (let i = 0; i < 2; i++) s = recordDenial(s, "write");
  assert.equal(shouldFallbackToPrompting(s, 3, "bash"), false);
  assert.equal(shouldFallbackToPrompting(s, 3, "write"), false);
  s = recordDenial(s, "bash");
  assert.equal(shouldFallbackToPrompting(s, 3, "bash"), true);
  assert.equal(shouldFallbackToPrompting(s, 3, "write"), false);
  // Clearing bash's streak leaves the write streak intact.
  const cleared = recordSuccess(s, "bash");
  assert.equal(shouldFallbackToPrompting(cleared, 3, "bash"), false);
  assert.equal(shouldFallbackToPrompting(cleared, 3, "write"), false);
});

test("DEFAULT_CLASSIFIER_CONFIG: 5 consecutive denials before human fallback", () => {
  assert.equal(DEFAULT_CLASSIFIER_CONFIG.maxConsecutiveDenials, 5);
});
