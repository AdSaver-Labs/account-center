import test from "node:test";
import assert from "node:assert/strict";
import { createAuthChallenge } from "./auth-challenges.js";
import { assessReauthCompletionReadiness } from "./reauth-completion-evidence.js";

const now = new Date("2026-07-30T12:00:00.000Z");
const challenge = createAuthChallenge(
  { mode: "reauth", provider: "openai", runtime: "openclaw", target: "private@example.test", scope: "default" },
  [],
  new Date("2026-07-30T11:00:00.000Z")
);
const proof = {
  schemaVersion: "account-center.reauth-proof.v1",
  challengeId: challenge.id,
  provider: "openai",
  runtime: "openclaw",
  scope: "default",
  observedAt: "2026-07-30T11:59:00.000Z",
  identity: "matched",
  health: "ok",
  replacement: "verified"
};

test("reauth completion readiness is proof-only and never claims a native apply", () => {
  assert.deepEqual(
    assessReauthCompletionReadiness(challenge, proof, { now }),
    { state: "VERIFIED", next: "native_transaction_required" }
  );
});

test("reauth completion readiness fails closed to one target-free contract", () => {
  const expected = { state: "UNPROVEN", next: "no_native_transaction" };
  for (const hostile of [
    undefined,
    { ...proof, token: "private-token" },
    { ...proof, observedAt: "2026-07-30T11:50:00.000Z" },
    { ...proof, challengeId: "private-challenge-id" },
    Object.create(proof)
  ]) {
    const result = assessReauthCompletionReadiness(challenge, hostile, { now });
    assert.deepEqual(result, expected);
    assert.doesNotMatch(JSON.stringify(result), /private|token|challenge/i);
  }

  const throwing = new Proxy({}, { ownKeys() { throw new Error("hostile proof"); } });
  assert.deepEqual(assessReauthCompletionReadiness(challenge, throwing, { now }), expected);
});
