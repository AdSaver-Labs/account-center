import type { AuthChallenge } from "./auth-challenges.js";
import { verifyReauthProof } from "./reauth-proof.js";

/**
 * Publicly safe readiness evidence for a future reauth transaction.
 *
 * This is deliberately not a mutation result: it neither starts login nor
 * writes credentials, changes routes, updates challenge state, or claims that
 * reauthentication has been applied. A native transaction must establish its
 * own lifecycle and post-apply evidence separately.
 */
export type ReauthCompletionReadiness =
  | { state: "VERIFIED"; next: "native_transaction_required" }
  | { state: "UNPROVEN"; next: "no_native_transaction" };

/**
 * Converts the private proof-validation taxonomy into one fixed, target-free
 * public readiness contract. Unexpected hostile values fail closed.
 */
export function assessReauthCompletionReadiness(
  challenge: AuthChallenge,
  proof: unknown,
  options: { now?: Date } = {}
): ReauthCompletionReadiness {
  try {
    const verification = verifyReauthProof(challenge, proof, options);
    return verification.kind === "verified"
      ? { state: "VERIFIED", next: "native_transaction_required" }
      : { state: "UNPROVEN", next: "no_native_transaction" };
  } catch {
    return { state: "UNPROVEN", next: "no_native_transaction" };
  }
}
