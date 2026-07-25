export type CapacityGateState = "available" | "unavailable";

export interface CapacityGateResult {
  state: CapacityGateState;
  workers: "running" | "paused";
  notification?: "capacity-unavailable" | "capacity-recovered";
}

/**
 * Stateful scheduler gate. Callers persist only `state`; exceptions do not
 * reach this module and therefore cannot manufacture a recovery notification.
 */
export function transitionAutomationCapacity(previous: CapacityGateState | undefined, authoritativeAvailable: boolean): CapacityGateResult {
  const state: CapacityGateState = authoritativeAvailable ? "available" : "unavailable";
  if (previous === state) return { state, workers: state === "available" ? "running" : "paused" };
  if (state === "unavailable") return { state, workers: "paused", notification: "capacity-unavailable" };
  return { state, workers: "running", ...(previous === "unavailable" ? { notification: "capacity-recovered" } : {}) };
}
