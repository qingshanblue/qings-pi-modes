import assert from "node:assert/strict";
import test from "node:test";
import { allModeNames, buildBashAskReview, buildFileToolAskReview, fileToolAllowedRoots, modePickerOptions } from "./action.ts";

test("buildBashAskReview: privilege, escape and unsandboxed facts are derived once", () => {
  const review = buildBashAskReview({
    command: "sudo rm -rf /",
    outsideReason: "privilege escalation via sudo",
    sandboxReady: true,
    sandboxEnabled: true,
    unsandboxed: true,
    scriptReview: { inspectable: false, scripts: [{ path: "helper.sh", content: "eval $X", truncated: false }] },
  });
  assert.equal(review.tool, "bash");
  assert.deepEqual(review.input, { command: "sudo rm -rf /" });
  assert.equal(review.privilege, true);
  assert.equal(review.sandboxEscape, true);
  assert.equal(review.escalateToHuman, true);
  assert.equal(review.inspectable, false);
  assert.equal(review.scripts?.length, 1);
});

test("buildFileToolAskReview: outside writes stay human-only; reads do not", () => {
  const write = buildFileToolAskReview({ tool: "write", path: "/etc/x", outside: true, surface: "write" });
  assert.equal(write.escalateToHuman, true);
  assert.equal(write.neverAI, true);
  assert.equal(write.unsandboxed, true);

  const read = buildFileToolAskReview({ tool: "read", path: "/etc/hosts", outside: true, surface: "read" });
  assert.equal(read.escalateToHuman, false);
  assert.equal(read.neverAI, false);
  assert.equal(read.unsandboxed, false);
});

test("allModeNames: append named-only modes after the cycle", () => {
  assert.deepEqual(allModeNames(["plan", "ask", "auto", "accept"], { ask: {}, edits: {}, auto: {}, plan: {}, accept: {} }), [
    "plan",
    "ask",
    "auto",
    "accept",
    "edits",
  ]);
});

test("modePickerOptions: only cycle modes appear, current gets a check", () => {
  assert.deepEqual(modePickerOptions(["plan", "ask", "auto"], { plan: "Plan", ask: "Ask", auto: "Auto", edits: "Edits" }, "ask"), [
    "  Plan",
    "✓ Ask",
    "  Auto",
  ]);
});

test("fileToolAllowedRoots: only write/edit consume outsideWriteRoots", () => {
  assert.deepEqual(fileToolAllowedRoots("/repo", "read", ["/etc/pm-roots"]), []);
  assert.deepEqual(fileToolAllowedRoots("/repo", "write", ["/etc/pm-roots", "~/notes"]).slice(0, 1), ["/etc/pm-roots"]);
});
