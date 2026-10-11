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

test("updateStatus: filtered / open / unrestricted / degraded", () => {
  const ready = { ready: true, warn: undefined, disabled: false };
  let c = ctx();
  updateStatus(c as never, mode({ enabled: true, writable: true, network: { allowedDomains: ["a.com"] } }), ready, false);
  assert.equal(c.status, "Build (sandboxed in project dir, alt+m)  Network: filtered (alt+n)");
  c = ctx();
  updateStatus(c as never, mode({ enabled: true, writable: true, network: { allowedDomains: [] } }), ready, true);
  assert.equal(c.status, "Build (sandboxed in project dir, alt+m)  Network: open (alt+n)");
  // No allowlist configured: the runtime does not filter, and the chip must not claim it does.
  c = ctx();
  updateStatus(c as never, mode({ enabled: true, writable: true }), ready, false);
  assert.equal(c.status, "Build (sandboxed in project dir, alt+m)  Network: unrestricted");
  c = ctx();
  updateStatus(c as never, mode({ enabled: true, writable: true, network: { allowedDomains: ["a.com"] } }), { ready: false, warn: "sandbox init failed", disabled: false }, false);
  assert.equal(c.status, "Build (alt+m) (!) sandbox init failed  Network: open");
});

test("updateStatus: the classifier chip only appears in classifier modes", () => {
  const ready = { ready: true, warn: undefined, disabled: false };
  let c = ctx();
  updateStatus(c as never, { ...mode({ enabled: true, writable: true }), classifier: true }, ready, false, "AI:m");
  assert.match(c.status, /AI:m/);
  c = ctx();
  updateStatus(c as never, mode({ enabled: true, writable: true }), ready, false, "AI:m");
  assert.ok(!/AI:m/.test(c.status), "no chip outside classifier modes");
});
