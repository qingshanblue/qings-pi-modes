/**
 * Unit tests for the read-only bash allowlist (safe-command.ts) — the Tier 1
 * fast path shared by the Ask / Edits / Auto modes.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { isSafeBashChain, isSafeCommand } from "./safe-command.ts";

test("isSafeCommand: read-only allowlist, git read-only subcommands, dangerous flags", () => {
  assert.equal(isSafeCommand("ls", ["-la"]), true);
  assert.equal(isSafeCommand("/usr/bin/cat", ["README.md"]), true);
  assert.equal(isSafeCommand("git", ["status"]), true);
  assert.equal(isSafeCommand("git", ["log", "--oneline"]), true);
  assert.equal(isSafeCommand("git", ["commit", "-m", "x"]), false);
  assert.equal(isSafeCommand("git", ["push"]), false);
  assert.equal(isSafeCommand("rm", ["-rf", "x"]), false);
  assert.equal(isSafeCommand("sed", ["-i", "s/a/b/", "f"]), false); // in-place write
  assert.equal(isSafeCommand("sed", ["s/a/b/", "f"]), true);
  assert.equal(isSafeCommand("find", [".", "-delete"]), false);
  assert.equal(isSafeCommand("find", [".", "-name", "*.md"]), true);
  assert.equal(isSafeCommand("node", ["-e", "1"]), false); // arbitrary code
  assert.equal(isSafeCommand("", []), false);
});

test("isSafeBashChain: rejects redirects, substitutions, and any unsafe link", () => {
  assert.equal(isSafeBashChain([{ name: "ls", args: ["-la"] }], "ls -la"), true);
  assert.equal(isSafeBashChain([{ name: "cat", args: ["a"] }, { name: "grep", args: ["x"] }], "cat a | grep x"), true);
  assert.equal(isSafeBashChain([{ name: "echo", args: ["hi"] }], "echo hi > f"), false); // redirect writes
  assert.equal(isSafeBashChain([{ name: "echo", args: ["hi"] }], "echo $(date)"), false); // substitution
  assert.equal(isSafeBashChain([{ name: "echo", args: ["hi"] }], "echo `date`"), false); // backticks
  assert.equal(isSafeBashChain([{ name: "ls", args: [] }, { name: "rm", args: ["-rf", "x"] }], "ls && rm -rf x"), false);
  assert.equal(isSafeBashChain([], "ls"), false);
});
