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

export interface AuthChallenge extends AuthChallengeInput {
  id: string;
  key: string;
  status: AuthChallengeStatus;
  createdAt: string;
  updatedAt: string;
}

export function createAuthChallenge(input: AuthChallengeInput, existing: AuthChallenge[] = []): AuthChallenge {
  const normalized = { ...input, target: input.target.trim().toLowerCase(), provider: input.provider.trim().toLowerCase(), runtime: input.runtime.trim().toLowerCase(), scope: input.scope.trim() };
  const key = challengeKey(normalized);
  const active = existing.find((item) => item.key === key && item.status === "pending");
  if (active) return active;
  const now = new Date().toISOString();
  return { ...normalized, id: `auth_${randomUUID()}`, key, status: "pending", createdAt: now, updatedAt: now };
}

export function cancelAuthChallenge(challenge: AuthChallenge): AuthChallenge {
  if (challenge.status !== "pending") return challenge;
  return { ...challenge, status: "cancelled", updatedAt: new Date().toISOString() };
}

export function getAuthChallenge(challenges: AuthChallenge[], id: string): AuthChallenge | undefined {
  return challenges.find((challenge) => challenge.id === id);
}

function challengeKey(input: AuthChallengeInput): string {
  return createHash("sha256").update([input.provider, input.runtime, input.target.trim().toLowerCase(), input.scope].join("\0")).digest("hex");
}
