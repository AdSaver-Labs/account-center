import test from "node:test";
import assert from "node:assert/strict";
import { HermesGatewayLivenessReader, MAX_HERMES_GATEWAY_STATUS_BYTES } from "./hermes-gateway-liveness.js";
import type { CommandRunner } from "./runtime-adapters.js";

const runner = (result: { code?: number; stdout?: string; stderr?: string; timeoutExceeded?: boolean; outputLimitExceeded?: boolean } = {}): CommandRunner => async (command, args, options) => {
  assert.equal(command, "systemctl");
  assert.deepEqual(args, ["--user", "is-active", "--quiet", "hermes-gateway.service"]);
  assert.deepEqual(options, { timeoutMs: 15_000, maxOutputBytes: MAX_HERMES_GATEWAY_STATUS_BYTES });
  return { code: result.code ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "", timeoutExceeded: result.timeoutExceeded, outputLimitExceeded: result.outputLimitExceeded };
};

test("Hermes gateway liveness runs only the fixed bounded systemctl command and returns a redacted running DTO", async () => {
  const observedAt = new Date("2026-09-07T12:00:00.000Z");
  const result = await new HermesGatewayLivenessReader({ runner: runner(), now: () => observedAt }).read();
  assert.deepEqual(result, {
    schemaVersion: "account-center.hermes-gateway-liveness.v1",
    runtime: "hermes",
    scope: "default",
    state: "running",
    observedAt: observedAt.toISOString(),
    verificationState: "UNPROVEN",
    evidence: "Gateway service liveness observed 2026-09-07T12:00:00.000Z; provider/account capacity, inventory, route, and recovery are UNPROVEN."
  });
  assert.equal(JSON.stringify(result).match(/stdout|stderr|secret|token|credential/i), null);
});

test("Hermes gateway liveness recognizes documented empty-output systemctl outcomes and fails closed", async () => {
  for (const result of [
    { code: 3 },
    { code: 1 },
    { timeoutExceeded: true },
    { outputLimitExceeded: true },
    { stderr: "anything" },
    { stdout: "anything" },
    { stdout: "x".repeat(MAX_HERMES_GATEWAY_STATUS_BYTES + 1) }
  ]) {
    const view = await new HermesGatewayLivenessReader({ runner: runner(result) }).read();
    assert.equal(view.state, result.code === 3 && result.stdout === undefined && result.stderr === undefined ? "stopped" : "unproven");
    assert.equal(view.verificationState, "UNPROVEN");
    assert.equal(JSON.stringify(view).match(/anything|maybe|xxxxx/i), null);
  }
  const thrown = await new HermesGatewayLivenessReader({ runner: async () => { throw new Error("private failure"); } }).read();
  assert.equal(thrown.state, "unproven");
});
