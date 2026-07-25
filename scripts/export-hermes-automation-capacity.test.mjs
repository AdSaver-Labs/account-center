import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod } from "node:fs/promises";
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

test("Hermes capacity export CLI emits only the redacted gate contract", async () => {
  const hermes = await fakeHermes('if [ "$1" = status ]; then echo "Hermes status healthy"; else echo "Authentication: valid"; echo "Capacity: available"; fi');
  const result = spawnSync(process.execPath, [script.pathname, "--hermes-bin", hermes, "--scope", "agent:main"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.agents[0].state, "available");
  assert.equal(JSON.stringify(output).match(/token|secret|credential|local-capacity-proof/i), null);
});

test("Hermes capacity export CLI fail-closes when the persisted state cannot be read", async () => {
  const result = spawnSync(process.execPath, [script.pathname, "--previous-state", "/definitely/not/a/state.json"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  const output = JSON.parse(result.stdout);
  assert.equal(output.agents[0].state, "blocked");
  assert.equal(output.agents[0].notification, undefined);
});
