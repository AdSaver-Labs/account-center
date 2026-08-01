import { createHash } from "node:crypto";
import { AuditStore } from "./audit-store.js";
import { AuthChallengeStore } from "./auth-challenge-store.js";
import { AuthChallenge, AuthChallengeInput } from "./auth-challenges.js";

/**
 * Narrow local lifecycle boundary for already-validated guided-auth requests.
 * It owns only durable challenge/audit coordination; it has no runtime adapter,
 * credential, route, or native-delete authority.
 */
export async function executeGuidedAuthStart(
  input: AuthChallengeInput,
  dependencies: { challengeStore: AuthChallengeStore }
): Promise<{ kind: "created" | "reused"; challenge: AuthChallenge }> {
  const result = await dependencies.challengeStore.createWithResult(input);
  return { kind: result.created ? "created" : "reused", challenge: result.challenge };
}

/** Cancel only after the audit store has proven readable; never mutate on an unavailable audit dependency. */
export async function executeGuidedAuthCancel(
  id: string,
  dependencies: { challengeStore?: AuthChallengeStore; auditStore?: AuditStore }
): Promise<{ kind: "cancelled" | "unchanged" | "not_found" | "audit_unavailable"; challenge?: AuthChallenge }> {
  if (!dependencies.challengeStore) return { kind: "not_found" };
  if (!dependencies.auditStore) return { kind: "audit_unavailable" };
  try {
    await dependencies.auditStore.list({ limit: 1 });
  } catch {
    return { kind: "audit_unavailable" };
  }
  const cancellation = await dependencies.challengeStore.cancelWithResult(id);
  if (!cancellation) return { kind: "not_found" };
  if (!cancellation.changed) return { kind: "unchanged", challenge: cancellation.challenge };
  const challenge = cancellation.challenge;
  await dependencies.auditStore.append({
    action: "guided_auth.cancel",
    outcome: "applied",
    proofState: "verified",
    requestDigest: createHash("sha256").update(`guided_auth.cancel\0${challenge.id}`).digest("hex"),
    summary: "Local guided-auth challenge cancelled.",
    warnings: [],
    runtime: challenge.runtime,
    ...(auditScopeKind(challenge.scope) ? { scopeKind: auditScopeKind(challenge.scope) } : {})
  });
  return { kind: "cancelled", challenge };
}

/**
 * Fixture-safe terminal reauth boundary. It has no runtime adapter, login,
 * credential, route, or native-delete authority. Invalid/replayed proof leaves
 * durable state unchanged and produces no terminal audit claim.
 */
export async function executeGuidedAuthReauthTerminal(
  id: string,
  proof: unknown,
  dependencies: { challengeStore?: AuthChallengeStore; auditStore?: AuditStore },
  now = new Date()
): Promise<{ kind: "completed" | "failed" | "unchanged" | "not_found" | "audit_unavailable"; challenge?: AuthChallenge }> {
  if (!dependencies.challengeStore) return { kind: "not_found" };
  if (!dependencies.auditStore) return { kind: "audit_unavailable" };
  try { await dependencies.auditStore.list({ limit: 1 }); } catch { return { kind: "audit_unavailable" }; }
  const result = await dependencies.challengeStore.completeReauthWithProof(id, proof, now);
  if (result.kind !== "completed" && result.kind !== "failed") return result;
  const challenge = result.challenge!;
  await dependencies.auditStore.append({
    action: "guided_auth.reauth_terminal",
    outcome: result.kind === "completed" ? "applied" : "failed_no_change_verified",
    proofState: "verified",
    requestDigest: createHash("sha256").update(`guided_auth.reauth_terminal\0${challenge.id}\0${result.kind}`).digest("hex"),
    summary: result.kind === "completed" ? "Local guided-auth reauth completion evidence recorded." : "Local guided-auth reauth failure evidence recorded.",
    warnings: [], runtime: challenge.runtime,
    ...(auditScopeKind(challenge.scope) ? { scopeKind: auditScopeKind(challenge.scope) } : {})
  });
  return result;
}

function auditScopeKind(scope: string): "agent" | "profile" | "session" | "default" | "all" | undefined {
  const kind = scope.split(":", 1)[0];
  return kind === "agent" || kind === "profile" || kind === "session" || kind === "default" || kind === "all" ? kind : undefined;
}
