import test from "node:test";
import assert from "node:assert/strict";
import { HermesRuntimeCapacityAdapter, MAX_HERMES_CAPACITY_STATUS_BYTES } from "./hermes-capacity-adapter.js";
import type { CommandRunner } from "./runtime-adapters.js";

const now = () => new Date("2026-07-25T20:00:00.000Z");

function runner(status: string, auth: string, overrides: { statusCode?: number; authCode?: number; timeout?: boolean; overflow?: boolean } = {}): CommandRunner {
  return async (_command, args, options) => {
    assert.equal(options?.timeoutMs, 15_000);
    assert.equal(options?.maxOutputBytes, MAX_HERMES_CAPACITY_STATUS_BYTES);
    if (args[0] === "status") return { code: overrides.statusCode ?? 0, stdout: status, stderr: "", timeoutExceeded: overrides.timeout, outputLimitExceeded: overrides.overflow };
    assert.deepEqual(args, ["auth", "status", "openai"]);
    return { code: overrides.authCode ?? 0, stdout: auth, stderr: "", timeoutExceeded: overrides.timeout, outputLimitExceeded: overrides.overflow };
  };
}

test("Hermes capacity adapter exports available only from fresh explicit runtime and provider proof", async () => {
  const adapter = new HermesRuntimeCapacityAdapter({ now, scope: "agent:main", runner: runner("Hermes Agent status: healthy", "Authentication: valid\nCapacity: available") });
  const result = await adapter.export();
  assert.deepEqual(result.agents, [{
    agentRef: "connection-1", runtime: "hermes", scope: "agent:main", state: "available", workers: "running",
    reason: "verified-capacity", evidence: { runtime: "verified", provider: "available" }
  }]);
  assert.equal(JSON.stringify(result).match(/token|secret|credential|local-capacity-proof/i), null);
});

test("Hermes capacity adapter recognizes Hermes logged-in auth but still blocks without explicit provider capacity proof", async () => {
  const adapter = new HermesRuntimeCapacityAdapter({ now, runner: runner("Hermes Agent status: healthy", "openai-codex: logged in") });
  const result = await adapter.export();
  assert.deepEqual(result.agents[0], {
    agentRef: "connection-1", runtime: "hermes", scope: "profile:default", state: "blocked", workers: "paused",
    reason: "provider-unproven", evidence: { runtime: "verified", provider: "unproven" }, notification: "automation-blocked"
  });
});

test("Hermes capacity adapter blocks explicit provider exhaustion and malformed runtime proof", async () => {
  const exhausted = new HermesRuntimeCapacityAdapter({ now, runner: runner("Hermes Agent status: healthy", "Authentication: valid\nQuota exhausted") });
  assert.equal((await exhausted.export()).agents[0]?.reason, "provider-unavailable");

  const noRuntime = new HermesRuntimeCapacityAdapter({ now, runner: runner("", "Authentication: valid\nCapacity: available") });
  const result = await noRuntime.export();
  assert.deepEqual(result.agents[0]?.evidence, { runtime: "unproven", provider: "available" });
  assert.equal(result.agents[0]?.reason, "runtime-unproven");
});

test("Hermes capacity adapter never treats failed, timed-out, or oversized status commands as proof", async () => {
  for (const overrides of [{ statusCode: 1 }, { timeout: true }, { overflow: true }]) {
    const adapter = new HermesRuntimeCapacityAdapter({ now, runner: runner("Hermes Agent status: healthy", "Authentication: valid\nCapacity: available", overrides) });
    const result = await adapter.export();
    assert.equal(result.agents[0]?.state, "blocked");
    assert.equal(result.agents[0]?.evidence.runtime, "unproven");
  }
});
