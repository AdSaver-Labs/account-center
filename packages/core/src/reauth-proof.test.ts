import test from "node:test";
import assert from "node:assert/strict";
import { createAuthChallenge } from "./auth-challenges.js";
import { verifyReauthProof } from "./reauth-proof.js";

const now = new Date("2026-07-29T22:00:00.000Z");
const challenge = createAuthChallenge(
  { mode: "reauth", provider: "openai", runtime: "openclaw", target: "private@example.test", scope: "default" },
  [],
  new Date("2026-07-29T21:00:00.000Z")
);
const proof = {
  schemaVersion: "account-center.reauth-proof.v1",
  challengeId: challenge.id,
  provider: "openai",
  runtime: "openclaw",
  scope: "default",
  observedAt: "2026-07-29T21:59:00.000Z",
  identity: "matched",
  health: "ok",
  replacement: "verified",
  result: "completed"
};

test("reauth completion proof requires bounded fresh identity, health, and replacement evidence", () => {
  assert.deepEqual(verifyReauthProof(challenge, proof, { now }), { kind: "verified" });
  assert.deepEqual(verifyReauthProof(challenge, { ...proof, health: "unknown" }, { now }), { kind: "UNPROVEN", reason: "reauth_proof_invalid" });
  assert.deepEqual(verifyReauthProof(challenge, { ...proof, observedAt: "2026-07-29T21:50:00.000Z" }, { now }), { kind: "UNPROVEN", reason: "reauth_proof_stale" });
  assert.deepEqual(verifyReauthProof(challenge, { ...proof, provider: "other" }, { now }), { kind: "UNPROVEN", reason: "reauth_proof_binding_mismatch" });
  assert.deepEqual(verifyReauthProof(challenge, { ...proof, result: "failed", health: "failed", replacement: "not_replaced" }, { now }), { kind: "verified" });
});

test("reauth proof rejects absent, terminal, credential-bearing, and arbitrary evidence without public disclosure", () => {
  assert.deepEqual(verifyReauthProof(challenge, undefined, { now }), { kind: "UNPROVEN", reason: "reauth_proof_absent" });
  assert.deepEqual(verifyReauthProof({ ...challenge, status: "cancelled" }, proof, { now }), { kind: "UNPROVEN", reason: "reauth_challenge_not_pending" });
  assert.deepEqual(verifyReauthProof(challenge, { ...proof, token: "not-allowed" }, { now }), { kind: "UNPROVEN", reason: "reauth_proof_invalid" });
  const inherited = Object.create(proof) as object;
  assert.deepEqual(verifyReauthProof(challenge, inherited, { now }), { kind: "UNPROVEN", reason: "reauth_proof_invalid" });
  assert.equal(JSON.stringify(verifyReauthProof(challenge, { ...proof, token: "private-token" }, { now })).includes("private-token"), false);
});
