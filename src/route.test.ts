import assert from "node:assert/strict";
import test from "node:test";
import { type AskFacts, routeAsk } from "./route.ts";

const base: AskFacts = {
  classifierEnabled: true,
  escalateToHuman: false,
  privilege: false,
  sandboxEscape: false,
  neverAI: false,
  inspectable: true,
  unsandboxedAI: true,
};

test("contained asks go to the classifier", () => {
  assert.equal(routeAsk(base), "classifier");
  assert.equal(routeAsk({ ...base, unsandboxedAI: false }), "classifier", "the opt-in does not affect contained asks");
});

test("I5: no classifier means human, always", () => {
  for (const f of allCombinations()) {
    if (!f.classifierEnabled) assert.equal(routeAsk(f), "human");
  }
});

test("I1–I3: privilege, sandbox escapes and outside file writes are never AI", () => {
  for (const f of allCombinations()) {
    if (f.privilege || f.sandboxEscape || f.neverAI) assert.equal(routeAsk(f), "human", JSON.stringify(f));
  }
});

test("I4: an unsandboxed action is AI only when opted in AND fully inspectable", () => {
  const unsandboxed = { ...base, escalateToHuman: true };
  assert.equal(routeAsk(unsandboxed), "classifier");
  assert.equal(routeAsk({ ...unsandboxed, unsandboxedAI: false }), "human");
  assert.equal(routeAsk({ ...unsandboxed, inspectable: false }), "human");
  assert.equal(routeAsk({ ...unsandboxed, inspectable: undefined }), "classifier", "unknown is not treated as opaque");
});

test("exhaustive: the classifier is only ever chosen when every invariant allows it", () => {
  for (const f of allCombinations()) {
    const route = routeAsk(f);
    if (route === "classifier") {
      assert.ok(f.classifierEnabled, JSON.stringify(f));
      assert.ok(!f.privilege && !f.sandboxEscape && !f.neverAI, JSON.stringify(f));
      if (f.escalateToHuman) {
        assert.ok(f.unsandboxedAI && f.inspectable !== false, JSON.stringify(f));
      }
    }
  }
});

function allCombinations(): AskFacts[] {
  const out: AskFacts[] = [];
  const bools = [false, true];
  for (const classifierEnabled of bools)
    for (const escalateToHuman of bools)
      for (const privilege of bools)
        for (const sandboxEscape of bools)
          for (const neverAI of bools)
            for (const unsandboxedAI of bools)
              for (const inspectable of [true, false, undefined] as const)
                out.push({ classifierEnabled, escalateToHuman, privilege, sandboxEscape, neverAI, unsandboxedAI, inspectable });
  return out;
}
