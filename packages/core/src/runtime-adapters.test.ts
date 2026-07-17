import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandRunner, execFileRunner, GenericCommandRuntimeAdapter, MAX_GENERIC_COMMAND_STATUS_BYTES, OpenClawRuntimeAdapter, normalizeOpenClawStatus } from "./runtime-adapters.js";

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

test("OpenClaw live route apply is blocked until scoped confirmation and authoritative verification exist", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "account-center-openclaw-"));
  const cli = join(workspace, "oauth_routing_cli.py");
  const switchScript = join(workspace, "3-Resources", "codex-account-ops", "scripts", "codex-auth-switch.mjs");
  await mkdir(join(workspace, "3-Resources", "codex-account-ops", "scripts"), { recursive: true });
  await writeFile(cli, "#!/usr/bin/env python3\n", "utf8");
  await writeFile(switchScript, "#!/usr/bin/env node\n", "utf8");
  await writeFile(join(workspace, "3-Resources", "codex-account-ops", "CODEX-ACCOUNT-STATUS.json"), JSON.stringify(routerStatus), "utf8");
  let applyCalled = false;
  const runner: CommandRunner = async (command, args) => {
    if (args.includes("status")) return { code: 0, stdout: JSON.stringify(routerStatus), stderr: "" };
    if (command === process.execPath) applyCalled = true;
    return { code: 0, stdout: "{}", stderr: "" };
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
  assert.equal(result.code, 2);
  assert.equal(applyCalled, false);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(receipt.applied, false);
  assert.equal(receipt.liveRuntimeMutation, false);
  assert.ok(receipt.receipt.warnings.includes("route_apply_requires_verified_mutation_contract"));
  assert.ok(receipt.receipt.warnings.includes("no_implicit_all_scope"));
});

test("OpenClaw account delete remains blocked until atomic transaction support exists", async () => {
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
    throw new Error("credential deletion helper must not run before atomic transaction support exists");
  };
  const receiptPath = join(workspace, "receipt.json");
  const adapter = new OpenClawRuntimeAdapter({ workspace, cli, runner });
  const result = await adapter.mutate({
    action: "account.delete",
    target: "openai:helper-2",
    apply: true,
    provider: "openai",
    runtime: "openclaw",
    receiptPath
  });
  assert.equal(result.code, 2);
  assert.equal(calls.length, 0, "fail-closed destructive delete must not invoke any external helper");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(receipt.applied, false);
  assert.equal(receipt.liveRuntimeMutation, false);
  assert.ok(receipt.receipt.warnings.includes("atomic_delete_transaction_not_implemented"));
});

test("OpenClaw account delete blocks profile labels rather than treating them as canonical identities", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "account-center-openclaw-delete-label-"));
  const cli = join(workspace, "oauth_routing_cli.py");
  await mkdir(join(workspace, "3-Resources", "codex-account-ops"), { recursive: true });
  await writeFile(cli, "#!/usr/bin/env python3\n", "utf8");
  await writeFile(join(workspace, "3-Resources", "codex-account-ops", "CODEX-ACCOUNT-STATUS.json"), JSON.stringify(routerStatus), "utf8");
  let deleteHelperCalled = false;
  const runner: CommandRunner = async (command, args) => {
    if (args.includes("status")) return { code: 0, stdout: JSON.stringify(routerStatus), stderr: "" };
    if (command === "python3" && args[0] === "-c") deleteHelperCalled = true;
    return { code: 0, stdout: "{}", stderr: "" };
  };
  const adapter = new OpenClawRuntimeAdapter({ workspace, cli, runner });
  const result = await adapter.mutate({ action: "account.delete", target: "helper-2", apply: true, provider: "openai", runtime: "openclaw", receiptPath: join(workspace, "receipt.json") });
  assert.equal(result.code, 2);
  assert.equal(deleteHelperCalled, false);
});

test("OpenClaw account delete blocks an ambiguous exact connected email", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "account-center-openclaw-delete-ambiguous-"));
  const cli = join(workspace, "oauth_routing_cli.py");
  const ambiguousStatus = {
    ...routerStatus,
    accounts: {
      "openai:helper-1": { ...routerStatus.accounts["openai:helper-1"], email: "duplicate@example.test" },
      "openai:helper-2": { ...routerStatus.accounts["openai:helper-2"], email: "duplicate@example.test" }
    }
  };
  await mkdir(join(workspace, "3-Resources", "codex-account-ops"), { recursive: true });
  await writeFile(cli, "#!/usr/bin/env python3\n", "utf8");
  await writeFile(join(workspace, "3-Resources", "codex-account-ops", "CODEX-ACCOUNT-STATUS.json"), JSON.stringify(ambiguousStatus), "utf8");
  let deleteHelperCalled = false;
  const runner: CommandRunner = async (command, args) => {
    if (args.includes("status")) return { code: 0, stdout: JSON.stringify(ambiguousStatus), stderr: "" };
    if (command === "python3" && args[0] === "-c") deleteHelperCalled = true;
    return { code: 0, stdout: "{}", stderr: "" };
  };
  const adapter = new OpenClawRuntimeAdapter({ workspace, cli, runner });
  const result = await adapter.mutate({ action: "account.delete", target: "duplicate@example.test", apply: true, provider: "openai", runtime: "openclaw", receiptPath: join(workspace, "receipt.json") });
  assert.equal(result.code, 2);
  assert.equal(deleteHelperCalled, false);
});

test("OpenClaw account delete blocks targets that do not exactly match a connected account", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "account-center-openclaw-delete-miss-"));
  const cli = join(workspace, "oauth_routing_cli.py");
  await mkdir(join(workspace, "3-Resources", "codex-account-ops"), { recursive: true });
  await writeFile(cli, "#!/usr/bin/env python3\n", "utf8");
  await writeFile(join(workspace, "3-Resources", "codex-account-ops", "CODEX-ACCOUNT-STATUS.json"), JSON.stringify(routerStatus), "utf8");
  let deleteHelperCalled = false;
  const runner: CommandRunner = async (command, args) => {
    if (args.includes("status")) return { code: 0, stdout: JSON.stringify(routerStatus), stderr: "" };
    if (command === "python3" && args[0] === "-c") deleteHelperCalled = true;
    return { code: 0, stdout: JSON.stringify({ warning: "target_not_found" }), stderr: "" };
  };
  const receiptPath = join(workspace, "receipt.json");
  const adapter = new OpenClawRuntimeAdapter({ workspace, cli, runner });
  const result = await adapter.mutate({
    action: "account.delete",
    target: "nobody@example.invalid",
    apply: true,
    provider: "openai",
    runtime: "openclaw",
    receiptPath
  });
  assert.equal(result.code, 2);
  assert.equal(deleteHelperCalled, false);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(receipt.applied, false);
  assert.equal(receipt.liveRuntimeMutation, false);
  assert.ok(receipt.receipt.warnings.includes("exact_match_required"));
});

test("OpenClaw route apply remains structured-blocked even when a runtime lock exists", async () => {
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
  const result = await adapter.mutate({
    action: "route.use",
    target: "openai:helper-2",
    apply: true,
    provider: "openai",
    runtime: "openclaw",
    receiptPath: join(workspace, "receipt.json")
  });
  assert.equal(result.code, 2);
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

test("Generic command adapter rejects oversized stdout before status parsing or redaction", async () => {
  let requestedCap: number | undefined;
  const adapter = new GenericCommandRuntimeAdapter({
    command: "agent-status",
    runner: async (_command, _args, options) => {
      requestedCap = options?.maxOutputBytes;
      return { code: 0, stdout: `${" ".repeat(MAX_GENERIC_COMMAND_STATUS_BYTES)}x`, stderr: "person@example.test sk-hostile-token-value-123456789" };
    }
  });
  await assert.rejects(adapter.readStatus(), /^Error: Generic command status output exceeds safe ingestion limit$/);
  assert.equal(requestedCap, MAX_GENERIC_COMMAND_STATUS_BYTES);
});

test("Generic command adapter keeps command failures and malformed JSON fixed and redacted", async () => {
  const hostile = "person@example.test sk-hostile-token-value-123456789 /srv/private/adapter";
  for (const result of [
    { code: 23, stdout: "", stderr: hostile },
    { code: 0, stdout: `{${hostile}`, stderr: "" }
  ]) {
    const adapter = new GenericCommandRuntimeAdapter({ command: "agent-status", runner: async () => result });
    await assert.rejects(adapter.readStatus(), /^Error: Generic command status is unavailable or unproven$/);
  }
});

test("Generic command adapter rejects a timeout even when the child reports zero with valid JSON", async () => {
  const adapter = new GenericCommandRuntimeAdapter({
    command: "agent-status",
    runner: async () => ({ code: 0, stdout: JSON.stringify({ ...routerStatus, source: "generic-command" }), stderr: "", timeoutExceeded: true })
  });
  await assert.rejects(adapter.readStatus(), /^Error: Generic command status is unavailable or unproven$/);
});

test("spawn runner accepts exactly the output cap and rejects both stream overflows", async () => {
  for (const stream of ["stdout", "stderr"] as const) {
    const exact = await execFileRunner(process.execPath, ["-e", `process.${stream}.write('x'.repeat(64))`], { maxOutputBytes: 64 });
    assert.equal(exact.code, 0, stream);
    assert.equal(exact.outputLimitExceeded, false, stream);
    assert.equal(Buffer.byteLength(exact[stream]), 64, stream);
  }

  for (const stream of ["stdout", "stderr"]) {
    const result = await execFileRunner(process.execPath, ["-e", `process.${stream}.write('x'.repeat(65)); setInterval(() => {}, 1000)`], { maxOutputBytes: 64 });
    assert.equal(result.outputLimitExceeded, true, stream);
    assert.equal(result.stdout, "", stream);
    assert.equal(result.stderr, "", stream);
  }
});

test("spawn runner escalates after timeout even when SIGTERM is ignored", async () => {
  const startedAt = Date.now();
  const result = await execFileRunner(process.execPath, ["-e", "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000)"], { timeoutMs: 100, maxOutputBytes: 64 });
  assert.notEqual(result.code, 0);
  assert.ok(Date.now() - startedAt < 2_000, "timeout must escalate instead of waiting for an untrusted process");
});

test("spawn runner records timeout before a SIGTERM handler exits successfully", async () => {
  const result = await execFileRunner(process.execPath, ["-e", "process.on('SIGTERM', () => process.exit(0)); process.stdout.write('ready'); setInterval(() => {}, 1000)"], { timeoutMs: 100, maxOutputBytes: 64 });
  assert.equal(result.code, 0);
  assert.equal(result.timeoutExceeded, true);
});

test("generic-command stderr flood is bounded at the actual spawn boundary", async () => {
  const startedAt = Date.now();
  const adapter = new GenericCommandRuntimeAdapter({
    command: process.execPath,
    args: ["-e", `process.stderr.write('x'.repeat(${MAX_GENERIC_COMMAND_STATUS_BYTES + 1})); setInterval(() => {}, 1000)`]
  });
  await assert.rejects(adapter.readStatus(), /^Error: Generic command status output exceeds safe ingestion limit$/);
  assert.ok(Date.now() - startedAt < 3_000, "stderr flood must terminate promptly");
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

test("Generic command adapter blocks live apply instead of shelling to an arbitrary runtime command", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "account-center-generic-"));
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: CommandRunner = async (command, args) => {
    calls.push({ command, args });
    if (command === "agent-status") return { code: 0, stdout: JSON.stringify({ ...routerStatus, source: "generic-command" }), stderr: "" };
    throw new Error("generic runtime apply command must never be executed");
  };
  const receiptPath = join(workspace, "receipt.json");
  const adapter = new GenericCommandRuntimeAdapter({ command: "agent-status", runner });
  const result = await adapter.mutate({
    action: "route.auto",
    apply: true,
    provider: "openai",
    runtime: "generic-command",
    receiptPath
  });
  assert.equal(result.code, 2);
  assert.deepEqual(calls, [{ command: "agent-status", args: ["--json"] }]);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(receipt.applied, false);
  assert.equal(receipt.liveRuntimeMutation, false);
  assert.equal(receipt.reason, "generic_apply_requires_protected_native_adapter");
});
