import assert from "node:assert/strict";
import test from "node:test";
import { gateFileTool } from "./file-gate.ts";
import type { ModeDef } from "./schema.ts";

const mode = (permission: Record<string, unknown>, label = "Ask"): ModeDef => ({ label, color: "success", permission } as unknown as ModeDef);
const base = { surface: "write" as const, toolName: "write", path: "src/a.ts", outside: false, strict: false };

test("strict + outside is a hard block regardless of policy", () => {
  const g = gateFileTool({ ...base, mode: mode({ write: "allow" }), outside: true, strict: true });
  assert.equal(g.kind, "block");
});

test("inside-project write follows the mode's policy", () => {
  assert.equal(gateFileTool({ ...base, mode: mode({ write: "allow" }) }).kind, "allow");
  const ask = gateFileTool({ ...base, mode: mode({ write: "ask" }) });
  assert.equal(ask.kind, "ask");
  assert.equal(ask.kind === "ask" && ask.title, "Allow write to src/a.ts?");
});

test("outside ask carries the Outside-project title and reason", () => {
  const g = gateFileTool({ ...base, mode: mode({ write: "ask", external_directory: "ask" }), path: "/etc/x", outside: true });
  assert.equal(g.kind, "ask");
  assert.ok(g.kind === "ask" && /^Outside project - allow write to \/etc\/x\?/.test(g.title));
  assert.equal(g.kind === "ask" && g.reason, "Access outside project blocked");
});

test("Markdown-only policy yields a notice alongside the block", () => {
  const g = gateFileTool({ ...base, mode: mode({ write: { "*": "deny", "*.md": "allow" } }, "Plan"), path: "src/a.ts" });
  assert.equal(g.kind, "block");
  assert.equal(g.kind === "block" && g.reason, "Plan allows editing Markdown files only");
  assert.equal(g.kind === "block" && g.notice, "Plan allows editing Markdown files only: src/a.ts");
});

test("a plain deny is a block without a notice", () => {
  const g = gateFileTool({ ...base, mode: mode({ write: "deny" }) });
  assert.equal(g.kind, "block");
  assert.equal(g.kind === "block" && g.notice, undefined);
});
