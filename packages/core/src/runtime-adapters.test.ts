import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandRunner, OpenClawRuntimeAdapter, normalizeOpenClawStatus } from "./runtime-adapters.js";

const routerStatus = {
  at: "2026-07-09T10:55:50.721Z",
  provider: "openai",
  override: { enabled: true, profileId: "openai:helper-1" },
  accounts: {
    "openai:helper-1": {
      profileId: "openai:helper-1",
      enabled: true,
      health: { healthy: true, expired: false, observedAt: "2026-07-09T10:50:26.991Z" },
      usage: { available: true, fiveHourRemaining: 84, weekRemaining: 17, observedAt: "2026-07-09T10:50:35.272Z" }
    },
    "openai:helper-2": {
      profileId: "openai:helper-2",
      enabled: true,
      health: { healthy: true, expired: false },
      usage: { available: true, fiveHourRemaining: 99, weekRemaining: 70 }
    }
  },
  effectiveAuthOrder: ["openai:helper-1", "openai:helper-2"]
};

test("normalizes OpenClaw router status into Account Center no-secret status", () => {
  const status = normalizeOpenClawStatus(routerStatus);
  assert.equal(status.schemaVersion, "account-center.status.v1");
  assert.equal(status.noSecrets, true);
  assert.equal(status.source, "openclaw");
  assert.equal(status.profiles.length, 2);
  assert.equal(status.routes[0]?.activeProfileId, "openai:helper-1");
  assert.equal(status.profiles[0]?.usage.windows[0]?.remainingPct, 84);
  assert.equal(JSON.stringify(status).includes("refreshToken"), false);
});

test("OpenClaw adapter reads status through configured CLI with mocked runner", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "account-center-openclaw-"));
  const cli = join(workspace, "oauth_routing_cli.py");
  await writeFile(cli, "#!/usr/bin/env python3\n", "utf8");
  const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  const runner: CommandRunner = async (command, args, options) => {
    calls.push({ command, args, cwd: options?.cwd });
    return { code: 0, stdout: JSON.stringify(routerStatus), stderr: "" };
  };
  const adapter = new OpenClawRuntimeAdapter({ workspace, cli, runner });
  const status = await adapter.readStatus();
  assert.equal(status.source, "openclaw");
  assert.equal(calls[0]?.command, "python3");
  assert.deepEqual(calls[0]?.args, [cli, "status", "--workspace", workspace, "--json"]);
});

test("OpenClaw dry-run mutations do not call runner", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "account-center-openclaw-"));
  const cli = join(workspace, "oauth_routing_cli.py");
  await writeFile(cli, "#!/usr/bin/env python3\n", "utf8");
  let calls = 0;
  const runner: CommandRunner = async () => {
    calls += 1;
    return { code: 0, stdout: JSON.stringify(routerStatus), stderr: "" };
  };
  const adapter = new OpenClawRuntimeAdapter({ workspace, cli, runner });
  const result = await adapter.mutate({
    action: "route.use",
    target: "openai:helper-2",
    apply: false,
    provider: "openai",
    runtime: "openclaw",
    receiptPath: join(workspace, "receipt.json")
  });
  assert.equal(result.code, 0);
  assert.equal(calls, 1, "only read-only status command should run");
  assert.equal((result.payload as { liveRuntimeMutation: boolean }).liveRuntimeMutation, false);
});

test("OpenClaw route apply shells only to existing routing script and writes receipt", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "account-center-openclaw-"));
  const cli = join(workspace, "oauth_routing_cli.py");
  const switchScript = join(workspace, "3-Resources", "codex-account-ops", "scripts", "codex-auth-switch.mjs");
  await mkdir(join(workspace, "3-Resources", "codex-account-ops", "scripts"), { recursive: true });
  await writeFile(cli, "#!/usr/bin/env python3\n", "utf8");
  await writeFile(switchScript, "#!/usr/bin/env node\n", "utf8");
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: CommandRunner = async (command, args) => {
    calls.push({ command, args });
    if (args.includes("status")) return { code: 0, stdout: JSON.stringify(routerStatus), stderr: "" };
    return { code: 0, stdout: "{\"status\":\"APPLIED\"}", stderr: "" };
  };
  const receiptPath = join(workspace, "receipt.json");
  const adapter = new OpenClawRuntimeAdapter({ workspace, cli, runner });
  const result = await adapter.mutate({
    action: "route.use",
    target: "openai:helper-2",
    apply: true,
    provider: "openai",
    runtime: "openclaw",
    receiptPath
  });
  assert.equal(result.code, 0);
  assert.equal(calls[1]?.command, process.execPath);
  assert.deepEqual(calls[1]?.args, [switchScript, "openai:helper-2", "--apply", "--agent", "all", "--no-refresh"]);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(receipt.applied, true);
  assert.equal(receipt.liveRuntimeMutation, true);
});
