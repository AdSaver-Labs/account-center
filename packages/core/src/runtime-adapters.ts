import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { AccountCenterStatus, AuditAction, Profile, assertAccountCenterStatus, isRecord, nowIso } from "./schemas.js";
import { createReceipt, nextEligible } from "./policy.js";
import { loadFixtureStatus } from "./fixtures.js";
import { redactJson } from "./redaction.js";

export type RuntimeSource = "fixture" | "openclaw";

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
  receiptDir?: string;
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
  private readonly receiptDir: string;
  private readonly runner: CommandRunner;

  constructor(config: OpenClawAdapterConfig = {}) {
    this.workspace = resolve(config.workspace ?? process.env.ACCOUNT_CENTER_OPENCLAW_WORKSPACE ?? join(homedir(), ".openclaw", "workspace"));
    this.cli = resolve(config.cli ?? process.env.ACCOUNT_CENTER_OPENCLAW_CLI ?? join(this.workspace, "ops", "scripts", "oauth_routing_cli.py"));
    this.receiptDir = resolve(config.receiptDir ?? process.env.ACCOUNT_CENTER_RECEIPT_DIR ?? ".account-center/receipts");
    this.runner = config.runner ?? execFileRunner;
  }

  async readStatus(): Promise<AccountCenterStatus> {
    const cliStatus = await this.tryReadCliStatus();
    if (cliStatus) return normalizeOpenClawStatus(cliStatus, "oauth_routing_cli status --json");

    const sentinelStatus = await this.tryReadJson(join(this.workspace, "3-Resources", "codex-account-ops", "CODEX-ACCOUNT-STATUS.json"));
    if (sentinelStatus) return normalizeOpenClawStatus(sentinelStatus, "CODEX-ACCOUNT-STATUS.json");

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
    const result = await this.runner(process.execPath, args, { cwd: this.workspace, timeoutMs: 60_000 });
    const receipt = createReceipt({
      action: input.action,
      dryRun: false,
      target,
      summary: result.code === 0 ? `Applied through existing OpenClaw account-routing script: ${input.action}` : `OpenClaw account-routing script failed: ${input.action}`,
      before: routeBefore(status),
      after: { command: "codex-auth-switch.mjs", args: args.slice(1).map((item) => item.includes("@") ? redactProfileArg(item) : item), exitCode: result.code },
      warnings: ["openclaw_account_routing_only", "sessions_prompts_memory_bootstrap_untouched"]
    });
    await writeReceipt(input.receiptPath, { applied: result.code === 0, dryRun: false, liveRuntimeMutation: result.code === 0, receipt, command: "codex-auth-switch.mjs", stderr: result.stderr.slice(0, 2000), stdout: result.stdout.slice(0, 2000) });
    return { code: result.code, payload: { applied: result.code === 0, dryRun: false, liveRuntimeMutation: result.code === 0, receiptPath: input.receiptPath, receipt } };
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

export function createRuntimeAdapter(source: RuntimeSource, options: { cwd?: string; runner?: CommandRunner } = {}): RuntimeAdapter {
  if (source === "openclaw") return new OpenClawRuntimeAdapter({ runner: options.runner });
  return new FixtureRuntimeAdapter(resolve(options.cwd ?? process.cwd(), "tests/fixtures/status.fixture.json"));
}

export function parseRuntimeSource(value: string | undefined): RuntimeSource {
  if (!value || value === "fixture") return "fixture";
  if (value === "openclaw") return "openclaw";
  throw new Error(`Unsupported source: ${value}. Expected fixture or openclaw.`);
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
        { name: "five-hour", remainingPct: account.fiveHourRemaining, resetsAt: account.fiveHourResetAt },
        { name: "weekly", remainingPct: account.weekRemaining, resetsAt: account.weekResetAt }
      ],
      auth: { state: account.authState, tokenExpiresAt: account.tokenExpiresAt },
      warnings: account.warnings
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

async function writeReceipt(path: string, payload: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(redactJson(payload), null, 2)}\n`, "utf8");
}

function requiredTarget(target: string | undefined, action: AuditAction): string {
  if (!target) throw new Error(`${action} requires a target profile`);
  return target;
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
  observedAt?: string;
  tokenExpiresAt?: string;
  cooldownUntil?: string;
  warnings: string[];
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
      fiveHourResetAt: stringFrom(fiveWindow, ["resetAt", "resetsAt"]),
      weekResetAt: stringFrom(weekWindow, ["resetAt", "resetsAt"]),
      observedAt: stringFrom(usage, ["observedAt"]) ?? stringFrom(health, ["observedAt"]),
      tokenExpiresAt: millisToIso(account.tokenExpiresAt ?? health.expiresAt),
      cooldownUntil: stringFrom(account.throttleHealth, ["cooldownUntil"]),
      warnings: [
        !readable ? "status_unreadable" : undefined,
        expired ? "auth_expired" : undefined,
        quarantine.active ? `quarantined:${String(quarantine.reason ?? "unknown")}` : undefined
      ].filter((item): item is string => Boolean(item))
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
    ?? stringFrom(raw, ["route", "lastGood"])
    ?? stringFrom(raw, ["route", "primary"])
    ?? order[0];
}

function roleFor(id: string, active: string, index: number): Profile["role"] {
  if (/adsaver|backup/i.test(id)) return "backup";
  if (id === active || index === 0) return "primary";
  return "secondary";
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

function numberOrNull(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function millisToIso(value: unknown): string | undefined {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return undefined;
  return new Date(number).toISOString();
}
