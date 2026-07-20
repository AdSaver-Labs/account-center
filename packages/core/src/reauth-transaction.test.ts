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

test("reauth replay retains failed and UNPROVEN verification categories without repeating dependencies", async () => {
  for (const verification of ["failed", "unproven"] as const) {
    await withRepository(async (repository) => {
      let calls = 0;
      const dependencies = {
        repository,
        stage: async () => { calls += 1; return { state: "staged" as const }; },
        verifyIdentityAndHealth: async () => { calls += 1; return { state: verification }; },
        decideRoute: async () => { calls += 1; return { state: "applied" as const }; }
      };
      await executeReauthTransaction(request(verification === "failed" ? "e".repeat(22) : "f".repeat(22)), dependencies);
      const replay = await executeReauthTransaction(request(verification === "failed" ? "e".repeat(22) : "f".repeat(22)), dependencies);
      assert.equal(calls, 2);
      assert.deepEqual({ verification: replay.verification, route: replay.route, replayed: replay.replayed }, { verification, route: "not_requested", replayed: true });
    });
  }
});

test("reauth replay retains the verified route decision outcome without repeating dependencies", async () => {
  for (const route of ["applied", "not_applied", "unproven"] as const) {
    await withRepository(async (repository) => {
      let calls = 0;
      const dependencies = {
        repository,
        stage: async () => { calls += 1; return { state: "staged" as const }; },
        verifyIdentityAndHealth: async () => { calls += 1; return { state: "verified" as const }; },
        decideRoute: async () => { calls += 1; return { state: route }; }
      };
      await executeReauthTransaction(request(`route${route}`.padEnd(22, "x")), dependencies);
      const replay = await executeReauthTransaction(request(`route${route}`.padEnd(22, "x")), dependencies);
      assert.equal(calls, 3);
      assert.deepEqual({ verification: replay.verification, route: replay.route, replayed: replay.replayed }, { verification: "verified", route, replayed: true });
    });
  }
});

test("reauth replay fails closed when durable reauth evidence is missing or malformed", async () => {
  for (const evidence of [undefined, { reauth: { verification: "verified" } }]) {
    let calls = 0;
    const repository = {
      claim: async () => ({
        kind: "replay" as const,
        operationId: "op_reauth_replay",
        outcome: "applied" as const,
        receipt: { audit: { warningCodes: [] }, evidence }
      })
    } as unknown as MutationRepository;
    const result = await executeReauthTransaction(request("g".repeat(22)), {
      repository,
      stage: async () => { calls += 1; throw new Error("must not stage on replay"); },
      verifyIdentityAndHealth: async () => { calls += 1; throw new Error("must not verify on replay"); },
      decideRoute: async () => { calls += 1; throw new Error("must not route on replay"); }
    });
    assert.equal(calls, 0);
    assert.deepEqual({ outcome: result.outcome, verification: result.verification, route: result.route, replayed: result.replayed }, { outcome: "not_applied", verification: "unproven", route: "not_requested", replayed: true });
  }
});

test("reauth direct replay fails closed for evidence with an unknown top-level key without invoking dependencies", async () => {
  let calls = 0;
  const repository = {
    claim: async () => ({
      kind: "replay" as const,
      operationId: "op_reauth_malformed_replay",
      outcome: "applied" as const,
      receipt: { audit: { warningCodes: [] }, evidence: { receiptId: "evt_reauth_malformed", verification: "verified", reauth: { verification: "verified", route: "not_requested" }, unexpected: "rejected" } }
    })
  } as unknown as MutationRepository;
  const result = await executeReauthTransaction(request("malformed-replay".padEnd(22, "x")), {
    repository,
    stage: async () => { calls += 1; throw new Error("must not stage on replay"); },
    verifyIdentityAndHealth: async () => { calls += 1; throw new Error("must not verify on replay"); },
    decideRoute: async () => { calls += 1; throw new Error("must not route on replay"); }
  });
  assert.equal(calls, 0);
  assert.deepEqual({ outcome: result.outcome, verification: result.verification, route: result.route, replayed: result.replayed }, { outcome: "not_applied", verification: "unproven", route: "not_requested", replayed: true });
});

test("reauth direct replay returns the fixed safe result for malformed nested durable evidence without invoking dependencies", async () => {
  for (const evidence of [
    { receiptId: "evt_reauth_nested", verification: "verified", reauth: { verification: "verified", route: "not_requested", unexpected: true } },
    { receiptId: "evt_reauth_nested", verification: "verified", proof: null }
  ]) {
    let calls = 0;
    const repository = {
      claim: async () => ({
        kind: "replay" as const,
        operationId: "op_reauth_nested_replay",
        outcome: "applied" as const,
        receipt: { audit: { warningCodes: [] }, evidence }
      })
    } as unknown as MutationRepository;
    const result = await executeReauthTransaction(request("nested-malformed-replay".slice(0, 22)), {
      repository,
      stage: async () => { calls += 1; throw new Error("must not stage on replay"); },
      verifyIdentityAndHealth: async () => { calls += 1; throw new Error("must not verify on replay"); },
      decideRoute: async () => { calls += 1; throw new Error("must not route on replay"); }
    });
    assert.equal(calls, 0);
    assert.deepEqual({ outcome: result.outcome, verification: result.verification, route: result.route, replayed: result.replayed }, { outcome: "not_applied", verification: "unproven", route: "not_requested", replayed: true });
  }
});

test("reauth replay fails closed for route evidence paired with failed or UNPROVEN verification", async () => {
  for (const reauth of [
    { verification: "failed", route: "applied" },
    { verification: "failed", route: "not_applied" },
    { verification: "failed", route: "unproven" },
    { verification: "unproven", route: "applied" },
    { verification: "unproven", route: "not_applied" },
    { verification: "unproven", route: "unproven" }
  ] as const) {
    let calls = 0;
    const repository = {
      claim: async () => ({
        kind: "replay" as const,
        operationId: "op_reauth_invalid_replay",
        outcome: "applied" as const,
        receipt: { audit: { warningCodes: [] }, evidence: { reauth } }
      })
    } as unknown as MutationRepository;
    const result = await executeReauthTransaction(request(`${reauth.verification}${reauth.route}`.padEnd(22, "x")), {
      repository,
      stage: async () => { calls += 1; throw new Error("must not stage on replay"); },
      verifyIdentityAndHealth: async () => { calls += 1; throw new Error("must not verify on replay"); },
      decideRoute: async () => { calls += 1; throw new Error("must not route on replay"); }
    });
    assert.equal(calls, 0);
    assert.deepEqual({ outcome: result.outcome, verification: result.verification, route: result.route, replayed: result.replayed }, { outcome: "not_applied", verification: "unproven", route: "not_requested", replayed: true });
  }
});

test("reauth replay fails closed for valid evidence paired with a contradictory receipt outcome", async () => {
  let calls = 0;
  const repository = {
    claim: async () => ({
      kind: "replay" as const,
      operationId: "op_reauth_corrupt_outcome",
      outcome: "applied" as const,
      receipt: { audit: { warningCodes: [] }, evidence: { reauth: { verification: "verified" as const, route: "not_applied" as const } } }
    })
  } as unknown as MutationRepository;
  const result = await executeReauthTransaction(request("outcome-corrupt".padEnd(22, "x")), {
    repository,
    stage: async () => { calls += 1; throw new Error("must not stage on replay"); },
    verifyIdentityAndHealth: async () => { calls += 1; throw new Error("must not verify on replay"); },
    decideRoute: async () => { calls += 1; throw new Error("must not route on replay"); }
  });
  assert.equal(calls, 0);
  assert.deepEqual({ outcome: result.outcome, verification: result.verification, route: result.route, replayed: result.replayed }, { outcome: "not_applied", verification: "unproven", route: "not_requested", replayed: true });
});

test("reauth transaction rejects raw target-like inputs by accepting only fixed-length digests", async () => {
  await withRepository(async (repository) => {
    await assert.rejects(() => executeReauthTransaction({ ...request(), targetDigest: "someone@example.test" }, { repository, stage: async () => ({ state: "staged" }), verifyIdentityAndHealth: async () => ({ state: "verified" }) }), /invalid_reauth_digest/);
  });
});
