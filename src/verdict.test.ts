import assert from "node:assert/strict";
import test from "node:test";
import type { BashCommand } from "./bash-parse.ts";
import { bashFacts, fileFacts, hostsInCommand, toolFacts, webFacts, type CallFacts } from "./facts.ts";
import { type Axes, verdict } from "./verdict.ts";
import type { Action, ModeDef, SandboxState } from "./schema.ts";

const root = "/home/u/proj";
const cmd = (name: string, ...args: string[]): BashCommand => ({ name, args, isNested: false });

const mode = (policy: Partial<Record<string, unknown>> = {}, extra: Partial<ModeDef> = {}): ModeDef =>
  ({
    label: "Test",
    color: "success",
    permission: { bash: { "*": "ask" }, write: "ask", edit: "ask", web_search: "ask", tool: "ask", external_directory: "ask", ...policy },
    ...extra,
  }) as unknown as ModeDef;

const axes = (over: Partial<Axes> = {}): Axes => ({
  root,
  sandboxEnabled: true,
  sandboxState: "on" as SandboxState,
  sandboxReady: true,
  classifierOn: true,
  unsandboxedAI: false,
  egressFiltered: false,
  egressOpen: false,
  hostAllowed: () => false,
  hostDenied: () => false,
  blocked: () => false,
  ...over,
});

const bash = (command: string, over: Partial<Parameters<typeof bashFacts>[0]> = {}, m = mode()): CallFacts =>
  bashFacts({
    command,
    root,
    bounds: [root, "/tmp/pi"],
    mode: m,
    modeLabel: m.label,
    sandboxed: true,
    commands: [cmd(command.split(" ")[0] ?? command, ...command.split(" ").slice(1))],
    outsideReason: undefined,
    usedFallback: false,
    safeChain: false,
    scriptReview: { inspectable: true, scripts: [] },
    ...over,
  });

test("bash: a whitelisted read-only in-bounds command is silent", () => {
  const f = bash("ls -la", { safeChain: true });
  assert.deepEqual(verdict(f, axes()), { kind: "allow" });
});

test("bash: an in-project non-whitelisted command goes to the classifier when on", () => {
  const v = verdict(bash("make build"), axes());
  assert.equal(v.kind, "ask");
  assert.ok(v.kind === "ask" && v.via === "ai");
  assert.ok(v.kind === "ask" && v.review?.tool === "bash");
});

test("bash: the classifier off means the human decides", () => {
  const v = verdict(bash("make build"), axes({ classifierOn: false }));
  assert.ok(v.kind === "ask" && v.via === "human");
});

test("bash: privilege escalation is human-only even with classifier and opt-in", () => {
  const f = bash("sudo apt update", {
    commands: [cmd("sudo", "apt", "update")],
    outsideReason: "privilege escalation via sudo",
    scriptReview: { inspectable: true, scripts: [] },
  });
  const v = verdict(f, axes({ unsandboxedAI: true }));
  assert.ok(v.kind === "ask" && v.via === "human", JSON.stringify(v));
  assert.deepEqual(v.kind === "ask" && v.target, ["escape:sudo apt update"]);
});

test("bash: strict state blocks outside access outright", () => {
  const f = bash("cat /etc/hosts", {
    commands: [cmd("cat", "/etc/hosts")],
    outsideReason: "path outside project: /etc/hosts",
  });
  const v = verdict(f, axes({ sandboxState: "strict" }));
  assert.equal(v.kind, "block");
});

test("bash: an enforced-sandbox escape is human-only", () => {
  const f = bash("cat /etc/shadow", {
    commands: [cmd("cat", "/etc/shadow")],
    outsideReason: "path outside project: /etc/shadow",
    usedFallback: true,
  });
  const v = verdict(f, axes({ sandboxState: "on", sandboxReady: true }));
  assert.ok(v.kind === "ask" && v.via === "human", JSON.stringify(v));
});

test("bash: sandbox off + opt-in + inspectable → AI; opaque → human", () => {
  const m = mode({ bash: { "*": "ask" } }, { aiGatesUnsandboxed: true } as Partial<ModeDef>);
  const ok = verdict(bash("node --version", { sandboxed: false }, m), axes({ sandboxEnabled: false, unsandboxedAI: true, sandboxReady: false }));
  assert.ok(ok.kind === "ask" && ok.via === "ai", JSON.stringify(ok));
  const opaque = verdict(
    bash("bash -c $(cat x)", { sandboxed: false, scriptReview: { inspectable: false, scripts: [] } }, m),
    axes({ sandboxEnabled: false, unsandboxedAI: true, sandboxReady: false }),
  );
  assert.ok(opaque.kind === "ask" && opaque.via === "human");
});

test("bash: a host outside the allowlist is a human decision (N2), a denied host blocks", () => {
  const f = bash("curl https://evil.example/x");
  assert.deepEqual(f.hosts, ["evil.example"]);
  const v = verdict(f, axes({ egressFiltered: true }));
  assert.ok(v.kind === "ask" && v.via === "human" && v.grantHost === "evil.example");
  const denied = verdict(f, axes({ egressFiltered: true, hostDenied: (h) => h === "evil.example" }));
  assert.equal(denied.kind, "block");
  const open = verdict(f, axes({ egressFiltered: true, egressOpen: true }));
  assert.equal(open.kind, "ask", "an open session does not force the network prompt");
  assert.ok(open.kind === "ask" && open.via === "ai");
});

test("bash: an allowlisted host does not prompt for the network", () => {
  const v = verdict(bash("curl https://api.github.com/x"), axes({ egressFiltered: true, hostAllowed: (h) => h === "api.github.com" }));
  assert.ok(v.kind === "ask" && v.via === "ai");
});

test("file: a protected path is blocked whatever the mode", () => {
  const m = mode({ write: "allow" });
  const f = fileFacts({ tool: "write", surface: "write", path: ".git/config", root, inBounds: [root], mode: m, modeLabel: "T", bypassProtectedPaths: false });
  assert.equal(verdict({ ...f, protectedPath: true }, axes()).kind, "block");
});

test("file: an outside write is human-only; outside read is classifier-gated", () => {
  const m = mode({ write: "allow", external_directory: "ask" });
  const write = fileFacts({ tool: "write", surface: "write", path: "/etc/x", root, inBounds: [root], mode: m, modeLabel: "T", bypassProtectedPaths: false });
  const vw = verdict(write, axes());
  assert.ok(vw.kind === "ask" && vw.via === "human" && vw.unsandboxed);
  const read = fileFacts({ tool: "read", surface: "read", path: "/etc/hosts", root, inBounds: [root], mode: mode({ read: "ask", external_directory: "ask" }), modeLabel: "T", bypassProtectedPaths: false });
  const vr = verdict(read, axes());
  assert.ok(vr.kind === "ask" && vr.via === "ai");
});

test("file: a granted outside-write root is in bounds (no prompt when write allowed)", () => {
  const m = mode({ write: "allow" });
  const f = fileFacts({ tool: "write", surface: "write", path: "/etc/pm-roots/n.txt", root, inBounds: [root, "/etc/pm-roots"], mode: m, modeLabel: "T", bypassProtectedPaths: false });
  assert.equal(f.isOutside, false);
  assert.deepEqual(verdict(f, axes()), { kind: "allow" });
});

test("file: a session-blocked path is refused before policy", () => {
  const m = mode({ read: "allow" });
  const f = fileFacts({ tool: "read", surface: "read", path: "/etc/hosts", root, inBounds: [root], mode: m, modeLabel: "T", bypassProtectedPaths: false });
  assert.equal(verdict(f, axes({ blocked: () => true })).kind, "block");
});

test("web: deny blocks, ask goes to the classifier when on, to the human when off", () => {
  const f = webFacts("latest news", mode({ web_search: "ask" }), "T");
  const v = verdict(f, axes());
  assert.ok(v.kind === "ask" && v.via === "ai" && v.surface === "web_search");
  assert.ok(verdict(webFacts("x", mode({ web_search: "deny" }), "T"), axes()).kind === "block");
  assert.ok(verdict(webFacts("x", mode({ web_search: "ask" }), "T"), axes({ classifierOn: false })).kind === "ask");
});

test("tool: first use asks and offers Allow forever", () => {
  const v = verdict(toolFacts("some_ext", { a: 1 }, mode({ tool: "ask" }), "T"), axes({ classifierOn: false }));
  assert.ok(v.kind === "ask" && v.via === "human" && v.learnForever);
});

test("hostsInCommand: URL authorities, credentials and ports stripped", () => {
  assert.deepEqual(hostsInCommand("curl https://user:pw@Example.com:8443/a?b=c && wget http://x.org"), ["example.com", "x.org"]);
  assert.deepEqual(hostsInCommand("ls -la"), []);
});

// ---- property checks over a matrix of facts and axes ----------------------

function matrix(): { f: CallFacts; a: Axes }[] {
  const out: { f: CallFacts; a: Axes }[] = [];
  const m = mode({ bash: { "*": "ask" }, write: "ask", read: "ask", web_search: "ask", tool: "ask" }, { aiGatesUnsandboxed: true } as Partial<ModeDef>);
  const bools = [false, true];
  const reasons: (string | undefined)[] = [undefined, "path outside project: /etc/x", "privilege escalation via sudo"];
  for (const policy of ["allow", "ask", "deny"] as Action[])
    for (const sandboxEnabled of bools)
      for (const sandboxState of ["off", "on", "strict"] as SandboxState[])
        for (const sandboxReady of bools)
          for (const classifierOn of bools)
            for (const unsandboxedAI of bools)
              for (const egressFiltered of bools)
                for (const egressOpen of bools)
                  for (const outsideReason of reasons)
                    for (const inspectable of bools)
                      for (const safeChain of bools)
                        for (const hosts of [[], ["evil.example"]] as string[][]) {
                          const base = bash("cmd x", {
                            sandboxed: sandboxEnabled,
                            outsideReason,
                            commands: [cmd(outsideReason?.startsWith("priv") ? "sudo" : "cmd", "x")],
                            usedFallback: true,
                            safeChain,
                            scriptReview: { inspectable, scripts: [] },
                          }, m);
                          const f: CallFacts = { ...base, policy, hosts, privileged: outsideReason?.startsWith("privilege") === true };
                          out.push({
                            f,
                            a: axes({
                              sandboxEnabled,
                              sandboxState,
                              sandboxReady,
                              classifierOn,
                              unsandboxedAI,
                              egressFiltered,
                              egressOpen,
                            }),
                          });
                        }
  return out;
}

test("N0: a protected path is never allowed or asked", () => {
  const m = mode({ write: "allow" });
  for (const a of [axes(), axes({ sandboxState: "off", sandboxEnabled: false })]) {
    const f = { ...fileFacts({ tool: "write", surface: "write", path: "x", root, inBounds: [root], mode: m, modeLabel: "T", bypassProtectedPaths: false }), protectedPath: true, policy: "allow" as Action };
    assert.equal(verdict(f, a).kind, "block");
  }
});

test("N1–N6 hold over the whole fact/axis matrix", () => {
  let checked = 0;
  for (const { f, a } of matrix()) {
    // Axes consistency: the state is "off" exactly when the profile is disabled.
    if ((a.sandboxState === "off") === a.sandboxEnabled) continue;
    const v = verdict(f, a);
    checked++;
    const privileged = f.privileged;
    const escape = Boolean(f.outsideReason) && a.sandboxReady && a.sandboxEnabled;
    // N1: privilege and escapes are never AI-judged; under an ENFORCING sandbox
    // they are never allowed silently either. (An unsandboxed mode whose policy
    // explicitly allows bash — e.g. accept — keeps its user-chosen silence.)
    if (privileged || escape) assert.ok(!(v.kind === "ask" && v.via === "ai"), JSON.stringify({ f: f.command, a }));
    if (escape && a.sandboxEnabled) assert.ok(v.kind !== "allow", JSON.stringify({ f: f.command, a }));
    // N2: an unlisted host (filtered egress, not open) is never allowed or AI-judged.
    if (a.egressFiltered && !a.egressOpen && f.hosts.length > 0 && !a.hostAllowed("evil.example")) {
      assert.ok(v.kind === "block" || (v.kind === "ask" && v.via === "human"), JSON.stringify({ v, a }));
    }
    // N3: a policy deny is not overridden by any grant.
    if (f.policy === "deny" && f.hosts.length === 0) assert.equal(v.kind, "block");
    // N4: strict blocks any outside access (no host prompt in front of it).
    if (a.sandboxState === "strict" && f.outsideReason && f.hosts.length === 0) assert.equal(v.kind, "block");
    // N5: an UNSANDBOXED call reaches the AI only if it is inspectable and names
    // no hosts. (Contained calls are bounded by the sandbox; the AI reviews them
    // even when the payload is opaque, e.g. `$(…)` in a build line.)
    const uncontained = !(a.sandboxEnabled && a.sandboxReady) || f.kind !== "bash";
    if (v.kind === "ask" && v.via === "ai" && uncontained && f.kind === "bash") {
      assert.ok(f.inspectable && (f.hosts.length === 0 || a.egressOpen), JSON.stringify(f.command));
    }
    // N6: no classifier means no AI.
    if (!a.classifierOn) assert.ok(!(v.kind === "ask" && v.via === "ai"));
  }
  assert.ok(checked > 5000, `matrix too small: ${checked}`);
});
