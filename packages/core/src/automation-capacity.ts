import type { AccountCenterStatus, AgentConnection } from "./schemas.js";

export type CapacityGateState = "available" | "unavailable";
export type AgentAutomationCapacityState = "available" | "blocked";
export type AutomationCapacityReason = "verified-capacity" | "needs-auth" | "runtime-unproven" | "provider-unproven" | "provider-unavailable";

export interface AutomationCapacityState {
  schemaVersion: "account-center.automation-capacity-state.v1";
  agents: Array<{ agentRef: string; runtime: "hermes" | "openclaw"; scope: string; state: AgentAutomationCapacityState }>;
}

export interface AutomationCapacityExport {
  schemaVersion: "account-center.automation-capacity-export.v1";
  generatedAt: string;
  state: AutomationCapacityState;
  agents: Array<{
    agentRef: string;
    runtime: "hermes" | "openclaw";
    scope: string;
    state: AgentAutomationCapacityState;
    workers: "running" | "paused";
    reason: AutomationCapacityReason;
    evidence: { runtime: "verified" | "unproven"; provider: "available" | "blocked" | "unproven" };
    notification?: "automation-blocked" | "automation-resumed";
  }>;
}

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

/**
 * Produces the redacted, persistable contract for the no-agent cron gate.
 * `state` is saved locally after a successful cron decision; `agents` is the
 * current export and only carries a notification on a transition. Capacity is
 * available solely when the exact runtime and provider both report fresh proof.
 */
export function automationCapacityExport(status: AccountCenterStatus, previous?: AutomationCapacityState): AutomationCapacityExport {
  const connections = (status.agentConnections ?? []).filter(isSupportedConnection);
  const agents = connections.map((connection, index) => {
    const agentRef = `connection-${index + 1}`;
    const evaluation = evaluateConnection(status, connection);
    const prior = previous?.agents.find((agent) => agent.agentRef === agentRef && agent.runtime === connection.runtime && agent.scope === connection.scope);
    const notification: "automation-blocked" | "automation-resumed" | undefined = prior?.state === evaluation.state
      ? undefined
      : evaluation.state === "blocked"
        ? "automation-blocked"
        : prior?.state === "blocked" ? "automation-resumed" : undefined;
    return {
      agentRef,
      runtime: connection.runtime,
      scope: connection.scope,
      state: evaluation.state,
      workers: evaluation.state === "available" ? "running" as const : "paused" as const,
      reason: evaluation.reason,
      evidence: evaluation.evidence,
      ...(notification ? { notification } : {})
    };
  });
  return {
    schemaVersion: "account-center.automation-capacity-export.v1",
    generatedAt: validTimestamp(status.generatedAt) ? status.generatedAt : "unknown",
    state: {
      schemaVersion: "account-center.automation-capacity-state.v1",
      agents: agents.map(({ agentRef, runtime, scope, state }) => ({ agentRef, runtime, scope, state }))
    },
    agents
  };
}

function evaluateConnection(status: AccountCenterStatus, connection: AgentConnection & { runtime: "hermes" | "openclaw" }): { state: AgentAutomationCapacityState; reason: AutomationCapacityReason; evidence: { runtime: "verified" | "unproven"; provider: "available" | "blocked" | "unproven" } } {
  const evidence = {
    runtime: connection.capacityEvidence?.runtime.state === "verified" && freshAt(connection.capacityEvidence.runtime.observedAt, status) ? "verified" as const : "unproven" as const,
    provider: (connection.capacityEvidence?.provider.state === "available" || connection.capacityEvidence?.provider.state === "blocked")
      && freshAt(connection.capacityEvidence.provider.observedAt, status)
      ? connection.capacityEvidence.provider.state
      : "unproven" as const
  };
  const profileIsUsable = connection.profileIds.some((profileId) => {
    const profile = status.profiles.find((candidate) => candidate.id === profileId);
    return Boolean(profile && connection.verifiedProfileIds.includes(profileId) && profile.usage.readable && profile.usage.auth.state === "ok" && !profile.disabled);
  });
  if (connection.state === "needs-auth" || !profileIsUsable) return { state: "blocked", reason: "needs-auth", evidence };
  if (evidence.runtime !== "verified") return { state: "blocked", reason: "runtime-unproven", evidence };
  if (evidence.provider === "unproven") return { state: "blocked", reason: "provider-unproven", evidence };
  if (evidence.provider === "blocked") return { state: "blocked", reason: "provider-unavailable", evidence };
  return { state: "available", reason: "verified-capacity", evidence };
}

function isSupportedConnection(connection: AgentConnection): connection is AgentConnection & { runtime: "hermes" | "openclaw" } {
  return (connection.runtime === "hermes" || connection.runtime === "openclaw") && /^[a-z][a-z0-9_-]{0,31}:[a-z0-9_-]{1,64}$/i.test(connection.scope);
}

function validTimestamp(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

function freshAt(observedAt: string, status: AccountCenterStatus): boolean {
  if (!validTimestamp(observedAt) || !validTimestamp(status.generatedAt) || !Number.isFinite(status.policy.staleAfterSeconds) || status.policy.staleAfterSeconds < 0) return false;
  // The Hermes proof and the canonical status are read independently. Either
  // can finish first, so freshness is bounded by their absolute observation
  // distance rather than requiring an artificial ordering.
  return Math.abs(Date.parse(status.generatedAt) - Date.parse(observedAt)) <= status.policy.staleAfterSeconds * 1_000;
}
