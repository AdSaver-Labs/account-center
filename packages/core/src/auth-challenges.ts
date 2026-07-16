import { createHash, randomUUID } from "node:crypto";

export type AuthChallengeMode = "add" | "reauth";
export type AuthChallengeStatus = "pending" | "completed" | "failed" | "cancelled" | "expired";

export interface AuthChallengeInput {
  mode: AuthChallengeMode;
  provider: string;
  runtime: string;
  target: string;
  scope: string;
  expiresAt?: string;
}

export interface AuthChallenge extends Omit<AuthChallengeInput, "target"> {
  id: string;
  key: string;
  status: AuthChallengeStatus;
  createdAt: string;
  updatedAt: string;
}

export function createAuthChallenge(input: AuthChallengeInput, existing: AuthChallenge[] = [], now = new Date()): AuthChallenge {
  const normalized = { ...input, target: input.target.trim().toLowerCase(), provider: input.provider.trim().toLowerCase(), runtime: input.runtime.trim().toLowerCase(), scope: input.scope.trim() };
  assertPublicChallengeMetadata(normalized);
  assertExpiry(normalized.expiresAt);
  const key = challengeKey(normalized);
  const active = existing.map((item) => expireAuthChallenge(item, now)).find((item) => item.key === key && item.status === "pending");
  if (active) return active;
  const timestamp = now.toISOString();
  const { target: _target, ...redacted } = normalized;
  return { ...redacted, id: `auth_${randomUUID()}`, key, status: "pending", createdAt: timestamp, updatedAt: timestamp };
}

/** Metadata returned by the redacted challenge APIs must remain safe identifiers. */
export function isSafePublicChallengeMetadata(value: Pick<AuthChallenge, "provider" | "runtime" | "scope">): boolean {
  return /^[a-z][a-z0-9._-]{0,63}$/.test(value.provider) &&
    /^[a-z][a-z0-9._-]{0,63}$/.test(value.runtime) &&
    /^[a-z][a-z0-9_-]{0,31}(?::[A-Za-z0-9._-]{1,96})?$/.test(value.scope);
}

export function expireAuthChallenge(challenge: AuthChallenge, now = new Date()): AuthChallenge {
  if (challenge.status !== "pending" || !challenge.expiresAt) return challenge;
  const expiry = parseExpiry(challenge.expiresAt);
  if (expiry.getTime() > now.getTime()) return challenge;
  return { ...challenge, status: "expired", updatedAt: now.toISOString() };
}

export function cancelAuthChallenge(challenge: AuthChallenge, now = new Date()): AuthChallenge {
  const current = expireAuthChallenge(challenge, now);
  if (current.status !== "pending") return current;
  return { ...current, status: "cancelled", updatedAt: now.toISOString() };
}

export function getAuthChallenge(challenges: AuthChallenge[], id: string): AuthChallenge | undefined {
  return challenges.find((challenge) => challenge.id === id);
}

function challengeKey(input: AuthChallengeInput): string {
  return createHash("sha256").update([input.mode, input.provider, input.runtime, input.target.trim().toLowerCase(), input.scope].join("\0")).digest("hex");
}

function assertExpiry(value: string | undefined): void { if (value) parseExpiry(value); }
function assertPublicChallengeMetadata(value: Pick<AuthChallenge, "provider" | "runtime" | "scope">): void {
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(value.provider)) throw new Error("invalid challenge provider");
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(value.runtime)) throw new Error("invalid challenge runtime");
  if (!/^[a-z][a-z0-9_-]{0,31}(?::[A-Za-z0-9._-]{1,96})?$/.test(value.scope)) throw new Error("invalid challenge scope");
}
function parseExpiry(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new Error("invalid challenge expiry");
  return parsed;
}
