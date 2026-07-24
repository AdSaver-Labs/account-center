#!/usr/bin/env node
import { chmod, lstat, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  AccountCenterStatus,
  AuditAction,
  AuditStore,
  AuthChallengeStore,
  CommandRunner,
  decodeConfirmationToken,
  createReceipt,
  createRuntimeAdapter,
  executeAccountCenterCommand,
  guardStatus,
  isValidGuidedAuthStart,
  MutationRepository,
  MutationScope,
  nextEligible,
  parseRuntimeSource,
  probeProviders,
  publicDoctorView,
  PublicStatusView,
  publicStatusView,
  redactJson
} from "@account-center/core";
import { randomBytes } from "node:crypto";
import { createAccountCenterServer } from "./server.js";
import { parseAuthCommand, renderAuthHelp } from "./auth-bridge.js";

interface CliResult {
  code: number;
  stdout: string;
  stderr?: string;
}

interface CliOptions {
  json: boolean;
  provider: string;
  runtime: string;
  scope: string;
  authMode?: string;
  model?: string;
  limit: number;
  statusPath: string;
  receiptRequested: boolean;
  writeExport: boolean;
  source: "fixture" | "openclaw" | "generic-command";
  apply: boolean;
  confirm?: string;
  idempotencyKey?: string;
  ensureRoute: boolean;
}

const DEFAULT_AUDIT_LIST_LIMIT = 20;
const MAX_AUDIT_LIST_LIMIT = 100;

export async function runCli(argv: string[], cwd = process.cwd(), deps: { runner?: CommandRunner; challengeStore?: AuthChallengeStore } = {}): Promise<CliResult> {
  let options: CliOptions;
  try {
    options = parseOptions(argv, cwd);
  } catch (error) {
    return { code: 1, stdout: "", stderr: `${error instanceof Error ? error.message : String(error)}\n` };
  }
  const positional = argv.filter((arg) => !arg.startsWith("--") && !isOptionValue(argv, arg));
  const [command, subcommand, target] = positional;

  if (!command || command === "help" || command === "--help") return ok(helpText());
  if (command === "auth") {
    try {
      const mapped = parseAuthCommand(argv.slice(1));
      if (mapped[0] === "help") return ok(renderAuthHelp());
      return runCli(mapped, cwd, deps);
    } catch (error) {
      return { code: 1, stdout: "", stderr: `${error instanceof Error ? error.message : String(error)}\n` };
    }
  }
  let adapter;
  try {
    adapter = createRuntimeAdapter(options.source, { cwd, runner: deps.runner });
  } catch (error) {
    if (options.source === "generic-command") return genericCommandFailure(options, command, subcommand);
    throw error;
  }
  if (command === "doctor") {
    const report = await adapter.doctor();
    const view = publicDoctorView(adapter.source, report);
    return ok(options.json ? json(view) : renderDoctorReport(view));
  }
  let statusExecution;
  try {
    statusExecution = await executeAccountCenterCommand({ command: "status" }, { adapter });
  } catch (error) {
    // Credential deletion is unavailable unless status can establish the
    // canonical connected target. Do not let a pre-lifecycle adapter failure
    // cross the public CLI boundary. Record only the fixed, target-free
    // failure evidence: an unavailable adapter must not bypass durable audit.
    if (command === "accounts" && subcommand === "delete") return credentialDeleteStatusFailure(options);
    if (options.source === "generic-command") return genericCommandFailure(options, command, subcommand);
    throw error;
  }
  const status = statusExecution.status!;
  if (command === "status") {
    const view = publicStatusView(status);
    await maybeWriteStatus(view, options);
    return ok(options.json ? json(view) : renderStatus(view));
  }
  if (command === "guard") {
    const guarded = guardStatus(status, options.provider, options.runtime, options.model);
    const receipt = createReceipt({ action: "guard.check", dryRun: true, summary: guarded.reason, target: guarded.next });
    const ensured = options.ensureRoute && guarded.ok
      ? (await adapter.mutate({ action: "route.auto", target: guarded.next, apply: options.apply, provider: options.provider, runtime: options.runtime })).payload
      : undefined;
    const payload = publicGuardView(status, guarded, receipt, ensured);
    return { code: guarded.ok ? 0 : 2, stdout: options.json ? json(payload) : renderGuard(payload) };
  }
  if (command === "accounts" && subcommand === "list") {
    const view = publicAccountsView(status);
    return ok(options.json ? json(view) : renderAccounts(view));
  }
  if (command === "providers" && subcommand === "probe") {
    let probes;
    try {
      probes = await probeProviders(status, options.provider);
    } catch {
      return providerProbeFailure(options);
    }
    const view = publicProviderProbesView(probes);
    return ok(options.json ? json(view) : renderProviderProbes(view));
  }
  if (command === "models" && subcommand === "list") {
    const view = publicModelsView(status);
    return ok(options.json ? json(view) : renderModels(view));
  }
  if (command === "routes" && subcommand === "next") {
    const selector = selectRouteNextSelector(argv, status);
    if (!selector) return routeSelectionFailure(options);
    const next = nextEligible(status, selector.provider, selector.runtime, options.model);
    const view = publicRouteNextView(status, next?.profile.id);
    return next ? ok(options.json ? json(view) : `Next eligible: ${view.next}\n`) : { code: 2, stdout: options.json ? json(view) : "Next eligible: none\n" };
  }
  if (command === "audit" && subcommand === "list") {
    const view = publicAuditView(status, options.limit);
    return ok(options.json ? json(view) : renderAudit(view));
  }
  if (command === "reauth" && subcommand === "start") return startReauth(target, status, options, deps.challengeStore);
  if (command === "routes" && ["auto", "use", "remove"].includes(subcommand ?? "")) {
    const action = routeAction(subcommand);
    const scope = parseAgentScope(options.scope);
    if (!scope) return { code: 2, stdout: options.json ? json(blockedRouteView(action)) : renderMutation(blockedRouteView(action)) };
    const review = options.confirm ? decodeConfirmationToken(options.confirm) : undefined;
    const lifecycle = await mutationLifecycle();
    const execution = await executeAccountCenterCommand({
      command: action,
      target: action === "route.auto" ? target ?? nextEligible(status, options.provider, options.runtime)?.profile.id : target,
      apply: options.apply,
      provider: options.provider,
      runtime: options.runtime,
      scope,
      ...(review ? { review, reviewToken: review.token } : {}),
      ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {})
    }, { adapter, mutation: lifecycle });
    const view = publicMutationView(execution.mutation);
    return { code: execution.code, stdout: options.json ? json(view) : renderMutation(view) };
  }
  if (command === "accounts" && ["disable", "enable", "delete"].includes(subcommand ?? "")) {
    if (subcommand === "delete" && options.apply) {
      const view = blockedCredentialDeleteView();
      return { code: 2, stdout: options.json ? json(view) : renderMutation(view) };
    }
    const mutation = await adapter.mutate({
      action: accountAction(subcommand),
      target,
      apply: options.apply,
      provider: options.provider,
      runtime: options.runtime
    });
    const view = publicMutationView(mutation.payload);
    return { code: mutation.code, stdout: options.json ? json(view) : renderMutation(view) };
  }
  if (command === "models" && ["disable", "enable"].includes(subcommand ?? "")) {
    const mutation = await adapter.mutate({
      action: modelAction(subcommand),
      target,
      apply: options.apply,
      provider: options.provider,
      runtime: options.runtime
    });
    const view = publicMutationView(mutation.payload);
    return { code: mutation.code, stdout: options.json ? json(view) : renderMutation(view) };
  }
  return { code: 1, stdout: "", stderr: `Unknown command. Run account-center help.\n` };
}

function parseOptions(argv: string[], cwd: string): CliOptions {
  return {
    json: argv.includes("--json"),
    provider: valueAfter(argv, "--provider") ?? "openai",
    runtime: valueAfter(argv, "--runtime") ?? "openclaw",
    scope: valueAfter(argv, "--scope") ?? "default",
    authMode: valueAfter(argv, "--mode"),
    model: valueAfter(argv, "--model"),
    limit: parseAuditListLimit(valueAfter(argv, "--limit")),
    statusPath: resolve(cwd, valueAfter(argv, "--status-path") ?? ".account-center/status-export.json"),
    receiptRequested: valueAfter(argv, "--receipt-path") !== undefined,
    writeExport: !argv.includes("--no-write-export"),
    source: parseSourceOption(argv),
    apply: argv.includes("--apply"),
    confirm: valueAfter(argv, "--confirm"),
    idempotencyKey: valueAfter(argv, "--idempotency-key"),
    ensureRoute: argv.includes("--ensure-route")
  };
}

function parseAuditListLimit(value: string | undefined): number {
  if (value === undefined) return DEFAULT_AUDIT_LIST_LIMIT;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) return DEFAULT_AUDIT_LIST_LIMIT;
  return Math.min(parsed, MAX_AUDIT_LIST_LIMIT);
}

function isOptionValue(argv: string[], arg: string): boolean {
  const index = argv.indexOf(arg);
  return index > 0 && argv[index - 1]?.startsWith("--") && !arg.startsWith("--");
}

function valueAfter(argv: string[], key: string): string | undefined {
  const index = argv.indexOf(key);
  return index >= 0 ? argv[index + 1] : undefined;
}

function parseSourceOption(argv: string[]): CliOptions["source"] {
  let source: CliOptions["source"] | undefined;
  let hasExplicitSource = false;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const value = option === "--source"
      ? argv[index + 1]
      : option?.startsWith("--source=")
        ? option.slice("--source=".length)
        : undefined;
    if (value === undefined && option !== "--source") continue;
    hasExplicitSource = true;
    if (value === undefined || value === "" || value.startsWith("--")) throw new Error("Unsupported Account Center source.");
    const parsedSource = parseRuntimeSource(value);
    if (source !== undefined) throw new Error("Unsupported Account Center source.");
    source = parsedSource;
  }
  return hasExplicitSource ? source! : parseRuntimeSource(process.env.ACCOUNT_CENTER_SOURCE);
}

function selectRouteNextSelector(argv: string[], status: AccountCenterStatus): { provider: string; runtime: string } | undefined {
  const provider = singleOptionValue(argv, "--provider", "openai");
  const runtime = singleOptionValue(argv, "--runtime", "openclaw");
  if (!provider || !runtime) return undefined;
  return status.routes.filter((route) => route.provider === provider && route.runtime === runtime).length === 1
    ? { provider, runtime }
    : undefined;
}

function singleOptionValue(argv: string[], option: "--provider" | "--runtime", fallback: string): string | undefined {
  let value: string | undefined;
  let count = 0;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === option) {
      count += 1;
      value = argv[index + 1];
    } else if (argument?.startsWith(`${option}=`)) {
      count += 1;
      value = argument.slice(option.length + 1);
    }
  }
  if (count === 0) return fallback;
  if (count !== 1 || !value || value.startsWith("--")) return undefined;
  return value;
}

async function maybeWriteStatus(status: unknown, options: CliOptions): Promise<void> {
  if (!options.writeExport) return;
  await mkdir(dirname(options.statusPath), { recursive: true });
  await writeFile(options.statusPath, `${json(status)}\n`, "utf8");
}

function routeAction(subcommand?: string): "route.auto" | "route.use" | "route.remove" {
  if (subcommand === "use") return "route.use";
  if (subcommand === "remove") return "route.remove";
  return "route.auto";
}

function accountAction(subcommand?: string): AuditAction {
  if (subcommand === "enable") return "account.enable";
  if (subcommand === "delete") return "account.delete";
  return "account.disable";
}

function modelAction(subcommand?: string): AuditAction {
  return subcommand === "enable" ? "model.enable" : "model.disable";
}

function listModels(status: AccountCenterStatus): Array<{ model: string; disabled: boolean; profiles: string[] }> {
  const models = new Map<string, Set<string>>();
  for (const profile of status.profiles) {
    for (const model of profile.models) {
      const profiles = models.get(model) ?? new Set<string>();
      profiles.add(profile.id);
      models.set(model, profiles);
    }
  }
  return [...models.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([model, profiles]) => ({
    model,
    disabled: status.policy.disabledModels.includes(model),
    profiles: [...profiles].sort()
  }));
}

type PublicGuardView = {
  schemaVersion: "account-center.public-guard.v1";
  verificationState: "UNPROVEN";
  ok: boolean;
  state: "OK" | "BLOCKED";
  next: string;
  receipt: { id: string; action: string; dryRun: boolean; target: "redacted-target" };
  ensured?: PublicMutationView;
};
type PublicMutationView = {
  schemaVersion: "account-center.public-mutation.v1";
  verificationState: "VERIFIED" | "UNPROVEN";
  applied: boolean;
  dryRun: boolean;
  liveRuntimeMutation: boolean;
  state: "APPLIED" | "DRY_RUN" | "BLOCKED" | "ATTEMPTED_UNPROVEN" | "REPLAYED" | "REPLAYED_ATTEMPTED_UNPROVEN";
  receipt: { id: string; action: string; dryRun: boolean; target: "redacted-target" };
  replayed?: true;
  historicalOutcome?: string;
  historicalLiveRuntimeMutation?: boolean;
  historicalVerification?: "VERIFIED" | "UNPROVEN";
  operationId?: string;
  confirmationToken?: string;
};

function publicAccountsView(status: AccountCenterStatus) {
  const publicStatus = publicStatusView(status);
  return {
    schemaVersion: "account-center.public-accounts.v1" as const,
    verificationState: "UNPROVEN" as const,
    accounts: publicStatus.profiles.map((profile) => ({
      id: profile.id,
      provider: profile.provider,
      role: profile.role,
      health: profile.usage.health,
      auth: profile.usage.auth.state,
      limits: profile.usage.windows.map((window) => ({ name: window.name, remainingPct: window.remainingPct }))
    }))
  };
}

function publicModelsView(status: AccountCenterStatus) {
  return {
    schemaVersion: "account-center.public-models.v1" as const,
    verificationState: "UNPROVEN" as const,
    models: listModels(status).map((item, index) => ({ id: `model-${index + 1}`, disabled: item.disabled, accountCount: item.profiles.length }))
  };
}

function publicProviderProbesView(probes: Array<{ ok: boolean; profiles: number; usableProfiles: number; lowestRemainingPct: number | null; highestRemainingPct: number | null }>) {
  return {
    schemaVersion: "account-center.public-provider-probes.v1" as const,
    verificationState: "UNPROVEN" as const,
    probes: probes.map((probe) => ({
      state: probe.ok ? "OK" as const : "BLOCKED" as const,
      profiles: boundedPublicCount(probe.profiles),
      usableProfiles: boundedPublicCount(probe.usableProfiles),
      limitsObserved: probe.lowestRemainingPct !== null || probe.highestRemainingPct !== null
    }))
  };
}

function boundedPublicCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 100) : 0;
}

function publicRouteNextView(status: AccountCenterStatus, target?: string) {
  return {
    schemaVersion: "account-center.public-route-next.v1" as const,
    verificationState: "UNPROVEN" as const,
    eligible: target !== undefined,
    next: publicAccountRef(status, target)
  };
}

function routeSelectionFailure(options: CliOptions): CliResult {
  const view = {
    schemaVersion: "account-center.public-route-next-error.v1",
    state: "UNPROVEN" as const
  };
  return { code: 2, stdout: options.json ? json(view) : "Route selection UNPROVEN.\n" };
}

function publicGuardView(status: AccountCenterStatus, guarded: { ok: boolean; next?: string }, receipt: unknown, ensured?: unknown): PublicGuardView {
  return {
    schemaVersion: "account-center.public-guard.v1",
    verificationState: "UNPROVEN",
    ok: guarded.ok,
    state: guarded.ok ? "OK" : "BLOCKED",
    next: publicAccountRef(status, guarded.next),
    receipt: publicReceipt(receipt),
    ...(ensured ? { ensured: publicMutationView(ensured) } : {})
  };
}

export function publicMutationView(payload: unknown): PublicMutationView {
  const report = isReport(payload) ? payload : {};
  const receipt = isReport(report.receipt) ? report.receipt : {};
  const credentialDelete = receipt.action === "account.delete";
  const applied = report.applied === true;
  const dryRun = report.dryRun === true || receipt.dryRun === true;
  const liveRuntimeMutation = report.liveRuntimeMutation === true;
  const verificationState = isReport(report.verification) && report.verification.kind === "verified" ? "VERIFIED" as const : "UNPROVEN" as const;
  const historicalLiveRuntimeMutation = report.historicalLiveRuntimeMutation === true;
  const historicalVerification = report.historicalVerification === "verified" ? "VERIFIED" as const : "UNPROVEN" as const;
  const attemptedUnproven = liveRuntimeMutation && (!applied || verificationState === "UNPROVEN");
  const replayedAttemptedUnproven = report.replayed === true && historicalLiveRuntimeMutation && historicalVerification === "UNPROVEN";
  return {
    schemaVersion: "account-center.public-mutation.v1",
    verificationState: credentialDelete ? "UNPROVEN" : verificationState,
    applied: credentialDelete ? false : applied,
    dryRun: credentialDelete ? true : dryRun,
    liveRuntimeMutation: credentialDelete ? false : liveRuntimeMutation,
    state: credentialDelete ? "BLOCKED" : report.replayed === true ? (replayedAttemptedUnproven ? "REPLAYED_ATTEMPTED_UNPROVEN" : "REPLAYED") : attemptedUnproven ? "ATTEMPTED_UNPROVEN" : typeof report.reason === "string" ? "BLOCKED" : applied && liveRuntimeMutation ? "APPLIED" : dryRun ? "DRY_RUN" : "BLOCKED",
    receipt: publicReceipt(receipt),
    ...(report.replayed === true ? { replayed: true as const, historicalOutcome: typeof report.historicalOutcome === "string" ? report.historicalOutcome : "unknown", historicalLiveRuntimeMutation, historicalVerification, ...(typeof report.operationId === "string" && /^op_[A-Za-z0-9_-]{1,100}$/.test(report.operationId) ? { operationId: report.operationId } : {}) } : {}),
    ...(typeof report.confirmationToken === "string" ? { confirmationToken: report.confirmationToken } : {})
  };
}

function parseAgentScope(value: string): MutationScope | undefined {
  const match = value.match(/^agent:([a-z][a-z0-9_-]{0,63})$/);
  return match && match[1] !== "all" ? { kind: "agent", id: match[1]! } : undefined;
}

function blockedRouteView(action: "route.auto" | "route.use" | "route.remove"): PublicMutationView {
  return { schemaVersion: "account-center.public-mutation.v1", verificationState: "UNPROVEN", applied: false, dryRun: true, liveRuntimeMutation: false, state: "BLOCKED", receipt: { id: "receipt-redacted", action, dryRun: true, target: "redacted-target" } };
}

export function blockedCredentialDeleteView(): PublicMutationView {
  return { schemaVersion: "account-center.public-mutation.v1", verificationState: "UNPROVEN", applied: false, dryRun: true, liveRuntimeMutation: false, state: "BLOCKED", receipt: { id: "receipt-redacted", action: "account.delete", dryRun: true, target: "redacted-target" } };
}

async function credentialDeleteStatusFailure(options: CliOptions): Promise<CliResult> {
  const view = blockedCredentialDeleteView();
  // Do not persist the requested target, adapter error, or runtime details.
  // This fixed allow-list record is safe even though status never established
  // a canonical connected target.
  const receipt = {
    outcome: "unproven",
    applied: false,
    dryRun: true,
    liveRuntimeMutation: false,
    receipt: { id: "receipt-redacted", action: "account.delete", dryRun: true, warnings: ["status_adapter_unavailable", "no_live_mutation"] }
  };
  // A caller-selected receipt pathname is never inspected or written. If one
  // was supplied, leave persistence absent; otherwise only this CLI boundary
  // may ask the descriptor-safe helper for an opaque durable record.
  if (!options.receiptRequested) persistBlockedDeleteReceipt();
  return { code: 2, stdout: options.json ? json(view) : renderMutation(view) };
}

function persistBlockedDeleteReceipt(): void {
  const root = resolve(process.env.ACCOUNT_CENTER_DATA_DIR ?? join(homedir(), ".account-center"));
  const helper = resolve(new URL("../../../scripts/persist_blocked_delete_receipt.py", import.meta.url).pathname);
  try { spawnSync("python3", [helper, root], { stdio: "ignore", timeout: 5_000 }); } catch { /* fail closed: output remains opaque */ }
}

async function mutationLifecycle(): Promise<{ secret: string; repository: MutationRepository }> {
  const root = resolve(process.env.ACCOUNT_CENTER_DATA_DIR ?? join(homedir(), ".account-center"));
  const secretPath = join(root, "mutation-review.secret");
  let secret: string;
  try { secret = (await readFile(secretPath, "utf8")).trim(); } catch {
    secret = randomBytes(32).toString("base64url");
    await mkdir(root, { recursive: true, mode: 0o700 }); await writeFile(secretPath, `${secret}\n`, { mode: 0o600 }); await chmod(secretPath, 0o600);
  }
  if (secret.length < 32) throw new Error("mutation review secret unavailable");
  return { secret, repository: new MutationRepository(join(root, "mutation-operations")) };
}

function publicReceipt(value: unknown): PublicMutationView["receipt"] {
  const receipt = isReport(value) ? value : {};
  return {
    id: typeof receipt.id === "string" ? receipt.id : "receipt-redacted",
    action: typeof receipt.action === "string" ? receipt.action : "unknown",
    dryRun: receipt.dryRun === true,
    target: "redacted-target"
  };
}

function publicAccountRef(status: AccountCenterStatus, target?: string): string {
  if (!target) return "none";
  const index = status.profiles.findIndex((profile) => profile.id === target || profile.label === target || profile.usage.profileId === target);
  return index >= 0 ? `account-${index + 1}` : "account-redacted";
}

function renderStatus(status: PublicStatusView): string {
  return [
    "Account Center: status observed",
    `Source: ${status.source}`,
    `Accounts observed: ${status.profiles.length}`,
    `Routes observed: ${status.routes.length}`,
    "Verification: UNPROVEN"
  ].join("\n") + "\n";
}

function statusFailure(options: CliOptions): CliResult {
  const view = {
    schemaVersion: "account-center.public-status-error.v1",
    source: options.source,
    state: "UNPROVEN" as const
  };
  return { code: 2, stdout: options.json ? json(view) : "Account Center: status UNPROVEN\nSource: " + view.source + "\n" };
}

function auditFailure(options: CliOptions): CliResult {
  const view = {
    schemaVersion: "account-center.public-audit.v1",
    verificationState: "UNPROVEN" as const,
    events: []
  };
  return { code: 2, stdout: options.json ? json(view) : "Audit: UNPROVEN\n" };
}

function providerProbeFailure(options: CliOptions): CliResult {
  const view = {
    schemaVersion: "account-center.public-provider-probes.v1",
    verificationState: "UNPROVEN" as const,
    probes: []
  };
  return { code: 2, stdout: options.json ? json(view) : "Provider probe UNPROVEN\n" };
}

function genericCommandFailure(options: CliOptions, command?: string, subcommand?: string): CliResult {
  if (command === "status") return statusFailure(options);
  if (command === "audit" && subcommand === "list") return auditFailure(options);
  const action = command === "routes"
    ? subcommand === "use" ? "route.use" : subcommand === "remove" ? "route.remove" : "route.auto"
    : command === "accounts"
      ? subcommand === "delete" ? "account.delete" : subcommand === "enable" ? "account.enable" : "account.disable"
      : command === "models"
        ? subcommand === "enable" ? "model.enable" : "model.disable"
        : undefined;
  if (action) {
    const view: PublicMutationView = {
      schemaVersion: "account-center.public-mutation.v1",
      verificationState: "UNPROVEN",
      applied: false,
      dryRun: true,
      liveRuntimeMutation: false,
      state: "BLOCKED",
      receipt: { id: "receipt-redacted", action, dryRun: true, target: "redacted-target" }
    };
    return { code: 2, stdout: options.json ? json(view) : renderMutation(view) };
  }
  const view = {
    schemaVersion: "account-center.public-command-error.v1",
    source: "generic-command" as const,
    state: "UNPROVEN" as const
  };
  return { code: 2, stdout: options.json ? json(view) : "Account Center: command UNPROVEN\nSource: generic-command\n" };
}

function renderCodexLimits(status: AccountCenterStatus, options: CliOptions): string {
  const route = status.routes.find((item) => item.provider === options.provider && item.runtime === options.runtime) ?? status.routes[0];
  const active = status.profiles.find((profile) => profile.id === route?.activeProfileId) ?? status.profiles[0];
  const nonAdsaverCount = nonAdsaverWeeklyUsableCount(status);
  const lines: string[] = [];
  lines.push("Codex account limits");
  lines.push(`Snapshot: ${statusGeneratedAtEEST(status)} EEST`);
  lines.push(`Current active account: ${profileEmail(active)}${active?.id ? ` (${active.id})` : ""}`);
  lines.push("");
  lines.push(`Non-AdSaver weekly-usable accounts: ${nonAdsaverCount ?? "unknown"}`);
  if (nonAdsaverCount === 1) lines.push("⚠️ WARNING: only 1 non-AdSaver weekly-usable account remains. Keep AdSaver as backup.");
  lines.push("");
  lines.push(nextResetSummary(status));
  lines.push("");
  lines.push("No-token commands you can use here:");
  lines.push("• /auth — show this status, current account, limits, next reset, and commands");
  lines.push("• /auth list or /auth status — compact route list with active marker");
  lines.push("• /auth <email> — switch active Codex route to that connected account");
  lines.push("• /auth auto — run safe auto-switch to best readable non-AdSaver account");
  lines.push("• /auth add <email> — record a local guided-auth initiation for a new account; it does not start device-code/OAuth login, store credentials, or activate routing");
  lines.push("• /auth reauth <email> — record a local guided-auth initiation for an existing account; it does not reauthenticate or change credentials or routing");
  lines.push("• /auth remove <email> — remove from routing without deleting credentials");
  lines.push("• /auth delete <email> — BLOCKED/UNPROVEN: live credential deletion is unavailable until a documented native transactional delete adapter exists");
  lines.push("• /auth delete <email> --dry-run — preview only; no deletion (live delete remains blocked/UNPROVEN)");
  lines.push("• Fallback CLI only if Telegram commands are unavailable: node 3-Resources/codex-account-ops/scripts/codex-device-auth-telegram.mjs start --email <email>");
  lines.push("");
  for (const profile of orderCodexProfiles(status.profiles)) {
    lines.push("────────────────────────");
    lines.push(`${profileEmail(profile)} — ${String(meta(profile, "plan") ?? "unknown").toUpperCase()}`);
    lines.push(`Status: ${availability(profile)}`);
    lines.push(`Routing: ${routingLabel(profile)}`);
    const expires = meta(profile, "tokenExpiresAtEEST") ?? formatEest(profile.usage.auth.tokenExpiresAt) ?? profile.usage.auth.tokenExpiresAt;
    if (expires) lines.push(`OAuth expires: ${expires}`);
    lines.push(windowLine(profile, "five-hour", "5h"));
    lines.push(windowLine(profile, "weekly", "Week"));
    lines.push("");
  }
  lines.push("Notes: OpenAI may report 5-hour and/or weekly windows; if the 5h window is not present, routing uses readable weekly capacity instead. This command reads provider usage endpoints/status JSON only — no LLM/model tokens.");
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

function statusGeneratedAtEEST(status: AccountCenterStatus): string {
  const first = status.profiles.find((profile) => meta(profile, "generatedAtEEST"));
  if (first) return String(meta(first, "generatedAtEEST"));
  return formatEest(status.generatedAt) ?? (status.generatedAt || "unknown");
}

function nonAdsaverWeeklyUsableCount(status: AccountCenterStatus): number | null {
  const fromMeta = status.profiles.map((profile) => meta(profile, "nonAdsaverWeeklyUsableCount")).find((value) => value !== null && value !== undefined);
  if (typeof fromMeta === "number") return fromMeta;
  const count = status.profiles.filter((profile) => !isAdsaver(profile) && profile.usage.health === "ok" && profile.usage.auth.state === "ok" && remaining(profile, "weekly") !== null && Number(remaining(profile, "weekly")) > 0).length;
  return Number.isFinite(count) ? count : null;
}

function nextResetSummary(status: AccountCenterStatus): string {
  const usable = status.profiles.filter((profile) => profile.usage.health === "ok" && profile.usage.auth.state === "ok" && (remaining(profile, "five-hour") ?? 1) > 0 && (remaining(profile, "weekly") ?? 1) > 0);
  if (usable.length > 0) return `Next available account: now — ${usable.map(profileEmail).join(", ")}`;
  return "No account currently has readable provider capacity.";
}

function orderCodexProfiles(profiles: AccountCenterStatus["profiles"]): AccountCenterStatus["profiles"] {
  return [...profiles].sort((a, b) => {
    const ar = meta(a, "routingEnabled") === false ? 1 : 0;
    const br = meta(b, "routingEnabled") === false ? 1 : 0;
    if (ar !== br) return ar - br;
    if (isAdsaver(a) && !isAdsaver(b)) return 1;
    if (isAdsaver(b) && !isAdsaver(a)) return -1;
    return profileEmail(a).localeCompare(profileEmail(b));
  });
}

function availability(profile: AccountCenterStatus["profiles"][number]): string {
  if (profile.usage.health !== "ok" || profile.usage.auth.state !== "ok") return `Needs reauthentication/check — couldn't read usage: ${profile.usage.warnings.join(", ") || profile.usage.health}`;
  if (meta(profile, "routingEnabled") !== false) return "Available/readable — routing enabled";
  if (isAdsaver(profile)) return "Available/readable — BACKUP ONLY / monitor-only";
  return "Available/readable — monitor-only";
}

function routingLabel(profile: AccountCenterStatus["profiles"][number]): string {
  const label = meta(profile, "routingRecommendation");
  if (typeof label === "string" && label) return label;
  if (isAdsaver(profile)) return "backup-of-backups; do not use unless all non-AdSaver accounts are blocked or Alej approves";
  return meta(profile, "routingEnabled") !== false ? "normal-routing" : "monitor-only";
}

function windowLine(profile: AccountCenterStatus["profiles"][number], name: string, fallbackLabel: string): string {
  const w = profile.usage.windows.find((window) => window.name === name || window.displayLabel === fallbackLabel);
  if (!w || w.remainingPct === null || w.remainingPct === undefined) return `• ${fallbackLabel}: unknown`;
  const used = typeof w.usedPct === "number" ? pct(w.usedPct) : pct(100 - Number(w.remainingPct));
  const line = `• ${w.displayLabel ?? fallbackLabel}: ${used} used / ${pct(w.remainingPct)} left`;
  return w.resetsAt ? `${line}\n  refresh: ${w.resetsAt}` : line;
}

function remaining(profile: AccountCenterStatus["profiles"][number], name: string): number | null {
  return profile.usage.windows.find((window) => window.name === name)?.remainingPct ?? null;
}

function pct(value: number): string {
  return `${Number(value).toFixed(0)}%`;
}

function formatEest(value?: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Sofia",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${Number(pick("day"))} ${pick("month")} ${pick("year")}, ${pick("hour")}:${pick("minute")}`;
}

function profileEmail(profile?: AccountCenterStatus["profiles"][number]): string {
  if (!profile) return "unknown";
  return String(meta(profile, "email") ?? profile.label ?? profile.id.replace(/^[^:]+:/, ""));
}

function isAdsaver(profile: AccountCenterStatus["profiles"][number]): boolean {
  return /adsaver/i.test(profileEmail(profile)) || profile.role === "backup";
}

function meta(profile: AccountCenterStatus["profiles"][number], key: string): unknown {
  return profile.metadata?.[key];
}

function renderGuard(payload: PublicGuardView): string {
  return `Guard: ${payload.state}\nNext: ${payload.next}\nVerification: ${payload.verificationState}\n`;
}

export function renderMutation(payload: PublicMutationView): string {
  if (payload.receipt.action === "account.delete") return renderBlockedCredentialDelete(payload);
  const { action, target } = payload.receipt;
  const { applied, dryRun, liveRuntimeMutation } = payload;
  const lines: string[] = [];

  if (payload.state === "ATTEMPTED_UNPROVEN") {
    lines.push("ATTEMPTED BUT UNPROVEN — a native runtime action may have been attempted; no store-change claim is made.");
    lines.push(`Action: ${action}`);
    lines.push(`Target: ${target}`);
    lines.push(`Result: ${payload.state}`);
    lines.push(`Verification: ${payload.verificationState}`);
    return `${lines.join("\n")}\n`;
  }

  if (payload.state === "REPLAYED_ATTEMPTED_UNPROVEN") {
    lines.push("REPLAYED HISTORICAL ATTEMPT BUT UNPROVEN — no current runtime action was attempted.");
    lines.push(`Action: ${action}`);
    lines.push(`Target: ${target}`);
    lines.push(`Result: ${payload.state}`);
    lines.push("Historical verification: UNPROVEN");
    return `${lines.join("\n")}\n`;
  }

  if (dryRun || !applied || !liveRuntimeMutation) {
    lines.push("DRY RUN — no account was deleted and no live Sentinel/OpenClaw store was changed.");
    lines.push(`Action: ${action}`);
    lines.push(`Target: ${target}`);
    lines.push(`Result: ${payload.state}`);
    lines.push(`Verification: ${payload.verificationState}`);
    if (action === "account.delete") {
      lines.push("");
      lines.push("Credential deletion is currently BLOCKED/UNPROVEN; no documented native transactional delete adapter is available.");
      lines.push("Exact connected-target confirmation remains required before credential deletion.");
    } else if (action === "route.remove") {
      lines.push("");
      lines.push("This is routing removal only. It does not delete credentials.");
      lines.push("Credential deletion is currently BLOCKED/UNPROVEN; no documented native transactional delete adapter is available.");
    }
    return `${lines.join("\n")}\n`;
  }

  if (action === "account.delete") {
    lines.push("BLOCKED/UNPROVEN — credential deletion is unavailable because no documented native transactional delete adapter is available.");
    lines.push("No Sentinel/OpenClaw credential store was changed.");
    lines.push(`Action: ${action}`);
    lines.push(`Target: ${target}`);
    lines.push("Result: BLOCKED");
    lines.push("Verification: UNPROVEN");
    return `${lines.join("\n")}\n`;
  }
  lines.push("APPLIED — live Sentinel/OpenClaw runtime store was changed.");
  lines.push(`Action: ${action}`);
  lines.push(`Target: ${target}`);
  lines.push(`Result: ${payload.state}`);
  return `${lines.join("\n")}\n`;
}

/** The sole public renderer for fail-closed native credential deletion. */
export function renderBlockedCredentialDelete(payload: PublicMutationView = blockedCredentialDeleteView()): string {
  return [
    "DRY RUN — no account was deleted and no live Sentinel/OpenClaw store was changed.",
    "Action: account.delete",
    `Target: ${payload.receipt.target}`,
    "Result: BLOCKED",
    "Verification: UNPROVEN",
    "",
    "Credential deletion is currently BLOCKED/UNPROVEN; no documented native transactional delete adapter is available.",
    "Exact connected-target confirmation remains required before credential deletion."
  ].join("\n") + "\n";
}

function renderAccounts(view: ReturnType<typeof publicAccountsView>): string {
  return view.accounts.map((account) => {
    const five = account.limits.find((window) => window.name === "five-hour")?.remainingPct ?? "unknown";
    const weekly = account.limits.find((window) => window.name === "weekly")?.remainingPct ?? "unknown";
    return `${account.id} role=${account.role} health=${account.health} auth=${account.auth} 5h=${five}% weekly=${weekly}%`;
  }).join("\n") + "\n";
}

function renderDoctorReport(report: ReturnType<typeof publicDoctorView>): string {
  return `Doctor: ${report.state}\nSource: ${report.source}\n`;
}

function renderModels(view: ReturnType<typeof publicModelsView>): string {
  return view.models.map((item) => `${item.id} disabled=${item.disabled} accounts=${item.accountCount}`).join("\n") + "\n";
}

function publicAuditView(status: AccountCenterStatus, limit: number) {
  return {
    schemaVersion: "account-center.public-audit.v1" as const,
    verificationState: "UNPROVEN" as const,
    events: status.audit.slice(0, limit).map((event) => ({ dryRun: event.dryRun === true, state: "UNPROVEN" as const }))
  };
}

function renderAudit(view: ReturnType<typeof publicAuditView>): string {
  return view.events.map((event) => `Audit event dryRun=${event.dryRun} ${event.state}`).join("\n") + "\n";
}

async function startReauth(target: string | undefined, status: AccountCenterStatus, options: CliOptions, store?: AuthChallengeStore): Promise<CliResult> {
  if (!target) return { code: 1, stdout: "", stderr: "Usage: /auth add <email> or /auth reauth <email>\n" };
  const mode = options.authMode;
  const input = { mode: mode === "add" ? "add" as const : mode === "reauth" || mode === undefined ? "reauth" as const : undefined, provider: options.provider, runtime: options.runtime, scope: options.scope, target };
  if (!input.mode || !isValidGuidedAuthStart(status, input)) return { code: 1, stdout: "", stderr: "Invalid guided-auth runtime, scope, provider, mode, or target.\n" };
  const durable = await (store ?? new AuthChallengeStore(join(resolve(process.env.ACCOUNT_CENTER_DATA_DIR ?? join(homedir(), ".account-center")), "auth-challenges.v1.json"))).createWithResult(input);
  const payload = {
    schemaVersion: "account-center.public-auth-challenge-start.v1",
    verificationState: "UNPROVEN" as const,
    idempotent: !durable.created,
    challenge: publicAuthChallenge(durable.challenge),
    noLlmTokens: true,
    note: "Local guided-auth challenge recorded. This build does not mutate runtime auth, credentials, OAuth, or device-code state."
  };
  if (options.json) return ok(json(payload));
  return ok([
    `Local ${payload.challenge.mode} guided-auth challenge: ${payload.challenge.id}`,
    `No LLM/model tokens are used by this command.`,
    payload.note
  ].join("\n") + "\n");
}

function publicAuthChallenge(challenge: Awaited<ReturnType<AuthChallengeStore["create"]>>) {
  const { id, mode, provider, runtime, scope, status, expiresAt, createdAt, updatedAt } = challenge;
  return { id, mode, provider, runtime, scope, status, ...(expiresAt ? { expiresAt } : {}), createdAt, updatedAt };
}

function renderProviderProbes(view: ReturnType<typeof publicProviderProbesView>): string {
  return view.probes.map((probe) => `Provider probe ${probe.state} usable=${probe.usableProfiles}/${probe.profiles} limits=${probe.limitsObserved ? "observed" : "unknown"}`).join("\n") + "\n";
}

function helpText(): string {
  return `account-center commands
  status [--json]
  status --source fixture|openclaw|generic-command [--json]
  guard [--provider openai] [--runtime openclaw] [--model provider/model] [--ensure-route] [--apply]
  accounts list
  providers probe [--provider openai|all] [--json]
  accounts disable <profile> [--apply] -- dry-run unless apply is supported and explicit
  accounts enable <profile> [--apply] -- dry-run unless apply is supported and explicit
  accounts delete <email-or-profile> [--dry-run] -- BLOCKED/UNPROVEN; no documented native transactional delete adapter is available
  routes next
  routes auto --scope agent:<id> -- preview returns a confirmation token
  routes use <canonical-profile-id> --scope agent:<id> -- preview returns a confirmation token
  routes remove <canonical-profile-id> --scope agent:<id> -- preview returns a confirmation token
  routes <auto|use|remove> ... --scope agent:<id> --apply --confirm <confirmation-token> --idempotency-key <key> -- apply exactly the previewed route
  models disable <provider/model> [--apply] -- dry-run unless apply is supported and explicit
  models enable <provider/model> [--apply] -- dry-run unless apply is supported and explicit
  models list
  doctor
  audit list [--limit 20]
  serve [--port 4317] --token-file <owner-only-file> [--source fixture|openclaw|generic-command] -- launch the local control panel
  auth "/auth ..." -- parse and execute manual /auth chat commands

Manual chat compatibility command is /auth. /account is the product namespace.

Runtime source defaults to fixture. Live reads require --source openclaw, --source generic-command, or ACCOUNT_CENTER_SOURCE.
OpenClaw config: ACCOUNT_CENTER_OPENCLAW_WORKSPACE and ACCOUNT_CENTER_OPENCLAW_CLI.
`;
}

function isReport(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ok(stdout: string): CliResult {
  return { code: 0, stdout };
}

function json(value: unknown): string {
  // The confirmation token is intentionally public, one-time CLI output. Keep
  // it byte-for-byte usable while applying normal recursive redaction to every
  // other response field.
  const confirmationToken = isReport(value) && value.schemaVersion === "account-center.public-mutation.v1" && typeof value.confirmationToken === "string" ? value.confirmationToken : undefined;
  const redacted = redactJson(value);
  if (confirmationToken && isReport(redacted)) redacted.confirmationToken = confirmationToken;
  return JSON.stringify(redacted, null, 2);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv[2] === "serve") {
    await serveControlPanel(process.argv.slice(3));
  } else {
    const result = await runCli(process.argv.slice(2));
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exitCode = result.code;
  }
}

export function createPersistentControlPanel(options: { token: string; source: CliOptions["source"]; stateRoot?: string }) {
  const stateRoot = resolve(options.stateRoot ?? process.env.ACCOUNT_CENTER_DATA_DIR ?? join(homedir(), ".account-center"));
  return createAccountCenterServer({
    token: options.token,
    source: options.source,
    auditStore: new AuditStore(join(stateRoot, "audit.v1.json")),
    challengeStore: new AuthChallengeStore(join(stateRoot, "auth-challenges.v1.json")),
    mutationRepository: new MutationRepository(join(stateRoot, "mutation-operations"))
  });
}

async function serveControlPanel(argv: string[]): Promise<void> {
  let source: CliOptions["source"];
  try {
    source = parseSourceOption(argv);
  } catch {
    process.stderr.write("Unsupported Account Center source.\n");
    process.exitCode = 1;
    return;
  }
  const portValue = valueAfter(argv, "--port") ?? "4317";
  const port = Number(portValue);
  // Port zero asks the kernel for an ephemeral loopback port. This makes the
  // local, token-protected beta smoke safe to run without competing for 4317.
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid --port: ${portValue}`);
  let token: string;
  try {
    token = await readLaunchTokenFile(argv);
  } catch {
    // Do not render a filesystem error: it can contain a secret pathname or
    // token-shaped file content. The fixed message fails closed instead.
    process.stderr.write("Launch token file unavailable.\n");
    process.exitCode = 1;
    return;
  }
  const app = createPersistentControlPanel({ token, source });
  const address = await app.listen(port);
  process.stdout.write(`Account Center local panel: http://127.0.0.1:${address.port}/\nLaunch token: supplied separately.\nPress Ctrl+C to stop.\n`);
  await new Promise<void>((resolve) => process.once("SIGINT", resolve));
  await app.close();
}

async function readLaunchTokenFile(argv: string[]): Promise<string> {
  let path: string | undefined;
  let count = 0;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--token" || argument?.startsWith("--token=")) throw new Error("legacy token input");
    if (argument?.startsWith("--token-file=")) throw new Error("equals token file input");
    if (argument !== "--token-file") continue;
    count += 1;
    const candidate = argv[index + 1];
    if (!candidate || candidate.startsWith("--")) throw new Error("invalid token file input");
    path = candidate;
  }
  if (count !== 1 || !path) throw new Error("missing token file input");

  // lstat gives an explicit symlink rejection, while O_NOFOLLOW protects the
  // final path component from changing before open. Validation is repeated on
  // the opened descriptor so a race cannot weaken the file contract.
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || !entry.isFile()) throw new Error("unsafe token file");
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    const uid = process.getuid?.();
    if (uid === undefined || !metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.uid !== uid) throw new Error("unsafe token file");
    const content = await handle.readFile({ encoding: "utf8" });
    const match = /^([^\s]+)\r?\n?$/.exec(content);
    if (!match) throw new Error("invalid token file content");
    return match[1]!;
  } finally {
    await handle.close();
  }
}
