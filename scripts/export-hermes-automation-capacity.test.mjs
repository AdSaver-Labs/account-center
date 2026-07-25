import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const script = new URL("./export-hermes-automation-capacity.mjs", import.meta.url);

async function fakeHermes(body) {
  const root = await mkdtemp(join(tmpdir(), "account-center-hermes-capacity-"));
  const path = join(root, "hermes");
  await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

async function canonicalWorkspace({ mapped = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "account-center-hermes-shared-status-"));
  const dir = join(root, "3-Resources", "codex-account-ops");
  await mkdir(dir, { recursive: true });
  const observedAt = new Date().toISOString();
  await writeFile(join(dir, "CODEX-ACCOUNT-STATUS.json"), JSON.stringify({
    at: observedAt, provider: "openai",
    accounts: { "openai:shared-1": { profileId: "openai:shared-1", enabled: true, health: { healthy: true, observedAt }, usage: { available: true, fiveHourRemaining: 84, weekRemaining: 68, observedAt } } },
    effectiveAuthOrder: ["openai:shared-1"],
    agentConnections: mapped ? [{ id: "hermes-main", runtime: "hermes", scope: "agent:main", profileIds: ["openai:shared-1"], verifiedProfileIds: ["openai:shared-1"], state: "connected" }] : []
  }), "utf8");
  return root;
}

test("Hermes capacity export CLI joins runtime status to the mapped canonical shared account", async () => {
  const hermes = await fakeHermes('echo "Hermes status healthy"');
  const workspace = await canonicalWorkspace();
  const result = spawnSync(process.execPath, [script.pathname, "--hermes-bin", hermes, "--scope", "agent:main"], { encoding: "utf8", env: { ...process.env, ACCOUNT_CENTER_OPENCLAW_WORKSPACE: workspace } });
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.agents[0].state, "available");
  assert.equal(JSON.stringify(output).match(/token|secret|credential|shared-1/i), null);
});

test("Hermes capacity export CLI fail-closes for an unmatched shared-account map or unreadable persisted state", async () => {
  const hermes = await fakeHermes('echo "Hermes status healthy"');
  const workspace = await canonicalWorkspace({ mapped: false });
  const unmatched = spawnSync(process.execPath, [script.pathname, "--hermes-bin", hermes, "--scope", "agent:main"], { encoding: "utf8", env: { ...process.env, ACCOUNT_CENTER_OPENCLAW_WORKSPACE: workspace } });
  assert.equal(unmatched.status, 2);
  assert.equal(JSON.parse(unmatched.stdout).agents[0].state, "blocked");

  const malformedState = spawnSync(process.execPath, [script.pathname, "--previous-state", "/definitely/not/a/state.json"], { encoding: "utf8" });
  assert.equal(malformedState.status, 2);
  const output = JSON.parse(malformedState.stdout);
  assert.equal(output.agents[0].state, "blocked");
  assert.equal(output.agents[0].notification, undefined);
});
