import test from "node:test";
import assert from "node:assert/strict";
import { honestOperationState, stateFromCapability } from "./operation-state.js";

test("honest operation taxonomy is exhaustive, terminal, target-free, and never successful", () => {
  for (const state of ["unsupported", "unentitled", "read_only", "unknown", "UNPROVEN"] as const) {
    const view = honestOperationState(state);
    assert.deepEqual(view, honestOperationState(state));
    assert.equal(view.state, state);
    assert.equal(view.success, false);
    assert.equal(view.terminal, true);
    assert.equal(JSON.stringify(view).match(/target|email|token|path/i), null);
  }
});

test("malformed or absent capability evidence fails closed while declared mutation authority remains unproven", () => {
  assert.equal(stateFromCapability(undefined, "routes"), "unknown");
  assert.equal(stateFromCapability({ readStatus: "true", mutateRoutes: true }, "routes"), "unknown");
  assert.equal(stateFromCapability({ readStatus: true, mutateRoutes: false }, "routes"), "read_only");
  assert.equal(stateFromCapability({ readStatus: true, mutateRoutes: true }, "routes"), "UNPROVEN");
  assert.equal(stateFromCapability({ readStatus: true, startReauth: false }, "reauth"), "read_only");
  assert.equal(stateFromCapability({ readStatus: true, mutateModels: true }, "models"), "UNPROVEN");
});
