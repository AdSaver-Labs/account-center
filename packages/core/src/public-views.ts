import type { AccountCenterStatus, HealthState, ProfileRole } from "./schemas.js";
import type { RuntimeSource } from "./runtime-adapters.js";

type PublicProvider = "anthropic" | "github-copilot" | "openai" | "openrouter" | "custom";
type PublicRuntime = "codex" | "generic-command" | "hermes" | "openclaw" | "custom";
export type PublicSource = "fixture" | "generic-command" | "openclaw" | "unknown";

export interface PublicStatusView {
  schemaVersion: "account-center.public-status.v1";
  source: PublicSource;
  verificationState: "UNPROVEN";
  generatedAt?: string;
  runtimes: Array<{ key: PublicRuntime; capabilities: { readStatus: boolean; mutateRoutes: boolean; startReauth: boolean; mutateModels: boolean } }>;
  profiles: Array<{
    id: string;
    label: string;
    provider: PublicProvider;
    role: ProfileRole | "unknown";
    runtimeCompatibility: PublicRuntime[];
    usage: {
      profileId: string;
      provider: PublicProvider;
      generatedAt?: string;
      readable: boolean;
      health: HealthState;
      windows: Array<{ name: "five-hour" | "daily" | "weekly" | "other"; remainingPct: number | null; resetsAt?: string }>;
      auth: { state: "ok" | "expired" | "reauth-needed" | "unknown" };
      warnings: [];
    };
  }>;
  routes: Array<{ provider: PublicProvider; runtime: PublicRuntime; activeProfileId: string; order: string[]; updatedAt?: string }>;
  reauth: Array<{ id: string; provider: PublicProvider; profileHint: string; expiresAt?: string; status: "pending" | "complete" | "expired" | "failed" }>;
}

export function publicStatusView(status: AccountCenterStatus): PublicStatusView {
  const accountRefById = new Map(status.profiles.map((profile, index) => [profile.id, `account-${index + 1}`]));
  const accountRef = (id: string): string => accountRefById.get(id) ?? "account-redacted";
  const profileHintRef = (hint: string): string => {
    const profile = status.profiles.find((candidate) => candidate.id === hint || candidate.label === hint);
    return profile ? accountRef(profile.id) : "account-redacted";
  };
  return {
    schemaVersion: "account-center.public-status.v1",
    source: publicSourceCategory(status.source),
    verificationState: "UNPROVEN",
    ...(isoTimestamp(status.generatedAt) ? { generatedAt: status.generatedAt } : {}),
    runtimes: status.runtimes.map((runtime) => ({ key: publicRuntime(runtime.key), capabilities: {
      readStatus: runtime.capabilities.readStatus === true,
      mutateRoutes: runtime.capabilities.mutateRoutes === true,
      startReauth: runtime.capabilities.startReauth === true,
      mutateModels: runtime.capabilities.mutateModels === true
    } })),
    profiles: status.profiles.map((profile, index) => {
      const account = `account-${index + 1}`;
      return {
        id: account,
        label: account,
        provider: publicProvider(profile.provider),
        role: publicRole(profile.role),
        runtimeCompatibility: profile.runtimeCompatibility.map(publicRuntime),
        usage: {
          profileId: account,
          provider: publicProvider(profile.usage.provider),
          ...(isoTimestamp(profile.usage.generatedAt) ? { generatedAt: profile.usage.generatedAt } : {}),
          readable: profile.usage.readable === true,
          health: publicHealth(profile.usage.health),
          windows: profile.usage.windows.map((window) => ({
            name: publicWindowName(window.name),
            remainingPct: publicPercentage(window.remainingPct),
            ...(isoTimestamp(window.resetsAt) ? { resetsAt: window.resetsAt } : {})
          })),
          auth: { state: publicAuthState(profile.usage.auth.state) },
          warnings: []
        }
      };
    }),
    routes: status.routes.map((route) => ({
      provider: publicProvider(route.provider),
      runtime: publicRuntime(route.runtime),
      activeProfileId: accountRef(route.activeProfileId),
      order: route.order.map(accountRef),
      ...(isoTimestamp(route.updatedAt) ? { updatedAt: route.updatedAt } : {})
    })),
    reauth: status.reauth.map((challenge, index) => ({
      id: `reauth-${index + 1}`,
      provider: publicProvider(challenge.provider),
      profileHint: profileHintRef(challenge.profileHint),
      ...(isoTimestamp(challenge.expiresAt) ? { expiresAt: challenge.expiresAt } : {}),
      status: publicChallengeStatus(challenge.status)
    }))
  };
}

export function publicDoctorView(source: RuntimeSource | string, report: unknown): { schemaVersion: "account-center.public-doctor.v1"; source: PublicSource; state: "OK" | "UNPROVEN" } {
  const publicSource = publicSourceCategory(source);
  return {
    schemaVersion: "account-center.public-doctor.v1",
    source: publicSource,
    state: publicSource === "unknown" || !isOkReport(report) ? "UNPROVEN" : "OK"
  };
}

function publicProvider(value: string): PublicProvider {
  return value === "openai" || value === "anthropic" || value === "openrouter" || value === "github-copilot" ? value : "custom";
}
export function publicSourceCategory(value: unknown): PublicSource {
  return value === "fixture" || value === "openclaw" || value === "generic-command" ? value : "unknown";
}
function publicRuntime(value: string): PublicRuntime {
  return value === "openclaw" || value === "hermes" || value === "codex" || value === "generic-command" ? value : "custom";
}
function publicRole(value: string): ProfileRole | "unknown" {
  return value === "primary" || value === "secondary" || value === "backup" || value === "monitor-only" || value === "disabled" ? value : "unknown";
}
function publicHealth(value: string): HealthState {
  return value === "ok" || value === "warn" || value === "error" ? value : "unknown";
}
function publicAuthState(value: string): "ok" | "expired" | "reauth-needed" | "unknown" {
  return value === "ok" || value === "expired" || value === "reauth-needed" ? value : "unknown";
}
function publicChallengeStatus(value: string): "pending" | "complete" | "expired" | "failed" {
  return value === "pending" || value === "complete" || value === "expired" ? value : "failed";
}
function publicWindowName(value: string): "five-hour" | "daily" | "weekly" | "other" {
  return value === "five-hour" || value === "daily" || value === "weekly" ? value : "other";
}
function publicPercentage(value: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}
function isoTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) && !Number.isNaN(Date.parse(value));
}
function isOkReport(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) && (value as { ok?: unknown }).ok === true;
}
