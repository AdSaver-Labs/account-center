import { automationCapacityExport, type AutomationCapacityExport, type AutomationCapacityState } from "./automation-capacity.js";
import { OpenClawRuntimeAdapter, execFileRunner, type CommandResult, type CommandRunner } from "./runtime-adapters.js";
import type { AccountCenterStatus, AgentConnection, Profile, ProviderKey } from "./schemas.js";

/** Bound the human-readable Hermes runtime status before inspecting it. */
export const MAX_HERMES_CAPACITY_STATUS_BYTES = 65_536;

export interface HermesCapacityAdapterConfig {
  hermesBin?: string;
  provider?: ProviderKey;
  scope?: string;
  runner?: CommandRunner;
  /** Reads the canonical, no-secret Account Center OpenClaw/Sentinel status. */
  statusReader?: () => Promise<AccountCenterStatus>;
  now?: () => Date;
}

/**
 * Read-only two-proof adapter for Hermes scheduled work.
 *
 * Hermes is asked only for a runtime-connection proof (`hermes status --all`).
 * It is never asked to state a provider quota. Provider capacity comes only
 * from Account Center's canonical OpenClaw/Sentinel status for the one account
 * explicitly mapped to this exact Hermes scope.
 */
export class HermesRuntimeCapacityAdapter {
  private readonly hermesBin: string;
  private readonly provider: ProviderKey;
  private readonly scope: string;
  private readonly runner: CommandRunner;
  private readonly statusReader: () => Promise<AccountCenterStatus>;
  private readonly now: () => Date;

  constructor(config: HermesCapacityAdapterConfig = {}) {
    this.hermesBin = config.hermesBin ?? "hermes";
    this.provider = config.provider ?? "openai";
    this.scope = config.scope ?? "profile:default";
    this.runner = config.runner ?? execFileRunner;
    this.statusReader = config.statusReader ?? (() => new OpenClawRuntimeAdapter().readStatus());
    this.now = config.now ?? (() => new Date());
  }

  async export(previous?: AutomationCapacityState): Promise<AutomationCapacityExport> {
    const [runtimeResult, canonicalStatus] = await Promise.all([this.runRuntimeStatus(), this.readCanonicalStatus()]);
    const observedAt = this.now().toISOString();
    const status = canonicalStatus ?? unavailableStatus(this.provider, observedAt);
    const connection = mappedHermesConnection(status, this.scope, this.provider);
    const mappedProfile = connection ? mappedProfileFor(connection, status, this.provider) : undefined;
    const providerEvidence = canonicalProviderCapacity(status, mappedProfile);
    const merged = mergeProof(status, connection, this.scope, observedAt, provesRuntime(runtimeResult), providerEvidence);
    return automationCapacityExport(merged, previous);
  }

  private async runRuntimeStatus(): Promise<CommandResult> {
    try {
      return await this.runner(this.hermesBin, ["status", "--all"], { timeoutMs: 15_000, maxOutputBytes: MAX_HERMES_CAPACITY_STATUS_BYTES });
    } catch {
      return { code: 127, stdout: "", stderr: "" };
    }
  }

  private async readCanonicalStatus(): Promise<AccountCenterStatus | undefined> {
    try {
      const status = await this.statusReader();
      return status.noSecrets === true && status.source === "openclaw" ? status : undefined;
    } catch {
      return undefined;
    }
  }
}

function mergeProof(
  status: AccountCenterStatus,
  connection: AgentConnection | undefined,
  scope: string,
  observedAt: string,
  runtimeVerified: boolean,
  provider: "available" | "blocked" | "unproven"
): AccountCenterStatus {
  const base: AgentConnection = connection ?? {
    id: "hermes-capacity-unmapped",
    runtime: "hermes",
    scope,
    profileIds: [],
    verifiedProfileIds: [],
    state: "needs-auth"
  };
  return {
    ...status,
    agentConnections: [{
      ...base,
      capacityEvidence: {
        runtime: { state: runtimeVerified ? "verified" : "unproven", observedAt },
        provider: { state: provider, observedAt: providerObservedAt(status, base) ?? "invalid" }
      }
    }]
  };
}

function unavailableStatus(provider: ProviderKey, generatedAt: string): AccountCenterStatus {
  return {
    schemaVersion: "account-center.status.v1", generatedAt, noSecrets: true, source: "openclaw",
    providers: [{ key: provider, displayName: provider }], runtimes: [], profiles: [], routes: [],
    policy: { minFiveHourRemainingPct: 5, minWeeklyRemainingPct: 5, allowBackupWhenNormalAvailable: false, disabledModels: [], staleAfterSeconds: 60 },
    leases: [], agentConnections: [], reauth: [], audit: [], warnings: ["canonical_status_unavailable"]
  };
}

function mappedHermesConnection(status: AccountCenterStatus, scope: string, provider: ProviderKey): AgentConnection | undefined {
  const matches = (status.agentConnections ?? []).filter((connection) => connection.runtime === "hermes" && connection.scope === scope);
  if (matches.length !== 1) return undefined;
  const connection = matches[0]!;
  const mapped = connection.profileIds.filter((id) => connection.verifiedProfileIds.includes(id) && status.profiles.some((profile) => profile.id === id && profile.provider === provider));
  // One exact scoped shared account is required. Ambiguous or unverified maps
  // fail closed rather than selecting a profile based on route order.
  return mapped.length === 1 && connection.state === "connected" ? connection : undefined;
}

function mappedProfileFor(connection: AgentConnection, status: AccountCenterStatus, provider: ProviderKey): Profile | undefined {
  const profileId = connection.profileIds.find((id) => connection.verifiedProfileIds.includes(id) && status.profiles.some((profile) => profile.id === id && profile.provider === provider));
  return profileId ? status.profiles.find((profile) => profile.id === profileId && profile.provider === provider) : undefined;
}

function canonicalProviderCapacity(status: AccountCenterStatus, profile: Profile | undefined): "available" | "blocked" | "unproven" {
  if (!profile || !validTimestamp(status.generatedAt) || !validTimestamp(profile.usage.generatedAt)) return "unproven";
  if (Math.abs(Date.parse(status.generatedAt) - Date.parse(profile.usage.generatedAt)) > status.policy.staleAfterSeconds * 1_000) return "unproven";
  if (!profile.usage.readable || profile.usage.auth.state !== "ok" || profile.disabled || profile.usage.health === "error") return "unproven";
  const fiveHour = remaining(profile, "five-hour");
  const weekly = remaining(profile, "weekly");
  if (fiveHour === undefined || weekly === undefined) return "unproven";
  return fiveHour < status.policy.minFiveHourRemainingPct || weekly < status.policy.minWeeklyRemainingPct ? "blocked" : "available";
}

function providerObservedAt(status: AccountCenterStatus, connection: AgentConnection): string | undefined {
  const profile = connection.profileIds.find((id) => connection.verifiedProfileIds.includes(id));
  return profile ? status.profiles.find((candidate) => candidate.id === profile)?.usage.generatedAt : undefined;
}

function remaining(profile: Profile, name: string): number | undefined {
  const value = profile.usage.windows.find((window) => window.name === name)?.remainingPct;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
}

function provesRuntime(result: CommandResult): boolean {
  return result.code === 0 && !result.timeoutExceeded && !result.outputLimitExceeded
    && Buffer.byteLength(result.stdout, "utf8") <= MAX_HERMES_CAPACITY_STATUS_BYTES
    && Buffer.byteLength(result.stderr, "utf8") <= MAX_HERMES_CAPACITY_STATUS_BYTES
    && result.stdout.trim().length > 0;
}

function validTimestamp(value: string): boolean { return !Number.isNaN(Date.parse(value)); }
