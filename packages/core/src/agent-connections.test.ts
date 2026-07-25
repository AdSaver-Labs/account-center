import test from "node:test";
import assert from "node:assert/strict";
import { loadFixtureStatus } from "./fixtures.js";
import { publicAgentConnectionInventoryView, verifyAgentConnection } from "./agent-connections.js";

test("one redacted account is visible through Hermes and OpenClaw without credential output", async () => {
  const inventory = publicAgentConnectionInventoryView(await loadFixtureStatus());
  assert.deepEqual(inventory.inventory.map((connection) => ({ runtime: connection.runtime, accounts: connection.accounts.length, first: connection.accounts[0]?.accountRef, weekly: connection.accounts[0]?.weeklyRemainingPct })), [
    { runtime: "openclaw", accounts: 4, first: "account-1", weekly: 68 },
    { runtime: "hermes", accounts: 4, first: "account-1", weekly: 68 }
  ]);
  assert.equal(JSON.stringify(inventory).match(/helper-|token|secret|five-hour/i), null);
});

test("unresolved Hermes credentials are needs-auth and never borrow OpenClaw proof", async () => {
  const inventory = publicAgentConnectionInventoryView(await loadFixtureStatus());
  const hermes = inventory.inventory.find((connection) => connection.runtime === "hermes");
  assert.equal(hermes?.state, "needs-auth");
  assert.deepEqual(hermes?.accounts[0], { accountRef: "account-1", state: "needs-auth", pairing: "paired-unverified", weeklyRemainingPct: 68, routeState: "not-routed" });
  assert.deepEqual(hermes?.accounts.slice(1).map((account) => account.pairing), ["unpaired", "unpaired", "unpaired"]);
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

test("connected Hermes sees five canonical redacted accounts but only its exact paired account can lease", async () => {
  const status = await loadFixtureStatus();
  const template = structuredClone(status.profiles[1]!);
  template.id = "openai:helper-5";
  template.label = "helper-5";
  template.usage.profileId = template.id;
  template.usage.windows = [{ name: "five-hour", remainingPct: 100 }, { name: "weekly", remainingPct: 55 }];
  status.profiles.push(template);
  const hermes = status.agentConnections!.find((connection) => connection.runtime === "hermes")!;
  hermes.state = "connected";
  hermes.verifiedProfileIds = ["openai:helper-1"];
  const view = publicAgentConnectionInventoryView(status).inventory.find((connection) => connection.runtime === "hermes")!;
  assert.equal(view.accounts.length, 5);
  assert.deepEqual(view.accounts.map((account) => ({ accountRef: account.accountRef, pairing: account.pairing, weekly: account.weeklyRemainingPct, lease: Boolean(account.lease) })), [
    { accountRef: "account-1", pairing: "paired-verified", weekly: 68, lease: true },
    { accountRef: "account-2", pairing: "unpaired", weekly: 77, lease: false },
    { accountRef: "account-3", pairing: "unpaired", weekly: 90, lease: false },
    { accountRef: "account-4", pairing: "unpaired", weekly: null, lease: false },
    { accountRef: "account-5", pairing: "unpaired", weekly: 55, lease: false }
  ]);
  assert.equal(JSON.stringify(view).match(/helper-|five-hour|token|secret/i), null);
});
