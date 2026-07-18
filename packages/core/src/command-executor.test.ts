import test from "node:test";
import assert from "node:assert/strict";
import { executeAccountCenterCommand } from "./command-executor.js";
import { FixtureRuntimeAdapter } from "./runtime-adapters.js";

test("core executor returns status without a UI or CLI renderer", async () => {
  const result = await executeAccountCenterCommand({ command: "status" }, { adapter: new FixtureRuntimeAdapter() });
  assert.equal(result.code, 0);
  assert.equal(result.kind, "status");
  assert.equal(result.status?.schemaVersion, "account-center.status.v1");
});

test("core executor plans routing by default and returns a receipt", async () => {
  const result = await executeAccountCenterCommand({ command: "route.auto", provider: "openai", runtime: "openclaw" }, { adapter: new FixtureRuntimeAdapter() });
  assert.equal(result.code, 0);
  assert.equal(result.kind, "mutation");
  assert.equal(result.mutation?.applied, false);
  assert.equal(result.mutation?.receipt.action, "route.auto");
});

test("core executor routes automatically with provider fallback when no exact runtime route exists", async () => {
  const result = await executeAccountCenterCommand({ command: "route.auto", provider: "openai", runtime: "hermes" }, { adapter: new FixtureRuntimeAdapter() });
  assert.equal(result.code, 0);
  assert.equal(result.kind, "mutation");
  assert.equal(result.mutation?.dryRun, true);
  assert.equal(result.mutation?.receipt.action, "route.auto");
  assert.equal(result.mutation?.receipt.target, "openai:helper-2");
});
