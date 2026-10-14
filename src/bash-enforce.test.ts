import assert from "node:assert/strict";
import test from "node:test";
import { type BashGate, bashExecPlan, bashGate, isBenignOutsideRead } from "./bash-enforce.ts";

const OUTSIDE = "path outside project: /etc/passwd";

test("bashGate: sandbox disabled still honors allow/ask policy", () => {
  for (const ready of [true, false]) {
    assert.equal(bashGate("allow", undefined, false, ready).kind, "allow");
    assert.equal(bashGate("allow", OUTSIDE, false, ready).kind, "allow"); // even an escape
    const ask = bashGate("ask", undefined, false, ready);
    assert.equal(ask.kind, "prompt");
    assert.equal(ask.onApproveUnsandboxed, true);
    assert.match(ask.title, /sandbox disabled/);
  }
});

test("bashGate: escape / privilege prompts and runs unsandboxed on approval", () => {
  const g = bashGate("allow", OUTSIDE, true, true);
  assert.equal(g.kind, "prompt");
  assert.equal(g.onApproveUnsandboxed, true);
  assert.ok(g.title.includes(OUTSIDE), g.title);
});

test("bashGate: in-project + sandbox down → prompt, unsandboxed (degraded fallback)", () => {
  const g = bashGate("allow", undefined, true, false);
  assert.equal(g.kind, "prompt");
  assert.equal(g.onApproveUnsandboxed, true);
  assert.match(g.title, /sandbox unavailable/);
});

test("bashGate: in-project, sandbox ready — action drives it", () => {
  assert.deepEqual(bashGate("allow", undefined, true, true), {
    kind: "allow",
    title: "",
    reason: "",
    onApproveUnsandboxed: false,
  } satisfies BashGate);
  const ask = bashGate("ask", undefined, true, true);
  assert.equal(ask.kind, "prompt");
  assert.equal(ask.onApproveUnsandboxed, false); // approved → still sandboxed
});

test("bashGate: deny blocks regardless of sandbox state", () => {
  for (const enabled of [true, false]) {
    assert.equal(bashGate("deny", undefined, enabled, true).kind, "block");
  }
});

test("bashExecPlan: sandboxed iff enabled & ready & not escaped; readOnly iff non-writable", () => {
  // Plan: enabled, non-writable.
  assert.deepEqual(bashExecPlan(true, false, true, false), { sandboxed: true, readOnly: true });
  // Build: enabled, writable.
  assert.deepEqual(bashExecPlan(true, true, true, false), { sandboxed: true, readOnly: false });
  // YOLO: disabled.
  assert.equal(bashExecPlan(false, true, true, false).sandboxed, false);
  // Approved escape → unsandboxed.
  assert.equal(bashExecPlan(true, true, true, true).sandboxed, false);
  // Sandbox down → unsandboxed.
  assert.equal(bashExecPlan(true, true, false, false).sandboxed, false);
});

test("isBenignOutsideRead: only a read-only path escape under an enforcing sandbox", () => {
  const base = {
    outsideReason: OUTSIDE,
    safeChain: true,
    usedFallback: false,
    sandboxEnabled: true,
    sandboxState: "on" as const,
    sandboxReady: true,
  };
  assert.equal(isBenignOutsideRead(base), true);
  // A privilege escalation is never benign — it must stay on the human path.
  assert.equal(isBenignOutsideRead({ ...base, outsideReason: "privilege escalation" }), false);
  // Nothing concerning to begin with.
  assert.equal(isBenignOutsideRead({ ...base, outsideReason: undefined }), false);
  // The sandbox would not actually enforce (off / strict / unavailable): keep the
  // conservative escape path so nothing runs unsandboxed.
  assert.equal(isBenignOutsideRead({ ...base, sandboxState: "off" }), false);
  assert.equal(isBenignOutsideRead({ ...base, sandboxState: "strict" }), false);
  assert.equal(isBenignOutsideRead({ ...base, sandboxEnabled: false }), false);
  assert.equal(isBenignOutsideRead({ ...base, sandboxReady: false }), false);
  // Only a VERIFIED read-only chain qualifies: without an AST (fallback) or with
  // a write/exec-capable command it is not a benign read.
  assert.equal(isBenignOutsideRead({ ...base, safeChain: false }), false);
  assert.equal(isBenignOutsideRead({ ...base, usedFallback: true }), false);
});
