/**
 * Unit tests for the read-only bash allowlist (safe-command.ts) — the Tier 1
 * fast path shared by the Ask / Edits / Auto modes.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { isSafeBashChain, isSafeCommand } from "./safe-command.ts";

test("isSafeCommand: refuses writers/executors that look read-only (regression set)", () => {
  // find's action flags: -execdir/-okdir execute, -fprint*/-fls write.
  assert.equal(isSafeCommand("find", [".", "-name", "*.tmp", "-execdir", "rm", "-f", "{}", ";"]), false);
  assert.equal(isSafeCommand("find", [".", "-okdir", "rm", "{}", ";"]), false);
  assert.equal(isSafeCommand("find", [".", "-fprintf", "/tmp/out", "%p"]), false);
  assert.equal(isSafeCommand("find", [".", "-fls", "/tmp/out"]), false);
  // sed is off the list entirely: its `e` command (and GNU's `s///e`) executes.
  assert.equal(isSafeCommand("sed", ["-n", "1p", "f"]), false);
  assert.equal(isSafeCommand("sed", ["1e", "sh"]), false);
  assert.equal(isSafeCommand("sed", ["-i.bak", "s/a/b/", "f"]), false);
  assert.equal(isSafeCommand("sed", ["--in-place=.bak", "s/a/b/", "f"]), false);
  // Short/long output flags of the commands that have them.
  assert.equal(isSafeCommand("sort", ["-o", "out.txt", "in.txt"]), false);
  assert.equal(isSafeCommand("sort", ["--output=out.txt", "in.txt"]), false);
  assert.equal(isSafeCommand("tree", ["-o", "out.txt"]), false);
  assert.equal(isSafeCommand("uniq", ["in.txt", "out.txt"]), false);
  assert.equal(isSafeCommand("git", ["diff", "--output=patch.diff"]), false);
  // ... while the read-only spellings of the same letters stay allowed.
  assert.equal(isSafeCommand("grep", ["-i", "needle", "f"]), true);
  assert.equal(isSafeCommand("grep", ["-o", "pattern", "f"]), true);
  assert.equal(isSafeCommand("sort", ["-n", "in.txt"]), true);
  assert.equal(isSafeCommand("uniq", ["in.txt"]), true);
  assert.equal(isSafeCommand("find", [".", "-name", "x", "-print"]), true);
});

test("isSafeCommand: read-only allowlist, git read-only subcommands, dangerous flags", () => {
  assert.equal(isSafeCommand("ls", ["-la"]), true);
  assert.equal(isSafeCommand("/usr/bin/cat", ["README.md"]), true);
  assert.equal(isSafeCommand("git", ["status"]), true);
  assert.equal(isSafeCommand("git", ["log", "--oneline"]), true);
  assert.equal(isSafeCommand("git", ["commit", "-m", "x"]), false);
  assert.equal(isSafeCommand("git", ["push"]), false);
  assert.equal(isSafeCommand("rm", ["-rf", "x"]), false);
  assert.equal(isSafeCommand("sed", ["-i", "s/a/b/", "f"]), false); // in-place write
  assert.equal(isSafeCommand("sed", ["s/a/b/", "f"]), false); // sed is off the list (the `e` command executes)
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
