import { createHash } from "node:crypto";
import { MutationRepository, type ReauthReceiptEvidence } from "./mutation-repository.js";
import type { MutationScopeKind } from "./mutation-contract.js";

/**
 * A deliberately credential-blind reauthentication transaction. Runtime-specific
 * adapters own any external authentication UI; this coordinator receives only an
 * opaque local challenge id and safe verification categories.
 */
export interface ReauthTransactionRequest {
  challengeId: string;
  provider: string;
  runtime: string;
  scopeKind: MutationScopeKind;
  scopeIdDigest: string;
  targetDigest: string;
  requestDigest: string;
  idempotencyKey: string;
  routeDecision?: "keep_existing" | "switch_after_verification";
}

export type ReauthVerification = "verified" | "failed" | "unproven";
export type ReauthRouteResult = "applied" | "not_applied" | "unproven";
export interface ReauthTransactionDependencies {
  repository: MutationRepository;
  stage(challengeId: string): Promise<{ state: "staged" | "failed" }>;
  verifyIdentityAndHealth(challengeId: string): Promise<{ state: ReauthVerification }>;
  decideRoute?(challengeId: string): Promise<{ state: ReauthRouteResult }>;
}

export interface ReauthTransactionResult {
  operationId: string;
  outcome: "applied" | "not_applied" | "failed";
  verification: ReauthVerification;
  route: "not_requested" | ReauthRouteResult;
  replayed: boolean;
  warnings: string[];
}

export async function executeReauthTransaction(request: ReauthTransactionRequest, deps: ReauthTransactionDependencies): Promise<ReauthTransactionResult> {
  assertRequest(request);
  const claim = await deps.repository.claim({
    idempotencyKey: request.idempotencyKey,
    requestDigest: request.requestDigest,
    audit: {
      action: "auth.reauth",
      provider: request.provider,
      runtime: request.runtime,
      scopeKind: request.scopeKind,
      scopeIdDigest: request.scopeIdDigest,
      targetDigest: request.targetDigest
    }
  });
  if (claim.kind === "replay") {
    const evidence = reauthEvidence(claim.receipt.evidence?.reauth);
    return replayResult(claim.operationId, claim.outcome, evidence?.verification ?? "unproven", evidence?.route ?? "not_requested", claim.receipt.audit.warningCodes);
  }
  if (claim.kind === "blocked") throw new Error(claim.reason);

  const staged = await deps.stage(request.challengeId);
  if (staged.state !== "staged") return complete(deps.repository, claim.operationId, "failed", "unproven", "not_requested", ["reauth_stage_failed"]);

  const verification = await deps.verifyIdentityAndHealth(request.challengeId);
  if (verification.state !== "verified") {
    // Do not switch routes or retire prior working auth without fresh identity
    // and health proof. An unavailable verifier is explicitly UNPROVEN.
    return complete(deps.repository, claim.operationId, "not_applied", verification.state, "not_requested", [verification.state === "failed" ? "reauth_identity_health_failed" : "reauth_identity_health_unproven"]);
  }

  if (request.routeDecision !== "switch_after_verification") return complete(deps.repository, claim.operationId, "applied", "verified", "not_requested", []);
  if (!deps.decideRoute) return complete(deps.repository, claim.operationId, "not_applied", "verified", "unproven", ["reauth_route_decision_unavailable"]);
  const route = await deps.decideRoute(request.challengeId);
  if (route.state !== "applied") return complete(deps.repository, claim.operationId, "not_applied", "verified", route.state, [route.state === "unproven" ? "reauth_route_decision_unproven" : "reauth_route_not_applied"]);
  return complete(deps.repository, claim.operationId, "applied", "verified", "applied", []);
}

async function complete(repository: MutationRepository, operationId: string, outcome: "applied" | "not_applied" | "failed", verification: ReauthVerification, route: ReauthTransactionResult["route"], warnings: string[]): Promise<ReauthTransactionResult> {
  await repository.complete({
    operationId,
    outcome,
    warningCodes: warnings,
    evidence: {
      receiptId: `evt_${opaqueId(operationId)}`,
      verification: verification === "verified" ? "verified" : "unproven",
      liveRuntimeMutation: false,
      reauth: { verification, route }
    }
  });
  return { operationId, outcome, verification, route, replayed: false, warnings: [...warnings] };
}

function replayResult(operationId: string, outcome: "applied" | "not_applied" | "blocked" | "failed", verification: ReauthVerification, route: ReauthTransactionResult["route"], warnings: string[]): ReauthTransactionResult {
  return { operationId, outcome: outcome === "blocked" ? "not_applied" : outcome, verification, route, replayed: true, warnings: ["idempotency_replay", ...warnings] };
}

function reauthEvidence(value: unknown): ReauthReceiptEvidence | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const evidence = value as Partial<ReauthReceiptEvidence>;
  if ((evidence.verification !== "verified" && evidence.verification !== "failed" && evidence.verification !== "unproven") || (evidence.route !== "not_requested" && evidence.route !== "applied" && evidence.route !== "not_applied" && evidence.route !== "unproven")) return undefined;
  return { verification: evidence.verification, route: evidence.route };
}

function assertRequest(value: ReauthTransactionRequest): void {
  if (!/^auth_[a-f0-9-]{36}$/.test(value.challengeId)) throw new Error("invalid_challenge_id");
  for (const identifier of [value.provider, value.runtime]) if (!/^[a-z][a-z0-9._-]{0,63}$/.test(identifier)) throw new Error("invalid_reauth_identifier");
  if (!["agent", "profile", "session", "default", "all"].includes(value.scopeKind)) throw new Error("invalid_reauth_scope_kind");
  for (const digest of [value.scopeIdDigest, value.targetDigest, value.requestDigest]) if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("invalid_reauth_digest");
  if (!/^[A-Za-z0-9_-]{22,128}$/.test(value.idempotencyKey)) throw new Error("invalid_reauth_idempotency_key");
  if (value.routeDecision !== undefined && value.routeDecision !== "keep_existing" && value.routeDecision !== "switch_after_verification") throw new Error("invalid_reauth_route_decision");
}
function opaqueId(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 24); }
