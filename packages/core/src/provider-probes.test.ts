import test from "node:test";
import assert from "node:assert/strict";
import { loadFixtureStatus, probeProviders } from "./index.js";

test("provider probes summarize no-token usage from status", async () => {
  const status = await loadFixtureStatus("tests/fixtures/status.fixture.json");
  const [probe] = await probeProviders(status, "openai");
  assert.equal(probe.provider, "openai");
  assert.equal(probe.source, "status");
  assert.equal(probe.ok, true);
  assert.equal(probe.profiles, 4);
  assert.equal(probe.usableProfiles, 2);
  assert.equal(probe.lowestRemainingPct, 1);
  assert.equal(probe.highestRemainingPct, 99);
});

test("provider probes normalize external command output", async () => {
  const status = await loadFixtureStatus("tests/fixtures/status.fixture.json");
  const old = process.env.ACCOUNT_CENTER_PROVIDER_PROBE_COMMAND;
  process.env.ACCOUNT_CENTER_PROVIDER_PROBE_COMMAND = "probe-cmd";
  try {
    const probes = await probeProviders(status, "pi", async (command, args) => {
      assert.equal(command, "probe-cmd");
      assert.deepEqual(args, ["pi", "--json"]);
      return JSON.stringify({ provider: "pi", ok: true, profiles: 2, usableProfiles: 1, lowestRemainingPct: 10, highestRemainingPct: 90, token: "SECRET" });
    });
    assert.deepEqual(probes, [{
      provider: "pi",
      source: "external-command",
      ok: true,
      generatedAt: probes[0].generatedAt,
      profiles: 2,
      usableProfiles: 1,
      lowestRemainingPct: 10,
      highestRemainingPct: 90,
      warnings: []
    }]);
  } finally {
    if (old === undefined) delete process.env.ACCOUNT_CENTER_PROVIDER_PROBE_COMMAND;
    else process.env.ACCOUNT_CENTER_PROVIDER_PROBE_COMMAND = old;
  }
});
