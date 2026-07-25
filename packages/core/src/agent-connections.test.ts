import test from "node:test";
import assert from "node:assert/strict";
import { loadFixtureStatus } from "./fixtures.js";
import { publicAgentConnectionInventoryView, verifyAgentConnection } from "./agent-connections.js";

test("one redacted account is visible through Hermes and OpenClaw without credential output", async () => {
  const inventory = publicAgentConnectionInventoryView(await loadFixtureStatus());
  assert.deepEqual(inventory.inventory.map((connection) => ({ runtime: connection.runtime, account: connection.accounts[0]?.accountRef, weekly: connection.accounts[0]?.weeklyRemainingPct })), [
    { runtime: "openclaw", account: "account-1", weekly: 68 },
    { runtime: "hermes", account: "account-1", weekly: 68 }
  ]);
  assert.equal(JSON.stringify(inventory).match(/helper-|token|secret|five-hour/i), null);
});

test("unresolved Hermes credentials are needs-auth and never borrow OpenClaw proof", async () => {
  const inventory = publicAgentConnectionInventoryView(await loadFixtureStatus());
  const hermes = inventory.inventory.find((connection) => connection.runtime === "hermes");
  assert.equal(hermes?.state, "needs-auth");
  assert.deepEqual(hermes?.accounts[0], { accountRef: "account-1", state: "needs-auth", weeklyRemainingPct: 68, routeState: "not-routed" });
  assert.equal(hermes?.onboarding.action, "reauth-local-adapter");
});

test("successful Hermes verification creates only a scoped redacted lease", async () => {
  const status = await loadFixtureStatus();
  const connection = status.agentConnections?.find((candidate) => candidate.runtime === "hermes");
  assert.ok(connection);
  status.agentConnections = status.agentConnections?.map((candidate) => candidate.id === connection.id ? verifyAgentConnection(candidate, "openai:helper-1") : candidate);
  const hermes = publicAgentConnectionInventoryView(status).inventory.find((candidate) => candidate.runtime === "hermes");
  assert.equal(hermes?.accounts[0]?.state, "usable");
  assert.deepEqual(hermes?.accounts[0]?.lease, {
    schemaVersion: "account-center.scoped-account-lease.v1", leaseRef: "lease-hermes-agent-main-account-1", accountRef: "account-1", runtime: "hermes", scope: "agent:main", state: "verified"
  });
  assert.equal(JSON.stringify(hermes).match(/openai:helper|token|secret/i), null);
});
