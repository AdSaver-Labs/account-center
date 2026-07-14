import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type MutationScopeKind = "agent" | "profile" | "session" | "default" | "all";

export interface MutationScope {
  kind: MutationScopeKind;
  id: string;
}

export interface MutationReviewInput {
  action: string;
  provider: string;
  runtime: string;
  scope: MutationScope;
  target: string;
  payload?: Record<string, unknown>;
}

export interface MutationReview {
  schemaVersion: "account-center.mutation-review.v1";
  action: string;
  provider: string;
  runtime: string;
  scope: MutationScope;
  targetDigest: string;
  requestDigest: string;
  issuedAt: string;
  expiresAt: string;
  token: string;
}

export type MutationReviewVerification =
  | { kind: "confirmed"; requestDigest: string }
  | { kind: "blocked"; reason: "review_expired" | "review_binding_mismatch" | "review_token_invalid" };

export function createMutationReview(input: MutationReviewInput, options: { secret: string; now?: Date; ttlMs?: number }): MutationReview {
  const now = options.now ?? new Date();
  const ttlMs = options.ttlMs ?? 5 * 60_000;
  if (!Number.isInteger(ttlMs) || ttlMs < 1) throw new Error("ttlMs must be a positive integer");
  const binding = mutationBinding(input);
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  const unsigned = { schemaVersion: "account-center.mutation-review.v1" as const, ...binding, issuedAt, expiresAt };
  return { ...unsigned, token: sign(unsigned, options.secret) };
}

export function verifyMutationApply(input: MutationReviewInput & { review: MutationReview; reviewToken: string }, options: { secret: string; now?: Date }): MutationReviewVerification {
  const now = options.now ?? new Date();
  if (Date.parse(input.review.expiresAt) <= now.getTime()) return { kind: "blocked", reason: "review_expired" };
  const { token: _ignored, ...unsigned } = input.review;
  if (!sameToken(input.reviewToken, sign(unsigned, options.secret))) return { kind: "blocked", reason: "review_token_invalid" };
  const binding = mutationBinding(input);
  if (binding.action !== input.review.action || binding.provider !== input.review.provider || binding.runtime !== input.review.runtime || binding.targetDigest !== input.review.targetDigest || binding.requestDigest !== input.review.requestDigest || binding.scope.kind !== input.review.scope.kind || binding.scope.id !== input.review.scope.id) {
    return { kind: "blocked", reason: "review_binding_mismatch" };
  }
  return { kind: "confirmed", requestDigest: input.review.requestDigest };
}

export class IdempotencyRegistry {
  private readonly requests = new Map<string, string>();

  claim(key: string, requestDigest: string): { kind: "new" | "replay" } | { kind: "blocked"; reason: "idempotency_key_reused_with_different_request" } {
    if (!key.trim()) throw new Error("idempotency key is required");
    const previous = this.requests.get(key);
    if (!previous) {
      this.requests.set(key, requestDigest);
      return { kind: "new" };
    }
    if (previous === requestDigest) return { kind: "replay" };
    return { kind: "blocked", reason: "idempotency_key_reused_with_different_request" };
  }
}

function mutationBinding(input: MutationReviewInput): Omit<MutationReview, "schemaVersion" | "issuedAt" | "expiresAt" | "token"> {
  assertInput(input);
  const targetDigest = digest(input.target);
  const requestDigest = digest(canonical({ action: input.action, provider: input.provider, runtime: input.runtime, scope: input.scope, targetDigest, payload: input.payload ?? {} }));
  return { action: input.action, provider: input.provider, runtime: input.runtime, scope: { kind: input.scope.kind, id: input.scope.id }, targetDigest, requestDigest };
}

function assertInput(input: MutationReviewInput): void {
  if (!input.action.trim() || !input.provider.trim() || !input.runtime.trim() || !input.target.trim() || !input.scope.id.trim()) throw new Error("mutation review requires action, provider, runtime, scope, and target");
  if (input.scope.kind === "all" && input.scope.id !== "all") throw new Error("all scope must use id=all");
}

function sign(value: unknown, secret: string): string {
  if (!secret) throw new Error("review signing secret is required");
  return createHmac("sha256", secret).update(canonical(value)).digest("base64url");
}

function sameToken(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
