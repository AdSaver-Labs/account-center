import type { AccountCenterStatus, AgentConnection } from "./schemas.js";
import { opaqueConnectionRef } from "./connection-refs.js";

export type AgentConnectionState = "connected" | "needs-auth" | "unavailable";

export interface ScopedAccountLeaseContract {
  schemaVersion: "account-center.scoped-account-lease.v1";
  leaseRef: string;
  connectionRef: string;
  accountRef: string;
  runtime: "hermes" | "openclaw";
  state: "verified";
}

export interface AgentConnectionInventory {
  schemaVersion: "account-center.agent-connections.v1";
  generatedAt: string;
  inventory: Array<{
    connectionRef: string;
    runtime: "hermes" | "openclaw";
    state: AgentConnectionState;
    onboarding: { action: "connect-local-adapter" | "reauth-local-adapter" };
    accounts: Array<{
      accountRef: string;
      state: "usable" | "needs-auth" | "unavailable";
      /** Owner-only redacted pairing evidence; never an inferred login identity. */
      pairing: "paired-verified" | "paired-unverified" | "unpaired";
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
    inventory: knownConnections.map((connection) => {
      const connectionRef = opaqueConnectionRef(connection.runtime, connection.id);
      return {
        connectionRef,
      runtime: connection.runtime,
      state: connection.state,
      onboarding: connection.state === "needs-auth"
        ? { action: "reauth-local-adapter" }
        : { action: "connect-local-adapter" },
      // A connected agent sees every canonical account in redacted form. Only
      // its explicit local pairing can make an individual row actionable.
      accounts: status.profiles.flatMap((profile) => {
        const accountRef = accountRefById.get(profile.id);
        if (!accountRef) return [];
        const paired = connection.profileIds.includes(profile.id);
        const verified = paired && connection.verifiedProfileIds.includes(profile.id);
        const route = status.routes.find((candidate) => candidate.runtime === connection.runtime && candidate.scope === connection.scope && candidate.order.includes(profile.id));
        const routeState = verified && route?.activeProfileId === profile.id ? "selected" : verified && route ? "available" : "not-routed";
        const weeklyRemainingPct = weeklyOnly(profile.usage.windows);
        const usable = connection.state === "connected" && verified && profile.usage.readable && profile.usage.auth.state === "ok";
        const pairing = verified ? "paired-verified" as const : paired ? "paired-unverified" as const : "unpaired" as const;
        const state = usable ? "usable" : paired ? "needs-auth" : "unavailable";
        return [{
          accountRef,
          state,
          pairing,
          weeklyRemainingPct,
          routeState,
          ...(usable ? { lease: createScopedAccountLease(connection, connectionRef, accountRef) } : {})
        }];
      })
    }})
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

function createScopedAccountLease(connection: AgentConnection & { runtime: "hermes" | "openclaw" }, connectionRef: string, accountRef: string): ScopedAccountLeaseContract {
  return {
    schemaVersion: "account-center.scoped-account-lease.v1",
    leaseRef: `lease-${connectionRef}-${accountRef}`,
    connectionRef,
    accountRef,
    runtime: connection.runtime,
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
