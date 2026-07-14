import test from "node:test";
import assert from "node:assert/strict";
import { IdempotencyRegistry, createMutationReview, verifyMutationApply } from "./index.js";

const secret = "test-only-mutation-contract-secret";
const input = {
  action: "route.use",
  provider: "openai",
  runtime: "openclaw",
  scope: { kind: "agent" as const, id: "main" },
  target: "openai:helper-2",
  payload: { preferred: true }
};

test("review token confirms only the exact action, scope, target, and payload", () => {
  const review = createMutationReview(input, { secret, now: new Date("2026-07-14T12:00:00.000Z"), ttlMs: 60_000 });
  const result = verifyMutationApply({ ...input, review, reviewToken: review.token }, { secret, now: new Date("2026-07-14T12:00:30.000Z") });
  assert.equal(result.kind, "confirmed");
  assert.equal(JSON.stringify(review).includes("openai:helper-2"), false);
});

test("review token blocks scope widening and changed request payload", () => {
  const review = createMutationReview(input, { secret, now: new Date("2026-07-14T12:00:00.000Z"), ttlMs: 60_000 });
  const widened = verifyMutationApply({ ...input, scope: { kind: "all", id: "all" }, review, reviewToken: review.token }, { secret, now: new Date("2026-07-14T12:00:30.000Z") });
  const changedPayload = verifyMutationApply({ ...input, payload: { preferred: false }, review, reviewToken: review.token }, { secret, now: new Date("2026-07-14T12:00:30.000Z") });
  assert.deepEqual(widened, { kind: "blocked", reason: "review_binding_mismatch" });
  assert.deepEqual(changedPayload, { kind: "blocked", reason: "review_binding_mismatch" });
});

test("review token expires and idempotency keys reject mismatched reuse", () => {
  const review = createMutationReview(input, { secret, now: new Date("2026-07-14T12:00:00.000Z"), ttlMs: 60_000 });
  const expired = verifyMutationApply({ ...input, review, reviewToken: review.token }, { secret, now: new Date("2026-07-14T12:01:01.000Z") });
  assert.deepEqual(expired, { kind: "blocked", reason: "review_expired" });

  const registry = new IdempotencyRegistry();
  assert.deepEqual(registry.claim("key-12345678", review.requestDigest), { kind: "new" });
  assert.deepEqual(registry.claim("key-12345678", review.requestDigest), { kind: "replay" });
  assert.deepEqual(registry.claim("key-12345678", "different-digest"), { kind: "blocked", reason: "idempotency_key_reused_with_different_request" });
});
