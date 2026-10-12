/**
 * End-to-end dispatcher tests for index.ts — a fake `pi`/`ctx` harness drives
 * the registered handlers (tool_call, input, commands, lifecycle) against the
 * stock defaults, exercising the wiring the pure-module tests can't reach:
 * prompt flows, session grants, mode switching, protected-path blocks, and
 * "Allow forever" persistence.
 *
 * Hermetic: each setup runs in a fresh temp project root with
 * PI_CODING_AGENT_DIR pointed at a fresh temp agent dir (so no user config is
 * read and "Allow forever" writes land in the sandbox of the test), and the
 * --no-sandbox flag set (so the OS sandbox runtime is never initialized —
 * bash gating then follows the documented degraded path: prompt).
 *
 * The pi SDK is host-bundled (a peerDependency): when it can't be resolved
 * (e.g. a bare no-install checkout), every test here skips — mirroring the
 * WASM-skip pattern in bash-parse.test.ts.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

type SetupExtension = (pi: unknown) => Promise<void>;

// Resolve the extension entry once; undefined → SDK unavailable → skip all.
const setupExtension: SetupExtension | undefined = await (async () => {
  try {
    return (await import("./index.ts")).default as unknown as SetupExtension;
  } catch {
    return undefined;
  }
})();
const skip = setupExtension ? false : "pi SDK not installed (run npm install)";

// --- fake pi ----------------------------------------------------------------

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

class FakePi {
  flags = new Map<string, unknown>();
  handlers = new Map<string, Handler[]>();
  commands = new Map<string, (args: string, ctx: unknown) => Promise<unknown>>();
  shortcuts = new Map<string, (ctx: unknown) => Promise<unknown>>();
  tools = new Map<string, { name: string }>();
  /** Mirrors pi: the built-in defaults are active at start (as with the stock
   * `defaultTools`), registered tools join automatically; grep/find/ls stay off. */
  activeTools: string[] = ["read", "bash", "edit", "write"];
  entries: Array<{ customType: string; data: unknown }> = [];
  /** User messages the extension sent (plan approval). */
  messages: Array<{ content: unknown; opts?: unknown }> = [];

  sendUserMessage(content: unknown, opts?: unknown) {
    this.messages.push({ content, opts });
  }
  registerFlag(name: string, def: { default?: unknown }) {
    if (!this.flags.has(name)) this.flags.set(name, def.default);
  }
  getFlag(name: string) {
    return this.flags.get(name);
  }
  registerCommand(name: string, def: { handler: (args: string, ctx: unknown) => Promise<unknown> }) {
    this.commands.set(name, def.handler);
  }
  registerShortcut(key: string, def: { handler: (ctx: unknown) => Promise<unknown> }) {
    this.shortcuts.set(key, def.handler);
  }
  registerTool(tool: { name: string }) {
    this.tools.set(tool.name, tool);
    if (!this.activeTools.includes(tool.name)) this.activeTools.push(tool.name);
  }
  getAllTools() {
    return [...this.tools.values()];
  }
  getActiveTools() {
    return [...this.activeTools];
  }
  setActiveTools(names: string[]) {
    this.activeTools = [...names];
  }
  appendEntry(customType: string, data: unknown) {
    this.entries.push({ customType, data });
  }
  on(event: string, handler: Handler) {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }
  /** Deliver an event to the registered handlers, returning the first result. */
  async emit(event: string, payload: unknown, ctx: unknown): Promise<unknown> {
    for (const h of this.handlers.get(event) ?? []) {
      const r = await h(payload, ctx);
      if (r !== undefined) return r;
    }
    return undefined;
  }
}

// --- fake ctx ----------------------------------------------------------------

interface FakeCtx {
  hasUI: boolean;
  cwd: string;
  prompts: Array<{ title: string; options: string[] }>;
  notices: string[];
  status: string;
  answers: string[];
  /** Scripted answers for ui.confirm, and the titles it was asked with. */
  confirms: boolean[];
  confirmPrompts: string[];
  ui: {
    select(title: string, options: string[]): Promise<string | undefined>;
    confirm(title: string, message: string): Promise<boolean>;
    notify(message: string, level?: string): void;
    setStatus(key: string, value: string): void;
    theme: { fg(color: string, text: string): string };
  };
  sessionManager: { getEntries(): Array<{ type: string; customType?: string; data?: unknown }>; getSessionId(): string };
  /** Optional classifier plumbing — set by the automode tests. */
  modelRegistry?: { find?(provider: string, id: string): unknown; complete?(model: unknown, context: unknown, options: unknown): Promise<unknown> };
  model?: { id: string; provider: string };
  signal?: AbortSignal;
}

function makeCtx(
  cwd: string,
  opts: {
    hasUI?: boolean;
    entries?: Array<{ type: string; customType?: string; data?: unknown }>;
    modelRegistry?: FakeCtx["modelRegistry"];
    model?: FakeCtx["model"];
    signal?: AbortSignal;
  } = {},
): FakeCtx {
  const ctx: FakeCtx = {
    hasUI: opts.hasUI ?? true,
    cwd,
    prompts: [],
    notices: [],
    status: "",
    answers: [],
    confirms: [],
    confirmPrompts: [],
    ui: {
      async select(title, options) {
        ctx.prompts.push({ title, options });
        return ctx.answers.shift();
      },
      async confirm(title) {
        ctx.confirmPrompts.push(title);
        return ctx.confirms.shift() ?? false;
      },
      notify(message) {
        ctx.notices.push(message);
      },
      setStatus(_key, value) {
        ctx.status = value;
      },
      theme: { fg: (_color, text) => text },
    },
    sessionManager: { getEntries: () => opts.entries ?? [], getSessionId: () => "sess-test" },
  };
  if (opts.modelRegistry) ctx.modelRegistry = opts.modelRegistry;
  if (opts.model) ctx.model = opts.model;
  if (opts.signal) ctx.signal = opts.signal;
  return ctx;
}

// --- harness ------------------------------------------------------------------

interface Harness {
  pi: FakePi;
  ctx: FakeCtx;
  root: string;
  agentDir: string;
  /** The scratch base this harness redirects PI_PERMISSION_TMPDIR to, and the session's folder under it. */
  scratchBase: string;
  scratchDir: string;
  /** Emit a tool_call and return its result ({block,reason} | undefined). */
  call(toolName: string, input: Record<string, unknown>): Promise<{ block?: boolean; reason?: string } | undefined>;
  /** Run the /perm command (mode switch etc.). */
  permission(args: string): Promise<unknown>;
  cleanup(): void;
}

let callId = 0;

/**
 * Build the extension against a fresh temp project + agent dir, then emit
 * session_start so the config/lifecycle path runs exactly as in production
 * (minus the OS sandbox, which --no-sandbox keeps off).
 */
async function setup(
  opts: {
    hasUI?: boolean;
    permFlag?: string;
    /** Simulate a parent-forwarded PI_PERMISSION_MODE. */
    envMode?: string;
    entries?: Array<{ type: string; customType?: string; data?: unknown }>;
    /** Classifier plumbing for automode tests. */
    modelRegistry?: FakeCtx["modelRegistry"];
    model?: FakeCtx["model"];
    signal?: AbortSignal;
  } = {},
): Promise<Harness> {
  const base = mkdtempSync(path.join(tmpdir(), "perm-idx-"));
  const root = path.join(base, "proj");
  const agentDir = path.join(base, "agent");
  mkdirSync(path.join(root, "src"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });

  const scratchBase = path.join(base, "scratch");

  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const prevScratch = process.env.PI_PERMISSION_TMPDIR;
  const prevCwd = process.cwd();
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_PERMISSION_TMPDIR = scratchBase; // never touch the real /tmp/pi from tests
  delete process.env.PI_PERMISSION_MODE;
  delete process.env.PI_PERMISSION_SANDBOX;
  if (opts.envMode !== undefined) process.env.PI_PERMISSION_MODE = opts.envMode;

  const pi = new FakePi();
  pi.flags.set("no-sandbox", true);
  if (opts.permFlag !== undefined) pi.flags.set("perm", opts.permFlag);

  process.chdir(root); // index.ts captures root = process.cwd() at setup
  try {
    await setupExtension!(pi);
  } finally {
    process.chdir(prevCwd);
  }

  const ctx = makeCtx(root, opts);
  await pi.emit("session_start", {}, ctx);

  return {
    pi,
    ctx,
    root,
    agentDir,
    scratchBase,
    scratchDir: path.join(scratchBase, "sess-test"),
    call: (toolName, input) =>
      pi.emit("tool_call", { type: "tool_call", toolCallId: `t${++callId}`, toolName, input }, ctx) as Promise<
        { block?: boolean; reason?: string } | undefined
      >,
    permission: (args) => pi.commands.get("permission")!(args, ctx),
    cleanup: () => {
      if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
      if (prevScratch === undefined) delete process.env.PI_PERMISSION_TMPDIR;
      else process.env.PI_PERMISSION_TMPDIR = prevScratch;
      delete process.env.CLAUDE_CODE_TMPDIR;
      delete process.env.CLAUDE_TMPDIR;
      delete process.env.PI_PERMISSION_MODE;
      delete process.env.PI_PERMISSION_SANDBOX;
      rmSync(base, { recursive: true, force: true });
    },
  };
}

// --- tests --------------------------------------------------------------------

test("default mode: reads free, writes prompt, protected paths hard-block", { skip }, async () => {
  const h = await setup();
  try {
    // Footer: mode label + shortcut hints + network state (open here: --no-sandbox).
    assert.match(h.ctx.status, /^Ask box:unavailable$/);

    // Reads pass silently.
    assert.equal(await h.call("read", { path: "src/app.ts" }), undefined);
    assert.equal(h.ctx.prompts.length, 0);

    // Protected paths block WITHOUT prompting, and before any policy ask.
    const blocked = await h.call("write", { path: ".env" });
    assert.equal(blocked?.block, true);
    assert.match(blocked?.reason ?? "", /protected/);
    assert.equal(h.ctx.prompts.length, 0);

    // A normal write prompts; Allow once passes, Deny blocks.
    h.ctx.answers.push("Allow once", "Deny");
    assert.equal(await h.call("write", { path: "notes.txt" }), undefined);
    const denied = await h.call("write", { path: "notes.txt" });
    assert.equal(denied?.block, true);
    assert.equal(h.ctx.prompts.length, 2);
  } finally {
    h.cleanup();
  }
});

test("sandbox-writable temp dirs are in-bounds: no 'outside project' prompt, no unsandboxed escape", { skip }, async () => {
  const h = await setup();
  try {
    // Ask: reads are free in-project; /tmp/pi (in the mode's allowWrite) is
    // in-bounds too, so the external_directory ask does not fold in. /etc still does.
    assert.equal(await h.call("read", { path: "/tmp/pi/scratch/out.txt" }), undefined);
    assert.equal(h.ctx.prompts.length, 0);
    h.ctx.answers.push("Deny");
    assert.equal((await h.call("read", { path: "/etc/hostname" }))?.block, true);
    assert.match(h.ctx.prompts[0]?.title ?? "", /Outside project/);

    // Bash: the sandbox is off in this harness, so in-project bash prompts as
    // "sandbox unavailable" — a /tmp path must get THAT prompt, not the
    // "path outside project" escape prompt (which would run it unsandboxed).
    h.ctx.answers.push("Deny");
    await h.call("bash", { command: "mktemp -d /tmp/pi/scratch.XXXX" });
    assert.match(h.ctx.prompts[1]?.title ?? "", /sandbox unavailable/);
    // A sibling of the base is NOT inside it (prefix ≠ containment): still an escape.
    h.ctx.answers.push("Deny");
    await h.call("bash", { command: "mktemp -d /tmp/pi.XXXX" });
    assert.match(h.ctx.prompts[2]?.title ?? "", /path outside project: \/tmp\/pi\.XXXX/);
    h.ctx.answers.push("Deny");
    await h.call("bash", { command: "cat /etc/passwd" });
    assert.match(h.ctx.prompts[3]?.title ?? "", /path outside project: \/etc\/passwd/);

    // Edits: a write into /tmp/pi passes silently (allowWrite covers it).
    await h.permission("edits");
    assert.equal(await h.call("write", { path: "/tmp/pi/scratch/notes.txt" }), undefined);
    assert.equal(h.ctx.prompts.length, 4);

    // YOLO doesn't sandbox, so allowWrite is meaningless — its own
    // external_directory:allow is what keeps /tmp (and everything) silent.
    await h.permission("accept");
    assert.equal(await h.call("write", { path: "/tmp/pi/scratch/notes.txt" }), undefined);
    assert.equal(h.ctx.prompts.length, 4);
  } finally {
    h.cleanup();
  }
});

test("session scratch dir: created per session, TMPDIR, in-bounds, advertised, stale siblings swept", { skip }, async () => {
  // Plant a stale and a fresh sibling BEFORE the session starts.
  const base = mkdtempSync(path.join(tmpdir(), "perm-scratch-e2e-"));
  const prev = process.env.PI_PERMISSION_TMPDIR;
  process.env.PI_PERMISSION_TMPDIR = base;
  const stale = path.join(base, "old-session");
  const fresh = path.join(base, "other-live-session");
  mkdirSync(stale);
  mkdirSync(fresh);
  const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  utimesSync(stale, old, old);
  const h = await setup(); // setup overrides PI_PERMISSION_TMPDIR to its own base…
  process.env.PI_PERMISSION_TMPDIR = base; // …so re-point and start again to exercise this base
  await h.pi.emit("session_start", {}, h.ctx);
  try {
    const dir = path.join(base, "sess-test");
    assert.ok(existsSync(dir), "scratch dir created from the session id");
    assert.equal(process.env.CLAUDE_CODE_TMPDIR, dir); // the runtime points TMPDIR here inside the sandbox
    assert.equal(process.env.CLAUDE_TMPDIR, dir); // the name older runtimes read
    assert.ok(!existsSync(stale), "stale sibling swept");
    assert.ok(existsSync(fresh), "fresh sibling kept");

    // In-bounds: a read inside it is not an out-of-project ask (Default).
    assert.equal(await h.call("read", { path: path.join(dir, "notes.txt") }), undefined);
    assert.equal(h.ctx.prompts.length, 0);
    // Bash to it prompts as "sandbox unavailable" (the harness runs --no-sandbox), never as an escape.
    h.ctx.answers.push("Deny");
    await h.call("bash", { command: `mktemp -p ${dir}` });
    assert.match(h.ctx.prompts[0]?.title ?? "", /sandbox unavailable/);

    // Advertised in the awareness section (degraded variant here).
    const res = (await h.pi.emit("before_agent_start", { systemPrompt: "BASE" }, h.ctx)) as { systemPrompt: string };
    assert.match(res.systemPrompt, /Sandbox & permissions \(Ask\)/);
    assert.ok(res.systemPrompt.includes(dir));
    assert.match(res.systemPrompt, /\$TMPDIR inside bash points there/);

    // Re-entering session_start (resume / reload) keeps the same folder and its files.
    writeFileSync(path.join(dir, "keep.txt"), "x");
    await h.pi.emit("session_start", {}, h.ctx);
    assert.ok(existsSync(path.join(dir, "keep.txt")));
  } finally {
    h.cleanup();
    if (prev === undefined) delete process.env.PI_PERMISSION_TMPDIR;
    else process.env.PI_PERMISSION_TMPDIR = prev;
    rmSync(base, { recursive: true, force: true });
  }
});

test("file tools judge the path pi opens: ~, @, file:// are normalized before the guards", { skip }, async () => {
  const h = await setup();
  try {
    // Ask: reads are free in-project, but `~/...` is the home dir, i.e. outside: external_directory asks.
    h.ctx.answers.push("Deny");
    const home = await h.call("read", { path: "~/.ssh/id_rsa" });
    assert.equal(home?.block, true);
    assert.match(h.ctx.prompts.at(-1)?.title ?? "", /Outside project/);
    // `@` prefix is stripped by pi: the protected-path backstop must see `.env`.
    const env = await h.call("write", { path: "@.env" });
    assert.equal(env?.block, true);
    assert.match(env?.reason ?? "", /protected/);
    // file:// URLs are paths to pi.
    h.ctx.answers.push("Deny");
    const url = await h.call("read", { path: "file:///etc/passwd" });
    assert.equal(url?.block, true);
    assert.match(h.ctx.prompts.at(-1)?.title ?? "", /Outside project/);
    // NUL bytes never reach the filesystem layer.
    const nul = await h.call("write", { path: ".git\u0000/config" });
    assert.equal(nul?.block, true);
    assert.match(nul?.reason ?? "", /NUL/);
  } finally {
    h.cleanup();
  }
});

test("deny and block: an escape prompt offers it, the path is masked for the session, /perm unblock lifts it", { skip }, async () => {
  const h = await setup();
  const home = os.homedir();
  try {
    // Bash escape to a file under home: four options, the last one blocks.
    h.ctx.answers.push("Deny and block ~/secret.txt for this session");
    const first = await h.call("bash", { command: "cat ~/secret.txt" });
    assert.equal(first?.block, true);
    assert.deepEqual(h.ctx.prompts[0].options, ["Allow once", "Allow for session", "Deny", "Deny and block ~/secret.txt for this session"]);
    assert.ok(h.ctx.notices.some((n) => /~\/secret\.txt is now unreadable inside the sandbox for this session/.test(n)));
    // Listed, and enforced without a prompt for bash and for the file tools.
    await h.permission("blocks");
    assert.match(h.ctx.notices.at(-1) ?? "", /- ~\/secret\.txt/);
    const again = await h.call("bash", { command: `python3 -c 'open("${path.join(home, "secret.txt")}")' && cat ~/secret.txt` });
    assert.equal(again?.block, true);
    assert.match(again?.reason ?? "", /blocked for this session/);
    const read = await h.call("read", { path: "~/secret.txt" });
    assert.equal(read?.block, true);
    assert.match(read?.reason ?? "", /blocked for this session/);
    assert.equal(h.ctx.prompts.length, 1, "no further prompts for a blocked path");
    // Unblock: the read prompts again (external_directory ask), offering the option again.
    await h.permission("unblock ~/secret.txt");
    assert.match(h.ctx.notices.at(-1) ?? "", /readable again/);
    h.ctx.answers.push("Deny");
    assert.equal((await h.call("read", { path: "~/secret.txt" }))?.block, true);
    assert.equal(h.ctx.prompts.length, 2);
    assert.equal(h.ctx.prompts[1].options.at(-1), "Deny and block ~/secret.txt for this session");
    // Privilege and home-level escapes do not offer it.
    h.ctx.answers.push("Deny");
    await h.call("bash", { command: "sudo id" });
    assert.deepEqual(h.ctx.prompts[2].options, ["Allow once", "Allow for session", "Deny"]);
    h.ctx.answers.push("Deny");
    await h.call("bash", { command: "ls ~" });
    assert.deepEqual(h.ctx.prompts[3].options, ["Allow once", "Allow for session", "Deny"]); // home is never blockable
    // clear-approvals clears blocks as well.
    h.ctx.answers.push("Deny and block ~/other.txt for this session");
    await h.call("read", { path: "~/other.txt" });
    await h.permission("clear-approvals");
    assert.match(h.ctx.notices.at(-1) ?? "", /cleared session approvals and blocked paths/);
    await h.permission("blocks");
    assert.match(h.ctx.notices.at(-1) ?? "", /no paths blocked/);
  } finally {
    h.cleanup();
  }
});

test("bash: a session grant never covers an escape, and an approved escape covers only itself", { skip }, async () => {
  const h = await setup();
  try {
    // In-project `touch` granted for the session (sandbox unavailable in the harness: prompts, then granted).
    h.ctx.answers.push("Allow for session");
    assert.equal(await h.call("bash", { command: "touch a.txt" }), undefined);
    assert.equal(h.ctx.prompts.length, 1);
    // The same name reaching outside the project is an escape: it must prompt again.
    h.ctx.answers.push("Deny");
    const escape = await h.call("bash", { command: "touch /etc/qings-x" });
    assert.equal(escape?.block, true);
    assert.equal(h.ctx.prompts.length, 2);
    assert.match(h.ctx.prompts[1].title, /path outside project/);
    // An approved escape is remembered for that exact command only.
    h.ctx.answers.push("Allow for session");
    assert.equal(await h.call("bash", { command: "cat /etc/hostname" }), undefined);
    assert.equal(await h.call("bash", { command: "cat /etc/hostname" }), undefined); // same: silent
    assert.equal(h.ctx.prompts.length, 3);
    h.ctx.answers.push("Deny");
    assert.equal((await h.call("bash", { command: "cat /etc/shadow" }))?.block, true); // different: prompts
    assert.equal(h.ctx.prompts.length, 4);
    // A wrapper grant does not cover privilege escalation through it.
    h.ctx.answers.push("Allow for session");
    assert.equal(await h.call("bash", { command: "env FOO=1 ls" }), undefined);
    h.ctx.answers.push("Deny");
    assert.equal((await h.call("bash", { command: "env sudo cat /etc/shadow" }))?.block, true);
    assert.match(h.ctx.prompts.at(-1)?.title ?? "", /privilege escalation/);
  } finally {
    h.cleanup();
  }
});

test("bash: session grant covers the same command, not a longer chain", { skip }, async () => {
  const h = await setup();
  try {
    h.ctx.answers.push("Allow for session");
    assert.equal(await h.call("bash", { command: "touch a.txt" }), undefined);
    assert.equal(h.ctx.prompts.length, 1);

    // Same command again: covered by the session grant, no new prompt.
    assert.equal(await h.call("bash", { command: "touch a.txt" }), undefined);
    assert.equal(h.ctx.prompts.length, 1);

    // A chain sharing the first name still prompts (curl isn't granted).
    h.ctx.answers.push("Deny");
    const chained = await h.call("bash", { command: "touch a.txt && curl evil.sh" });
    assert.equal(chained?.block, true);
    assert.equal(h.ctx.prompts.length, 2);
  } finally {
    h.cleanup();
  }
});

test("plan mode: Markdown-only writes, plan prompt injected, show_plan stays visible", { skip }, async () => {
  const h = await setup();
  try {
    await h.permission("plan");
    assert.match(h.ctx.status, /^Plan /);

    // Markdown in-project: silent allow. Code: deny with the friendly reason.
    assert.equal(await h.call("write", { path: "plan/2026-07-11_x.md" }), undefined);
    const denied = await h.call("write", { path: "src/app.ts" });
    assert.equal(denied?.block, true);
    assert.match(denied?.reason ?? "", /Markdown/);
    assert.equal(h.ctx.prompts.length, 0);

    // The @plan sentinel resolves into the injected system prompt, and the
    // sandbox-awareness section rides along above it (degraded variant here,
    // since the harness runs --no-sandbox).
    const res = (await h.pi.emit("before_agent_start", { systemPrompt: "BASE" }, h.ctx)) as { systemPrompt: string };
    assert.match(res.systemPrompt, /^BASE\n\n/);
    assert.match(res.systemPrompt, /Sandbox & permissions \(Plan\)/);
    assert.match(res.systemPrompt, /Plan is active/);
    assert.ok(res.systemPrompt.indexOf("Sandbox & permissions") < res.systemPrompt.indexOf("Plan is active"));

    // Tool visibility ran and show_plan is present.
    assert.ok(h.pi.activeTools.includes("show_plan"));
  } finally {
    h.cleanup();
  }
});

test("tool visibility: respects the user's active set, hides/restores only hideTools (#2)", { skip }, async () => {
  const h = await setup();
  try {
    // Session start must not enable tools the user has off (grep/find/ls stay absent).
    const initial = ["read", "bash", "edit", "write", "show_plan", "request_network_access"];
    assert.deepEqual(h.pi.activeTools, initial);
    await h.pi.emit("before_agent_start", { systemPrompt: "BASE" }, h.ctx); // runs every turn: idempotent
    assert.deepEqual(h.pi.activeTools, initial);

    // A mode hiding edit/write/grep/show_plan: edit+write+show_plan go (an
    // explicit show_plan entry is honored, #8), grep was never on (so nothing
    // to remember).
    const dir = path.join(h.agentDir, "permission-mode");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "permission-mode.json"),
      JSON.stringify({
        modes: {
          review: {
            label: "Review",
            color: "mdLink",
            sandbox: { enabled: true, writable: false },
            permission: { read: "allow", bash: "allow", write: "deny", edit: "deny" },
            hideTools: ["edit", "write", "grep", "show_plan"],
          },
        },
      }),
    );
    await h.pi.emit("session_start", {}, h.ctx);
    await h.permission("review");
    assert.deepEqual(h.pi.activeTools, ["read", "bash", "request_network_access"]);
    await h.pi.emit("before_agent_start", { systemPrompt: "BASE" }, h.ctx);
    assert.deepEqual(h.pi.activeTools, ["read", "bash", "request_network_access"]);

    // Switching back restores exactly what we hid (incl. show_plan) — grep stays off.
    await h.permission("ask");
    assert.deepEqual([...h.pi.activeTools].sort(), [...initial].sort());
    assert.ok(!h.pi.activeTools.includes("grep"));
    assert.ok(h.pi.activeTools.includes("show_plan"));
  } finally {
    h.cleanup();
  }
});

test("accept: never prompts, protected paths bypassed", { skip }, async () => {
  const h = await setup();
  try {
    await h.permission("accept");
    assert.match(h.ctx.status, /^Accept /);
    // The sandbox is decoupled: turn it off so the escape runs without a prompt.
    await h.pi.commands.get("sandbox")!("off", h.ctx);
    assert.equal(await h.call("bash", { command: "sudo rm -rf /" }), undefined);
    assert.equal(await h.call("edit", { path: ".env" }), undefined);
    assert.equal(await h.call("write", { path: ".git/config" }), undefined);
    assert.equal(h.ctx.prompts.length, 0);
    // Sandbox off: no boundary briefing — only the scratch-dir pointer.
    const res = (await h.pi.emit("before_agent_start", { systemPrompt: "BASE" }, h.ctx)) as { systemPrompt: string };
    assert.match(res.systemPrompt, /## Scratch directory \(Accept\)/);
    assert.ok(res.systemPrompt.includes(h.scratchDir));
    assert.doesNotMatch(res.systemPrompt, /Sandbox & permissions/);
  } finally {
    h.cleanup();
  }
});

test("our tools carry a promptSnippet (listed in the system prompt's Available tools section)", { skip }, async () => {
  const h = await setup();
  try {
    for (const name of ["show_plan", "request_network_access"]) {
      const tool = h.pi.tools.get(name) as { promptSnippet?: string } | undefined;
      assert.ok(tool, `${name} registered`);
      assert.match(tool?.promptSnippet ?? "", /\S/, `${name} has a promptSnippet`);
      assert.ok(!tool?.promptSnippet?.includes("\n"), `${name} snippet is one line`);
    }
  } finally {
    h.cleanup();
  }
});

test("web_search: ask in Ask, session-wide grant", { skip }, async () => {
  const h = await setup();
  try {
    h.ctx.answers.push("Deny", "Allow for session");
    const denied = await h.call("web_search", { query: "anything" });
    assert.equal(denied?.block, true);
    assert.equal(await h.call("web_search", { query: "again" }), undefined);
    // Grant is surface-wide: a different query passes without a new prompt.
    assert.equal(await h.call("web_search", { query: "third" }), undefined);
    assert.equal(h.ctx.prompts.length, 2);
  } finally {
    h.cleanup();
  }
});

test("custom tools: first-use prompt in Ask (with Allow forever), silent in Bypass", { skip }, async () => {
  const h = await setup();
  try {
    h.ctx.answers.push("Allow for session");
    assert.equal(await h.call("my_mcp_tool", { arg: 1 }), undefined);
    assert.equal(h.ctx.prompts.length, 1);
    // First-use prompts offer the persistent fourth option.
    assert.ok(h.ctx.prompts[0].options.includes("Allow forever"));
    assert.equal(await h.call("my_mcp_tool", { arg: 2 }), undefined); // granted for session
    assert.equal(h.ctx.prompts.length, 1);

    await h.permission("accept");
    assert.equal(await h.call("other_tool", {}), undefined); // Bypass trusts tools
    assert.equal(h.ctx.prompts.length, 1);
  } finally {
    h.cleanup();
  }
});

test("'Allow forever' persists the rule to the global config and stops prompting", { skip }, async () => {
  const h = await setup();
  try {
    h.ctx.answers.push("Allow forever");
    assert.equal(await h.call("my_mcp_tool", {}), undefined);
    const file = path.join(h.agentDir, "permission-mode", "permission-mode.json");
    assert.ok(existsSync(file), "rule persisted to the temp agent dir");
    const saved = JSON.parse(readFileSync(file, "utf-8")) as {
      modes: { ask: { permission: { tool: Record<string, string> } } };
    };
    assert.equal(saved.modes.ask.permission.tool.my_mcp_tool, "allow");
    assert.equal(saved.modes.ask.permission.tool["*"], "ask"); // others keep prompting

    // The hot-reloaded config allows it now — and other tools still prompt.
    assert.equal(await h.call("my_mcp_tool", {}), undefined);
    assert.equal(h.ctx.prompts.length, 1);
    h.ctx.answers.push("Deny");
    const other = await h.call("stranger_tool", {});
    assert.equal(other?.block, true);
    assert.equal(h.ctx.prompts.length, 2);
  } finally {
    h.cleanup();
  }
});

test("skills: /skill:<name> is gated via the input event", { skip }, async () => {
  const h = await setup();
  try {
    h.ctx.answers.push("Deny", "Allow once");
    const denied = await h.pi.emit("input", { text: "/skill:deep-research" }, h.ctx);
    assert.deepEqual(denied, { action: "handled" }); // blocked → swallowed
    const allowed = await h.pi.emit("input", { text: "/skill:deep-research" }, h.ctx);
    assert.equal(allowed, undefined); // allowed → continues to expansion
    // Non-skill input is ignored.
    assert.equal(await h.pi.emit("input", { text: "hello" }, h.ctx), undefined);
    assert.equal(h.ctx.prompts.length, 2);
  } finally {
    h.cleanup();
  }
});

test("no UI: asks deny instead of hanging", { skip }, async () => {
  const h = await setup({ hasUI: false });
  try {
    const bash = await h.call("bash", { command: "touch x" });
    assert.equal(bash?.block, true);
    const write = await h.call("write", { path: "x.txt" });
    assert.equal(write?.block, true);
    assert.equal(h.ctx.prompts.length, 0);
  } finally {
    h.cleanup();
  }
});

test("headless fallback: restrictive policy WITHOUT the plan prompt, not exported to children", { skip }, async () => {
  const h = await setup({ hasUI: false });
  try {
    // Ask: the headless fallback is the default (ask) mode …
    assert.match(h.ctx.status, /^Ask /);
    const denied = await h.call("write", { path: "src/app.ts" });
    assert.equal(denied?.block, true); // … and its policy fully applies
    // … but the planning system prompt is NOT injected into the headless
    // worker — only the FACTUAL sandbox-awareness section is (boundary
    // knowledge helps; a planning prompt would misdirect).
    const res = (await h.pi.emit("before_agent_start", { systemPrompt: "BASE" }, h.ctx)) as { systemPrompt: string };
    assert.match(res.systemPrompt, /Sandbox & permissions/);
    assert.doesNotMatch(res.systemPrompt, /Plan is active/);
    // The implicit fallback is not forwarded as if it were an explicit choice:
    // a grandchild derives its own fallback (and skips the prompt too).
    assert.equal(process.env.PI_PERMISSION_MODE, undefined);
  } finally {
    h.cleanup();
  }
});

test("headless child with an explicitly forwarded mode keeps its system prompt", { skip }, async () => {
  const h = await setup({ hasUI: false, envMode: "plan" });
  try {
    assert.match(h.ctx.status, /^Plan /);
    const res = (await h.pi.emit("before_agent_start", { systemPrompt: "BASE" }, h.ctx)) as { systemPrompt: string };
    assert.match(res.systemPrompt, /Plan is active/); // explicit → injected
    assert.equal(process.env.PI_PERMISSION_MODE, "plan"); // and re-exported onward
  } finally {
    h.cleanup();
  }
});

test("startup: an explicit --perm flag beats a persisted session entry", { skip }, async () => {
  const h = await setup({ permFlag: "accept", entries: [{ type: "custom", customType: "perm-mode", data: { mode: "plan" } }] });
  try {
    assert.match(h.ctx.status, /^Accept /);
  } finally {
    h.cleanup();
  }
});

test("startup: --perm flag wins; a persisted session entry restores the mode", { skip }, async () => {
  const flagged = await setup({ permFlag: "accept" });
  try {
    assert.match(flagged.ctx.status, /^Accept /);
  } finally {
    flagged.cleanup();
  }

  const resumed = await setup({ entries: [{ type: "custom", customType: "perm-mode", data: { mode: "edits" } }] });
  try {
    assert.match(resumed.ctx.status, /^Edits /);
  } finally {
    resumed.cleanup();
  }
});

test("/permission: a bare call opens the mode picker, an unknown argument prints usage without switching", { skip }, async () => {
  const h = await setup();
  try {
    assert.match(h.ctx.status, /^Ask /);
    await h.permission("buidl");
    assert.match(h.ctx.status, /^Ask /);
    assert.match(h.ctx.notices.at(-1) ?? "", /unknown mode or subcommand "buidl"; usage: \/permission \[plan\|ask\|edits\|auto\|accept\|init/);

    // No args: the interactive picker lists the cycleOrder with the current mode marked.
    await h.permission("");
    const picker = h.ctx.prompts.at(-1)!;
    assert.match(picker.title, /Permission mode/);
    assert.equal(picker.options.length, 5);
    assert.match(picker.options[1], /^✓/); // "ask" is current (cycleOrder[1])

    // Dismiss (no scripted answer) changes nothing; picking an entry switches.
    assert.match(h.ctx.status, /^Ask /);
    h.ctx.answers.push(picker.options[2]); // "edits"
    await h.permission("");
    assert.match(h.ctx.status, /^Edits /);
  } finally {
    h.cleanup();
  }
});

test("ctrl+q cycles modes and persists the choice as a session entry", { skip }, async () => {
  const h = await setup();
  try {
    // ask → edits → auto → accept (permission order)
    await h.pi.shortcuts.get("ctrl+q")!(h.ctx);
    assert.match(h.ctx.status, /^Edits /);
    assert.deepEqual(h.pi.entries.at(-1), { customType: "perm-mode", data: { mode: "edits" } });
    await h.pi.shortcuts.get("ctrl+q")!(h.ctx);
    assert.match(h.ctx.status, /^Auto /);
    await h.pi.shortcuts.get("ctrl+q")!(h.ctx);
    assert.match(h.ctx.status, /^Accept /);
  } finally {
    h.cleanup();
  }
});

test("defaults audit: stale /perm-init copy warns per field, acknowledge silences, upgrade notice fires once", { skip }, async () => {
  const h = await setup();
  try {
    const dir = path.join(h.agentDir, "permission-mode");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "permission-mode.json");
    // A 2.2.x-era full copy: still lists /tmp in all three sandboxed modes.
    const oldCopy = JSON.parse(readFileSync(path.join(process.cwd(), "defaults-history.json"), "utf-8"))[0].defaults;
    writeFileSync(file, JSON.stringify(oldCopy));
    // Pretend the last run was 2.2.1 so the upgrade notice has something to compare.
    writeFileSync(path.join(dir, "state.json"), JSON.stringify({ lastVersion: "2.0.0" }));

    h.ctx.notices.length = 0;
    await h.pi.emit("session_start", {}, h.ctx);
    const stale = h.ctx.notices.find((n) => /still hold an outdated default/.test(n)) ?? "";
    assert.match(stale, /5 value\(s\)/); // defaultMode + cycleOrder + plan's bash policy are stale
    assert.match(stale, /defaultMode still holds the 2\.0\.0 to 2\.3\.1 default/);
    assert.match(stale, /cycleOrder still holds the 2\.0\.0 to 2\.3\.1 default/);
    assert.match(stale, /acknowledgeDefaults/);
    const upgrade = h.ctx.notices.find((n) => /updated 2\.0\.0 ->/.test(n)) ?? "";
    assert.match(upgrade, /stock defaults changed for .*modes\.default\.sandbox\.allowWrite/);
    // State recorded: the notice does not repeat on the next start.
    assert.match(readFileSync(path.join(dir, "state.json"), "utf-8"), /"lastVersion"/);
    h.ctx.notices.length = 0;
    await h.pi.emit("session_start", {}, h.ctx);
    assert.ok(!h.ctx.notices.some((n) => /updated .* ->/.test(n)), "upgrade notice fires once");
    assert.ok(h.ctx.notices.some((n) => /outdated default/.test(n)), "stale warning repeats until fixed");

    // Acknowledging the current version silences the stale warning.
    const cfg = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    cfg.acknowledgeDefaults = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf-8")).version;
    writeFileSync(file, JSON.stringify(cfg));
    h.ctx.notices.length = 0;
    await h.pi.emit("session_start", {}, h.ctx);
    assert.ok(!h.ctx.notices.some((n) => /outdated default/.test(n)));

    // No global config at all: silent, state still recorded.
    rmSync(file);
    rmSync(path.join(dir, "state.json"));
    h.ctx.notices.length = 0;
    await h.pi.emit("session_start", {}, h.ctx);
    assert.ok(!h.ctx.notices.some((n) => /outdated default|updated .* ->/.test(n)));
    assert.ok(existsSync(path.join(dir, "state.json")));
  } finally {
    h.cleanup();
  }
});

test("/perm init scaffolds the global config once", { skip }, async () => {
  const h = await setup();
  try {
    await h.permission("init");
    const file = path.join(h.agentDir, "permission-mode", "permission-mode.json");
    assert.ok(existsSync(file));
    // The scaffold is the stock defaults, ready to edit.
    const cfg = JSON.parse(readFileSync(file, "utf-8")) as { modes: Record<string, unknown>; $comment?: string };
    assert.deepEqual(Object.keys(cfg.modes), ["ask", "plan", "auto", "edits", "accept"]);
    assert.match(String(cfg.$comment), /Copied from the pi-permission-modes \d+\.\d+\.\d+ stock defaults/);
    assert.equal(Object.keys(cfg)[1], "$comment"); // right after $schema, where a reader sees it first
    // A fresh copy never trips the audit.
    h.ctx.notices.length = 0;
    await h.pi.emit("session_start", {}, h.ctx);
    assert.ok(!h.ctx.notices.some((n) => /outdated default/.test(n)));
    // Second init refuses to overwrite.
    await h.permission("init");
    assert.match(h.ctx.notices.at(-1) ?? "", /already exists/);
  } finally {
    h.cleanup();
  }
});

test("project config tightens a mode through the dispatcher", { skip }, async () => {
  const h = await setup();
  try {
    const piDir = path.join(h.root, ".pi");
    mkdirSync(piDir, { recursive: true });
    const project = { modes: { edits: { permission: { write: "deny" } } } };
    writeFileSync(path.join(piDir, "permission-mode.json"), JSON.stringify(project));
    await h.pi.emit("session_start", {}, h.ctx); // reload with the project overlay

    await h.permission("edits");
    const denied = await h.call("write", { path: "src/app.ts" });
    assert.equal(denied?.block, true); // edits allows writes, but the overlay denies
    assert.equal(await h.call("read", { path: "src/app.ts" }), undefined); // reads untouched
  } finally {
    h.cleanup();
  }
});

test("a hostile project config cannot take the session down: global layer applied, sandbox initialized, mode set", { skip }, async () => {
  const h = await setup();
  try {
    const dir = path.join(h.agentDir, "permission-mode");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "permission-mode.json"), JSON.stringify({ modes: { ask: { permission: { read: { "*": "allow", "*.pem": "deny" } } } } }));
    const piDir = path.join(h.root, ".pi");
    mkdirSync(piDir, { recursive: true });
    writeFileSync(path.join(piDir, "permission-mode.json"), '{"modes":{"ask":null,"__proto__":{"sandbox":{"allowWrite":5}}}}');
    h.ctx.notices.length = 0;
    await h.pi.emit("session_start", {}, h.ctx);
    assert.match(h.ctx.status, /^Ask /); // session start completed (setMode ran)
    assert.ok(h.ctx.notices.some((n) => /project mode "ask" must be an object/.test(n)));
    const denied = await h.call("read", { path: "key.pem" });
    assert.equal(denied?.block, true, "the global layer is still in force");
  } finally {
    h.cleanup();
  }
});

test("prototype names are not modes anywhere: /perm, env, session entries, headless fallback", { skip }, async () => {
  const h = await setup({ envMode: "constructor" });
  try {
    assert.match(h.ctx.status, /^Ask /); // env value ignored
    h.ctx.notices.length = 0;
    await h.permission("constructor"); // unknown -> usage notice, no switch, no throw
    assert.match(h.ctx.notices.at(-1) ?? "", /unknown mode or subcommand "constructor"/);
    assert.match(h.ctx.status, /^Ask /);
  } finally {
    h.cleanup();
  }
  // Headless child with a cycleOrder of only YOLO still starts in a sandboxed mode.
  const g = await setup({ hasUI: false });
  try {
    const dir = path.join(g.agentDir, "permission-mode");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "permission-mode.json"), JSON.stringify({ defaultMode: "accept", cycleOrder: ["accept"] }));
    await g.pi.emit("session_start", {}, g.ctx);
    assert.match(g.ctx.status, /^Accept /);
  } finally {
    g.cleanup();
  }
});

test("project config cannot disable sandboxing or suppress Ask bash prompts", { skip }, async () => {
  const h = await setup();
  try {
    const piDir = path.join(h.root, ".pi");
    mkdirSync(piDir, { recursive: true });
    const project = { modes: { ask: { sandbox: { enabled: false } } } };
    writeFileSync(path.join(piDir, "permission-mode.json"), JSON.stringify(project));
    await h.pi.emit("session_start", {}, h.ctx);

    assert.match(h.ctx.notices.join("\n"), /cannot change sandbox\.enabled/);
    h.ctx.answers.push("Deny");
    const denied = await h.call("bash", { command: "touch owned" });
    assert.equal(denied?.block, true);
    assert.equal(h.ctx.prompts.length, 1);
  } finally {
    h.cleanup();
  }
});

test("custom unsandboxed mode still honors bash ask", { skip }, async () => {
  const h = await setup();
  try {
    const dir = path.join(h.agentDir, "permission-mode");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "permission-mode.json"),
      JSON.stringify({
        defaultMode: "confirm-unsandboxed",
        cycleOrder: ["confirm-unsandboxed"],
        modes: {
          "confirm-unsandboxed": {
            label: "Confirm unsandboxed",
            color: "error",
            sandbox: { enabled: false, writable: true },
            permission: { bash: "ask" },
          },
        },
      }),
    );
    await h.pi.emit("session_start", {}, h.ctx);
    await h.permission("confirm-unsandboxed");

    h.ctx.answers.push("Deny");
    const denied = await h.call("bash", { command: "touch owned" });
    assert.equal(denied?.block, true);
    assert.match(h.ctx.prompts[0]?.title ?? "", /will run unsandboxed/);
  } finally {
    h.cleanup();
  }
});

test("multi-line bash commands: policy applies across newlines (no silent allow, no Bypass noise)", { skip }, async () => {
  const h = await setup();
  try {
    // Accept: a multi-line command used to fall through every "*" rule to the
    // "ask" fallback and prompt on every heredoc/script.
    await h.permission("accept");
    // Drop the OS sandbox so the heredoc runs without a prompt (the harness has
    // no sandbox runtime; a sandboxed mode would ask).
    await h.pi.commands.get("sandbox")!("off", h.ctx);
    assert.equal(await h.call("bash", { command: "cat <<'EOF' > notes.txt\nline one\nline two\nEOF" }), undefined);
    assert.equal(h.ctx.prompts.length, 0);

    // A deny rule must hold when a newline sits inside an argument, both in an
    // unsandboxed mode (decide over the whole line) and in a sandboxed one
    // (decideBashCommand per extracted command, where the per-token path layer
    // used to be the only match and yielded "allow").
    const dir = path.join(h.agentDir, "permission-mode");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "permission-mode.json"),
      JSON.stringify({
        modes: {
          accept: { permission: { bash: { "*": "allow", "rm -rf *": "deny" } } },
          ask: { permission: { bash: { "*": "ask", "sudo *": "deny" } } },
        },
      }),
    );
    await h.pi.emit("session_start", {}, h.ctx);

    await h.permission("accept");
    assert.equal(await h.call("bash", { command: "echo 'a\nb'" }), undefined);
    const rm = await h.call("bash", { command: "rm -rf 'a\nb'" });
    assert.equal(rm?.block, true);
    assert.match(rm?.reason ?? "", /denied by policy/);

    await h.permission("ask");
    const sudo = await h.call("bash", { command: "sudo sh -c '\nid\n'" });
    assert.equal(sudo?.block, true);
    assert.match(sudo?.reason ?? "", /denied by policy/);
    assert.equal(h.ctx.prompts.length, 0); // deny blocks outright, nothing asked
  } finally {
    h.cleanup();
  }
});

test("network: /net allow + status, request tool degrades gracefully, ctrl+n informs", { skip }, async () => {
  const h = await setup();
  try {
    // Degraded (--no-sandbox): nothing filters — the tool says so instead of prompting.
    const tool = h.pi.tools.get("request_network_access") as unknown as {
      execute: (id: string, p: unknown, s?: unknown, u?: unknown, ctx?: unknown) => Promise<{ content: Array<{ text: string }> }>;
    };
    const res = await tool.execute("t-net", { domains: ["api.example.com"], reason: "testing" }, undefined, undefined, h.ctx);
    assert.match(res.content[0].text, /not filtered/);
    assert.equal(h.ctx.prompts.length, 0);

    // /net allow normalizes and records session grants; /net status reports them.
    await h.pi.commands.get("network")!("allow api.example.com https://svc.io/health", h.ctx);
    assert.match(h.ctx.notices.at(-1) ?? "", /allowed for this session: api\.example\.com, svc\.io/);
    await h.pi.commands.get("network")!("status", h.ctx);
    assert.match(h.ctx.notices.at(-1) ?? "", /Session grants: api\.example\.com, svc\.io/);

    // Overly-broad patterns are rejected outright.
    await h.pi.commands.get("network")!("allow *", h.ctx);
    assert.match(h.ctx.notices.at(-1) ?? "", /usage: \/network allow/);

    // ctrl+n with nothing enforcing explains itself instead of silently toggling.
    await h.pi.shortcuts.get("ctrl+n")!(h.ctx);
    assert.match(h.ctx.notices.at(-1) ?? "", /not filtered in this mode\/state/);

    // /net reset clears the grants.
    await h.pi.commands.get("network")!("reset", h.ctx);
    await h.pi.commands.get("network")!("status", h.ctx);
    assert.match(h.ctx.notices.at(-1) ?? "", /Session grants: \(none\)/);
  } finally {
    h.cleanup();
  }
});

test("injectSandboxInfo:false opts a mode out of the awareness injection", { skip }, async () => {
  const h = await setup();
  try {
    // Ask (sandboxed, no systemPrompt) injects the awareness section …
    const before = (await h.pi.emit("before_agent_start", { systemPrompt: "BASE" }, h.ctx)) as { systemPrompt: string };
    assert.match(before.systemPrompt, /Sandbox & permissions \(Ask\)/);

    // … until the global config opts it out; then nothing is injected at all.
    const dir = path.join(h.agentDir, "permission-mode");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "permission-mode.json"),
      JSON.stringify({ modes: { ask: { injectSandboxInfo: false } } }),
    );
    await h.pi.emit("session_start", {}, h.ctx);
    assert.equal(await h.pi.emit("before_agent_start", { systemPrompt: "BASE" }, h.ctx), undefined);
  } finally {
    h.cleanup();
  }
});

// --- plan approval -------------------------------------------------------------

/** Emulate a Plan-mode run that rendered `planPath` with show_plan: agent_start, the tool call, its result, agent_end. */
async function runWithShownPlan(h: Harness, planPath: string, opts: { error?: string; endRun?: boolean } = {}) {
  if (!opts.error) {
    mkdirSync(path.dirname(path.join(h.root, planPath)), { recursive: true });
    writeFileSync(path.join(h.root, planPath), `# ${planPath}\n`);
  }
  await h.pi.emit("agent_start", { type: "agent_start" }, h.ctx);
  const toolCallId = `plan${++callId}`;
  const gate = await h.pi.emit("tool_call", { type: "tool_call", toolCallId, toolName: "show_plan", input: { path: planPath } }, h.ctx);
  assert.equal(gate, undefined, "show_plan itself is never gated");
  const result = opts.error ? { details: { error: opts.error } } : { details: { path: planPath, markdown: "# plan" } };
  await h.pi.emit("tool_execution_end", { type: "tool_execution_end", toolCallId, toolName: "show_plan", result, isError: false }, h.ctx);
  if (opts.endRun !== false) await h.pi.emit("agent_end", { type: "agent_end", messages: [] }, h.ctx);
}

const APPROVE_MSG = (p: string) => `The plan in \`${p}\` is approved. Implement it now.`;

test("plan approval A: Accept after the run switches to Edits and sends the approval message once", { skip }, async () => {
  const h = await setup();
  try {
    await h.permission("plan");
    h.ctx.answers.push("Accept: switch to Edits and implement it");
    await runWithShownPlan(h, "plan/2026-09-24_x.md");
    assert.deepEqual(h.ctx.prompts.at(-1), {
      title: "Plan ready: plan/2026-09-24_x.md",
      options: ["Accept: switch to Edits and implement it", "Decline: keep refining in Plan"],
    });
    assert.match(h.ctx.status, /^Edits /);
    assert.deepEqual(h.pi.messages, [{ content: APPROVE_MSG("plan/2026-09-24_x.md"), opts: { deliverAs: "followUp" } }]); // queued: agent_end still counts as streaming
    // Persisted: shown, then approved (no path), so a resume does not re-offer it.
    const plan = h.pi.entries.filter((e) => e.customType === "perm-plan").map((e) => e.data as { path?: string; sha?: string });
    assert.equal(plan.length, 2);
    assert.equal(plan[0].path, "plan/2026-09-24_x.md");
    assert.match(plan[0].sha ?? "", /^[0-9a-f]{64}$/, "the shown content is hashed");
    assert.deepEqual(plan[1], {});
    await h.pi.commands.get("plan")!("status", h.ctx);
    assert.match(h.ctx.notices.at(-1) ?? "", /no plan pending/);
    // The implementing run ends without a show_plan: nothing is asked.
    const before = h.ctx.prompts.length;
    await h.pi.emit("agent_start", { type: "agent_start" }, h.ctx);
    await h.pi.emit("agent_end", { type: "agent_end", messages: [] }, h.ctx);
    assert.equal(h.ctx.prompts.length, before);
  } finally {
    h.cleanup();
  }
});

test("plan approval: Decline keeps Plan Mode and the pending plan; B confirms on /perm build; Esc counts as decline", { skip }, async () => {
  const h = await setup();
  try {
    await h.permission("plan");
    h.ctx.answers.push("Decline: keep refining in Plan");
    await runWithShownPlan(h, "plan/2026-09-24_a.md");
    assert.match(h.ctx.status, /^Plan /);
    assert.equal(h.pi.messages.length, 0);
    // A second run without a new show_plan asks nothing.
    const prompts = h.ctx.prompts.length;
    await h.pi.emit("agent_start", { type: "agent_start" }, h.ctx);
    await h.pi.emit("agent_end", { type: "agent_end", messages: [] }, h.ctx);
    assert.equal(h.ctx.prompts.length, prompts);
    // Still pending for B and C.
    await h.pi.commands.get("plan")!("status", h.ctx);
    assert.match(h.ctx.notices.at(-1) ?? "", /pending plan: plan\/2026-09-24_a\.md/);
    // B: the manual switch asks; No leaves Edits with nothing sent.
    h.ctx.confirms.push(false);
    await h.permission("edits");
    assert.deepEqual(h.ctx.confirmPrompts, ["Implement plan/2026-09-24_a.md now?"]);
    assert.match(h.ctx.status, /^Edits /);
    assert.equal(h.pi.messages.length, 0);
    // Back to Plan, switch again, Yes sends it.
    await h.permission("plan");
    h.ctx.confirms.push(true);
    await h.permission("edits");
    assert.deepEqual(h.pi.messages.map((m) => m.content), [APPROVE_MSG("plan/2026-09-24_a.md")]);
    // A dismissed prompt (Esc -> undefined) is a decline too.
    await h.permission("plan");
    await runWithShownPlan(h, "plan/2026-09-24_b.md"); // no scripted answer -> undefined
    assert.match(h.ctx.status, /^Plan /);
    assert.equal(h.pi.messages.length, 1);
  } finally {
    h.cleanup();
  }
});

test("plan approval C: /plan approve switches and sends without a prompt; nothing pending -> notice only", { skip }, async () => {
  const h = await setup();
  try {
    await h.pi.commands.get("plan")!("approve", h.ctx);
    assert.match(h.ctx.notices.at(-1) ?? "", /no plan pending/);
    assert.equal(h.pi.messages.length, 0);
    await h.permission("plan");
    await runWithShownPlan(h, "plan/2026-09-24_c.md", { endRun: false });
    const prompts = h.ctx.prompts.length;
    await h.pi.commands.get("plan")!("approve", h.ctx);
    assert.equal(h.ctx.prompts.length, prompts, "explicit approval asks nothing");
    assert.equal(h.ctx.confirmPrompts.length, 0, "the switch it performs does not ask B");
    assert.match(h.ctx.status, /^Edits /);
    assert.deepEqual(h.pi.messages.map((m) => m.content), [APPROVE_MSG("plan/2026-09-24_c.md")]);
    // show_plan outside a planning mode (here Edits) is plain display: nothing is offered.
    const before = h.ctx.prompts.length;
    await runWithShownPlan(h, "plan/2026-09-24_d.md");
    assert.equal(h.ctx.prompts.length, before);
    await h.pi.commands.get("plan")!("status", h.ctx);
    assert.match(h.ctx.notices.at(-1) ?? "", /no plan pending/);
    assert.equal(h.pi.messages.length, 1);
  } finally {
    h.cleanup();
  }
});

test("plan approval: a missing approveMode warns once and disables A, B, and C; approveMessage is templated", { skip }, async () => {
  const h = await setup();
  try {
    const piDir = path.join(h.agentDir, "permission-mode");
    mkdirSync(piDir, { recursive: true });
    writeFileSync(path.join(piDir, "permission-mode.json"), JSON.stringify({ plan: { approveMode: "nope" } }));
    await h.pi.emit("session_start", {}, h.ctx);
    await h.permission("plan");
    await runWithShownPlan(h, "plan/2026-09-24_e.md");
    assert.equal(h.ctx.prompts.length, 0, "no Accept/Decline prompt");
    assert.equal(h.ctx.notices.filter((n) => /approveMode "nope" is not a defined mode/.test(n)).length, 1);
    await h.pi.commands.get("plan")!("approve", h.ctx);
    assert.equal(h.pi.messages.length, 0);
    assert.equal(h.ctx.notices.filter((n) => /approveMode "nope"/.test(n)).length, 1, "warned once");
    assert.match(h.ctx.status, /^Plan /);

    // A custom approve mode + message.
    writeFileSync(
      path.join(piDir, "permission-mode.json"),
      JSON.stringify({ plan: { approveMode: "ask", approveMessage: "Go: {path} ({path})" } }),
    );
    await h.pi.emit("session_start", {}, h.ctx);
    await h.permission("plan");
    h.ctx.answers.push("Accept: switch to Ask and implement it");
    await runWithShownPlan(h, "plan/2026-09-24_f.md");
    assert.match(h.ctx.status, /^Ask /);
    assert.deepEqual(h.pi.messages.map((m) => m.content), ["Go: plan/2026-09-24_f.md (plan/2026-09-24_f.md)"]);
  } finally {
    h.cleanup();
  }
});

test("plan approval: headless sessions get no prompt and no switch; the plan is still recorded", { skip }, async () => {
  const h = await setup({ hasUI: false, permFlag: "plan" });
  try {
    await runWithShownPlan(h, "plan/2026-09-24_g.md");
    assert.equal(h.ctx.prompts.length, 0);
    assert.equal(h.ctx.confirmPrompts.length, 0);
    assert.equal(h.pi.messages.length, 0);
    assert.deepEqual(h.pi.entries.filter((e) => e.customType === "perm-plan").map((e) => (e.data as { path: string }).path), ["plan/2026-09-24_g.md"]);
  } finally {
    h.cleanup();
  }
});

test("plan approval: resume restores the latest perm-plan entry; an approved plan is not offered again", { skip }, async () => {
  const entries = [
    { type: "custom", customType: "perm-mode", data: { mode: "plan" } },
    { type: "custom", customType: "perm-plan", data: { path: "plan/old.md" } },
  ];
  const h = await setup({ entries });
  try {
    await h.pi.commands.get("plan")!("status", h.ctx);
    assert.match(h.ctx.notices.at(-1) ?? "", /pending plan: plan\/old\.md/);
    // No show_plan in this run: agent_end asks nothing; B still works.
    await h.pi.emit("agent_start", { type: "agent_start" }, h.ctx);
    await h.pi.emit("agent_end", { type: "agent_end", messages: [] }, h.ctx);
    assert.equal(h.ctx.prompts.length, 0);
    h.ctx.confirms.push(true);
    await h.permission("edits");
    assert.deepEqual(h.pi.messages.map((m) => m.content), [APPROVE_MSG("plan/old.md")]);
  } finally {
    h.cleanup();
  }
  const done = await setup({ entries: [...entries, { type: "custom", customType: "perm-plan", data: {} }] });
  try {
    await done.pi.commands.get("plan")!("status", done.ctx);
    assert.match(done.ctx.notices.at(-1) ?? "", /no plan pending/);
    done.ctx.confirms.push(true);
    await done.permission("edits");
    assert.equal(done.ctx.confirmPrompts.length, 0, "nothing pending, nothing asked");
  } finally {
    done.cleanup();
  }
});

test("plan approval: a show_plan that reported an error leaves nothing pending", { skip }, async () => {
  const h = await setup();
  try {
    await h.permission("plan");
    await runWithShownPlan(h, "notes/x.md", { error: "show_plan only renders Markdown files under plan/." });
    assert.equal(h.ctx.prompts.length, 0);
    await h.pi.commands.get("plan")!("status", h.ctx);
    assert.match(h.ctx.notices.at(-1) ?? "", /no plan pending/);
    assert.equal(h.pi.entries.filter((e) => e.customType === "perm-plan").length, 0);
  } finally {
    h.cleanup();
  }
});

test("plan approval: a plan edited after show_plan is not approved blindly; unsafe plan names are never offered", { skip }, async () => {
  const h = await setup();
  try {
    await h.permission("plan");
    await runWithShownPlan(h, "plan/2026-09-24_h.md", { endRun: false });
    writeFileSync(path.join(h.root, "plan/2026-09-24_h.md"), "# swapped after it was shown\n");
    await h.pi.commands.get("plan")!("approve", h.ctx);
    assert.equal(h.pi.messages.length, 0);
    assert.match(h.ctx.notices.at(-1) ?? "", /changed since it was shown/);
    assert.match(h.ctx.status, /^Plan /);
    // A name carrying a backtick (message injection) is displayed but not offered.
    await runWithShownPlan(h, "plan/x`y.md");
    assert.equal(h.ctx.prompts.length, 0);
  } finally {
    h.cleanup();
  }
});

test("bare-word symlink out of the project prompts as an escape and can be denied and blocked", { skip }, async () => {
  const h = await setup();
  const outside = mkdtempSync(path.join(tmpdir(), "perm-bare-out-"));
  try {
    writeFileSync(path.join(outside, "secret.txt"), "top secret");
    symlinkSync(path.join(outside, "secret.txt"), path.join(h.root, "data"));
    await h.permission("edits");
    h.ctx.answers.push(`Deny and block ${path.join(outside, "secret.txt")} for this session`);
    const res = await h.call("bash", { command: "cat data" });
    assert.equal(res?.block, true);
    assert.match(h.ctx.prompts[0]?.title ?? "", /path outside project: data/);
    assert.ok(h.ctx.prompts[0]?.options.at(-1)?.includes(path.join(outside, "secret.txt")), "the block targets the link's real file");
    const again = await h.call("bash", { command: "cat data" });
    assert.match(again?.reason ?? "", /blocked for this session/);
  } finally {
    rmSync(outside, { recursive: true, force: true });
    h.cleanup();
  }
});

// --- AI classifier / automode ------------------------------------------------

/** A model-registry stub whose completion returns a scripted reply (or throws). */
function classifierRegistry(reply: () => unknown) {
  const calls: Array<{ model: unknown; context: any; options: any }> = [];
  return {
    calls,
    find: () => undefined,
    complete: async (model: unknown, context: any, options: any) => {
      calls.push({ model, context, options });
      return reply();
    },
  };
}
const allowReply = () => ({ content: [{ type: "text", text: '{"allow":true,"risk":"low","reason":"ok"}' }] });
const denyReply = () => ({ content: [{ type: "text", text: '{"allow":false,"risk":"high","reason":"secret access"}' }] });

test("automode: an allowed ask runs without prompting; status shows the classifier", { skip }, async () => {  const registry = classifierRegistry(allowReply);
  const h = await setup({ permFlag: "auto", modelRegistry: registry, model: { id: "m", provider: "p" } });
  try {
    assert.match(h.ctx.status, /^Auto /);
    assert.match(h.ctx.status, /AI:inherit/);
    const res = await h.call("write", { path: "src/app.ts", content: "x" });
    assert.equal(res, undefined); // allowed, not blocked
    assert.equal(h.ctx.prompts.length, 0); // never asked the human
    assert.equal(registry.calls.length, 1);
    assert.equal(registry.calls[0].options.maxRetries, 0); // single bounded attempt
  } finally {
    h.cleanup();
  }
});

test("automode: a denied ask is blocked without prompting", { skip }, async () => {
  const registry = classifierRegistry(denyReply);
  const h = await setup({ permFlag: "auto", modelRegistry: registry, model: { id: "m", provider: "p" } });
  try {
    const res = await h.call("write", { path: "src/app.ts", content: "x" });
    assert.equal(res?.block, true);
    assert.equal(h.ctx.prompts.length, 0);
    assert.ok(h.ctx.notices.some((n) => /auto blocked/.test(n)));
  } finally {
    h.cleanup();
  }
});

test("automode: a classifier failure fails closed (blocks) by default", { skip }, async () => {
  const registry = classifierRegistry(() => {
    throw new Error("boom");
  });
  const h = await setup({ permFlag: "auto", modelRegistry: registry, model: { id: "m", provider: "p" } });
  try {
    const res = await h.call("write", { path: "src/app.ts", content: "x" });
    assert.equal(res?.block, true);
    assert.ok(h.ctx.notices.some((n) => /classifier unavailable/.test(n)));
  } finally {
    h.cleanup();
  }
});

test("automode: failClosed:false falls back to the human prompt", { skip }, async () => {
  const registry = classifierRegistry(() => {
    throw new Error("boom");
  });
  const h = await setup({ permFlag: "auto", modelRegistry: registry, model: { id: "m", provider: "p" } });
  try {
    const dir = path.join(h.agentDir, "permission-mode");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "permission-mode.json"), JSON.stringify({ classifier: { failClosed: false } }));
    await h.pi.emit("session_start", {}, h.ctx); // reload the config
    h.ctx.answers.push("Allow once");
    const res = await h.call("write", { path: "src/app.ts", content: "x" });
    assert.equal(res, undefined); // the human allowed it
    assert.equal(h.ctx.prompts.length, 1);
    assert.ok(h.ctx.notices.some((n) => /asking instead/.test(n)));
  } finally {
    h.cleanup();
  }
});

test("automode: allowed reads never reach the classifier", { skip }, async () => {
  const registry = classifierRegistry(allowReply);
  const h = await setup({ permFlag: "auto", modelRegistry: registry, model: { id: "m", provider: "p" } });
  try {
    const res = await h.call("read", { path: "src/app.ts" });
    assert.equal(res, undefined);
    assert.equal(registry.calls.length, 0); // the allow policy short-circuits
  } finally {
    h.cleanup();
  }
});

test("/classifier-model: a bare call opens the picker, picking persists", { skip }, async () => {
  const registry = {
    find: () => undefined,
    getAvailable: () => [
      { provider: "anthropic", id: "claude-haiku-4-5" },
      { provider: "openai", id: "gpt-5" },
    ],
  };
  const h = await setup({ modelRegistry: registry, model: { id: "m", provider: "p" } });
  try {
    // Bare call: the picker lists `current-model` first (marked active by default),
    // then every registry model.
    h.ctx.answers.push("anthropic/claude-haiku-4-5");
    await h.pi.commands.get("classifier-model")!("", h.ctx);
    assert.deepEqual(h.ctx.prompts.at(-1)?.options, [
      "\u2713 current-model",
      "anthropic/claude-haiku-4-5",
      "openai/gpt-5",
    ]);
    const file = path.join(h.agentDir, "permission-mode", "permission-mode.json");
    assert.equal(
      (JSON.parse(readFileSync(file, "utf-8")) as { classifier: { model: string } }).classifier.model,
      "anthropic/claude-haiku-4-5",
    );

    // A second bare call marks the (now) active model and can switch back.
    h.ctx.notices.length = 0;
    h.ctx.answers.push("\u2713 current-model");
    await h.pi.commands.get("classifier-model")!("", h.ctx);
    assert.deepEqual(h.ctx.prompts.at(-1)?.options, [
      "current-model",
      "\u2713 anthropic/claude-haiku-4-5",
      "openai/gpt-5",
    ]);
    assert.equal(
      (JSON.parse(readFileSync(file, "utf-8")) as { classifier: { model: string } }).classifier.model,
      "current",
    );
  } finally {
    h.cleanup();
  }
});

// --- sandbox decoupling (ctrl+m / pin) ---------------------------------------

test("sandbox: ctrl+m cycles off/on/strict and /sandbox sets it", { skip }, async () => {
  const h = await setup();
  try {
    const ctrlS = h.pi.shortcuts.get("ctrl+m")!;
    await ctrlS(h.ctx); // on → strict
    assert.deepEqual(h.pi.entries.at(-1), { customType: "perm-sandbox", data: { state: "strict" } });
    await ctrlS(h.ctx); // strict → off
    assert.deepEqual(h.pi.entries.at(-1), { customType: "perm-sandbox", data: { state: "off" } });
    await ctrlS(h.ctx); // off → on
    assert.deepEqual(h.pi.entries.at(-1), { customType: "perm-sandbox", data: { state: "on" } });
    // Direct set via the command.
    await h.pi.commands.get("sandbox")!("off", h.ctx);
    assert.deepEqual(h.pi.entries.at(-1), { customType: "perm-sandbox", data: { state: "off" } });
    await h.pi.commands.get("sandbox")!("bogus", h.ctx);
    assert.match(h.ctx.notices.at(-1) ?? "", /usage: \/sandbox/);
  } finally {
    h.cleanup();
  }
});

test("/network and /sandbox: no args open interactive pickers and apply the pick", { skip }, async () => {
  const h = await setup();
  try {
    await h.permission("edits");

    // Network: the harness runtime cannot enforce (no bubblewrap) -> the honest
    // notice instead of a picker; with a live runtime the same branch opens the
    // two-option posture picker (limit/free) wired to toggleNetwork.
    await h.pi.commands.get("network")!("", h.ctx);
    assert.match(h.ctx.notices.at(-1) ?? "", /not filtered in this mode\/state/);

    // Sandbox picker: three states, current marked; picking strict persists it.
    await h.pi.commands.get("sandbox")!("", h.ctx);
    const sbPicker = h.ctx.prompts.at(-1)!;
    assert.match(sbPicker.title, /Sandbox boundary/);
    assert.equal(sbPicker.options.length, 3);
    assert.match(sbPicker.options[1], /^✓/); // "on" is the default state
    h.ctx.answers.push(sbPicker.options[2]); // strict
    await h.pi.commands.get("sandbox")!("", h.ctx);
    assert.deepEqual(h.pi.entries.at(-1), { customType: "perm-sandbox", data: { state: "strict" } });
  } finally {
    h.cleanup();
  }
});

test("sandbox: a pinned mode overrides ctrl+m, and the state outlives the mode", { skip }, async () => {
  const h = await setup();
  try {
    const dir = path.join(h.agentDir, "permission-mode");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "permission-mode.json"),
      JSON.stringify({ modes: { locked: { label: "Locked", color: "error", sandboxPin: "strict", permission: {} } } }),
    );
    await h.pi.emit("session_start", {}, h.ctx);
    await h.permission("locked");
    await h.pi.shortcuts.get("ctrl+m")!(h.ctx); // session: on → strict
    assert.deepEqual(h.pi.entries.at(-1), { customType: "perm-sandbox", data: { state: "strict" } });
    // Strict: an out-of-project command is blocked outright, no prompt.
    const sealed = await h.call("bash", { command: "cat /etc/hostname" });
    assert.equal(sealed?.block, true);
    assert.match(sealed?.reason ?? "", /Sandbox strict: outside-project access is blocked/);

    // The sandbox state is MODE-INDEPENDENT: switching to `ask` keeps `strict`.
    await h.permission("ask");
    const still = await h.call("bash", { command: "cat /etc/hostname" });
    assert.equal(still?.block, true);
    assert.match(still?.reason ?? "", /Sandbox strict/);

    // ctrl+m (strict → off): the boundary opens for every mode.
    await h.pi.shortcuts.get("ctrl+m")!(h.ctx);
    assert.deepEqual(h.pi.entries.at(-1), { customType: "perm-sandbox", data: { state: "off" } });
    h.ctx.answers.push("Deny");
    const opened = await h.call("bash", { command: "cat /etc/hostname" });
    assert.equal(opened?.block, true);
    assert.doesNotMatch(opened?.reason ?? "", /Sandbox strict/); // now it is the escape prompt, not the boundary
    assert.equal(h.ctx.prompts.length, 1);
  } finally {
    h.cleanup();
  }
});

test("sandbox: the session state is restored from the persisted entry", { skip }, async () => {
  const h = await setup({ entries: [{ type: "custom", customType: "perm-sandbox", data: { state: "off" } }] });
  try {
    h.ctx.notices.length = 0;
    await h.pi.commands.get("sandbox")!("status", h.ctx);
    assert.match(h.ctx.notices.join("\n"), /sandbox OFF/);
  } finally {
    h.cleanup();
  }
});

test("whitelist (Tier 1): a read-only bash command runs without prompting; a mutation still asks", { skip }, async () => {
  const h = await setup();
  try {
    assert.equal(await h.call("bash", { command: "ls -la | grep src" }), undefined);
    assert.equal(h.ctx.prompts.length, 0, "read-only whitelisted command never prompts");
    h.ctx.answers.push("Allow once");
    const mutating = await h.call("bash", { command: "touch newfile" });
    assert.equal(mutating, undefined);
    assert.equal(h.ctx.prompts.length, 1, "a mutation still asks");
  } finally {
    h.cleanup();
  }
});
