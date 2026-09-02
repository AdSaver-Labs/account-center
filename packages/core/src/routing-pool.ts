import { createHash } from "node:crypto";
import type { OpenClawRoutingPool } from "./runtime-adapters.js";

export interface PublicRoutingPoolView {
  schemaVersion: "account-center.openclaw-routing-pool.v1";
  agentRef: string;
  provider: "openai";
  verificationState: "UNPROVEN";
  candidates: Array<{ accountRef: string; state: "saved-unverified" }>;
  explicitOverrideOrder: string[];
  overrideState: "explicit" | "none";
}

/** The native IDs never leave this projection. This is inventory, not capacity or selection evidence. */
export function publicRoutingPoolView(pool: OpenClawRoutingPool): PublicRoutingPoolView {
  const refs = new Map(pool.profiles.map((id, index) => [id, `pool-account-${index + 1}`]));
  return {
    schemaVersion: "account-center.openclaw-routing-pool.v1",
    agentRef: opaqueAgentRef(pool.agentId),
    provider: "openai",
    verificationState: "UNPROVEN",
    candidates: pool.profiles.map((id) => ({ accountRef: refs.get(id)!, state: "saved-unverified" })),
    explicitOverrideOrder: pool.order.map((id) => refs.get(id)!),
    overrideState: pool.order.length ? "explicit" : "none"
  };
}

export function opaqueAgentRef(agentId: string): string {
  return `agent-${createHash("sha256").update(agentId).digest("hex").slice(0, 16)}`;
}
