import type { AccountCenterStatus, AgentConnection } from "./schemas.js";

export type AgentConnectionState = "connected" | "needs-auth" | "unavailable";

export interface ScopedAccountLeaseContract {
  schemaVersion: "account-center.scoped-account-lease.v1";
  leaseRef: string;
  accountRef: string;
  runtime: "hermes" | "openclaw";
  scope: string;
  state: "verified";
}

export interface AgentConnectionInventory {
  schemaVersion: "account-center.agent-connections.v1";
  generatedAt: string;
  inventory: Array<{
    connectionRef: string;
    runtime: "hermes" | "openclaw";
    scope: string;
    state: AgentConnectionState;
    onboarding: { action: "connect-local-adapter" | "reauth-local-adapter"; command: string };
    accounts: Array<{
      accountRef: string;
      state: "usable" | "needs-auth" | "unavailable";
      weeklyRemainingPct: number | null;
      routeState: "selected" | "available" | "not-routed";
      lease?: ScopedAccountLeaseContract;
    }>;
  }>;
}

/**
 * This module is the only seam that turns adapter-local proof into a shared
 * inventory. It never accepts credential material and never borrows a proof
 * from another runtime/scope.
 */
export function publicAgentConnectionInventoryView(status: AccountCenterStatus): AgentConnectionInventory {
  const accountRefById = new Map(status.profiles.map((profile, index) => [profile.id, `account-${index + 1}`]));
  const knownConnections = (status.agentConnections ?? []).filter(isSupportedConnection);
  return {
    schemaVersion: "account-center.agent-connections.v1",
    generatedAt: validTimestamp(status.generatedAt) ? status.generatedAt : "unknown",
    inventory: knownConnections.map((connection, index) => ({
      connectionRef: `connection-${index + 1}`,
      runtime: connection.runtime,
      scope: connection.scope,
      state: connection.state,
      onboarding: connection.state === "needs-auth"
        ? { action: "reauth-local-adapter", command: `account-center connect-agent --runtime ${connection.runtime} --scope ${connection.scope} --reauth-local` }
        : { action: "connect-local-adapter", command: `account-center connect-agent --runtime ${connection.runtime} --scope ${connection.scope}` },
      accounts: connection.profileIds.flatMap((profileId) => {
        const profile = status.profiles.find((candidate) => candidate.id === profileId);
        const accountRef = accountRefById.get(profileId);
        if (!profile || !accountRef) return [];
        const verified = connection.verifiedProfileIds.includes(profileId);
        const route = status.routes.find((candidate) => candidate.runtime === connection.runtime && candidate.scope === connection.scope && candidate.order.includes(profileId));
        const routeState = route?.activeProfileId === profileId ? "selected" : route ? "available" : "not-routed";
        const weeklyRemainingPct = weeklyOnly(profile.usage.windows);
        const usable = connection.state === "connected" && verified && profile.usage.readable && profile.usage.auth.state === "ok";
        const state = usable ? "usable" : connection.state === "needs-auth" || !verified || profile.usage.auth.state !== "ok" ? "needs-auth" : "unavailable";
        return [{
          accountRef,
          state,
          weeklyRemainingPct,
          routeState,
          ...(usable ? { lease: createScopedAccountLease(connection, accountRef) } : {})
        }];
      })
    }))
  };
}

/** Adapter verification is explicit and scoped; it cannot reuse another runtime's proof. */
export function verifyAgentConnection(connection: AgentConnection, profileId: string): AgentConnection {
  if (!isSupportedConnection(connection) || !connection.profileIds.includes(profileId)) throw new Error("unknown_scoped_account");
  return {
    ...connection,
    state: "connected",
    verifiedProfileIds: Array.from(new Set([...connection.verifiedProfileIds, profileId]))
  };
}

function createScopedAccountLease(connection: AgentConnection & { runtime: "hermes" | "openclaw" }, accountRef: string): ScopedAccountLeaseContract {
  return {
    schemaVersion: "account-center.scoped-account-lease.v1",
    leaseRef: `lease-${connection.runtime}-${connection.scope.replace(/[^a-z0-9_-]/gi, "-")}-${accountRef}`,
    accountRef,
    runtime: connection.runtime,
    scope: connection.scope,
    state: "verified"
  };
}

function isSupportedConnection(value: AgentConnection): value is AgentConnection & { runtime: "hermes" | "openclaw" } {
  return (value.runtime === "hermes" || value.runtime === "openclaw") && /^[a-z][a-z0-9_-]{0,31}:[a-z0-9_-]{1,64}$/i.test(value.scope) && (value.state === "connected" || value.state === "needs-auth" || value.state === "unavailable");
}
function weeklyOnly(windows: Array<{ name: string; remainingPct: number | null }>): number | null {
  const value = windows.find((window) => window.name === "weekly")?.remainingPct;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}
function validTimestamp(value: string): boolean { return !Number.isNaN(Date.parse(value)); }
