/**
 * The shipped defaults must satisfy the shipped schema.
 *
 * Both files are user-facing (`/permission init` copies the defaults; editors
 * validate user configs against the schema), and the schema is `strict`
 * (`additionalProperties: false`), so any key the loader accepts but the schema
 * does not declare — or vice versa — makes the stock file invalid or rejects a
 * working user config. This is a structural check by hand: the repo has no
 * JSON-schema validator dependency and the subset used here is small.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const schema = JSON.parse(readFileSync(path.join(root, "schemas", "permission-mode.schema.json"), "utf-8")) as {
  properties: Record<string, { enum?: string[]; properties?: Record<string, unknown> }>;
  $defs: Record<string, { properties: Record<string, unknown> }>;
};
const defaults = JSON.parse(readFileSync(path.join(root, "permission-mode.defaults.json"), "utf-8")) as {
  cycleOrder?: string[];
  defaultMode?: string;
  statusFormat?: string;
  network?: Record<string, unknown>;
  modes: Record<string, Record<string, unknown>>;
};

const top = schema.properties;
const modeProps = schema.$defs.mode.properties;
const sandboxProps = schema.$defs.sandbox.properties;
const permissionProps = schema.$defs.permission.properties;

describe("defaults ↔ schema consistency", () => {
  it("declares every top-level key the defaults use", () => {
    for (const key of Object.keys(defaults)) {
      assert.ok(key in top, `schema is missing the top-level property "${key}"`);
    }
  });

  it("declares every mode key, color, sandbox key, and permission surface the defaults use", () => {
    const colors = schema.$defs.mode.properties.color as unknown as { enum: string[] };
    for (const [name, mode] of Object.entries(defaults.modes)) {
      for (const key of Object.keys(mode)) {
        assert.ok(key in modeProps, `schema is missing modes.${name}.${key}`);
      }
      if (typeof mode.color === "string") assert.ok(colors.enum.includes(mode.color), `modes.${name}.color "${mode.color}" is not in the schema enum`);
      if (mode.sandboxPin !== undefined) {
        const pin = (modeProps.sandboxPin as unknown as { enum: string[] }).enum;
        assert.ok(pin.includes(mode.sandboxPin as string), `modes.${name}.sandboxPin "${mode.sandboxPin}" is not in the schema enum`);
      }
      const sandbox = mode.sandbox as Record<string, unknown> | undefined;
      if (sandbox) for (const key of Object.keys(sandbox)) assert.ok(key in sandboxProps, `schema is missing modes.${name}.sandbox.${key}`);
      const permission = mode.permission as Record<string, unknown> | undefined;
      if (permission) for (const key of Object.keys(permission)) assert.ok(key in permissionProps, `schema is missing modes.${name}.permission.${key}`);
    }
  });

  it("declares the top-level network keys and the status format the defaults use", () => {
    const netProps = top.network.properties ?? {};
    for (const key of Object.keys(defaults.network ?? {})) assert.ok(key in netProps, `schema is missing the top-level network.${key}`);
    if (defaults.statusFormat !== undefined) {
      assert.ok(top.statusFormat.enum?.includes(defaults.statusFormat), `statusFormat "${defaults.statusFormat}" is not in the schema enum`);
    }
  });

  it("keeps cycleOrder and defaultMode pointing at shipped modes", () => {
    const names = new Set(Object.keys(defaults.modes));
    for (const name of defaults.cycleOrder ?? []) assert.ok(names.has(name), `cycleOrder lists unknown mode "${name}"`);
    assert.ok(names.has(defaults.defaultMode as string), `defaultMode "${defaults.defaultMode}" is not a shipped mode`);
  });

  it("ships the sandbox states as off/on/strict everywhere (the removed `ro` state must not reappear)", () => {
    const pins = modeProps.sandboxPin as unknown as { enum: string[] };
    assert.deepEqual([...pins.enum].sort(), ["off", "on", "strict"]);
    for (const [name, mode] of Object.entries(defaults.modes)) {
      assert.notEqual(mode.sandboxPin, "ro", `modes.${name} still pins the removed "ro" state`);
    }
  });
});
