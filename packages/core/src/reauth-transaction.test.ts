import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MutationRepository } from "./mutation-repository.js";
import { executeReauthTransaction } from "./reauth-transaction.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const challengeId = `auth_${randomUUID()}`;

async function withRepository(run: (repository: MutationRepository) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "account-center-reauth-"));
  try { await run(new MutationRepository(root)); } finally { await rm(root, { recursive: true, force: true }); }
}
function request(key = "a".repeat(22)) {
  return { challengeId, provider: "openai", runtime: "openclaw", scopeKind: "agent" as const, scopeIdDigest: digest("agent"), targetDigest: digest("prior-working-auth"), requestDigest: digest("reauth-request"), idempotencyKey: key, routeDecision: "switch_after_verification" as const };
}

test("reauth transaction stages, verifies identity and health, then optionally decides route with a redacted durable receipt", async () => {
  await withRepository(async (repository) => {
    const order: string[] = [];
    const result = await executeReauthTransaction(request(), {
      repository,
      stage: async (id) => { order.push(`stage:${id}`); return { state: "staged" }; },
      verifyIdentityAndHealth: async (id) => { order.push(`verify:${id}`); return { state: "verified" }; },
      decideRoute: async (id) => { order.push(`route:${id}`); return { state: "applied" }; }
    });
    assert.deepEqual(order, [`stage:${challengeId}`, `verify:${challengeId}`, `route:${challengeId}`]);
    assert.deepEqual({ outcome: result.outcome, verification: result.verification, route: result.route, replayed: result.replayed, warnings: result.warnings }, { outcome: "applied", verification: "verified", route: "applied", replayed: false, warnings: [] });
    assert.match(result.operationId, /^op_/);
    const [receipt] = await repository.list();
    assert.deepEqual(receipt && { action: receipt.audit.action, provider: receipt.audit.provider, runtime: receipt.audit.runtime, scopeKind: receipt.audit.scopeKind, warningCodes: receipt.audit.warningCodes }, { action: "auth.reauth", provider: "openai", runtime: "openclaw", scopeKind: "agent", warningCodes: [] });
    assert.equal(JSON.stringify(receipt).includes("prior-working-auth"), false);
  });
});

test("failed or UNPROVEN verification preserves prior auth by never deciding a route", async () => {
  for (const verification of ["failed", "unproven"] as const) {
    await withRepository(async (repository) => {
      let routeCalls = 0;
      const result = await executeReauthTransaction(request(verification === "failed" ? "b".repeat(22) : "c".repeat(22)), {
        repository,
        stage: async () => ({ state: "staged" }),
        verifyIdentityAndHealth: async () => ({ state: verification }),
        decideRoute: async () => { routeCalls += 1; return { state: "applied" }; }
      });
      assert.equal(routeCalls, 0);
      assert.deepEqual({ outcome: result.outcome, verification: result.verification, route: result.route, warnings: result.warnings }, { outcome: "not_applied", verification, route: "not_requested", warnings: [verification === "failed" ? "reauth_identity_health_failed" : "reauth_identity_health_unproven"] });
    });
  }
});

test("reauth transaction replays a terminal receipt without repeating stage, verification, or route decision", async () => {
  await withRepository(async (repository) => {
    let calls = 0;
    const dependencies = { repository, stage: async () => { calls += 1; return { state: "staged" as const }; }, verifyIdentityAndHealth: async () => { calls += 1; return { state: "verified" as const }; }, decideRoute: async () => { calls += 1; return { state: "applied" as const }; } };
    const first = await executeReauthTransaction(request("d".repeat(22)), dependencies);
    const replay = await executeReauthTransaction(request("d".repeat(22)), dependencies);
    assert.equal(calls, 3);
    assert.equal(replay.replayed, true);
    assert.equal(replay.operationId, first.operationId);
    assert.deepEqual(replay.warnings, ["idempotency_replay"]);
  });
});

test("reauth transaction rejects raw target-like inputs by accepting only fixed-length digests", async () => {
  await withRepository(async (repository) => {
    await assert.rejects(() => executeReauthTransaction({ ...request(), targetDigest: "someone@example.test" }, { repository, stage: async () => ({ state: "staged" }), verifyIdentityAndHealth: async () => ({ state: "verified" }) }), /invalid_reauth_digest/);
  });
});
