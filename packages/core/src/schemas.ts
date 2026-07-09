export type ProviderKey = "openai" | "anthropic" | "openrouter" | "github-copilot" | `custom:${string}`;
export type RuntimeKey = "openclaw" | "hermes" | "codex" | "generic-command" | `custom:${string}`;
export type HealthState = "ok" | "warn" | "error" | "unknown";
export type ProfileRole = "primary" | "secondary" | "backup" | "monitor-only" | "disabled";
export type AuditAction =
  | "route.auto"
  | "route.use"
  | "route.remove"
  | "account.disable"
  | "account.enable"
  | "model.disable"
  | "model.enable"
  | "status.export"
  | "guard.check";

export interface Provider {
  key: ProviderKey;
  displayName: string;
}

export interface Runtime {
  key: RuntimeKey;
  displayName: string;
  capabilities: {
    readStatus: boolean;
    mutateRoutes: boolean;
    startReauth: boolean;
    mutateModels: boolean;
  };
}

export interface UsageWindow {
  name: "five-hour" | "daily" | "weekly" | string;
  remainingPct: number | null;
  resetsAt?: string;
}

export interface UsageSnapshot {
  profileId: string;
  provider: ProviderKey;
  generatedAt: string;
  readable: boolean;
  health: HealthState;
  windows: UsageWindow[];
  auth: {
    state: "ok" | "expired" | "reauth-needed" | "unknown";
    tokenExpiresAt?: string;
  };
  warnings: string[];
}

export interface Profile {
  id: string;
  provider: ProviderKey;
  label: string;
  role: ProfileRole;
  runtimeCompatibility: RuntimeKey[];
  models: string[];
  disabled: boolean;
  cooldownUntil?: string;
  usage: UsageSnapshot;
}

export interface RouteState {
  provider: ProviderKey;
  runtime: RuntimeKey;
  activeProfileId: string;
  order: string[];
  updatedAt: string;
}

export interface Policy {
  minFiveHourRemainingPct: number;
  minWeeklyRemainingPct: number;
  allowBackupWhenNormalAvailable: boolean;
  disabledModels: string[];
  staleAfterSeconds: number;
}

export interface Lease {
  id: string;
  profileId: string;
  holder: string;
  reason: string;
  expiresAt: string;
}

export interface ReauthChallenge {
  id: string;
  provider: ProviderKey;
  profileHint: string;
  userCode?: string;
  verificationUri?: string;
  expiresAt: string;
  status: "pending" | "complete" | "expired" | "failed";
}

export interface AuditEvent {
  id: string;
  action: AuditAction;
  actor: string;
  dryRun: boolean;
  createdAt: string;
  target?: string;
  summary: string;
  before?: unknown;
  after?: unknown;
  warnings: string[];
}

export interface AccountCenterStatus {
  schemaVersion: "account-center.status.v1";
  generatedAt: string;
  noSecrets: true;
  source: "fixture" | "file-store" | "openclaw";
  providers: Provider[];
  runtimes: Runtime[];
  profiles: Profile[];
  routes: RouteState[];
  policy: Policy;
  leases: Lease[];
  reauth: ReauthChallenge[];
  audit: AuditEvent[];
  warnings: string[];
}

export function assertAccountCenterStatus(value: unknown): asserts value is AccountCenterStatus {
  if (!isRecord(value)) throw new Error("status must be an object");
  if (value.schemaVersion !== "account-center.status.v1") throw new Error("unsupported status schemaVersion");
  for (const key of ["generatedAt", "noSecrets", "source", "providers", "runtimes", "profiles", "routes", "policy", "leases", "reauth", "audit", "warnings"]) {
    if (!(key in value)) throw new Error(`status missing ${key}`);
  }
  if (value.noSecrets !== true) throw new Error("status must declare noSecrets=true");
  if (!Array.isArray(value.profiles)) throw new Error("profiles must be an array");
  if (!Array.isArray(value.routes)) throw new Error("routes must be an array");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function nowIso(): string {
  return new Date().toISOString();
}
