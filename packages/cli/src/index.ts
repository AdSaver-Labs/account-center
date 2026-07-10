#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  AccountCenterStatus,
  AuditAction,
  CommandRunner,
  createReceipt,
  createRuntimeAdapter,
  guardStatus,
  nextEligible,
  parseRuntimeSource,
  probeProviders,
  redactJson
} from "@account-center/core";
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
  model?: string;
  limit: number;
  statusPath: string;
  receiptPath: string;
  writeExport: boolean;
  source: "fixture" | "openclaw" | "generic-command";
  apply: boolean;
  ensureRoute: boolean;
}

export async function runCli(argv: string[], cwd = process.cwd(), deps: { runner?: CommandRunner } = {}): Promise<CliResult> {
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
  const adapter = createRuntimeAdapter(options.source, { cwd, runner: deps.runner });
  if (command === "doctor") {
    const report = await adapter.doctor();
    return ok(options.json ? json(report) : renderDoctorReport(report));
  }
  const status = await adapter.readStatus();
  if (command === "status") {
    await maybeWriteStatus(status, options);
    return ok(options.json ? json(status) : renderStatus(status, options));
  }
  if (command === "guard") {
    const guarded = guardStatus(status, options.provider, options.runtime, options.model);
    const receipt = createReceipt({ action: "guard.check", dryRun: true, summary: guarded.reason, target: guarded.next });
    const ensured = options.ensureRoute && guarded.ok
      ? (await adapter.mutate({ action: "route.auto", target: guarded.next, apply: options.apply, provider: options.provider, runtime: options.runtime, receiptPath: options.receiptPath })).payload
      : undefined;
    const payload = { ...guarded, receipt, ...(ensured ? { ensured } : {}) };
    return { code: guarded.ok ? 0 : 2, stdout: options.json ? json(payload) : renderGuard(payload) };
  }
  if (command === "accounts" && subcommand === "list") return ok(options.json ? json(status.profiles) : renderAccounts(status));
  if (command === "providers" && subcommand === "probe") {
    const probes = await probeProviders(status, options.provider);
    return ok(options.json ? json(probes) : renderProviderProbes(probes));
  }
  if (command === "models" && subcommand === "list") return ok(options.json ? json(listModels(status)) : renderModels(status));
  if (command === "routes" && subcommand === "next") {
    const next = nextEligible(status, options.provider, options.runtime, options.model);
    return next ? ok(options.json ? json(next) : `Next eligible: ${next.profile.id}\n`) : { code: 2, stdout: "", stderr: "No eligible account found\n" };
  }
  if (command === "audit" && subcommand === "list") return ok(options.json ? json(status.audit.slice(0, options.limit)) : renderAudit(status, options.limit));
  if (command === "reauth" && subcommand === "start") return startReauth(target, status, options);
  if (command === "routes" && ["auto", "use", "remove"].includes(subcommand ?? "")) {
    const action = routeAction(subcommand);
    const mutation = await adapter.mutate({
      action,
      target: action === "route.auto" ? target ?? nextEligible(status, options.provider, options.runtime)?.profile.id : target,
      apply: options.apply,
      provider: options.provider,
      runtime: options.runtime,
      receiptPath: options.receiptPath
    });
    return { code: mutation.code, stdout: json(mutation.payload) };
  }
  if (command === "accounts" && ["disable", "enable", "delete"].includes(subcommand ?? "")) {
    const mutation = await adapter.mutate({
      action: accountAction(subcommand),
      target,
      apply: options.apply,
      provider: options.provider,
      runtime: options.runtime,
      receiptPath: options.receiptPath
    });
    return { code: mutation.code, stdout: json(mutation.payload) };
  }
  if (command === "models" && ["disable", "enable"].includes(subcommand ?? "")) {
    const mutation = await adapter.mutate({
      action: modelAction(subcommand),
      target,
      apply: options.apply,
      provider: options.provider,
      runtime: options.runtime,
      receiptPath: options.receiptPath
    });
    return { code: mutation.code, stdout: json(mutation.payload) };
  }
  return { code: 1, stdout: "", stderr: `Unknown command. Run account-center help.\n` };
}

function parseOptions(argv: string[], cwd: string): CliOptions {
  return {
    json: argv.includes("--json"),
    provider: valueAfter(argv, "--provider") ?? "openai",
    runtime: valueAfter(argv, "--runtime") ?? "openclaw",
    model: valueAfter(argv, "--model"),
    limit: Number(valueAfter(argv, "--limit") ?? "20"),
    statusPath: resolve(cwd, valueAfter(argv, "--status-path") ?? ".account-center/status-export.json"),
    receiptPath: resolve(cwd, valueAfter(argv, "--receipt-path") ?? `.account-center/receipts/${new Date().toISOString().replace(/[:.]/g, "-")}.json`),
    writeExport: !argv.includes("--no-write-export"),
    source: parseRuntimeSource(valueAfter(argv, "--source") ?? process.env.ACCOUNT_CENTER_SOURCE),
    apply: argv.includes("--apply"),
    ensureRoute: argv.includes("--ensure-route")
  };
}

function isOptionValue(argv: string[], arg: string): boolean {
  const index = argv.indexOf(arg);
  return index > 0 && argv[index - 1]?.startsWith("--") && !arg.startsWith("--");
}

function valueAfter(argv: string[], key: string): string | undefined {
  const index = argv.indexOf(key);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function maybeWriteStatus(status: AccountCenterStatus, options: CliOptions): Promise<void> {
  if (!options.writeExport) return;
  await mkdir(dirname(options.statusPath), { recursive: true });
  await writeFile(options.statusPath, `${json({ ...status, generatedAt: new Date().toISOString(), source: options.source })}\n`, "utf8");
}

function routeAction(subcommand?: string): AuditAction {
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

function renderStatus(status: AccountCenterStatus, options: CliOptions): string {
  if (status.source === "openclaw") return renderCodexLimits(status, options);
  const route = status.routes.find((item) => item.provider === options.provider && item.runtime === options.runtime);
  const next = nextEligible(status, options.provider, options.runtime, options.model);
  return [
    "Account Center: OK",
    `Active: ${route?.activeProfileId ?? "unknown"}`,
    `Next eligible: ${next?.profile.id ?? "none"}`,
    `Warnings: ${status.warnings.join("; ") || "none"}`
  ].join("\n") + "\n";
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
  lines.push("• /auth add <email> — start OpenAI Codex device-code login from Telegram; background worker attempts to save/refresh the OAuth profile and activates it when usable, then reports success/failure");
  lines.push("• /auth reauth <email> — same as /auth add <email>; use for expired/401 accounts");
  lines.push("• /auth remove <email> — remove from routing without deleting credentials");
  lines.push("• /auth delete <email> --apply — permanently delete that account's Sentinel/OpenClaw credentials after backup");
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
  lines.push("Notes: OpenAI returns 5-hour and weekly windows. This command reads provider usage endpoints/status JSON only — no LLM/model tokens.");
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
  return "No account currently has both 5h + weekly capacity.";
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

function renderGuard(payload: { ok: boolean; reason: string; next?: string }): string {
  return `Guard: ${payload.ok ? "OK" : "BLOCKED"}\nReason: ${payload.reason}\nNext: ${payload.next ?? "none"}\n`;
}

function renderAccounts(status: AccountCenterStatus): string {
  return status.profiles.map((profile) => {
    const five = profile.usage.windows.find((window) => window.name === "five-hour")?.remainingPct ?? "unknown";
    const weekly = profile.usage.windows.find((window) => window.name === "weekly")?.remainingPct ?? "unknown";
    return `${profile.id} role=${profile.role} health=${profile.usage.health} auth=${profile.usage.auth.state} 5h=${five}% weekly=${weekly}%`;
  }).join("\n") + "\n";
}

function renderDoctorReport(report: unknown): string {
  if (isReport(report)) {
    const lines = [
      `Doctor: ${report.ok ? "OK" : "WARN"}`,
      `Source: ${String(report.source ?? "unknown")}`
    ];
    if (typeof report.fixtureOnly === "boolean") lines.push(`Fixture only: ${report.fixtureOnly ? "yes" : "no"}`);
    if (typeof report.profiles === "number") lines.push(`Profiles: ${report.profiles}`);
    if (typeof report.routes === "number") lines.push(`Routes: ${report.routes}`);
    if (Array.isArray(report.checks)) {
      for (const check of report.checks) {
        if (isReport(check)) lines.push(`- ${String(check.name)}: ${check.ok ? "ok" : "fail"} (${String(check.detail ?? "")})`);
      }
    }
    return `${lines.join("\n")}\n`;
  }
  return `${json(report)}\n`;
}

function renderModels(status: AccountCenterStatus): string {
  return listModels(status).map((item) => `${item.model} disabled=${item.disabled} profiles=${item.profiles.length}`).join("\n") + "\n";
}

function renderAudit(status: AccountCenterStatus, limit: number): string {
  return status.audit.slice(0, limit).map((event) => `${event.id} ${event.action} dryRun=${event.dryRun} ${event.summary}`).join("\n") + "\n";
}

function startReauth(target: string | undefined, status: AccountCenterStatus, options: CliOptions): CliResult {
  if (!target) return { code: 1, stdout: "", stderr: "Usage: /auth add <email> or /auth reauth <email>\n" };
  const script = "/home/Alej/.openclaw/workspace/3-Resources/codex-account-ops/scripts/codex-device-auth-telegram.mjs";
  const payload = {
    started: false,
    dryRun: !options.apply,
    noLlmTokens: true,
    target,
    command: `node ${script} start --email ${target}`,
    note: options.apply
      ? "Live device-code auth start is reserved for the native Telegram bridge in this build; run the printed fallback command if Account Center cannot start it in this chat."
      : "Dry-run only. Add --apply to request a live device-code auth start, or run the printed fallback command."
  };
  if (options.json) return ok(json(payload));
  return ok([
    `OpenAI Codex device-code auth for ${target}`,
    `No LLM/model tokens are used by this command.`,
    payload.note,
    `Fallback CLI: ${payload.command}`
  ].join("\n") + "\n");
}

function renderProviderProbes(probes: Array<{ provider: string; ok: boolean; profiles: number; usableProfiles: number; lowestRemainingPct: number | null; highestRemainingPct: number | null; source: string }>): string {
  return probes.map((probe) => `${probe.provider} ok=${probe.ok} usable=${probe.usableProfiles}/${probe.profiles} remaining=${probe.lowestRemainingPct ?? "unknown"}-${probe.highestRemainingPct ?? "unknown"}% source=${probe.source}`).join("\n") + "\n";
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
  accounts delete <email-or-profile> [--apply] -- destructive credential deletion; backs up first; dry-run unless --apply
  routes next
  routes auto [--apply] -- dry-run unless --apply
  routes use <profile> [--apply] -- dry-run unless --apply
  routes remove <profile> [--apply] -- dry-run unless --apply
  models disable <provider/model> [--apply] -- dry-run unless apply is supported and explicit
  models enable <provider/model> [--apply] -- dry-run unless apply is supported and explicit
  models list
  doctor
  audit list [--limit 20]
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
  return JSON.stringify(redactJson(value), null, 2);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runCli(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.code;
}
