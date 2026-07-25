import test from "node:test";
import assert from "node:assert/strict";
import { HermesRuntimeCapacityAdapter, MAX_HERMES_CAPACITY_STATUS_BYTES } from "./hermes-capacity-adapter.js";
import { loadFixtureStatus } from "./fixtures.js";
import type { AccountCenterStatus } from "./schemas.js";
import type { CommandRunner } from "./runtime-adapters.js";

const now = () => new Date("2026-07-25T20:00:00.000Z");

const runtimeRunner = (overrides: { code?: number; timeout?: boolean; overflow?: boolean } = {}): CommandRunner => async (_command, args, options) => {
  assert.deepEqual(args, ["status", "--all"], "Hermes must not be queried for quota/auth capacity");
  assert.equal(options?.timeoutMs, 15_000);
  assert.equal(options?.maxOutputBytes, MAX_HERMES_CAPACITY_STATUS_BYTES);
  return { code: overrides.code ?? 0, stdout: "Hermes status: connected", stderr: "", timeoutExceeded: overrides.timeout, outputLimitExceeded: overrides.overflow };
};

async function canonicalStatus(): Promise<AccountCenterStatus> {
  const status = await loadFixtureStatus();
  status.source = "openclaw";
  status.generatedAt = now().toISOString();
  status.policy.staleAfterSeconds = 60;
  const profile = status.profiles.find((candidate) => candidate.id === "openai:helper-1")!;
  profile.usage.generatedAt = now().toISOString();
  const hermes = status.agentConnections!.find((candidate) => candidate.runtime === "hermes")!;
  hermes.state = "connected";
  hermes.verifiedProfileIds = ["openai:helper-1"];
  return status;
}

test("Hermes exporter joins fresh runtime proof to canonical mapped OpenClaw/Sentinel capacity", async () => {
  const status = await canonicalStatus();
  status.profiles.find((candidate) => candidate.id === "openai:helper-1")!.usage.windows.find((window) => window.name === "weekly")!.remainingPct = 3;
  const adapter = new HermesRuntimeCapacityAdapter({ now, scope: "agent:main", runner: runtimeRunner(), statusReader: async () => status });
  const result = await adapter.export();
  assert.deepEqual(result.agents, [{
    agentRef: "connection-1", runtime: "hermes", scope: "agent:main", state: "blocked", workers: "paused",
    reason: "provider-unavailable", evidence: { runtime: "verified", provider: "blocked" }, notification: "automation-blocked"
  }], "only the canonical weekly window gates Hermes automation");

  status.profiles.find((candidate) => candidate.id === "openai:helper-1")!.usage.windows.find((window) => window.name === "weekly")!.remainingPct = 84;
  const available = await adapter.export(result.state);
  assert.deepEqual(available.agents[0], {
    agentRef: "connection-1", runtime: "hermes", scope: "agent:main", state: "available", workers: "running",
    reason: "verified-capacity", evidence: { runtime: "verified", provider: "available" }, notification: "automation-resumed"
  });
  assert.equal(JSON.stringify(available).match(/token|secret|credential|helper-1|local-capacity-proof/i), null);
});

test("Hermes login text never invents provider capacity", async () => {
  const status = await canonicalStatus();
  status.profiles.find((candidate) => candidate.id === "openai:helper-1")!.usage.windows = [];
  const adapter = new HermesRuntimeCapacityAdapter({ now, scope: "agent:main", runner: runtimeRunner(), statusReader: async () => status });
  const result = await adapter.export();
  assert.deepEqual(result.agents[0]?.evidence, { runtime: "verified", provider: "unproven" });
  assert.equal(result.agents[0]?.reason, "provider-unproven");
});

test("unmatched or needs-auth Hermes mappings remain blocked and cannot borrow another account", async () => {
  const status = await canonicalStatus();
  const hermes = status.agentConnections!.find((candidate) => candidate.runtime === "hermes")!;
  hermes.verifiedProfileIds = [];
  hermes.state = "needs-auth";
  const adapter = new HermesRuntimeCapacityAdapter({ now, scope: "agent:main", runner: runtimeRunner(), statusReader: async () => status });
  const result = await adapter.export();
  assert.equal(result.agents[0]?.state, "blocked");
  assert.equal(result.agents[0]?.reason, "needs-auth");
  assert.deepEqual(result.agents[0]?.evidence, { runtime: "verified", provider: "unproven" });
});

test("stale, malformed, failed, or oversized proof is fail-closed", async () => {
  const stale = await canonicalStatus();
  stale.profiles.find((candidate) => candidate.id === "openai:helper-1")!.usage.generatedAt = "2026-07-25T19:58:00.000Z";
  const staleResult = await new HermesRuntimeCapacityAdapter({ now, scope: "agent:main", runner: runtimeRunner(), statusReader: async () => stale }).export();
  assert.equal(staleResult.agents[0]?.reason, "provider-unproven");

  const malformed = await canonicalStatus();
  malformed.profiles.find((candidate) => candidate.id === "openai:helper-1")!.usage.windows = [{ name: "weekly", remainingPct: 101 }];
  const malformedResult = await new HermesRuntimeCapacityAdapter({ now, scope: "agent:main", runner: runtimeRunner(), statusReader: async () => malformed }).export();
  assert.equal(malformedResult.agents[0]?.reason, "provider-unproven");

  const failedResult = await new HermesRuntimeCapacityAdapter({ now, scope: "agent:main", runner: runtimeRunner({ code: 1 }), statusReader: canonicalStatus }).export();
  assert.equal(failedResult.agents[0]?.reason, "runtime-unproven");
  const oversizedResult = await new HermesRuntimeCapacityAdapter({ now, scope: "agent:main", runner: runtimeRunner({ overflow: true }), statusReader: canonicalStatus }).export();
  assert.equal(oversizedResult.agents[0]?.reason, "runtime-unproven");
});
