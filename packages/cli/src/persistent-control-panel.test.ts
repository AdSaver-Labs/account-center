import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AuditStore, AuthChallengeStore, MutationRepository } from "../../core/dist/index.js";
import { createPersistentControlPanel } from "./index.js";

test("persistent control panel reads the owner-only local state used by the launcher", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-panel-state-"));
  const token = "test-token";
  const challenges = new AuthChallengeStore(join(root, "auth-challenges.v1.json"));
  const audit = new AuditStore(join(root, "audit.v1.json"));
  const operations = new MutationRepository(join(root, "mutation-operations"));
  await challenges.create({ mode: "add", provider: "openai", runtime: "openclaw", target: "example@example.invalid", scope: "default" });
  await audit.append({ action: "guided_auth.cancel", outcome: "blocked", proofState: "not_applicable", requestDigest: "a".repeat(64), summary: "A local guided-auth challenge was cancelled.", warnings: [] });
  const claim = await operations.claim({ idempotencyKey: "test-idempotency-key-000", requestDigest: "b".repeat(64), audit: { action: "guided_auth.cancel", provider: "openai", runtime: "openclaw", scopeKind: "default", scopeIdDigest: "c".repeat(64), targetDigest: "d".repeat(64) } });
  assert.equal(claim.kind, "execute");
  if (claim.kind === "execute") await operations.complete({ operationId: claim.operationId, outcome: "not_applied" });
  const app = createPersistentControlPanel({ token, source: "fixture", stateRoot: root });
  const address = await app.listen();
  try {
    const headers = { authorization: `Bearer ${token}` };
    const [challengeResponse, auditResponse, operationResponse] = await Promise.all([
      fetch(`http://127.0.0.1:${address.port}/api/auth-challenges`, { headers }),
      fetch(`http://127.0.0.1:${address.port}/api/audit`, { headers }),
      fetch(`http://127.0.0.1:${address.port}/api/mutation-operations`, { headers })
    ]);
    assert.equal(challengeResponse.status, 200);
    assert.equal(auditResponse.status, 200);
    assert.equal(operationResponse.status, 200);
    const challengesView = await challengeResponse.json() as { challenges: Array<{ target?: unknown }> };
    const auditView = await auditResponse.json() as { records: unknown[] };
    const operationsView = await operationResponse.json() as { operations: unknown[] };
    assert.equal(challengesView.challenges.length, 1);
    assert.equal("target" in challengesView.challenges[0], false);
    assert.equal(auditView.records.length, 1);
    assert.equal(operationsView.operations.length, 1);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
