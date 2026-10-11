/**
 * Parity tests — assert the data-driven engine (stock defaults + decide +
 * bash-enforce) reproduces the intended per-mode behavior on representative
 * inputs. The shipped modes are the CC-style set: ask / plan / auto / edits /
 * bypass. The sandbox is the TOP-LEVEL profile with a per-mode `sandboxPin`;
 * `sbOf` derives the effective enabled/writable (session state "on" for
 * unpinned modes) the way index.ts does.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { bashExecPlan, bashGate } from "./bash-enforce.ts";
import { loadStockDefaults } from "./config-load.ts";
import { decide } from "./resolve.ts";
import type { ModeDef } from "./schema.ts";

const M = loadStockDefaults().modes;
const sbOf = (m: ModeDef): { enabled: boolean; writable: boolean } => {
  const st = m.sandboxPin ?? "on";
  return { enabled: st !== "off", writable: st === "on" };
};
const OUTSIDE = "path outside project: /etc/passwd";

test("ask: confirm bash/write/web_search; reads free; out-of-project asks", () => {
  const d = M.ask;
  const sb = sbOf(d);
  assert.equal(decide(d, "bash", "ls -la"), "ask");
  assert.equal(decide(d, "write", "src/app.ts"), "ask");
  assert.equal(decide(d, "write", "notes.md"), "ask"); // no markdown carve-out in Ask
  assert.equal(decide(d, "edit", "src/app.ts"), "ask");
  assert.equal(decide(d, "web_search", "anything"), "ask");
  assert.equal(decide(d, "read", "src/app.ts"), "allow");
  assert.equal(decide(d, "read", "/etc/passwd", { isOutside: true }), "ask"); // external_directory
  assert.equal(decide(d, "tool", "some_extension_tool"), "ask"); // unknown tool → first-use prompt
  assert.equal(decide(d, "skill", "deep-research"), "ask");
  // bash composition: in-project ask → prompt, stays sandboxed.
  const g = bashGate(decide(d, "bash", "ls"), undefined, sb.enabled, true);
  assert.equal(g.kind, "prompt");
  assert.equal(g.onApproveUnsandboxed, false);
  assert.deepEqual(bashExecPlan(sb.enabled, sb.writable, true, false), {
    sandboxed: true,
    readOnly: false,
  });
});

test("plan: read-only sandbox (pin), Markdown-only writes, reads free", () => {
  const p = M.plan;
  const sb = sbOf(p);
  assert.equal(decide(p, "write", "plan/2026-06-08_x.md"), "allow");
  assert.equal(decide(p, "write", "README.markdown"), "allow");
  assert.equal(decide(p, "write", "src/app.ts"), "deny"); // → "Markdown only" block
  assert.equal(decide(p, "edit", "src/app.ts"), "deny");
  assert.equal(decide(p, "read", "src/app.ts"), "allow");
  assert.equal(decide(p, "tool", "some_extension_tool"), "ask"); // unknown tool → first-use prompt
  assert.equal(decide(p, "skill", "deep-research"), "ask");
  assert.equal(decide(p, "bash", "ls"), "allow");
  // bash composition: allow, sandboxed READ-ONLY (the `ro` pin).
  const g = bashGate(decide(p, "bash", "ls"), undefined, sb.enabled, true);
  assert.equal(g.kind, "allow");
  assert.deepEqual(bashExecPlan(sb.enabled, sb.writable, true, false), {
    sandboxed: true,
    readOnly: true,
  });
  assert.equal(p.systemPrompt, "@plan"); // Plan injects the planning prompt
  assert.equal(p.sandboxPin, "ro");
});

test("edits: in-project file edits silent; bash still asks; out-of-project asks", () => {
  const e = M.edits;
  const sb = sbOf(e);
  assert.equal(decide(e, "write", "src/app.ts"), "allow");
  assert.equal(decide(e, "edit", "src/app.ts"), "allow");
  assert.equal(decide(e, "bash", "make"), "ask"); // bash is NOT auto-approved in Edits
  assert.equal(decide(e, "read", "/etc/hosts", { isOutside: true }), "ask"); // external_directory
  assert.equal(decide(e, "tool", "some_extension_tool"), "ask");
  assert.equal(decide(e, "skill", "deep-research"), "ask");
  const g = bashGate(decide(e, "bash", "make"), undefined, sb.enabled, true);
  assert.equal(g.kind, "prompt");
  // Privilege/escape still prompts and runs unsandboxed on approval.
  const esc = bashGate(decide(e, "bash", "sudo x"), OUTSIDE, sb.enabled, true);
  assert.equal(esc.kind, "prompt");
  assert.equal(esc.onApproveUnsandboxed, true);
});

test("bypass: everything allowed, protected paths bypassed; decoupled from the sandbox", () => {
  const y = M.bypass;
  const sb = sbOf(y); // no pin → the session default ("on")
  assert.equal(decide(y, "write", "src/app.ts"), "allow");
  assert.equal(decide(y, "bash", "rm -rf build"), "allow");
  assert.equal(decide(y, "read", "/etc/passwd", { isOutside: true }), "allow"); // external_directory: allow
  assert.equal(decide(y, "web_search", "x"), "allow");
  assert.equal(decide(y, "tool", "some_extension_tool"), "allow");
  assert.equal(decide(y, "skill", "deep-research"), "allow");
  assert.equal(y.bypassProtectedPaths, true);
  assert.equal(y.sandboxPin, undefined); // decoupled: bypass no longer pins the sandbox off
  // With the sandbox OFF (alt+s off / a pin), an escape is allowed silently …
  assert.equal(bashGate(decide(y, "bash", "x"), OUTSIDE, false, true).kind, "allow");
  // … with the sandbox ON the gate would prompt; a trust-all mode (index.ts)
  // auto-approves it and runs unsandboxed (covered end-to-end in index.test.ts).
  assert.equal(bashGate(decide(y, "bash", "x"), OUTSIDE, true, true).kind, "prompt");
});
