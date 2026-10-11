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
  updateStatus(c as never, mode({ enabled: true, writable: true, network: { allowedDomains: ["a.com"] } }), ready, false, undefined, false);
  assert.equal(c.status, "Build (sandboxed in project dir, alt+m)  Network: filtered (alt+n)");
  c = ctx();
  updateStatus(c as never, mode({ enabled: true, writable: true, network: { allowedDomains: [] } }), ready, true, undefined, false);
  assert.equal(c.status, "Build (sandboxed in project dir, alt+m)  Network: open (alt+n)");
  // No allowlist configured: the runtime does not filter, and the chip must not claim it does.
  c = ctx();
  updateStatus(c as never, mode({ enabled: true, writable: true }), ready, false, undefined, false);
  assert.equal(c.status, "Build (sandboxed in project dir, alt+m)  Network: unrestricted");
  c = ctx();
  updateStatus(c as never, mode({ enabled: true, writable: true, network: { allowedDomains: ["a.com"] } }), { ready: false, warn: "sandbox init failed", disabled: false }, false, undefined, false);
  assert.equal(c.status, "Build (alt+m) (!) sandbox init failed  Network: open");
});

test("updateStatus (compact, default): readable tokens for sandbox / network / classifier", () => {
  const ready = { ready: true, warn: undefined, disabled: false };
  const sbOnFiltered = { enabled: true, writable: true, network: { allowedDomains: ["a.com"] } };
  // sandbox on + filtered network + classifier
  let c = ctx();
  updateStatus(c as never, { ...mode(sbOnFiltered), classifier: true }, ready, false, "AI:m");
  assert.equal(c.status, "Build · sandbox:on · net:filtered · AI:m");
  // network open
  c = ctx();
  updateStatus(c as never, mode(sbOnFiltered), ready, true, undefined);
  assert.equal(c.status, "Build · sandbox:on · net:open");
  // read-only sandbox
  c = ctx();
  updateStatus(c as never, mode({ enabled: true, writable: false, network: { allowedDomains: ["a.com"] } }), ready, false, undefined);
  assert.equal(c.status, "Build · sandbox:read-only · net:filtered");
  // no allowlist → no network token
  c = ctx();
  updateStatus(c as never, mode({ enabled: true, writable: true }), ready, false, undefined);
  assert.equal(c.status, "Build · sandbox:on");
  // sandbox off
  c = ctx();
  updateStatus(c as never, mode({ enabled: false, writable: true }), ready, false, undefined);
  assert.equal(c.status, "Build · sandbox:off");
  // sandbox unavailable (degraded)
  c = ctx();
  updateStatus(c as never, mode(sbOnFiltered), { ready: false, warn: "nope", disabled: false }, false, undefined);
  assert.equal(c.status, "Build · sandbox:unavailable");
});

test("updateStatus: the classifier AI token only appears in classifier modes", () => {
  const ready = { ready: true, warn: undefined, disabled: false };
  const sb = { enabled: true, writable: true };
  let c = ctx();
  updateStatus(c as never, { ...mode(sb), classifier: true }, ready, false, "AI:m");
  assert.match(c.status, /AI:m/);
  c = ctx();
  updateStatus(c as never, mode(sb), ready, false, "AI:m");
  assert.ok(!/AI/.test(c.status), "no AI token outside classifier modes");
});
