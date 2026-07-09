import { spawn } from "node:child_process";
import { AccountCenterStatus, isRecord, nowIso } from "./schemas.js";
import { redactJson } from "./redaction.js";

export interface ProviderProbeResult {
  provider: string;
  source: "status" | "external-command";
  ok: boolean;
  generatedAt: string;
  profiles: number;
  usableProfiles: number;
  lowestRemainingPct: number | null;
  highestRemainingPct: number | null;
  warnings: string[];
}

export async function probeProviders(status: AccountCenterStatus, provider = "all", runner: ProbeRunner = execProbeRunner): Promise<ProviderProbeResult[]> {
  const external = process.env.ACCOUNT_CENTER_PROVIDER_PROBE_COMMAND;
  if (external) return normalizeExternalProbe(await runner(external, [provider, "--json"]));
  const providers = provider === "all" ? [...new Set(status.profiles.map((profile) => profile.provider))].sort() : [provider];
  return providers.map((item) => probeProviderFromStatus(status, item));
}

export type ProbeRunner = (command: string, args: string[]) => Promise<string>;

function probeProviderFromStatus(status: AccountCenterStatus, provider: string): ProviderProbeResult {
  const profiles = status.profiles.filter((profile) => profile.provider === provider);
  const remaining = profiles.flatMap((profile) => profile.usage.windows.map((window) => window.remainingPct).filter((value): value is number => typeof value === "number"));
  const isUsable = (profile: AccountCenterStatus["profiles"][number]) => profile.usage.health === "ok" && profile.usage.auth.state === "ok";
  return {
    provider,
    source: "status",
    ok: profiles.some(isUsable),
    generatedAt: nowIso(),
    profiles: profiles.length,
    usableProfiles: profiles.filter(isUsable).length,
    lowestRemainingPct: remaining.length ? Math.min(...remaining) : null,
    highestRemainingPct: remaining.length ? Math.max(...remaining) : null,
    warnings: profiles.length ? [] : ["provider_not_found"]
  };
}

function normalizeExternalProbe(rawText: string): ProviderProbeResult[] {
  const raw = JSON.parse(rawText);
  const items = Array.isArray(raw) ? raw : [raw];
  return items.map((item) => {
    if (!isRecord(item)) throw new Error("Provider probe command must return an object or array of objects.");
    return redactJson({
      provider: String(item.provider ?? "unknown"),
      source: "external-command",
      ok: Boolean(item.ok),
      generatedAt: String(item.generatedAt ?? nowIso()),
      profiles: Number(item.profiles ?? 0),
      usableProfiles: Number(item.usableProfiles ?? 0),
      lowestRemainingPct: item.lowestRemainingPct ?? null,
      highestRemainingPct: item.highestRemainingPct ?? null,
      warnings: Array.isArray(item.warnings) ? item.warnings.map(String) : []
    }) as ProviderProbeResult;
  });
}

async function execProbeRunner(command: string, args: string[]): Promise<string> {
  const parts = splitArgs(command);
  const executable = parts[0] ?? command;
  const finalArgs = [...parts.slice(1), ...args];
  return new Promise((resolve, reject) => {
    const child = spawn(executable, finalArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`Provider probe command failed (${code}): ${stderr.slice(0, 500)}`)));
  });
}

function splitArgs(text: string): string[] {
  return text.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((part) => part.replace(/^"|"$/g, "")) ?? [];
}
