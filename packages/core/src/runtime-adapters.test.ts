import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandRunner, GenericCommandRuntimeAdapter, OpenClawRuntimeAdapter, normalizeOpenClawStatus } from "./runtime-adapters.js";

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
  await mkdir(join(workspace, "3-Resources", "codex-account-ops", "state"), { recursive: true });
  await writeFile(cli, "#!/usr/bin/env python3\n", "utf8");
  await writeFile(switchScript, "#!/usr/bin/env node\n", "utf8");
  await writeFile(join(workspace, "3-Resources", "codex-account-ops", "CODEX-ACCOUNT-STATUS.json"), JSON.stringify(routerStatus), "utf8");
  await writeFile(join(workspace, "3-Resources", "codex-account-ops", "state", "sentinel-state.json"), JSON.stringify({ route: "before" }), "utf8");
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: CommandRunner = async (command, args) => {
    calls.push({ command, args });
    if (args.includes("status")) return { code: 0, stdout: JSON.stringify(routerStatus), stderr: "" };
    return { code: 0, stdout: "{\"status\":\"APPLIED\"}", stderr: "" };
  };
  const receiptPath = join(workspace, "receipt.json");
  const adapter = new OpenClawRuntimeAdapter({ workspace, cli, agentDir: join(workspace, "agent"), runner });
  const result = await adapter.mutate({
    action: "route.use",
    target: "openai:helper-2",
    apply: true,
    provider: "openai",
    runtime: "openclaw",
    receiptPath
  });
  assert.equal(result.code, 0);
  const applyCall = calls.at(-1);
  assert.equal(applyCall?.command, process.execPath);
  assert.deepEqual(applyCall?.args, [switchScript, "openai:helper-2", "--apply", "--agent", "all", "--no-refresh"]);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(receipt.applied, true);
  assert.equal(receipt.liveRuntimeMutation, true);
  assert.ok(receipt.rollback.backupDir.includes("openclaw-routing"));
  assert.equal(receipt.rollback.files.length, 2);
  assert.ok(receipt.receipt.warnings.includes("lock_acquired"));
  assert.ok(receipt.receipt.warnings.includes("rollback_pointer_written"));
});

test("OpenClaw account delete apply backs up and invokes credential deletion script", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "account-center-openclaw-delete-"));
  const agentDir = join(workspace, "..", "agents", "main", "agent");
  const cli = join(workspace, "oauth_routing_cli.py");
  await mkdir(join(workspace, "3-Resources", "codex-account-ops", "state"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(cli, "#!/usr/bin/env python3\n", "utf8");
  await writeFile(join(workspace, "3-Resources", "codex-account-ops", "CODEX-ACCOUNT-STATUS.json"), JSON.stringify(routerStatus), "utf8");
  await writeFile(join(workspace, "3-Resources", "codex-account-ops", "state", "sentinel-state.json"), JSON.stringify({ route: "before" }), "utf8");
  await writeFile(join(agentDir, "openclaw-agent.sqlite"), "sqlite placeholder", "utf8");
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: CommandRunner = async (command, args) => {
    calls.push({ command, args });
    if (args.includes("status")) return { code: 0, stdout: JSON.stringify(routerStatus), stderr: "" };
    return { code: 0, stdout: JSON.stringify({ deleted: ["openai:helper-2"], removedFromOrder: ["openai:helper-2"] }), stderr: "" };
  };
  const receiptPath = join(workspace, "receipt.json");
  const adapter = new OpenClawRuntimeAdapter({ workspace, cli, runner });
  const result = await adapter.mutate({
    action: "account.delete",
    target: "helper-2@example.com",
    apply: true,
    provider: "openai",
    runtime: "openclaw",
    receiptPath
  });
  assert.equal(result.code, 0);
  const deleteCall = calls.at(-1);
  assert.equal(deleteCall?.command, "python3");
  assert.equal(deleteCall?.args[0], "-c");
  assert.ok(deleteCall?.args.includes("helper-2@example.com"));
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(receipt.applied, true);
  assert.equal(receipt.liveRuntimeMutation, true);
  assert.ok(receipt.receipt.warnings.includes("credential_delete_destructive"));
  assert.ok(receipt.rollback.files.some((file: string) => file.includes("openclaw-agent.sqlite")));
});

test("OpenClaw route apply refuses to run when runtime lock is already held", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "account-center-openclaw-lock-"));
  const cli = join(workspace, "oauth_routing_cli.py");
  const switchScript = join(workspace, "3-Resources", "codex-account-ops", "scripts", "codex-auth-switch.mjs");
  await mkdir(join(workspace, "3-Resources", "codex-account-ops", "scripts"), { recursive: true });
  await mkdir(join(workspace, ".account-center", "locks", "openclaw-route.lock"), { recursive: true });
  await writeFile(cli, "#!/usr/bin/env python3\n", "utf8");
  await writeFile(switchScript, "#!/usr/bin/env node\n", "utf8");
  const runner: CommandRunner = async (_command, args) => {
    if (args.includes("status")) return { code: 0, stdout: JSON.stringify(routerStatus), stderr: "" };
    throw new Error("apply command should not run while locked");
  };
  const adapter = new OpenClawRuntimeAdapter({ workspace, cli, runner });
  await assert.rejects(() => adapter.mutate({
    action: "route.use",
    target: "openai:helper-2",
    apply: true,
    provider: "openai",
    runtime: "openclaw",
    receiptPath: join(workspace, "receipt.json")
  }), /EEXIST|file already exists/);
});

test("Generic command adapter reads no-secret status from any agent command", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: CommandRunner = async (command, args) => {
    calls.push({ command, args });
    return { code: 0, stdout: JSON.stringify({ ...routerStatus, source: "generic-command" }), stderr: "" };
  };
  const adapter = new GenericCommandRuntimeAdapter({ command: "agent-status", args: ["--json"], runner });
  const status = await adapter.readStatus();
  assert.equal(status.source, "generic-command");
  assert.equal(status.noSecrets, true);
  assert.equal(status.profiles.length, 2);
  assert.deepEqual(calls[0], { command: "agent-status", args: ["--json"] });
});

test("Generic command adapter dry-run mutation never calls apply command", async () => {
  let calls = 0;
  const runner: CommandRunner = async () => {
    calls += 1;
    return { code: 0, stdout: JSON.stringify({ ...routerStatus, source: "generic-command" }), stderr: "" };
  };
  const adapter = new GenericCommandRuntimeAdapter({ command: "agent-status", runner });
  const result = await adapter.mutate({
    action: "route.auto",
    apply: false,
    provider: "openai",
    runtime: "generic-command",
    receiptPath: "/tmp/not-written.json"
  });
  assert.equal(result.code, 0);
  assert.equal(calls, 1, "only read status should run");
  assert.equal((result.payload as { liveRuntimeMutation: boolean }).liveRuntimeMutation, false);
});

test("Generic command adapter apply shells to explicit apply command and writes receipt", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "account-center-generic-"));
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: CommandRunner = async (command, args) => {
    calls.push({ command, args });
    if (command === "agent-status") return { code: 0, stdout: JSON.stringify({ ...routerStatus, source: "generic-command" }), stderr: "" };
    return { code: 0, stdout: JSON.stringify({ applied: true }), stderr: "" };
  };
  const receiptPath = join(workspace, "receipt.json");
  const adapter = new GenericCommandRuntimeAdapter({ command: "agent-status", applyCommand: "agent-route", runner });
  const result = await adapter.mutate({
    action: "route.auto",
    apply: true,
    provider: "openai",
    runtime: "generic-command",
    receiptPath
  });
  assert.equal(result.code, 0);
  assert.deepEqual(calls[1], { command: "agent-route", args: ["route.auto", "openai:helper-2", "--json"] });
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(receipt.applied, true);
  assert.equal(receipt.liveRuntimeMutation, true);
});
