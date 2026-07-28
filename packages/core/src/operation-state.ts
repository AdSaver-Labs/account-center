/**
 * Public, fail-closed state vocabulary for every Account Center operation.
 * These labels describe authority/evidence, never a credential or target.
 */
export type HonestOperationState = "unsupported" | "unentitled" | "read_only" | "unknown" | "UNPROVEN";

export interface HonestOperationStateView {
  state: HonestOperationState;
  success: false;
  terminal: boolean;
  meaning: string;
}

const VIEWS: Record<HonestOperationState, HonestOperationStateView> = {
  unsupported: { state: "unsupported", success: false, terminal: true, meaning: "This runtime does not expose a supported Account Center operation." },
  unentitled: { state: "unentitled", success: false, terminal: true, meaning: "The runtime may support this operation, but the current account is not entitled to use it." },
  read_only: { state: "read_only", success: false, terminal: true, meaning: "Only observation is authorized; no mutation authority was established." },
  unknown: { state: "unknown", success: false, terminal: true, meaning: "Runtime capability evidence is absent or malformed." },
  UNPROVEN: { state: "UNPROVEN", success: false, terminal: true, meaning: "An operation was unavailable or its result could not be authoritatively verified." }
};

/** Returns a new allow-listed public DTO; arbitrary adapter text never crosses. */
export function honestOperationState(state: HonestOperationState): HonestOperationStateView {
  return { ...VIEWS[state] };
}

/**
 * Converts only well-formed protected capability evidence to the public state.
 * A false mutation flag is read-only; absent/non-boolean evidence is unknown.
 * No branch indicates successful mutation.
 */
export function stateFromCapability(capability: unknown, operation: "routes" | "reauth" | "models"): HonestOperationState {
  if (!capability || typeof capability !== "object" || Array.isArray(capability)) return "unknown";
  const record = capability as Record<string, unknown>;
  if (record.readStatus !== true && record.readStatus !== false) return "unknown";
  if (record.readStatus !== true) return "unknown";
  const key = operation === "routes" ? "mutateRoutes" : operation === "reauth" ? "startReauth" : "mutateModels";
  return record[key] === true ? "UNPROVEN" : record[key] === false ? "read_only" : "unknown";
}
