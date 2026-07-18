import type { AccountCenterStatus, HealthState, ProfileRole } from "./schemas.js";
import type { RuntimeSource } from "./runtime-adapters.js";

type PublicProvider = "anthropic" | "github-copilot" | "openai" | "openrouter" | "custom";
type PublicRuntime = "codex" | "generic-command" | "hermes" | "openclaw" | "custom";
export type PublicSource = "fixture" | "generic-command" | "openclaw" | "unknown";

const PUBLIC_MODEL_IDS = new Set(["openai/gpt-4.1", "openai/gpt-5.3-codex", "openai/gpt-5.5"]);

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

/**
 * Protected inventory endpoints deliberately share this narrow projection
 * rather than serializing runtime status fields directly. Generic-command
 * status is schema-valid but still untrusted for public labels.
 */
export function publicModelCatalogView(status: AccountCenterStatus, runtime?: string): unknown {
  const known = new Set([
    ...status.profiles.flatMap((profile) => profile.models),
    ...status.policy.disabledModels
  ]);
  const models = Array.from(known).filter((id) => PUBLIC_MODEL_IDS.has(id)).sort();
  return {
    schemaVersion: "account-center.models.v1",
    ...publicGeneratedAt(status.generatedAt),
    selection: {
      requestedPolicy: { state: "not_reported" },
      effectiveRuntimeModel: { state: "not_reported" },
      fallbackChain: { state: "not_reported" },
      verificationState: "UNPROVEN"
    },
    models: models.map((id) => {
      const observedProfiles = status.profiles.filter((profile) => profile.models.includes(id) && (!runtime || profile.runtimeCompatibility.includes(runtime as typeof profile.runtimeCompatibility[number])));
      const disabled = status.policy.disabledModels.includes(id);
      return {
        id,
        selectable: !disabled,
        ...(disabled ? { reason: "disabled_by_policy" } : {}),
        observedProfileCount: observedProfiles.length,
        readableProfileCount: observedProfiles.filter((profile) => profile.usage.readable === true).length,
        runtimeCompatibility: Array.from(new Set(observedProfiles.flatMap((profile) => profile.runtimeCompatibility)
          .filter((candidate) => !runtime || candidate === runtime)
          .map(publicRuntime))).sort(),
        verificationState: "UNPROVEN"
      };
    })
  };
}

export function publicLimitsInventoryView(status: AccountCenterStatus, runtime?: string): unknown {
  return {
    schemaVersion: "account-center.limits.v1",
    ...publicGeneratedAt(status.generatedAt),
    accounts: status.profiles.map((profile, index) => ({ profile, index }))
      .filter(({ profile }) => !runtime || profile.runtimeCompatibility.includes(runtime as typeof profile.runtimeCompatibility[number]))
      .map(({ profile, index }) => ({
        accountRef: `account-${index + 1}`,
        provider: publicProvider(profile.provider),
        health: publicHealth(profile.usage.health),
        authState: publicAuthState(profile.usage.auth.state),
        readable: profile.usage.readable === true,
        windows: profile.usage.windows.map((window) => ({
          name: publicWindowName(window.name),
          remainingPct: publicPercentage(window.remainingPct),
          ...publicResetAt(window.resetsAt)
        }))
      }))
  };
}

export function publicRuntimeScopeCatalogView(status: AccountCenterStatus): unknown {
  const scopes = new Map<PublicRuntime, { readStatus: boolean; mutateRoutes: boolean; startReauth: boolean; mutateModels: boolean }>();
  for (const runtime of status.runtimes) {
    const key = publicRuntime(runtime.key);
    const existing = scopes.get(key);
    scopes.set(key, {
      readStatus: existing?.readStatus === true || runtime.capabilities.readStatus === true,
      mutateRoutes: existing?.mutateRoutes === true || runtime.capabilities.mutateRoutes === true,
      startReauth: existing?.startReauth === true || runtime.capabilities.startReauth === true,
      mutateModels: existing?.mutateModels === true || runtime.capabilities.mutateModels === true
    });
  }
  return {
    schemaVersion: "account-center.runtime-scopes.v1",
    ...publicGeneratedAt(status.generatedAt),
    scopes: Array.from(scopes.entries()).sort(([left], [right]) => left.localeCompare(right)).map(([runtime, capabilities]) => ({
      runtime,
      scope: { kind: "default", id: "default" },
      capabilities
    }))
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
function publicGeneratedAt(value: unknown): { generatedAt: string } {
  return { generatedAt: isoTimestamp(value) ? value : "unknown" };
}
function publicResetAt(value: unknown): { resetsAt?: string } {
  return isoTimestamp(value) ? { resetsAt: value } : {};
}
function isOkReport(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) && (value as { ok?: unknown }).ok === true;
}
