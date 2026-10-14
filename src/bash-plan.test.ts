import assert from "node:assert/strict";
import test from "node:test";
import { type BashPlanFacts, planSandboxedBash, planUnsandboxedBash } from "./bash-plan.ts";
import type { BashCommand } from "./bash-parse.ts";

const cmd = (name: string, ...args: string[]): BashCommand => ({ name, args, isNested: false });
const root = "/home/u/proj";
const base = (over: Partial<BashPlanFacts> = {}): BashPlanFacts => ({
  command: "make build",
  root,
  bounds: [root, "/tmp/pi"],
  action: "ask",
  analysis: { commands: [cmd("make", "build")], outsideReason: undefined, usedFallback: false },
  safeChain: false,
  sandboxEnabled: true,
  sandboxState: "on",
  sandboxReady: true,
  isBlocked: () => false,
  ...over,
});

test("sandboxed: a whitelisted read-only in-project command is silent", () => {
  const plan = planSandboxedBash(base({ command: "ls", safeChain: true, analysis: { commands: [cmd("ls")], outsideReason: undefined, usedFallback: false } }));
  assert.equal(plan.kind, "allow");
});

test("sandboxed: a hard policy deny blocks", () => {
  const plan = planSandboxedBash(base({ action: "deny" }));
  assert.equal(plan.kind, "block");
  assert.match(plan.kind === "block" ? plan.reason : "", /denied by policy/);
});

test("sandboxed: strict state blocks any outside access outright", () => {
  const plan = planSandboxedBash(
    base({
      sandboxState: "strict",
      analysis: { commands: [cmd("cat", "/etc/hosts")], outsideReason: "path outside project: /etc/hosts", usedFallback: false },
    }),
  );
  assert.equal(plan.kind, "block");
  assert.match(plan.kind === "block" ? plan.reason : "", /Sandbox strict/);
});

test("sandboxed: a benign outside read stays sandboxed and says so (not unsandboxed)", () => {
  const plan = planSandboxedBash(
    base({
      command: "cat /etc/hosts",
      safeChain: true,
      action: "ask",
      analysis: { commands: [cmd("cat", "/etc/hosts")], outsideReason: "path outside project: /etc/hosts", usedFallback: false },
    }),
  );
  assert.equal(plan.kind, "prompt");
  if (plan.kind !== "prompt") return;
  assert.match(plan.title, /runs inside the sandbox/);
  assert.equal(plan.unsandboxed, false);
});

test("sandboxed: privilege escalation is a human prompt keyed on the exact command, run unsandboxed on approval", () => {
  const plan = planSandboxedBash(
    base({
      command: "sudo apt update",
      analysis: { commands: [cmd("sudo", "apt", "update")], outsideReason: "privilege escalation via sudo", usedFallback: false },
    }),
  );
  assert.equal(plan.kind, "prompt");
  if (plan.kind !== "prompt") return;
  assert.deepEqual(plan.keys, ["escape:sudo apt update"]);
  assert.equal(plan.unsandboxed, true);
  assert.deepEqual(plan.targets, [], "privilege escalation offers no path targets");
});

test("sandboxed: an escape to a path already blocked this session is refused without a prompt", () => {
  const plan = planSandboxedBash(
    base({
      command: "cat /etc/pm-blocked",
      analysis: { commands: [cmd("cat", "/etc/pm-blocked")], outsideReason: "path outside project: /etc/pm-blocked", usedFallback: true },
      isBlocked: (t) => t.endsWith("pm-blocked"),
    }),
  );
  assert.equal(plan.kind, "block");
  assert.match(plan.kind === "block" ? plan.reason : "", /blocked for this session/);
});

test("sandboxed: a normal ask is keyed on every command name in the chain", () => {
  const plan = planSandboxedBash(
    base({
      command: "git status && npm test",
      analysis: { commands: [cmd("git", "status"), cmd("npm", "test")], outsideReason: undefined, usedFallback: false },
    }),
  );
  assert.equal(plan.kind, "prompt");
  if (plan.kind !== "prompt") return;
  assert.deepEqual(plan.keys, ["git", "npm"]);
  assert.equal(plan.unsandboxed, false);
});

test("unsandboxed: the Tier-1 whitelist still runs without a prompt", () => {
  const plan = planUnsandboxedBash({ command: "ls", effective: "ask", outsideReason: undefined, safeChain: true, sandboxReady: false });
  assert.equal(plan.kind, "allow");
});

test("unsandboxed: an ask prompts, is keyed on the command, and runs unsandboxed when approved", () => {
  const plan = planUnsandboxedBash({ command: "make build", effective: "ask", outsideReason: undefined, safeChain: false, sandboxReady: false });
  assert.equal(plan.kind, "prompt");
  if (plan.kind !== "prompt") return;
  assert.deepEqual(plan.keys, ["make build"]);
  assert.equal(plan.unsandboxed, true);
  assert.equal(plan.sandboxEnabled, false);
});

test("unsandboxed: a policy deny blocks", () => {
  const plan = planUnsandboxedBash({ command: "rm -rf x", effective: "deny", outsideReason: undefined, safeChain: false, sandboxReady: false });
  assert.equal(plan.kind, "block");
});
