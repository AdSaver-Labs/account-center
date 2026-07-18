import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandRunner, execFileRunner, GenericCommandRuntimeAdapter, MAX_GENERIC_COMMAND_STATUS_BYTES, OpenClawRuntimeAdapter, normalizeOpenClawStatus } from "./runtime-adapters.js";
import { executeAccountCenterCommand } from "./command-executor.js";
import { createMutationReview } from "./mutation-contract.js";
import { MutationRepository } from "./mutation-repository.js";

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

async function capabilityRoute(adapter: OpenClawRuntimeAdapter, action: "route.auto" | "route.use" | "route.remove", target: string, agent: string, receiptPath: string) {
  const scope = { kind: "agent" as const, id: agent };
  const secret = "test-shared-mutation-secret";
  const review = createMutationReview({ action, target, provider: "openai", runtime: "openclaw", scope }, { secret });
  return executeAccountCenterCommand({ command: action, target, apply: true, provider: "openai", runtime: "openclaw", scope, review, reviewToken: review.token, idempotencyKey: "routeapplycapabilitykey0001", receiptPath }, { adapter, mutation: { secret, repository: new MutationRepository(await mkdtemp(join(tmpdir(), "account-center-capability-"))) } });
}

function routedStatus(activeProfileId: string, order: string[], agent = "main") {
  return { ...routerStatus, scope: `agent:${agent}`, override: { enabled: true, profileId: activeProfileId }, effectiveAuthOrder: order };
}

async function openClawWorkspace() {
  const root = await mkdtemp(join(tmpdir(), "account-center-openclaw-route-"));
  const cli = join(root, "oauth_routing_cli.py");
  const scripts = join(root, "3-Resources", "codex-account-ops", "scripts");
  const switchScript = join(scripts, "codex-auth-switch.mjs");
  const sentinel = join(scripts, "codex-account-sentinel.mjs");
  await mkdir(scripts, { recursive: true });
  await writeFile(cli, "#!/usr/bin/env python3\n", "utf8");
  await writeFile(switchScript, "#!/usr/bin/env node\n", "utf8");
  await writeFile(sentinel, "#!/usr/bin/env node\n", "utf8");
  await writeFile(join(root, "3-Resources", "codex-account-ops", "CODEX-ACCOUNT-STATUS.json"), JSON.stringify(routerStatus), "utf8");
  return { root, cli, switchScript, sentinel };
}

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

test("OpenClaw route apply never invokes the native script before shared confirmation", async () => {
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
  assert.ok(receipt.warningCodes.includes("explicit_agent_scope_required"));
});

test("a deep-imported public core surface cannot mint a route capability for direct live apply", async () => {
  const capabilityModule = await import(new URL("../dist/executor-route-capability.js", import.meta.url).href) as Record<string, unknown>;
  assert.equal(typeof capabilityModule.mintExecutorRouteCapability, "undefined");
  const workspace = await openClawWorkspace();
  let nativeCalls = 0;
  const adapter = new OpenClawRuntimeAdapter({ workspace: workspace.root, cli: workspace.cli, runner: async (command) => {
    if (command === process.execPath) nativeCalls += 1;
    return { code: 0, stdout: JSON.stringify(routerStatus), stderr: "" };
  } });
  const result = await adapter.mutate({ action: "route.use", target: "openai:helper-2", apply: true, provider: "openai", runtime: "openclaw", scope: { kind: "agent", id: "main" }, routeCapability: capabilityModule.mintExecutorRouteCapability, receiptPath: join(workspace.root, "receipt.json") });
  assert.equal(result.code, 2);
  assert.equal(nativeCalls, 0);
});

test("hostile direct adapter callers cannot supply a verifier secret or forge a route capability", async () => {
  const workspace = await openClawWorkspace();
  let nativeCalls = 0;
  const hostileConfig: unknown = {
    workspace: workspace.root,
    cli: workspace.cli,
    // Runtime config is deliberately ignored even if an untyped caller tries it.
    routeCapabilitySecret: "attacker-controlled-secret",
    runner: async (command: string) => {
      if (command === process.execPath) nativeCalls += 1;
      return { code: 0, stdout: JSON.stringify(routerStatus), stderr: "" };
    }
  };
  const adapter = new OpenClawRuntimeAdapter(hostileConfig as ConstructorParameters<typeof OpenClawRuntimeAdapter>[0]);
  const result = await adapter.mutate({
    action: "route.use", target: "openai:helper-2", apply: true, provider: "openai", runtime: "openclaw",
    scope: { kind: "agent", id: "main" }, routeCapability: "attacker-forged-capability", receiptPath: join(workspace.root, "receipt.json")
  });
  assert.equal(result.code, 2);
  assert.equal(nativeCalls, 0);
  assert.equal((result.payload as { reason: string }).reason, "route_apply_requires_executor_capability");
});

test("OpenClaw confirmed manual route uses the exact scoped native command and verifies fresh status", async () => {
  const workspace = await openClawWorkspace();
  const calls: Array<{ command: string; args: string[] }> = [];
  const fresh = routedStatus("openai:helper-2", ["openai:helper-2", "openai:helper-1"], "jacques");
  const adapter = new OpenClawRuntimeAdapter({ workspace: workspace.root, cli: workspace.cli, runner: async (command, args) => {
    calls.push({ command, args });
    if (args.includes("--print")) return { code: 0, stdout: JSON.stringify(fresh), stderr: "" };
    return { code: 0, stdout: JSON.stringify({ action: "route.use", agent: "jacques", selected: { profileId: "openai:helper-2" } }), stderr: "" };
  } });
  const result = await capabilityRoute(adapter, "route.use", "openai:helper-2", "jacques", join(workspace.root, "receipt.json"));
  assert.equal(result.code, 0);
  assert.deepEqual(calls[0], { command: process.execPath, args: [workspace.switchScript, "openai:helper-2", "--apply", "--agent", "jacques"] });
  assert.deepEqual(calls[1], { command: process.execPath, args: [workspace.sentinel, "--print"] });
  assert.equal(result.mutation?.applied, true);
  const persisted = await readFile(join(workspace.root, "receipt.json"), "utf8");
  assert.match(persisted, /persisted-route-receipt/);
  assert.doesNotMatch(persisted, /helper-1|helper-2|jacques|activeProfileId|effectiveAuthOrder|stdout|stderr|@|oauth_routing_cli|codex-auth-switch|sk-/);
  assert.match(persisted, /id_[a-f0-9]{24}/);
});

test("OpenClaw confirmed remove invokes only the native route-only remove contract and persists opaque proof", async () => {
  const workspace = await openClawWorkspace();
  const calls: Array<{ command: string; args: string[] }> = [];
  const fresh = routedStatus("openai:helper-1", ["openai:helper-1"], "jacques");
  const adapter = new OpenClawRuntimeAdapter({ workspace: workspace.root, cli: workspace.cli, runner: async (command, args) => {
    calls.push({ command, args });
    if (args.includes("--print")) return { code: 0, stdout: JSON.stringify(fresh), stderr: "" };
    return { code: 0, stdout: JSON.stringify({ action: "route.remove", agent: "jacques", target: "openai:helper-2" }), stderr: "" };
  } });
  const receiptPath = join(workspace.root, "remove-receipt.json");
  const result = await capabilityRoute(adapter, "route.remove", "openai:helper-2", "jacques", receiptPath);
  assert.equal(result.code, 0);
  assert.deepEqual(calls[0], { command: process.execPath, args: [workspace.switchScript, "remove", "openai:helper-2", "--apply", "--agent", "jacques"] });
  assert.deepEqual(calls[1], { command: process.execPath, args: [workspace.sentinel, "--print"] });
  assert.equal(calls.some(({ args }) => args.some((arg) => /delete|credential|auth-profiles|sqlite/i.test(arg))), false, "remove must not invoke a credential/delete path");
  const persisted = await readFile(receiptPath, "utf8");
  assert.match(persisted, /route\.remove/);
  assert.match(persisted, /id_[a-f0-9]{24}/);
  assert.doesNotMatch(persisted, /helper-2|jacques|stdout|stderr|@/);
});

test("OpenClaw remove treats a native target mismatch or retained route entry as unproven", async () => {
  const workspace = await openClawWorkspace();
  const adapter = new OpenClawRuntimeAdapter({ workspace: workspace.root, cli: workspace.cli, runner: async (_command, args) => {
    if (args.includes("--print")) return { code: 0, stdout: JSON.stringify(routedStatus("openai:helper-1", ["openai:helper-1", "openai:helper-2"], "main")), stderr: "" };
    return { code: 0, stdout: JSON.stringify({ action: "route.remove", agent: "main", target: "openai:helper-1" }), stderr: "" };
  } });
  const result = await capabilityRoute(adapter, "route.remove", "openai:helper-2", "main", join(workspace.root, "remove-mismatch.json"));
  assert.equal(result.code, 2);
  assert.equal(result.mutation?.applied, false);
  assert.equal((result.mutation as unknown as { reason: string }).reason, "native_route_result_unproven");
});

test("route target canonicalization accepts an exact observed profile and rejects option-shaped operands", async () => {
  const status = normalizeOpenClawStatus({
    ...routerStatus,
    scope: "agent:main",
    accounts: { ...routerStatus.accounts, "openai:helper-2": { ...routerStatus.accounts["openai:helper-2"], email: "member@example.test" } }
  });
  const calls: string[][] = [];
  const adapter = {
    source: "openclaw" as const,
    readStatus: async () => status,
    doctor: async () => ({}),
    mutate: async (input: { target?: string }) => { calls.push([input.target ?? ""]); return { code: 0, payload: { applied: false, dryRun: true, liveRuntimeMutation: false, receipt: { id: "evt_test", action: "route.remove", actor: "test", dryRun: true, createdAt: "2026-07-18T00:00:00.000Z", summary: "preview", warnings: [] } } }; }
  };
  const accepted = await executeAccountCenterCommand({ command: "route.remove", target: "openai:helper-2", provider: "openai", runtime: "openclaw", scope: { kind: "agent", id: "main" } }, { adapter });
  assert.equal(accepted.code, 0);
  assert.deepEqual(calls, [["openai:helper-2"]]);
  const rejected = await executeAccountCenterCommand({ command: "route.remove", target: "--apply", provider: "openai", runtime: "openclaw", scope: { kind: "agent", id: "main" } }, { adapter });
  assert.equal(rejected.code, 2);
  assert.equal(calls.length, 1);
});

test("OpenClaw confirmed automatic route invokes --auto for one exact agent and verifies the selected native result", async () => {
  const workspace = await openClawWorkspace();
  const fresh = routedStatus("openai:helper-2", ["openai:helper-2", "openai:helper-1"]);
  const calls: string[][] = [];
  const adapter = new OpenClawRuntimeAdapter({ workspace: workspace.root, cli: workspace.cli, runner: async (_command, args) => {
    calls.push(args);
    if (args.includes("--print")) return { code: 0, stdout: JSON.stringify(fresh), stderr: "" };
    return { code: 0, stdout: JSON.stringify({ action: "route.auto", agent: "main", selected: { profileId: "openai:helper-2" } }), stderr: "" };
  } });
  const result = await capabilityRoute(adapter, "route.auto", "openai:helper-2", "main", join(workspace.root, "receipt.json"));
  assert.equal(result.code, 0);
  assert.deepEqual(calls[0], [workspace.switchScript, "--auto", "--apply", "--agent", "main"]);
});

test("OpenClaw route apply rejects implicit, all, and non-agent scopes without native invocation", async () => {
  const workspace = await openClawWorkspace();
  let calls = 0;
  const adapter = new OpenClawRuntimeAdapter({ workspace: workspace.root, cli: workspace.cli, runner: async () => { calls += 1; return { code: 0, stdout: "{}", stderr: "" }; } });
  for (const scope of [undefined, { kind: "all" as const, id: "all" }, { kind: "default" as const, id: "default" }]) {
    const result = await adapter.mutate({ action: "route.use", target: "openai:helper-2", apply: true, scope, provider: "openai", runtime: "openclaw", receiptPath: join(workspace.root, `receipt-${calls}.json`) });
    assert.equal(result.code, 2);
  }
  assert.equal(calls, 0);
});

test("OpenClaw native route failure returns a truthful non-applied receipt", async () => {
  const workspace = await openClawWorkspace();
  const receiptPath = join(workspace.root, "receipt.json");
  const adapter = new OpenClawRuntimeAdapter({ workspace: workspace.root, cli: workspace.cli, runner: async () => ({ code: 9, stdout: "", stderr: "private@example.test sk-secret" }) });
  const result = await capabilityRoute(adapter, "route.use", "openai:helper-2", "main", receiptPath);
  assert.equal(result.code, 2);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(receipt.applied, false);
  assert.equal(JSON.stringify(receipt).includes("sk-secret"), false);
  assert.ok(receipt.warningCodes.includes("native_route_command_failed"));
});

test("OpenClaw read-after-write mismatch never reports applied", async () => {
  const workspace = await openClawWorkspace();
  const adapter = new OpenClawRuntimeAdapter({ workspace: workspace.root, cli: workspace.cli, runner: async (_command, args) => {
    if (args.includes("--print")) return { code: 0, stdout: JSON.stringify(routerStatus), stderr: "" };
    return { code: 0, stdout: JSON.stringify({ action: "route.use", agent: "main", selected: { profileId: "openai:helper-2" } }), stderr: "" };
  } });
  const result = await capabilityRoute(adapter, "route.use", "openai:helper-2", "main", join(workspace.root, "receipt.json"));
  assert.equal(result.code, 2);
  assert.equal(result.mutation?.applied, false);
  assert.equal((result.mutation as unknown as { reason: string }).reason, "route_read_after_write_mismatch");
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
  assert.ok(receipt.warningCodes.includes("atomic_delete_transaction_not_implemented"));
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
  assert.ok(receipt.warningCodes.includes("exact_match_required"));
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
  const result = await execFileRunner(process.execPath, ["-e", "process.on('SIGTERM', () => process.exit(0)); process.stdout.write('ready'); setInterval(() => {}, 1000)"], { timeoutMs: 500, maxOutputBytes: 64 });
  assert.equal(result.code, 0);
  assert.equal(result.timeoutExceeded, true);
});

test("spawn runner terminates a SIGTERM-ignoring descendant with its timed-out command group", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "account-center-command-tree-"));
  const marker = join(workspace, "descendant-survived");
  const script = `const { spawn } = require("node:child_process"); const marker = process.argv[1]; spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'survived'), 500); setInterval(() => {}, 1000)", marker], { stdio: "ignore" }); process.stdout.write("ready"); setInterval(() => {}, 1000);`;
  const result = await execFileRunner(process.execPath, ["-e", script, marker], { timeoutMs: 100, maxOutputBytes: 64 });
  assert.equal(result.timeoutExceeded, true);
  await new Promise((resolve) => setTimeout(resolve, 700));
  await assert.rejects(access(marker));
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
  assert.ok(receipt.warningCodes.includes("generic_apply_requires_protected_native_adapter"));
});
