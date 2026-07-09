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
  if (command === "accounts" && ["disable", "enable"].includes(subcommand ?? "")) {
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
  return subcommand === "enable" ? "account.enable" : "account.disable";
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
  const route = status.routes.find((item) => item.provider === options.provider && item.runtime === options.runtime);
  const next = nextEligible(status, options.provider, options.runtime, options.model);
  return [
    "Account Center: OK",
    `Active: ${route?.activeProfileId ?? "unknown"}`,
    `Next eligible: ${next?.profile.id ?? "none"}`,
    `Warnings: ${status.warnings.join("; ") || "none"}`
  ].join("\n") + "\n";
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
