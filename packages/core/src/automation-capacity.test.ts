import test from "node:test";
import assert from "node:assert/strict";
import { automationCapacityExport, transitionAutomationCapacity } from "./automation-capacity.js";
import { loadFixtureStatus } from "./fixtures.js";

test("capacity gate alerts once, stays silent while blocked, then alerts once on recovery", () => {
  const blocked = transitionAutomationCapacity("available", false);
  const unchanged = transitionAutomationCapacity(blocked.state, false);
  const recovered = transitionAutomationCapacity(unchanged.state, true);
  assert.deepEqual(blocked, { state: "unavailable", workers: "paused", notification: "capacity-unavailable" });
  assert.deepEqual(unchanged, { state: "unavailable", workers: "paused" });
  assert.deepEqual(recovered, { state: "available", workers: "running", notification: "capacity-recovered" });
});

test("fixture capacity blocks once, remains silent, and resumes only on fresh verified runtime/provider evidence", async () => {
  const status = await loadFixtureStatus();
  const blocked = automationCapacityExport(status);
  const unchanged = automationCapacityExport(status, blocked.state);

  const recoveredStatus = structuredClone(status);
  const hermes = recoveredStatus.agentConnections?.find((connection) => connection.runtime === "hermes");
  assert.ok(hermes);
  hermes.state = "connected";
  hermes.verifiedProfileIds = ["openai:helper-1"];
  hermes.capacityEvidence = {
    runtime: { state: "verified", observedAt: "2026-07-09T00:01:00.000Z" },
    provider: { state: "available", observedAt: "2026-07-09T00:01:00.000Z" }
  };
  recoveredStatus.generatedAt = "2026-07-09T00:01:00.000Z";

  const recovered = automationCapacityExport(recoveredStatus, unchanged.state);
  const hermesBlocked = blocked.agents.find((agent) => agent.runtime === "hermes");
  const hermesUnchanged = unchanged.agents.find((agent) => agent.runtime === "hermes");
  const hermesRecovered = recovered.agents.find((agent) => agent.runtime === "hermes");

  assert.deepEqual(hermesBlocked, {
    agentRef: "connection-2", runtime: "hermes", scope: "agent:main", state: "blocked", workers: "paused",
    reason: "needs-auth", evidence: { runtime: "unproven", provider: "unproven" }, notification: "automation-blocked"
  });
  assert.deepEqual(hermesUnchanged, {
    agentRef: "connection-2", runtime: "hermes", scope: "agent:main", state: "blocked", workers: "paused",
    reason: "needs-auth", evidence: { runtime: "unproven", provider: "unproven" }
  });
  assert.deepEqual(hermesRecovered, {
    agentRef: "connection-2", runtime: "hermes", scope: "agent:main", state: "available", workers: "running",
    reason: "verified-capacity", evidence: { runtime: "verified", provider: "available" }, notification: "automation-resumed"
  });
});

test("unresolved Hermes needs-auth remains blocked even if an active credential marker exists", async () => {
  const status = await loadFixtureStatus();
  const hermes = status.agentConnections?.find((connection) => connection.runtime === "hermes");
  assert.ok(hermes);
  hermes.state = "connected";
  hermes.verifiedProfileIds = ["openai:helper-1"];
  // A credential/auth marker is insufficient; no runtime/provider evidence
  // may manufacture a resume signal.
  const result = automationCapacityExport(status, {
    schemaVersion: "account-center.automation-capacity-state.v1",
    agents: [{ agentRef: "connection-2", runtime: "hermes", scope: "agent:main", state: "blocked" }]
  });
  const capacity = result.agents.find((agent) => agent.runtime === "hermes");
  assert.deepEqual(capacity, {
    agentRef: "connection-2", runtime: "hermes", scope: "agent:main", state: "blocked", workers: "paused",
    reason: "runtime-unproven", evidence: { runtime: "unproven", provider: "unproven" }
  });
});

test("automation fails closed when a connected agent has no explicit verified pairing", async () => {
  const status = await loadFixtureStatus();
  const hermes = status.agentConnections?.find((connection) => connection.runtime === "hermes");
  assert.ok(hermes);
  hermes.state = "connected";
  hermes.profileIds = [];
  hermes.verifiedProfileIds = [];
  hermes.capacityEvidence = {
    runtime: { state: "verified", observedAt: status.generatedAt },
    provider: { state: "available", observedAt: status.generatedAt }
  };
  const capacity = automationCapacityExport(status).agents.find((agent) => agent.runtime === "hermes");
  assert.deepEqual(capacity, {
    agentRef: "connection-2", runtime: "hermes", scope: "agent:main", state: "blocked", workers: "paused",
    reason: "needs-auth", evidence: { runtime: "verified", provider: "available" }, notification: "automation-blocked"
  });
});
