import assert from "node:assert/strict";
import test from "node:test";
import type { ModeDef } from "./schema.ts";
import { updateStatus } from "./status.ts";

const ctx = () => {
  let status = "";
  return {
    ui: { theme: { fg: (_c: string, t: string) => t }, setStatus: (_k: string, v: string) => void (status = v) },
    get status() {
      return status;
    },
  };
};
const mode = (sandbox: ModeDef["sandbox"]): ModeDef => ({ label: "Build", color: "accent", sandbox, permission: {} });

test("updateStatus (verbose): filtered / open / unrestricted / degraded", () => {
  const ready = { ready: true, warn: undefined, disabled: false };
  let c = ctx();
  updateStatus(c as never, mode({ enabled: true, writable: true, network: { allowedDomains: ["a.com"] } }), ready, false, undefined, false, "on");
  assert.equal(c.status, "Build (sandboxed in project dir, alt+m)  Network: filtered (alt+n)");
  c = ctx();
  updateStatus(c as never, mode({ enabled: true, writable: true, network: { allowedDomains: [] } }), ready, true, undefined, false, "on");
  assert.equal(c.status, "Build (sandboxed in project dir, alt+m)  Network: open (alt+n)");
  // No allowlist configured: the runtime does not filter, and the chip must not claim it does.
  c = ctx();
  updateStatus(c as never, mode({ enabled: true, writable: true }), ready, false, undefined, false, "on");
  assert.equal(c.status, "Build (sandboxed in project dir, alt+m)  Network: unrestricted");
  c = ctx();
  updateStatus(c as never, mode({ enabled: true, writable: true, network: { allowedDomains: ["a.com"] } }), { ready: false, warn: "sandbox init failed", disabled: false }, false, undefined, false, "on");
  assert.equal(c.status, "Build (alt+m) (!) sandbox init failed  Network: open");
});

test("updateStatus (compact, default): box / net / AI tokens", () => {
  const ready = { ready: true, warn: undefined, disabled: false };
  const sbOnLimited = { enabled: true, writable: true, network: { allowedDomains: ["a.com"] } };
  // sandbox on + network limited + classifier
  let c = ctx();
  updateStatus(c as never, { ...mode(sbOnLimited), classifier: true }, ready, false, "AI:inherit", true, "on");
  assert.equal(c.status, "Build box:on net:limit AI:inherit");
  // network free
  c = ctx();
  updateStatus(c as never, mode(sbOnLimited), ready, true, undefined, true, "on");
  assert.equal(c.status, "Build box:on net:free");
  // strict sandbox
  c = ctx();
  updateStatus(c as never, mode(sbOnLimited), ready, false, undefined, true, "strict");
  assert.equal(c.status, "Build box:strict net:limit");
  // no allowlist → no network token
  c = ctx();
  updateStatus(c as never, mode({ enabled: true, writable: true }), ready, false, undefined, true, "on");
  assert.equal(c.status, "Build box:on");
  // sandbox off
  c = ctx();
  updateStatus(c as never, mode({ enabled: false, writable: true }), ready, false, undefined, true, "off");
  assert.equal(c.status, "Build box:off");
  // sandbox unavailable (degraded)
  c = ctx();
  updateStatus(c as never, mode(sbOnLimited), { ready: false, warn: "nope", disabled: false }, false, undefined, true, "on");
  assert.equal(c.status, "Build box:unavailable");
});

test("updateStatus: the classifier AI token only appears in classifier modes", () => {
  const ready = { ready: true, warn: undefined, disabled: false };
  const sb = { enabled: true, writable: true };
  let c = ctx();
  updateStatus(c as never, { ...mode(sb), classifier: true }, ready, false, "AI:inherit", true, "on");
  assert.match(c.status, /AI:inherit/);
  c = ctx();
  updateStatus(c as never, mode(sb), ready, false, "AI:inherit", true, "on");
  assert.ok(!/AI/.test(c.status), "no AI token outside classifier modes");
});

test("updateStatus: a classifier mode without an enforcing sandbox shows AI:no-box", () => {
  const sb = { enabled: true, writable: true };
  // sandbox off
  let c = ctx();
  updateStatus(c as never, { ...mode({ enabled: false, writable: true }), classifier: true }, { ready: true, warn: undefined, disabled: false }, false, "AI:inherit", true, "off");
  assert.equal(c.status, "Build box:off AI:no-box");
  // sandbox on but unavailable
  c = ctx();
  updateStatus(c as never, { ...mode(sb), classifier: true }, { ready: false, warn: "nope", disabled: false }, false, "AI:inherit", true, "on");
  assert.equal(c.status, "Build box:unavailable AI:no-box");
  // verbose form explains why
  c = ctx();
  updateStatus(c as never, { ...mode(sb), classifier: true }, { ready: false, warn: "nope", disabled: false }, false, "AI:inherit", false, "on");
  assert.match(c.status, /AI: without a sandbox, bash asks go to you/);
});
