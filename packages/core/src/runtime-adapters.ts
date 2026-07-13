import { access, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { AccountCenterStatus, AuditAction, Profile, assertAccountCenterStatus, isRecord, nowIso } from "./schemas.js";
import { createReceipt, nextEligible } from "./policy.js";
import { loadFixtureStatus } from "./fixtures.js";
import { redactJson } from "./redaction.js";

export type RuntimeSource = "fixture" | "openclaw" | "generic-command";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (command: string, args: string[], options?: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }) => Promise<CommandResult>;

export interface RuntimeMutationInput {
  action: AuditAction;
  target?: string;
  apply: boolean;
  provider: string;
  runtime: string;
  receiptPath: string;
}

export interface RuntimeMutationResult {
  code: number;
  payload: unknown;
}

export interface RuntimeAdapter {
  readonly source: RuntimeSource;
  readStatus(): Promise<AccountCenterStatus>;
  doctor(): Promise<unknown>;
  mutate(input: RuntimeMutationInput): Promise<RuntimeMutationResult>;
}

export interface OpenClawAdapterConfig {
  workspace?: string;
  cli?: string;
  agentDir?: string;
  receiptDir?: string;
  runner?: CommandRunner;
}

export interface GenericCommandAdapterConfig {
  command?: string;
  args?: string[];
  applyCommand?: string;
  runner?: CommandRunner;
}

export class FixtureRuntimeAdapter implements RuntimeAdapter {
  readonly source = "fixture" as const;

  constructor(private readonly fixturePath = "tests/fixtures/status.fixture.json") {}

  async readStatus(): Promise<AccountCenterStatus> {
    return loadFixtureStatus(this.fixturePath);
  }

  async doctor(): Promise<unknown> {
    const status = await this.readStatus();
    return {
      ok: true,
      source: status.source,
      fixtureOnly: true,
      profiles: status.profiles.length,
      routes: status.routes.length,
      warnings: status.warnings
    };
  }

  async mutate(input: RuntimeMutationInput): Promise<RuntimeMutationResult> {
    const status = await this.readStatus();
    return { code: 0, payload: dryRunReceipt(input.action, input.target, status, "fixture") };
  }
}

export class OpenClawRuntimeAdapter implements RuntimeAdapter {
  readonly source = "openclaw" as const;
  private readonly workspace: string;
  private readonly cli: string;
  private readonly agentDir: string;
  private readonly receiptDir: string;
  private readonly runner: CommandRunner;

  constructor(config: OpenClawAdapterConfig = {}) {
    this.workspace = resolve(config.workspace ?? process.env.ACCOUNT_CENTER_OPENCLAW_WORKSPACE ?? join(homedir(), ".openclaw", "workspace"));
    this.cli = resolve(config.cli ?? process.env.ACCOUNT_CENTER_OPENCLAW_CLI ?? join(this.workspace, "ops", "scripts", "oauth_routing_cli.py"));
    this.agentDir = resolve(config.agentDir ?? process.env.ACCOUNT_CENTER_OPENCLAW_AGENT_DIR ?? join(dirname(this.workspace), "agents", "main", "agent"));
    this.receiptDir = resolve(config.receiptDir ?? process.env.ACCOUNT_CENTER_RECEIPT_DIR ?? ".account-center/receipts");
    this.runner = config.runner ?? execFileRunner;
  }

  async readStatus(): Promise<AccountCenterStatus> {
    // Prefer Sentinel's account-limit snapshot over the older routing CLI.  The
    // routing CLI is good for route health, but it often lacks the Codex 5h/week
    // usage windows that Dexter's Telegram `/auth` renders from
    // CODEX-ACCOUNT-STATUS.json/codex-limits.mjs.  Falling back to the CLI keeps
    // older workspaces supported without showing `unknown` when fresh Sentinel
    // limit data exists.
    const sentinelStatus = await this.tryReadJson(join(this.workspace, "3-Resources", "codex-account-ops", "CODEX-ACCOUNT-STATUS.json"));
    if (sentinelStatus) return normalizeOpenClawStatus(sentinelStatus, "CODEX-ACCOUNT-STATUS.json");

    const cliStatus = await this.tryReadCliStatus();
    if (cliStatus) return normalizeOpenClawStatus(cliStatus, "oauth_routing_cli status --json");

    const sentinelState = await this.tryReadJson(join(this.workspace, "3-Resources", "codex-account-ops", "state", "sentinel-state.json"));
    if (sentinelState) return normalizeOpenClawStatus(sentinelState, "sentinel-state.json");

    throw new Error(`OpenClaw status unavailable. Set ACCOUNT_CENTER_OPENCLAW_WORKSPACE or ACCOUNT_CENTER_OPENCLAW_CLI; checked ${this.cli}`);
  }

  async doctor(): Promise<unknown> {
    const checks = [
      await pathCheck("workspace", this.workspace),
      await pathCheck("openclawCli", this.cli),
      await pathCheck("sentinelStatus", join(this.workspace, "3-Resources", "codex-account-ops", "CODEX-ACCOUNT-STATUS.json"))
    ];
    let statusReadable = false;
    let detail = "not checked";
    try {
      const status = await this.readStatus();
      statusReadable = true;
      detail = `${status.profiles.length} profiles, ${status.routes.length} routes`;
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
    }
    checks.push({ name: "status", ok: statusReadable, detail });
    return { ok: checks.every((item) => item.ok), source: "openclaw", workspace: this.workspace, cli: this.cli, checks, safety: ["read_only_diagnostic", "does_not_touch_sessions_prompts_memory_bootstrap"] };
  }

  async mutate(input: RuntimeMutationInput): Promise<RuntimeMutationResult> {
    const status = await this.readStatus();
    if (!input.apply) return { code: 0, payload: dryRunReceipt(input.action, input.target, status, "openclaw") };

    if (input.action === "account.delete") return this.deleteAccountCredentials(input, status);

    if (!["route.auto", "route.use", "route.remove"].includes(input.action)) {
      const receipt = createReceipt({
        action: input.action,
        dryRun: true,
        target: input.target,
        summary: `${input.action} apply is not supported by the configured OpenClaw account-routing CLI; no live mutation was attempted.`,
        warnings: ["openclaw_apply_unsupported", "no_live_mutation"]
      });
      return { code: 2, payload: { applied: false, dryRun: true, liveRuntimeMutation: false, receipt } };
    }

    const switchScript = join(this.workspace, "3-Resources", "codex-account-ops", "scripts", "codex-auth-switch.mjs");
    if (!(await exists(switchScript))) {
      const receipt = createReceipt({
        action: input.action,
        dryRun: true,
        target: input.target,
        summary: `OpenClaw account-routing switch script is missing; no live mutation was attempted.`,
        warnings: ["openclaw_apply_unsupported", "missing_existing_routing_script", "no_live_mutation"]
      });
      return { code: 2, payload: { applied: false, dryRun: true, liveRuntimeMutation: false, receipt } };
    }
    const target = input.action === "route.auto" ? nextEligible(status, input.provider, input.runtime)?.profile.id : input.target;
    const args = input.action === "route.auto"
      ? [switchScript, "--auto", "--apply", "--agent", "all", "--no-refresh"]
      : input.action === "route.remove"
        ? [switchScript, "remove", requiredTarget(target, input.action), "--apply", "--agent", "all", "--no-refresh"]
        : [switchScript, requiredTarget(target, input.action), "--apply", "--agent", "all", "--no-refresh"];
    const lock = await acquireRuntimeLock(this.workspace, "openclaw-route");
    try {
      const rollback = await backupOpenClawRoutingState(this.workspace, this.agentDir);
      const result = await this.runner(process.execPath, args, { cwd: this.workspace, timeoutMs: 60_000 });
      const receipt = createReceipt({
        action: input.action,
        dryRun: false,
        target,
        summary: result.code === 0 ? `Applied through existing OpenClaw account-routing script: ${input.action}` : `OpenClaw account-routing script failed: ${input.action}`,
        before: routeBefore(status),
        after: { command: "codex-auth-switch.mjs", args: args.slice(1).map((item) => item.includes("@") ? redactProfileArg(item) : item), exitCode: result.code, rollback },
        warnings: ["openclaw_account_routing_only", "sessions_prompts_memory_bootstrap_untouched", "lock_acquired", "rollback_pointer_written"]
      });
      await writeReceipt(input.receiptPath, { applied: result.code === 0, dryRun: false, liveRuntimeMutation: result.code === 0, receipt, command: "codex-auth-switch.mjs", rollback, stderr: result.stderr.slice(0, 2000), stdout: result.stdout.slice(0, 2000) });
      return { code: result.code, payload: { applied: result.code === 0, dryRun: false, liveRuntimeMutation: result.code === 0, receiptPath: input.receiptPath, receipt, rollback } };
    } finally {
      await releaseRuntimeLock(lock);
    }
  }

  private async deleteAccountCredentials(input: RuntimeMutationInput, status: AccountCenterStatus): Promise<RuntimeMutationResult> {
    const requestedTarget = requiredTarget(input.target, input.action);
    const resolvedTarget = resolveExactDeleteTarget(requestedTarget, status);
    if (!resolvedTarget) {
      const receipt = createReceipt({
        action: "account.delete",
        dryRun: true,
        target: requestedTarget,
        summary: `Blocked credential delete: target must exactly match a connected account email or profile id.`,
        before: routeBefore(status),
        warnings: ["target_not_found", "no_live_mutation", "exact_match_required"]
      });
      const payload = { applied: false, dryRun: true, liveRuntimeMutation: false, receipt, reason: "target_not_found_exact_match_required" };
      await writeReceipt(input.receiptPath, payload);
      return { code: 2, payload };
    }
    const target = resolvedTarget.id;
    const lock = await acquireRuntimeLock(this.workspace, "openclaw-credential-delete");
    try {
      const rollback = await backupOpenClawRoutingState(this.workspace, this.agentDir);
      const result = await this.runner("python3", ["-c", credentialDeletePython(), this.agentDir, target, this.workspace], { cwd: this.workspace, timeoutMs: 60_000 });
      let deletion: unknown = {};
      try { deletion = result.stdout.trim() ? JSON.parse(result.stdout) : {}; } catch { deletion = { parseError: true }; }
      const deletionSummary = redactedDeletionSummary(deletion);
      const targetNotFound = isRecord(deletion) && deletion.warning === "target_not_found";
      const applied = result.code === 0 && !targetNotFound;
      const receipt = createReceipt({
        action: "account.delete",
        dryRun: !applied,
        target: requestedTarget,
        summary: applied ? `Deleted Sentinel/OpenClaw credentials for ${redactProfileArg(requestedTarget)}` : `Credential delete did not find an exact connected target for ${redactProfileArg(requestedTarget)}; no live delete was applied.`,
        before: routeBefore(status),
        after: { command: "python3 account-center credential-delete", exitCode: result.code, deleted: deletionSummary, rollback, resolvedProfileId: redactProfileArg(target) },
        warnings: applied
          ? ["credential_delete_destructive", "openclaw_account_routing_only", "sessions_prompts_memory_bootstrap_untouched", "lock_acquired", "rollback_pointer_written", "exact_match_verified"]
          : ["target_not_found", "no_live_mutation", "exact_match_required", "rollback_pointer_written"]
      });
      const payload = { applied, dryRun: !applied, liveRuntimeMutation: applied, receiptPath: input.receiptPath, receipt, rollback, result: deletionSummary, stderr: result.stderr.slice(0, 2000) };
      await writeReceipt(input.receiptPath, payload);
      return { code: applied ? result.code : 2, payload };
    } finally {
      await releaseRuntimeLock(lock);
    }
  }

  private async tryRefreshSentinelStatus(): Promise<unknown | undefined> {
    const sentinel = join(this.workspace, "3-Resources", "codex-account-ops", "scripts", "codex-account-sentinel.mjs");
    if (!(await exists(sentinel))) return undefined;
    const result = await this.runner(process.execPath, [sentinel, "--print"], {
      cwd: this.workspace,
      timeoutMs: 60_000,
      env: { ...process.env, CODEX_SENTINEL_NO_SEND: "1" }
    });
    if (result.code !== 0 || !result.stdout.trim()) return undefined;
    return JSON.parse(result.stdout);
  }

  private async tryReadCliStatus(): Promise<unknown | undefined> {
    if (!(await exists(this.cli))) return undefined;
    const result = await this.runner("python3", [this.cli, "status", "--workspace", this.workspace, "--json"], { cwd: this.workspace, timeoutMs: 60_000 });
    if (result.code !== 0) return undefined;
    return JSON.parse(result.stdout);
  }

  private async tryReadJson(path: string): Promise<unknown | undefined> {
    if (!(await exists(path))) return undefined;
    return JSON.parse(await readFile(path, "utf8"));
  }
}

export class GenericCommandRuntimeAdapter implements RuntimeAdapter {
  readonly source = "generic-command" as const;
  private readonly command: string;
  private readonly args: string[];
  private readonly applyCommand?: string;
  private readonly runner: CommandRunner;

  constructor(config: GenericCommandAdapterConfig = {}) {
    const commandText = config.command ?? process.env.ACCOUNT_CENTER_GENERIC_COMMAND;
    if (!commandText) throw new Error("Generic command source requires ACCOUNT_CENTER_GENERIC_COMMAND or adapter command config.");
    const commandParts = splitArgs(commandText);
    this.command = commandParts[0] ?? commandText;
    this.args = config.args ?? [...commandParts.slice(1), ...splitArgs(process.env.ACCOUNT_CENTER_GENERIC_ARGS ?? "--json")];
    this.applyCommand = config.applyCommand ?? process.env.ACCOUNT_CENTER_GENERIC_APPLY_COMMAND;
    this.runner = config.runner ?? execFileRunner;
  }

  async readStatus(): Promise<AccountCenterStatus> {
    const result = await this.runner(this.command, this.args, { timeoutMs: 60_000 });
    if (result.code !== 0) throw new Error(`Generic command status failed (${result.code}): ${result.stderr.slice(0, 500)}`);
    return normalizeGenericCommandStatus(JSON.parse(result.stdout));
  }

  async doctor(): Promise<unknown> {
    try {
      const status = await this.readStatus();
      return { ok: true, source: "generic-command", command: this.command, profiles: status.profiles.length, routes: status.routes.length, safety: ["adapter_contract_json", "no_secret_status_required"] };
    } catch (error) {
      return { ok: false, source: "generic-command", command: this.command, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async mutate(input: RuntimeMutationInput): Promise<RuntimeMutationResult> {
    const status = await this.readStatus();
    if (!input.apply) return { code: 0, payload: dryRunReceipt(input.action, input.target, status, "generic-command") };
    if (!this.applyCommand) {
      const receipt = createReceipt({ action: input.action, dryRun: true, target: input.target, summary: "Generic command apply requires ACCOUNT_CENTER_GENERIC_APPLY_COMMAND; no live mutation was attempted.", warnings: ["generic_apply_unconfigured", "no_live_mutation"] });
      return { code: 2, payload: { applied: false, dryRun: true, liveRuntimeMutation: false, receipt } };
    }
    const target = input.action === "route.auto" ? nextEligible(status, input.provider, input.runtime)?.profile.id : input.target;
    const result = await this.runner(this.applyCommand, [input.action, requiredTarget(target, input.action), "--json"], { timeoutMs: 60_000 });
    const receipt = createReceipt({
      action: input.action,
      dryRun: false,
      target,
      summary: result.code === 0 ? `Applied through generic command adapter: ${input.action}` : `Generic command adapter failed: ${input.action}`,
      before: routeBefore(status),
      after: { command: this.applyCommand, action: input.action, exitCode: result.code },
      warnings: ["generic_command_adapter", "external_command_contract"]
    });
    const payload = { applied: result.code === 0, dryRun: false, liveRuntimeMutation: result.code === 0, receipt, stdout: result.stdout.slice(0, 2000), stderr: result.stderr.slice(0, 2000) };
    await writeReceipt(input.receiptPath, payload);
    return { code: result.code, payload };
  }
}

export function createRuntimeAdapter(source: RuntimeSource, options: { cwd?: string; runner?: CommandRunner } = {}): RuntimeAdapter {
  if (source === "openclaw") return new OpenClawRuntimeAdapter({ runner: options.runner });
  if (source === "generic-command") return new GenericCommandRuntimeAdapter({ runner: options.runner });
  return new FixtureRuntimeAdapter(resolve(options.cwd ?? process.cwd(), "tests/fixtures/status.fixture.json"));
}

export function parseRuntimeSource(value: string | undefined): RuntimeSource {
  if (!value || value === "fixture") return "fixture";
  if (value === "openclaw") return "openclaw";
  if (value === "generic-command") return "generic-command";
  throw new Error(`Unsupported source: ${value}. Expected fixture, openclaw, or generic-command.`);
}

export function normalizeGenericCommandStatus(raw: unknown): AccountCenterStatus {
  if (isRecord(raw) && raw.schemaVersion === "account-center.status.v1") {
    const status = { ...raw, source: "generic-command", noSecrets: true };
    assertAccountCenterStatus(status);
    return redactJson(status) as AccountCenterStatus;
  }
  const normalized = normalizeOpenClawStatus(raw, "generic-command adapter status");
  return redactJson({
    ...normalized,
    source: "generic-command",
    runtimes: [{ key: "generic-command", displayName: "Generic command adapter", capabilities: { readStatus: true, mutateRoutes: true, startReauth: false, mutateModels: false } }],
    profiles: normalized.profiles.map((profile) => ({ ...profile, runtimeCompatibility: ["generic-command"] })),
    routes: normalized.routes.map((route) => ({ ...route, runtime: "generic-command" })),
    warnings: [...normalized.warnings, "generic_command_contract"]
  }) as AccountCenterStatus;
}

export function dryRunReceipt(action: AuditAction, target: string | undefined, status: AccountCenterStatus, source: RuntimeSource): unknown {
  const profile = target ? status.profiles.find((item) => item.id === target || item.label === target) : undefined;
  return redactJson({
    applied: false,
    dryRun: true,
    liveRuntimeMutation: false,
    receipt: createReceipt({
      action,
      dryRun: true,
      target: target ?? profile?.id,
      summary: `Dry run only: ${action} would be planned against ${source} data; live runtime stores are not mutated.`,
      before: profile ? { id: profile.id, role: profile.role, disabled: profile.disabled } : undefined,
      after: action.endsWith("disable") ? { disabled: true } : action.endsWith("enable") ? { disabled: false } : undefined,
      warnings: source === "fixture" ? ["fixture_only", "no_live_mutation"] : ["openclaw_dry_run", "no_live_mutation"]
    })
  });
}

export function normalizeOpenClawStatus(raw: unknown, sourceDetail = "openclaw"): AccountCenterStatus {
  const generatedAt = stringFrom(raw, ["at", "generatedAt", "updatedAt"]) ?? nowIso();
  const provider = stringFrom(raw, ["provider"]) ?? "openai";
  const accounts = accountRecords(raw);
  const order = routeOrder(raw, accounts.map((account) => account.id));
  const activeProfileId = activeProfile(raw, order) ?? order[0] ?? accounts[0]?.id ?? "unknown";
  const routePolicy = isRecord(raw) && isRecord(raw.routePolicy) ? raw.routePolicy : {};
  const profiles: Profile[] = accounts.map((account, index) => ({
    id: account.id,
    provider: provider as Profile["provider"],
    label: account.label,
    role: roleFor(account.id, activeProfileId, index),
    runtimeCompatibility: ["openclaw"],
    models: ["openai/gpt-5.5", "openai/gpt-5.3-codex"],
    disabled: !account.enabled,
    cooldownUntil: account.cooldownUntil,
    usage: {
      profileId: account.id,
      provider: provider as Profile["provider"],
      generatedAt: account.observedAt ?? generatedAt,
      readable: account.readable,
      health: account.health,
      windows: [
        { name: "five-hour", displayLabel: "5h", usedPct: account.fiveHourUsed, remainingPct: account.fiveHourRemaining, resetsAt: account.fiveHourResetAt },
        { name: "weekly", displayLabel: "Week", usedPct: account.weekUsed, remainingPct: account.weekRemaining, resetsAt: account.weekResetAt }
      ],
      auth: { state: account.authState, tokenExpiresAt: account.tokenExpiresAt },
      warnings: account.warnings
    },
    metadata: {
      email: account.email,
      plan: account.plan,
      routingEnabled: account.routingEnabled,
      routingRecommendation: account.routingRecommendation,
      tokenExpiresAtEEST: account.tokenExpiresAtEEST,
      nonAdsaverWeeklyUsableCount: numberOrNull(routePolicy.nonAdsaverWeeklyUsableCount),
      generatedAtEEST: stringFrom(raw, ["generatedAtEEST"])
    }
  }));
  const status: AccountCenterStatus = {
    schemaVersion: "account-center.status.v1",
    generatedAt,
    noSecrets: true,
    source: "openclaw",
    providers: [{ key: provider as AccountCenterStatus["providers"][number]["key"], displayName: provider === "openai" ? "OpenAI" : provider }],
    runtimes: [{
      key: "openclaw",
      displayName: "OpenClaw live adapter",
      capabilities: { readStatus: true, mutateRoutes: true, startReauth: false, mutateModels: false }
    }],
    profiles,
    routes: [{
      provider: provider as AccountCenterStatus["routes"][number]["provider"],
      runtime: "openclaw",
      activeProfileId,
      order,
      updatedAt: generatedAt
    }],
    policy: {
      minFiveHourRemainingPct: 5,
      minWeeklyRemainingPct: 5,
      allowBackupWhenNormalAvailable: false,
      disabledModels: [],
      staleAfterSeconds: 1800
    },
    leases: [],
    reauth: [],
    audit: [createReceipt({ action: "status.export", actor: "openclaw-adapter", dryRun: true, summary: `Loaded OpenClaw no-secret status from ${sourceDetail}` })],
    warnings: [`source=${sourceDetail}`]
  };
  assertAccountCenterStatus(status);
  return redactJson(status) as AccountCenterStatus;
}

async function execFileRunner(command: string, args: string[], options: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<CommandResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = options.timeoutMs ? setTimeout(() => child.kill("SIGTERM"), options.timeoutMs) : undefined;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      if (timeout) clearTimeout(timeout);
      resolvePromise({ code: 127, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function pathCheck(name: string, path: string): Promise<{ name: string; ok: boolean; detail: string }> {
  return { name, ok: await exists(path), detail: path };
}

async function acquireRuntimeLock(workspace: string, name: string): Promise<string> {
  const lockRoot = join(workspace, ".account-center", "locks");
  const lockDir = join(lockRoot, `${name}.lock`);
  await mkdir(lockRoot, { recursive: true });
  await mkdir(lockDir, { recursive: false });
  await writeFile(join(lockDir, "owner.json"), `${JSON.stringify({ name, pid: process.pid, acquiredAt: nowIso() }, null, 2)}\n`, "utf8");
  return lockDir;
}

async function releaseRuntimeLock(lockDir: string): Promise<void> {
  await rm(lockDir, { recursive: true, force: true });
}

async function backupOpenClawRoutingState(workspace: string, agentDir?: string): Promise<{ backupDir: string; files: string[] }> {
  const backupDir = join(workspace, ".account-center", "backups", "openclaw-routing", safeStamp());
  await mkdir(backupDir, { recursive: true });
  const candidates = [
    join(workspace, "3-Resources", "codex-account-ops", "CODEX-ACCOUNT-STATUS.json"),
    join(workspace, "3-Resources", "codex-account-ops", "state", "sentinel-state.json"),
    ...(agentDir ? [
      join(agentDir, "openclaw-agent.sqlite"),
      join(agentDir, "auth-profiles.json"),
      join(agentDir, "auth-state.json")
    ] : [])
  ];
  const files: string[] = [];
  for (const source of candidates) {
    if (!(await exists(source))) continue;
    const destination = join(backupDir, source.replace(workspace, "").replace(/^\/+/, "").replace(/[\\/]/g, "__"));
    await copyFile(source, destination);
    files.push(destination);
  }
  await writeFile(join(backupDir, "ROLLBACK.md"), rollbackText(files), "utf8");
  return { backupDir, files };
}

function rollbackText(files: string[]): string {
  return [`# Account Center OpenClaw routing backup`, ``, `Created: ${nowIso()}`, ``, `Files copied:`, ...files.map((file) => `- ${file}`), ``, `Rollback is manual in v0: inspect these no-secret/state files, then restore through the OpenClaw/Sentinel native routing tools rather than editing unrelated session/prompt/memory/bootstrap files.`].join("\n") + "\n";
}

function credentialDeletePython(): string {
  return String.raw`
import json, os, sqlite3, sys, time
from pathlib import Path
agent_dir = Path(sys.argv[1])
target = sys.argv[2]
workspace = Path(sys.argv[3]) if len(sys.argv) > 3 else None

def ids_for(value):
    raw = str(value).strip()
    email = raw.split(':', 1)[1] if ':' in raw else raw
    ids = {raw}
    if '@' in email:
        ids.add('openai:' + email)
        ids.add('openai-codex:' + email)
    return ids

targets = ids_for(target)
summary = {'deletedProfiles': [], 'removedFromOrder': [], 'clearedLastGood': [], 'filesTouched': []}

def matches(value):
    if value is None:
        return False
    return bool(ids_for(value) & targets)

def scrub_state(state):
    order = state.get('order') if isinstance(state.get('order'), dict) else {}
    for provider, values in list(order.items()):
        if not isinstance(values, list):
            continue
        kept = [item for item in values if item not in targets]
        removed = [item for item in values if item in targets]
        if removed:
            summary['removedFromOrder'].extend(removed)
            order[provider] = kept
    last = state.get('lastGood') if isinstance(state.get('lastGood'), dict) else {}
    for provider, value in list(last.items()):
        if value in targets:
            summary['clearedLastGood'].append(value)
            last.pop(provider, None)
    usage = state.get('usageStats') if isinstance(state.get('usageStats'), dict) else {}
    for key in list(usage.keys()):
        if key in targets:
            usage.pop(key, None)
    return state

def scrub_store(store):
    profiles = store.get('profiles') if isinstance(store.get('profiles'), dict) else {}
    for key, row in list(profiles.items()):
        email = row.get('email') if isinstance(row, dict) else None
        row_ids = ids_for(email) if email else set()
        row_ids.add(key)
        if row_ids & targets:
            profiles.pop(key, None)
            summary['deletedProfiles'].append(key)
    return store

def scrub_status(status):
    accounts = status.get('accounts')
    if isinstance(accounts, list):
        kept = []
        for row in accounts:
            if isinstance(row, dict) and (matches(row.get('profileId')) or matches(row.get('email')) or matches(row.get('id'))):
                summary['deletedProfiles'].append(str(row.get('profileId') or row.get('email') or row.get('id')))
            else:
                kept.append(row)
        status['accounts'] = kept
    elif isinstance(accounts, dict):
        for key, row in list(accounts.items()):
            if matches(key) or (isinstance(row, dict) and (matches(row.get('profileId')) or matches(row.get('email')) or matches(row.get('id')))):
                accounts.pop(key, None)
                summary['deletedProfiles'].append(str(key))

    for key in ['effectiveAuthOrder', 'currentAuthOrder']:
        values = status.get(key)
        if isinstance(values, list):
            removed = [item for item in values if matches(item)]
            if removed:
                status[key] = [item for item in values if not matches(item)]
                summary['removedFromOrder'].extend(map(str, removed))

    route_policy = status.get('routePolicy') if isinstance(status.get('routePolicy'), dict) else {}
    for key in ['primary', 'lastGood']:
        if matches(route_policy.get(key)):
            summary['clearedLastGood'].append(str(route_policy.get(key)))
            route_policy.pop(key, None)
    order = route_policy.get('order')
    if isinstance(order, list):
        removed = [item for item in order if matches(item)]
        if removed:
            route_policy['order'] = [item for item in order if not matches(item)]
            summary['removedFromOrder'].extend(map(str, removed))
    alerts = status.get('alerts')
    if isinstance(alerts, dict):
        for key in list(alerts.keys()):
            if any(str(t) in str(key) for t in targets):
                alerts.pop(key, None)
    return status

def edit_json_file(path, editor):
    if not path.exists():
        return
    data = json.loads(path.read_text())
    new_data = editor(data)
    path.write_text(json.dumps(new_data, indent=2, sort_keys=True) + '\n')
    summary['filesTouched'].append(str(path))

edit_json_file(agent_dir / 'auth-profiles.json', scrub_store)
edit_json_file(agent_dir / 'auth-state.json', scrub_state)
if workspace:
    edit_json_file(workspace / '3-Resources' / 'codex-account-ops' / 'CODEX-ACCOUNT-STATUS.json', scrub_status)
    edit_json_file(workspace / '3-Resources' / 'codex-account-ops' / 'state' / 'sentinel-state.json', scrub_status)

db = agent_dir / 'openclaw-agent.sqlite'
if db.exists():
    con = sqlite3.connect(db)
    try:
        cur = con.execute("SELECT store_json FROM auth_profile_store WHERE store_key='primary'")
        row = cur.fetchone()
        if row:
            store = scrub_store(json.loads(row[0]))
            con.execute("UPDATE auth_profile_store SET store_json=?, updated_at=? WHERE store_key='primary'", (json.dumps(store, separators=(',', ':')), int(time.time()*1000)))
            summary['filesTouched'].append(str(db) + ':auth_profile_store')
        cur = con.execute("SELECT state_json FROM auth_profile_state WHERE state_key='primary'")
        row = cur.fetchone()
        if row:
            state = scrub_state(json.loads(row[0]))
            con.execute("UPDATE auth_profile_state SET state_json=?, updated_at=? WHERE state_key='primary'", (json.dumps(state, separators=(',', ':')), int(time.time()*1000)))
            summary['filesTouched'].append(str(db) + ':auth_profile_state')
        con.commit()
    finally:
        con.close()

if not summary['deletedProfiles'] and not summary['removedFromOrder'] and not summary['clearedLastGood']:
    summary['warning'] = 'target_not_found'
print(json.dumps(summary, sort_keys=True))
`;
}

function redactedDeletionSummary(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const keep: Record<string, unknown> = {};
  for (const key of ["deletedProfiles", "removedFromOrder", "clearedLastGood", "filesTouched", "warning", "parseError"]) {
    if (key in value) keep[key] = value[key];
  }
  return keep;
}

function safeStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function writeReceipt(path: string, payload: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(redactJson(payload), null, 2)}\n`, "utf8");
}

function requiredTarget(target: string | undefined, action: AuditAction): string {
  if (!target) throw new Error(`${action} requires a target profile`);
  return target;
}

function normalizeProfileTarget(value: string): string {
  return value.trim().toLowerCase();
}

function profileEmail(profile: Profile): string | undefined {
  const email = profile.metadata?.email;
  if (typeof email === "string" && email.trim()) return email;
  const idEmail = profile.id.includes(":") ? profile.id.slice(profile.id.indexOf(":") + 1) : profile.id;
  return idEmail.includes("@") ? idEmail : undefined;
}

function resolveExactDeleteTarget(target: string, status: AccountCenterStatus): Profile | undefined {
  const raw = target.trim();
  const normalized = normalizeProfileTarget(raw);
  return status.profiles.find((profile) => {
    const candidates = [
      profile.id,
      profile.label,
      profileEmail(profile),
      profile.id.startsWith("openai:") ? profile.id.slice("openai:".length) : undefined,
      profile.id.startsWith("openai-codex:") ? `openai:${profile.id.slice("openai-codex:".length)}` : undefined,
    ].filter((item): item is string => Boolean(item));
    return candidates.some((candidate) => normalizeProfileTarget(candidate) === normalized);
  });
}

function routeBefore(status: AccountCenterStatus): unknown {
  return status.routes.map((route) => ({ provider: route.provider, runtime: route.runtime, activeProfileId: route.activeProfileId, order: route.order }));
}

function redactProfileArg(value: string): string {
  return value.replace(/([^:@\s]{2})[^:@\s]*(@[^:\s]+)/g, "$1[REDACTED]$2");
}

function accountRecords(raw: unknown): Array<{
  id: string;
  label: string;
  enabled: boolean;
  readable: boolean;
  health: "ok" | "warn" | "error" | "unknown";
  authState: "ok" | "expired" | "reauth-needed" | "unknown";
  fiveHourRemaining: number | null;
  weekRemaining: number | null;
  fiveHourResetAt?: string;
  weekResetAt?: string;
  fiveHourUsed: number | null;
  weekUsed: number | null;
  observedAt?: string;
  tokenExpiresAt?: string;
  tokenExpiresAtEEST?: string;
  cooldownUntil?: string;
  warnings: string[];
  email: string;
  plan: string;
  routingEnabled: boolean;
  routingRecommendation: string;
}> {
  const rawAccounts = isRecord(raw) && isRecord(raw.accounts)
    ? Object.values(raw.accounts).filter(isRecord)
    : isRecord(raw) && Array.isArray(raw.accounts)
      ? raw.accounts.filter(isRecord)
      : [];
  return rawAccounts.map((account) => {
    const id = String(account.profileId ?? account.id ?? account.email ?? "unknown");
    const usage = isRecord(account.usage) ? account.usage : {};
    const health = isRecord(account.health) ? account.health : {};
    const quarantine = isRecord(account.quarantine) ? account.quarantine : {};
    const windows = Array.isArray(account.windows) ? account.windows.filter(isRecord) : [];
    const fiveWindow = windows.find((item) => /5h|five/i.test(String(item.label ?? item.name)));
    const weekWindow = windows.find((item) => /week|168h|weekly/i.test(String(item.label ?? item.name)));
    const expired = Boolean(health.expired);
    const healthy = Boolean(account.ok ?? health.healthy ?? usage.available);
    const readable = Boolean(account.ok ?? usage.available ?? health.healthy);
    return {
      id,
      label: String(account.name ?? account.email ?? id.replace(/^[^:]+:/, "")),
      enabled: Boolean(account.enabled ?? account.routingEnabled ?? true) && !Boolean(quarantine.active),
      readable,
      health: expired ? "error" : healthy ? "ok" : readable ? "warn" : "unknown",
      authState: expired ? "expired" : healthy ? "ok" : readable ? "unknown" : "reauth-needed",
      fiveHourRemaining: numberOrNull(usage.fiveHourRemaining ?? fiveWindow?.leftPercent ?? account.fiveHourRemaining),
      weekRemaining: numberOrNull(usage.weekRemaining ?? weekWindow?.leftPercent ?? account.weekRemaining),
      fiveHourResetAt: firstString(fiveWindow, ["resetAtEEST", "resetAt", "resetsAt"]),
      weekResetAt: firstString(weekWindow, ["resetAtEEST", "resetAt", "resetsAt"]),
      fiveHourUsed: numberOrNull(fiveWindow?.usedPercent),
      weekUsed: numberOrNull(weekWindow?.usedPercent),
      observedAt: stringFrom(usage, ["observedAt"]) ?? stringFrom(health, ["observedAt"]),
      tokenExpiresAt: millisToIso(account.tokenExpiresAt ?? health.expiresAt),
      tokenExpiresAtEEST: stringFrom(account, ["tokenExpiresAtEEST"]),
      cooldownUntil: stringFrom(account.throttleHealth, ["cooldownUntil"]),
      warnings: [
        !readable ? "status_unreadable" : undefined,
        expired ? "auth_expired" : undefined,
        quarantine.active ? `quarantined:${String(quarantine.reason ?? "unknown")}` : undefined
      ].filter((item): item is string => Boolean(item)),
      email: String(account.email ?? id.replace(/^[^:]+:/, "")),
      plan: String(account.plan ?? inferredPlan(String(account.email ?? id))),
      routingEnabled: Boolean(account.routingEnabled ?? account.enabled ?? true),
      routingRecommendation: String(account.routingRecommendation ?? (account.routingEnabled ? "normal-routing" : "monitor-only"))
    };
  });
}

function routeOrder(raw: unknown, fallback: string[]): string[] {
  const candidates = [
    nestedArray(raw, ["effectiveAuthOrder"]),
    nestedArray(raw, ["orderPresentation", "policySafeOrder"]),
    nestedArray(raw, ["currentAuthOrder"]),
    nestedArray(raw, ["routePolicy", "order"])
  ].find((item) => item.length > 0);
  return [...new Set([...(candidates ?? []), ...fallback])];
}

function activeProfile(raw: unknown, order: string[]): string | undefined {
  return stringFrom(raw, ["override", "profileId"])
    ?? stringFrom(raw, ["orderPresentation", "activeHead"])
    ?? stringFrom(raw, ["orderPresentation", "policyHead"])
    ?? stringFrom(raw, ["routePolicy", "lastGood"])
    ?? stringFrom(raw, ["routePolicy", "primary"])
    ?? stringFrom(raw, ["route", "lastGood"])
    ?? stringFrom(raw, ["route", "primary"])
    ?? order[0];
}

function roleFor(id: string, active: string, index: number): Profile["role"] {
  if (/adsaver|backup/i.test(id)) return "backup";
  if (id === active || index === 0) return "primary";
  return "secondary";
}

function inferredPlan(emailOrId: string): string {
  if (/travis86242339651/i.test(emailOrId)) return "free";
  if (/49pushy|adsaveragency/i.test(emailOrId)) return "plus";
  return "unknown";
}

function nestedArray(raw: unknown, path: string[]): string[] {
  let cursor: unknown = raw;
  for (const segment of path) cursor = isRecord(cursor) ? cursor[segment] : undefined;
  return Array.isArray(cursor) ? cursor.map(String) : [];
}

function stringFrom(raw: unknown, path: string[]): string | undefined {
  let cursor: unknown = raw;
  for (const segment of path) cursor = isRecord(cursor) ? cursor[segment] : undefined;
  if (typeof cursor === "string" && cursor) return cursor;
  if (typeof cursor === "number") return millisToIso(cursor);
  return undefined;
}

function firstString(raw: unknown, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = stringFrom(raw, [key]);
    if (value) return value;
  }
  return undefined;
}

function numberOrNull(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function millisToIso(value: unknown): string | undefined {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return undefined;
  return new Date(number).toISOString();
}

function splitArgs(value: string): string[] {
  return value.trim() ? value.trim().split(/\s+/) : [];
}
