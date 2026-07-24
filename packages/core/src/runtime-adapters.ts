import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { verifiesExecutorRouteCapability } from "./command-executor.js";
import { AccountCenterStatus, AuditAction, Profile, RuntimeKey, assertAccountCenterStatus, isRecord, nowIso } from "./schemas.js";
import { createReceipt } from "./policy.js";
import { loadFixtureStatus } from "./fixtures.js";
import { redactJson } from "./redaction.js";
import { DEFAULT_OPENCLAW_OBSERVED_MODEL_IDS } from "./model-catalog-policy.js";
import type { MutationScope } from "./mutation-contract.js";

export type RuntimeSource = "fixture" | "openclaw" | "generic-command";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  outputLimitExceeded?: boolean;
  timeoutExceeded?: boolean;
}

export type CommandRunner = (command: string, args: string[], options?: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; maxOutputBytes?: number }) => Promise<CommandResult>;

// Generic commands are untrusted adapters. Keep their status ingestion bounded
// before JSON parsing or recursive redaction can process attacker-controlled data.
export const MAX_GENERIC_COMMAND_STATUS_BYTES = 1_048_576;
const PROCESS_TERMINATION_GRACE_MS = 250;
const GENERIC_COMMAND_FAILURE = "Generic command status is unavailable or unproven";
// The status contract is deliberately redacted before it leaves normalization.
// Keep connected emails only in this module-scoped, non-serializable sidecar so
// account.delete can make its exact identity decision without publishing them.
const privateConnectedEmails = new WeakMap<AccountCenterStatus, Map<string, string>>();

export interface RuntimeMutationInput {
  action: AuditAction;
  target?: string;
  apply: boolean;
  provider: string;
  runtime: string;
  /** Opaque, executor-minted, one-operation authorization; a boolean is never sufficient. */
  routeCapability?: unknown;
  /** OpenClaw route mutations are deliberately limited to one exact agent. */
  scope?: MutationScope;
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
  runner?: CommandRunner;
}

export interface GenericCommandAdapterConfig {
  command?: string;
  args?: string[];
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
  private readonly runner: CommandRunner;

  constructor(config: OpenClawAdapterConfig = {}) {
    this.workspace = resolve(config.workspace ?? process.env.ACCOUNT_CENTER_OPENCLAW_WORKSPACE ?? join(homedir(), ".openclaw", "workspace"));
    this.cli = resolve(config.cli ?? process.env.ACCOUNT_CENTER_OPENCLAW_CLI ?? join(this.workspace, "ops", "scripts", "oauth_routing_cli.py"));
    this.agentDir = resolve(config.agentDir ?? process.env.ACCOUNT_CENTER_OPENCLAW_AGENT_DIR ?? join(dirname(this.workspace), "agents", "main", "agent"));
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

    return this.applyRoute(input, status);
  }

  private async applyRoute(input: RuntimeMutationInput, before: AccountCenterStatus): Promise<RuntimeMutationResult> {
    const blocked = async (reason: string, warning: string): Promise<RuntimeMutationResult> => {
      const receipt = createReceipt({ action: input.action, dryRun: true, target: input.target, summary: "OpenClaw route apply was not authorized or could not be proven; no applied receipt was issued.", before: routeBefore(before), warnings: [warning, "no_live_mutation"] });
      const payload = { applied: false, dryRun: true, liveRuntimeMutation: false, receipt, reason };
      return { code: 2, payload };
    };
    if (input.scope?.kind !== "agent" || !isExactAgentScope(input.scope.id)) return blocked("explicit_agent_scope_required", "explicit_agent_scope_required");
    if (!input.target || !verifiesExecutorRouteCapability(input.routeCapability, { action: input.action, target: input.target, provider: input.provider, runtime: input.runtime, scope: input.scope })) return blocked("route_apply_requires_executor_capability", "route_apply_requires_executor_capability");
    if (input.provider !== "openai" || input.runtime !== "openclaw") return blocked("openclaw_route_provider_runtime_required", "openclaw_route_provider_runtime_required");

    const switchScript = join(this.workspace, "3-Resources", "codex-account-ops", "scripts", "codex-auth-switch.mjs");
    if (!(await exists(switchScript))) return blocked("missing_existing_routing_script", "missing_existing_routing_script");
    const target = input.action === "route.auto" ? undefined : canonicalRouteTarget(before, requiredTarget(input.target, input.action), input.provider, input.runtime);
    if (input.action !== "route.auto" && !target) return blocked("canonical_route_target_required", "canonical_route_target_required");
    const args = input.action === "route.auto"
      ? [switchScript, "--auto", "--apply", "--agent", input.scope.id]
      : input.action === "route.remove"
        ? [switchScript, "remove", target!, "--apply", "--agent", input.scope.id]
        : [switchScript, target!, "--apply", "--agent", input.scope.id];
    let native: CommandResult;
    try {
      native = await this.runner(process.execPath, args, { cwd: this.workspace, timeoutMs: 60_000, maxOutputBytes: 256 * 1024 });
    } catch {
      return this.routeFailure(input, before, "native_route_command_failed", "native_route_command_failed");
    }
    if (native.code !== 0 || native.timeoutExceeded || native.outputLimitExceeded) return this.routeFailure(input, before, "native_route_command_failed", "native_route_command_failed");
    const nativeEvent = parseNativeEvent(native.stdout);
    const nativeTarget = input.action === "route.auto" ? nativeSelectedProfile(nativeEvent) : target;
    // The shared review binds the previewed automatic candidate. The native
    // script remains the selector, but a changed selection is not silently
    // accepted as confirmation for a different profile.
    if (!nativeEventProof(nativeEvent, input.action, nativeTarget, input.scope.id) || !nativeTarget || canonicalRouteTarget(before, nativeTarget, input.provider, input.runtime) !== nativeTarget || (input.action === "route.auto" && nativeTarget !== input.target)) return this.routeFailure(input, before, "native_route_result_unproven", "native_route_result_unproven");
    const expectedTarget = nativeTarget;
    let after: AccountCenterStatus;
    try {
      after = await this.readFreshStatus();
    } catch {
      return this.routeFailure(input, before, "route_read_after_write_unproven", "route_read_after_write_unproven");
    }
    if (!routeMutationVerified(after, input.action, expectedTarget, input.scope.id)) return this.routeFailure(input, before, "route_read_after_write_mismatch", "route_read_after_write_mismatch");
    const receipt = createReceipt({
      action: input.action,
      dryRun: false,
      target: expectedTarget,
      summary: `Applied and verified OpenClaw ${input.action} for the confirmed agent scope.`,
      before: routeBefore(before),
      after: routeBefore(after),
      warnings: ["openclaw_account_routing_only", "native_backup_and_event_receipt", "fresh_read_after_write_verified", "sessions_prompts_memory_bootstrap_untouched"]
    });
    const payload = {
      applied: true,
      dryRun: false,
      liveRuntimeMutation: true,
      receipt,
      verification: { kind: "verified", route: routeBefore(after) },
      proof: routeApplyProof(input.action, input.scope.id, expectedTarget, before, after)
    };
    return { code: 0, payload };
  }

  private async routeFailure(input: RuntimeMutationInput, before: AccountCenterStatus, reason: string, warning: string): Promise<RuntimeMutationResult> {
    const receipt = createReceipt({ action: input.action, dryRun: false, target: input.target, summary: "OpenClaw route operation did not receive an applied receipt because its native result or fresh verification was not proven.", before: routeBefore(before), warnings: [warning, "recovery_required"] });
    const payload = { applied: false, dryRun: false, liveRuntimeMutation: true, receipt, reason, verification: { kind: "unproven" } };
    return { code: 2, payload };
  }

  private async readFreshStatus(): Promise<AccountCenterStatus> {
    const fresh = await this.tryRefreshSentinelStatus();
    if (!fresh) throw new Error("fresh_status_unavailable");
    return normalizeOpenClawStatus(fresh, "fresh codex-account-sentinel --print");
  }

  private async deleteAccountCredentials(input: RuntimeMutationInput, status: AccountCenterStatus): Promise<RuntimeMutationResult> {
    const requestedTarget = requiredTarget(input.target, input.action);
    const resolution = resolveExactDeleteTarget(requestedTarget, status);
    if (resolution.kind !== "resolved") {
      const reason = resolution.kind;
      const receipt = createReceipt({
        action: "account.delete",
        dryRun: true,
        target: requestedTarget,
        summary: reason === "target_ambiguous"
          ? "Blocked credential delete: the target matches more than one connected account."
          : "Blocked credential delete: target must exactly match one connected account email or canonical profile id.",
        before: routeBefore(status),
        warnings: [reason, "no_live_mutation", "exact_match_required"]
      });
      const payload = { applied: false, dryRun: true, liveRuntimeMutation: false, receipt, reason };
      return { code: 2, payload };
    }
    const target = resolution.profile.id;
    // OpenClaw/Sentinel exposes no documented native exact-profile credential
    // transaction. Direct JSON/SQLite edits and private internals are unsafe,
    // so fail closed rather than risk a partial credential deletion.
    const receipt = createReceipt({
      action: "account.delete",
      dryRun: true,
      target: requestedTarget,
      summary: "Credential deletion is temporarily unavailable until Account Center's atomic transaction and recovery verification are implemented; no live mutation was attempted.",
      before: routeBefore(status),
      warnings: ["atomic_delete_transaction_not_implemented", "no_live_mutation", "exact_match_verified", "sessions_prompts_memory_bootstrap_untouched"]
    });
    const payload = {
      applied: false,
      dryRun: true,
      liveRuntimeMutation: false,
      receipt,
      reason: "atomic_delete_transaction_not_implemented",
      resolvedTarget: redactProfileArg(target)
    };
    return { code: 2, payload };
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
  private readonly runner: CommandRunner;

  constructor(config: GenericCommandAdapterConfig = {}) {
    const commandText = config.command ?? process.env.ACCOUNT_CENTER_GENERIC_COMMAND;
    if (!commandText) throw new Error("Generic command source requires ACCOUNT_CENTER_GENERIC_COMMAND or adapter command config.");
    const commandParts = splitArgs(commandText);
    this.command = commandParts[0] ?? commandText;
    this.args = config.args ?? [...commandParts.slice(1), ...splitArgs(process.env.ACCOUNT_CENTER_GENERIC_ARGS ?? "--json")];
    this.runner = config.runner ?? execFileRunner;
  }

  async readStatus(): Promise<AccountCenterStatus> {
    const result = await this.runner(this.command, this.args, { timeoutMs: 60_000, maxOutputBytes: MAX_GENERIC_COMMAND_STATUS_BYTES });
    if (result.outputLimitExceeded || Buffer.byteLength(result.stdout, "utf8") > MAX_GENERIC_COMMAND_STATUS_BYTES || Buffer.byteLength(result.stderr, "utf8") > MAX_GENERIC_COMMAND_STATUS_BYTES) {
      throw new Error("Generic command status output exceeds safe ingestion limit");
    }
    if (result.timeoutExceeded || result.code !== 0) throw new Error(GENERIC_COMMAND_FAILURE);
    try {
      return normalizeGenericCommandStatus(JSON.parse(result.stdout));
    } catch {
      throw new Error(GENERIC_COMMAND_FAILURE);
    }
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
    const receipt = createReceipt({
      action: input.action,
      dryRun: true,
      target: input.target,
      summary: "Generic command live apply is blocked: an arbitrary runtime command cannot provide Account Center's scoped review, idempotency, durable redacted receipt, and authoritative post-operation proof.",
      before: routeBefore(status),
      warnings: ["generic_apply_requires_protected_native_adapter", "no_live_mutation"]
    });
    const payload = { applied: false, dryRun: true, liveRuntimeMutation: false, receipt, reason: "generic_apply_requires_protected_native_adapter" };
    return { code: 2, payload };
  }
}

export function createRuntimeAdapter(source: unknown, options: { cwd?: string; runner?: CommandRunner } = {}): RuntimeAdapter {
  if (source === "openclaw") return new OpenClawRuntimeAdapter({ runner: options.runner });
  if (source === "generic-command") return new GenericCommandRuntimeAdapter({ runner: options.runner });
  if (source === "fixture") return new FixtureRuntimeAdapter(resolve(options.cwd ?? process.cwd(), "tests/fixtures/status.fixture.json"));
  throw new Error("Unsupported Account Center source.");
}

export function parseRuntimeSource(value: string | undefined): RuntimeSource {
  if (value === undefined || value === "fixture") return "fixture";
  if (value === "openclaw") return "openclaw";
  if (value === "generic-command") return "generic-command";
  throw new Error("Unsupported Account Center source.");
}

export function normalizeGenericCommandStatus(raw: unknown): AccountCenterStatus {
  if (isRecord(raw) && raw.schemaVersion === "account-center.status.v1") {
    if (!Array.isArray(raw.audit)) throw new Error("Generic command status audit must be an array");
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
    models: [...DEFAULT_OPENCLAW_OBSERVED_MODEL_IDS],
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
      updatedAt: generatedAt,
      ...(stringFrom(raw, ["scope"]) ? { scope: stringFrom(raw, ["scope"]) } : {})
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
  const publicStatus = redactJson(status) as AccountCenterStatus;
  privateConnectedEmails.set(publicStatus, new Map(accounts.map((account) => [account.id, account.email])));
  return publicStatus;
}

export async function execFileRunner(command: string, args: string[], options: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; maxOutputBytes?: number } = {}): Promise<CommandResult> {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        detached: process.platform !== "win32",
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch {
      resolvePromise({ code: 127, stdout: "", stderr: "command_start_failed" });
      return;
    }
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputLimitExceeded = false;
    let timeoutExceeded = false;
    let terminationRequested = false;
    let settled = false;
    let escalation: NodeJS.Timeout | undefined;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (terminationRequested) terminateCommandTree(child, "SIGKILL");
      if (escalation) clearTimeout(escalation);
      resolvePromise({ code, stdout, stderr, outputLimitExceeded, timeoutExceeded });
    };
    const terminate = () => {
      if (settled) return;
      terminationRequested = true;
      // Closing both pipes applies backpressure immediately, so an untrusted
      // command cannot keep this process buffering data while it exits.
      child.stdout?.destroy();
      child.stderr?.destroy();
      terminateCommandTree(child, "SIGTERM");
      escalation = setTimeout(() => terminateCommandTree(child, "SIGKILL"), PROCESS_TERMINATION_GRACE_MS);
    };
    const timeout = options.timeoutMs ? setTimeout(() => {
      timeoutExceeded = true;
      terminate();
    }, options.timeoutMs) : undefined;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (outputLimitExceeded) return;
      stdoutBytes += Buffer.byteLength(chunk, "utf8");
      if (options.maxOutputBytes !== undefined && stdoutBytes > options.maxOutputBytes) {
        outputLimitExceeded = true;
        stdout = "";
        stderr = "";
        terminate();
        return;
      }
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      if (outputLimitExceeded) return;
      stderrBytes += Buffer.byteLength(chunk, "utf8");
      if (options.maxOutputBytes !== undefined && stderrBytes > options.maxOutputBytes) {
        outputLimitExceeded = true;
        stdout = "";
        stderr = "";
        terminate();
        return;
      }
      stderr += chunk;
    });
    child.on("error", () => finish(127));
    child.on("close", (code) => {
      finish(code ?? 1);
    });
  });
}

function terminateCommandTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  // A detached POSIX child leads a process group, so termination also reaches
  // untrusted descendants that could otherwise survive a bounded read.
  try {
    if (process.platform !== "win32" && child.pid !== undefined) {
      process.kill(-child.pid, signal);
      return;
    }
    child.kill(signal);
  } catch {
    // The command may have exited between timeout/output handling and cleanup.
  }
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

function requiredTarget(target: string | undefined, action: AuditAction): string {
  if (!target) throw new Error(`${action} requires a target profile`);
  return target;
}

function normalizeProfileTarget(value: string): string {
  return value.trim().toLowerCase();
}

function profileEmail(profile: Profile): string | undefined {
  const email = profile.metadata?.email;
  // Normalized status may use a non-email display label as a fallback value.
  // It is never a credential identity unless it is an actual email address.
  if (typeof email === "string" && email.includes("@") && email.trim()) return email;
  const idEmail = profile.id.includes(":") ? profile.id.slice(profile.id.indexOf(":") + 1) : profile.id;
  return idEmail.includes("@") ? idEmail : undefined;
}

type DeleteTargetResolution =
  | { kind: "resolved"; profile: Profile }
  | { kind: "target_not_found" | "target_ambiguous" };

function resolveExactDeleteTarget(target: string, status: AccountCenterStatus): DeleteTargetResolution {
  const normalized = normalizeProfileTarget(target);
  const connectedEmails = privateConnectedEmails.get(status);
  const matches = status.profiles.filter((profile) => {
    // A destructive delete accepts only the immutable profile id or the
    // explicitly connected email. Labels and derived provider aliases are
    // intentionally excluded: they are presentation/routing hints, not a
    // canonical credential identity.
    const connectedEmail = connectedEmails?.get(profile.id) ?? profileEmail(profile);
    return normalizeProfileTarget(profile.id) === normalized
      || normalizeProfileTarget(connectedEmail ?? "") === normalized;
  });
  if (matches.length === 1) return { kind: "resolved", profile: matches[0]! };
  return { kind: matches.length === 0 ? "target_not_found" : "target_ambiguous" };
}

function routeBefore(status: AccountCenterStatus): unknown {
  return status.routes.map((route) => ({ provider: route.provider, runtime: route.runtime, activeProfileId: route.activeProfileId, order: route.order }));
}

/** Bounded, opaque proof retained by the immutable mutation operation only. */
function routeApplyProof(action: AuditAction, agent: string, target: string, before: AccountCenterStatus, after: AccountCenterStatus) {
  const scopeId = opaqueIdentifier(agent);
  return {
    nativeEvent: { action, scopeId, targetId: opaqueIdentifier(target), status: "verified" as const },
    verification: {
      scopeId,
      before: scopedRouteEvidence(before, agent),
      after: scopedRouteEvidence(after, agent)
    }
  };
}

function scopedRouteEvidence(status: AccountCenterStatus, agent: string) {
  const route = status.routes.find((item) => item.runtime === "openclaw" && item.provider === "openai" && routeScopeMatches(item, agent));
  return route
    ? { status: "observed" as const, activeTargetId: opaqueIdentifier(route.activeProfileId), orderTargetIds: route.order.slice(0, 10).map(opaqueIdentifier) }
    : { status: "absent" as const, orderTargetIds: [] as string[] };
}

function opaqueIdentifier(value: string): string { return `id_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`; }

function isExactAgentScope(value: string): boolean {
  return /^[a-z][a-z0-9_-]{0,63}$/.test(value) && value !== "all";
}

function parseNativeEvent(stdout: string): Record<string, unknown> | undefined {
  try { const parsed: unknown = JSON.parse(stdout); return isRecord(parsed) ? parsed : undefined; } catch { return undefined; }
}

function nativeSelectedProfile(event: Record<string, unknown> | undefined): string | undefined {
  const selected = event?.selected;
  return isRecord(selected) && typeof selected.profileId === "string" && selected.profileId.trim() ? selected.profileId : undefined;
}

function routeMutationVerified(status: AccountCenterStatus, action: AuditAction, target: string, agent: string): boolean {
  const route = status.routes.find((item) => item.runtime === "openclaw" && item.provider === "openai" && routeScopeMatches(item, agent));
  if (!route) return false;
  if (action === "route.remove") return !route.order.includes(target) && route.activeProfileId !== target;
  return route.activeProfileId === target && route.order[0] === target;
}

function canonicalRouteTarget(status: AccountCenterStatus, target: string, provider: string, runtime: string): string | undefined {
  if (!target || target.startsWith("-") || /\s/.test(target)) return undefined;
  const matches = status.profiles.filter((profile) =>
    profile.provider === provider &&
    profile.runtimeCompatibility.includes(runtime as RuntimeKey) &&
    profile.id === target
  );
  return matches.length === 1 ? matches[0]!.id : undefined;
}
function routeScopeMatches(route: AccountCenterStatus["routes"][number], agent: string): boolean { return route.scope === `agent:${agent}`; }
function nativeEventProof(event: Record<string, unknown> | undefined, action: AuditAction, target: string | undefined, agent: string): boolean {
  if (!event || event.action !== action || event.agent !== agent || !target) return false;
  const selected = nativeSelectedProfile(event);
  return action === "route.remove" ? event.target === target : selected === target;
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
  // An authoritative runtime order is not an account inventory. Appending
  // every connected account would make a route-only removal appear to remain
  // in the route, even when credentials correctly stay connected.
  return [...new Set(candidates ?? fallback)];
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
