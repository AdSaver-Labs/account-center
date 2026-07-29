import type { AuthChallenge } from "./auth-challenges.js";

/**
 * Bounded, target-free evidence required before any future native reauth
 * adapter may report a replacement credential as verified. This validator does
 * not perform login, credential writes, or route changes.
 */
export interface ReauthProof {
  schemaVersion: "account-center.reauth-proof.v1";
  challengeId: string;
  provider: string;
  runtime: string;
  scope: string;
  observedAt: string;
  identity: "matched";
  health: "ok";
  replacement: "verified";
}

export type ReauthProofVerification =
  | { kind: "verified" }
  | { kind: "UNPROVEN"; reason: "reauth_proof_absent" | "reauth_challenge_not_pending" | "reauth_proof_invalid" | "reauth_proof_binding_mismatch" | "reauth_proof_stale" };

const MAX_PROOF_AGE_MS = 5 * 60_000;
const PROOF_KEYS = new Set(["schemaVersion", "challengeId", "provider", "runtime", "scope", "observedAt", "identity", "health", "replacement"]);

/** Fail closed: only exact, fresh, non-secret evidence bound to one pending challenge verifies. */
export function verifyReauthProof(challenge: AuthChallenge, value: unknown, options: { now?: Date } = {}): ReauthProofVerification {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { kind: "UNPROVEN", reason: "reauth_proof_absent" };
  if (challenge.mode !== "reauth" || challenge.status !== "pending") return { kind: "UNPROVEN", reason: "reauth_challenge_not_pending" };
  const proof = value as Partial<ReauthProof>;
  if (Object.keys(proof).length !== PROOF_KEYS.size || !Object.keys(proof).every((key) => PROOF_KEYS.has(key) && Object.prototype.hasOwnProperty.call(proof, key)) ||
      proof.schemaVersion !== "account-center.reauth-proof.v1" ||
      typeof proof.challengeId !== "string" || typeof proof.provider !== "string" || typeof proof.runtime !== "string" ||
      typeof proof.scope !== "string" || typeof proof.observedAt !== "string" || proof.identity !== "matched" || proof.health !== "ok" || proof.replacement !== "verified") {
    return { kind: "UNPROVEN", reason: "reauth_proof_invalid" };
  }
  if (proof.challengeId !== challenge.id || proof.provider !== challenge.provider || proof.runtime !== challenge.runtime || proof.scope !== challenge.scope) return { kind: "UNPROVEN", reason: "reauth_proof_binding_mismatch" };
  const observed = new Date(proof.observedAt);
  const now = options.now ?? new Date();
  if (!Number.isFinite(observed.getTime()) || observed.toISOString() !== proof.observedAt || observed.getTime() > now.getTime() || now.getTime() - observed.getTime() > MAX_PROOF_AGE_MS) return { kind: "UNPROVEN", reason: "reauth_proof_stale" };
  return { kind: "verified" };
}
