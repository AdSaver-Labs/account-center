import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandRunner, GenericCommandRuntimeAdapter, MAX_GENERIC_COMMAND_STATUS_BYTES, OpenClawRuntimeAdapter, normalizeOpenClawStatus } from "./runtime-adapters.js";

const routerStatus = {
  at: "2026-07-09T10:55:50.721Z", provider: "openai", override: { enabled: true, profileId: "openai:helper-1" },
  accounts: {
    "openai:helper-1": { profileId: "openai:helper-1", enabled: true, health: { healthy: true, expired: false }, usage: { available: true, fiveHourRemaining: 84, weekRemaining: 17 } },
    "openai:helper-2": { profileId: "openai:helper-2", enabled: true, health: { healthy: true, expired: false }, usage: { available: true, fiveHourRemaining: 99, weekRemaining: 70 } }
  }, effectiveAuthOrder: ["openai:helper-1", "openai:helper-2"]
};

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "account-center-adapter-"));
  const cli = join(root, "oauth_routing_cli.py");
  await mkdir(join(root, "3-Resources", "codex-account-ops"), { recursive: true });
  await writeFile(cli, "#!/usr/bin/env python3\n");
  await writeFile(join(root, "3-Resources", "codex-account-ops", "CODEX-ACCOUNT-STATUS.json"), JSON.stringify(routerStatus));
  return { root, cli };
}

test("normalizes OpenClaw status without publishing connected identities", () => {
  const status = normalizeOpenClawStatus(routerStatus);
  assert.equal(status.schemaVersion, "account-center.status.v1");
  assert.equal(status.profiles.length, 2);
  assert.equal(status.profiles[0]?.usage.windows[1]?.remainingPct, 17);
});

test("runtime adapters return receipt payloads and never create a caller receipt path", async () => {
  const fixture = await workspace();
  const requested = join(fixture.root, "caller-selected.json");
  const adapter = new OpenClawRuntimeAdapter({ workspace: fixture.root, cli: fixture.cli });
  const result = await adapter.mutate({ action: "account.delete", target: "openai:helper-2", apply: true, provider: "openai", runtime: "openclaw" });
  assert.equal(result.code, 2);
  assert.equal((result.payload as { receipt: { action: string } }).receipt.action, "account.delete");
  await assert.rejects(lstat(requested));
});

test("OpenClaw credential delete remains native fail-closed", async () => {
  const fixture = await workspace();
  let calls = 0;
  const runner: CommandRunner = async () => { calls += 1; throw new Error("must not execute"); };
  const adapter = new OpenClawRuntimeAdapter({ workspace: fixture.root, cli: fixture.cli, runner });
  const result = await adapter.mutate({ action: "account.delete", target: "openai:helper-2", apply: true, provider: "openai", runtime: "openclaw" });
  assert.equal(result.code, 2);
  assert.equal(calls, 0);
  assert.equal((result.payload as { liveRuntimeMutation: boolean }).liveRuntimeMutation, false);
});

test("generic command bounds untrusted status output", async () => {
  const adapter = new GenericCommandRuntimeAdapter({ command: "status", runner: async () => ({ code: 0, stdout: "x".repeat(MAX_GENERIC_COMMAND_STATUS_BYTES + 1), stderr: "" }) });
  await assert.rejects(adapter.readStatus(), /safe ingestion limit/);
});

test("generic live apply returns a payload only", async () => {
  const adapter = new GenericCommandRuntimeAdapter({ command: "status", runner: async () => ({ code: 0, stdout: JSON.stringify(routerStatus), stderr: "" }) });
  const result = await adapter.mutate({ action: "route.auto", apply: true, provider: "openai", runtime: "generic-command" });
  assert.equal(result.code, 2);
  assert.equal((result.payload as { liveRuntimeMutation: boolean }).liveRuntimeMutation, false);
});
