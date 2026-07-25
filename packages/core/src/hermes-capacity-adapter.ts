import { automationCapacityExport, type AutomationCapacityExport, type AutomationCapacityState } from "./automation-capacity.js";
import { execFileRunner, type CommandResult, type CommandRunner } from "./runtime-adapters.js";
import type { AccountCenterStatus, ProviderKey } from "./schemas.js";

/** Bound the human-readable Hermes status surfaces before inspecting them. */
export const MAX_HERMES_CAPACITY_STATUS_BYTES = 65_536;

export interface HermesCapacityAdapterConfig {
  hermesBin?: string;
  provider?: ProviderKey;
  scope?: string;
  runner?: CommandRunner;
  now?: () => Date;
}

export interface HermesCapacityEvidence {
  runtime: "verified" | "unproven";
  provider: "available" | "blocked" | "unproven";
}

/**
 * Read-only adapter for Hermes' documented status surfaces:
 *
 *   hermes status --all
 *   hermes auth status <provider>
 *
 * Hermes does not currently document a JSON capacity schema. Consequently the
 * provider result is deliberately strict: only an explicit capacity/quota/usage
 * statement is proof. A successful authentication check or credential marker
 * by itself remains unproven.
 */
export class HermesRuntimeCapacityAdapter {
  private readonly hermesBin: string;
  private readonly provider: ProviderKey;
  private readonly scope: string;
  private readonly runner: CommandRunner;
  private readonly now: () => Date;

  constructor(config: HermesCapacityAdapterConfig = {}) {
    this.hermesBin = config.hermesBin ?? "hermes";
    this.provider = config.provider ?? "openai";
    this.scope = config.scope ?? "profile:default";
    this.runner = config.runner ?? execFileRunner;
    this.now = config.now ?? (() => new Date());
  }

  async export(previous?: AutomationCapacityState): Promise<AutomationCapacityExport> {
    const [runtimeResult, providerResult] = await Promise.all([
      this.run(["status", "--all"]),
      this.run(["auth", "status", this.provider])
    ]);
    const observedAt = this.now().toISOString();
    const evidence: HermesCapacityEvidence = {
      runtime: provesRuntime(runtimeResult) ? "verified" : "unproven",
      provider: providerCapacity(providerResult)
    };
    return automationCapacityExport(this.toStatus(evidence, observedAt, providerResult), previous);
  }

  private async run(args: string[]): Promise<CommandResult> {
    try {
      return await this.runner(this.hermesBin, args, { timeoutMs: 15_000, maxOutputBytes: MAX_HERMES_CAPACITY_STATUS_BYTES });
    } catch {
      return { code: 127, stdout: "", stderr: "" };
    }
  }

  private toStatus(evidence: HermesCapacityEvidence, observedAt: string, providerResult: CommandResult): AccountCenterStatus {
    const authIsUsable = commandSucceeded(providerResult) && explicitlyAuthenticated(providerResult.stdout);
    return {
      schemaVersion: "account-center.status.v1",
      generatedAt: observedAt,
      noSecrets: true,
      source: "generic-command",
      providers: [{ key: this.provider, displayName: this.provider }],
      runtimes: [{ key: "hermes", displayName: "Hermes live capacity adapter", capabilities: { readStatus: true, mutateRoutes: false, startReauth: false, mutateModels: false } }],
      profiles: [{
        // This internal sentinel is intentionally never exported by the
        // automation contract. It cannot identify a Hermes account.
        id: "hermes:local-capacity-proof",
        provider: this.provider,
        label: "Hermes local proof",
        role: "monitor-only",
        runtimeCompatibility: ["hermes"],
        models: [],
        disabled: false,
        usage: {
          profileId: "hermes:local-capacity-proof",
          provider: this.provider,
          generatedAt: observedAt,
          readable: authIsUsable,
          health: authIsUsable ? "ok" : "unknown",
          windows: [],
          auth: { state: authIsUsable ? "ok" : "unknown" },
          warnings: authIsUsable ? [] : ["hermes_auth_status_unproven"]
        }
      }],
      routes: [],
      policy: { minFiveHourRemainingPct: 5, minWeeklyRemainingPct: 5, allowBackupWhenNormalAvailable: false, disabledModels: [], staleAfterSeconds: 60 },
      leases: [],
      agentConnections: [{
        id: "hermes-live-capacity",
        runtime: "hermes",
        scope: this.scope,
        profileIds: ["hermes:local-capacity-proof"],
        verifiedProfileIds: authIsUsable ? ["hermes:local-capacity-proof"] : [],
        state: authIsUsable ? "connected" : "needs-auth",
        capacityEvidence: {
          runtime: { state: evidence.runtime, observedAt },
          provider: { state: evidence.provider, observedAt }
        }
      }],
      reauth: [],
      audit: [],
      warnings: ["hermes_read_only_capacity_adapter"]
    };
  }
}

function commandSucceeded(result: CommandResult): boolean {
  return result.code === 0 && !result.timeoutExceeded && !result.outputLimitExceeded
    && Buffer.byteLength(result.stdout, "utf8") <= MAX_HERMES_CAPACITY_STATUS_BYTES
    && Buffer.byteLength(result.stderr, "utf8") <= MAX_HERMES_CAPACITY_STATUS_BYTES;
}

function provesRuntime(result: CommandResult): boolean {
  return commandSucceeded(result) && result.stdout.trim().length > 0;
}

function providerCapacity(result: CommandResult): HermesCapacityEvidence["provider"] {
  if (!commandSucceeded(result)) return "unproven";
  const output = result.stdout;
  if (/\b(?:capacity|quota|usage)\b[^\n]{0,100}\b(?:blocked|unavailable|exhausted|limit(?:\s+reached)?|rate[- ]limited)\b/i.test(output)
    || /\b(?:quota|limit)\s+(?:reached|exhausted)\b/i.test(output)) return "blocked";
  if (/\b(?:capacity|quota|usage)\b[^\n]{0,100}\bavailable\b/i.test(output)
    || /\bavailable\b[^\n]{0,100}\b(?:capacity|quota|usage)\b/i.test(output)) return "available";
  return "unproven";
}

function explicitlyAuthenticated(output: string): boolean {
  if (/\b(?:not authenticated|unauthenticated|expired|reauth(?:entication)? required)\b/i.test(output)) return false;
  return /\b(?:authenticated|logged\s+in|signed\s+in|credential active|auth(?:entication)?\s*:\s*(?:ok|valid))\b/i.test(output);
}
