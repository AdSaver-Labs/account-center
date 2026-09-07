import { execFileRunner, type CommandRunner } from "./runtime-adapters.js";

/** The fixed reader never retains or exposes more than this bounded command output. */
export const MAX_HERMES_GATEWAY_STATUS_BYTES = 65_536;

export type HermesGatewayLivenessState = "running" | "stopped" | "unproven";

export interface HermesGatewayLivenessView {
  schemaVersion: "account-center.hermes-gateway-liveness.v1";
  runtime: "hermes";
  scope: "default";
  state: HermesGatewayLivenessState;
  observedAt: string;
  verificationState: "UNPROVEN";
  evidence: string;
}

export interface HermesGatewayLivenessReaderConfig {
  runner?: CommandRunner;
  now?: () => Date;
}

/** Read-only, fixed-command gateway service liveness; it makes no account or routing claim. */
export class HermesGatewayLivenessReader {
  private readonly runner: CommandRunner;
  private readonly now: () => Date;

  constructor(config: HermesGatewayLivenessReaderConfig = {}) {
    this.runner = config.runner ?? execFileRunner;
    this.now = config.now ?? (() => new Date());
  }

  async read(): Promise<HermesGatewayLivenessView> {
    const observedAt = this.now().toISOString();
    let state: HermesGatewayLivenessState = "unproven";
    try {
      const result = await this.runner("systemctl", ["--user", "is-active", "--quiet", "hermes-gateway.service"], { timeoutMs: 15_000, maxOutputBytes: MAX_HERMES_GATEWAY_STATUS_BYTES });
      if (!result.timeoutExceeded && !result.outputLimitExceeded && result.stdout === "" && result.stderr === "" &&
        Buffer.byteLength(result.stdout, "utf8") <= MAX_HERMES_GATEWAY_STATUS_BYTES && Buffer.byteLength(result.stderr, "utf8") <= MAX_HERMES_GATEWAY_STATUS_BYTES) {
        state = result.code === 0 ? "running" : result.code === 3 ? "stopped" : "unproven";
      }
    } catch {
      // External command failures are intentionally indistinguishable from unproven liveness.
    }
    return view(state, observedAt);
  }
}


function view(state: HermesGatewayLivenessState, observedAt: string): HermesGatewayLivenessView {
  const prefix = state === "running" ? `Gateway service liveness observed ${observedAt}` : state === "stopped" ? `Gateway service stopped observed ${observedAt}` : "Gateway service liveness is UNPROVEN";
  return {
    schemaVersion: "account-center.hermes-gateway-liveness.v1",
    runtime: "hermes",
    scope: "default",
    state,
    observedAt,
    verificationState: "UNPROVEN",
    evidence: `${prefix}; provider/account capacity, inventory, route, and recovery are UNPROVEN.`
  };
}
