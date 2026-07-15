import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditStore, AuthChallengeStore, MutationRepository } from "@account-center/core";
import { createAccountCenterServer } from "./server.js";

async function request(port: number, path: string, token?: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
}

test("local API requires bearer token and returns no-store status", async () => {
  const app = createAccountCenterServer({ token: "test-token" });
  const address = await app.listen();
  try {
    const denied = await request(address.port, "/api/status");
    assert.equal(denied.status, 401);
    const accepted = await request(address.port, "/api/status", "test-token");
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get("cache-control"), "no-store");
  } finally {
    await app.close();
  }
});

test("read-only model catalog is bearer-protected, versioned, and reflects disabled policy without profile metadata", async () => {
  const app = createAccountCenterServer({ token: "test-token" });
  const address = await app.listen();
  try {
    assert.equal((await request(address.port, "/api/models")).status, 401);
    const accepted = await request(address.port, "/api/models", "test-token");
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get("cache-control"), "no-store");
    const body = await accepted.json() as { schemaVersion: string; generatedAt: string; models: Array<{ id: string; selectable: boolean; reason?: string }> };
    assert.equal(body.schemaVersion, "account-center.models.v1");
    assert.match(body.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(body.models, [
      { id: "openai/gpt-4.1", selectable: false, reason: "disabled_by_policy" },
      { id: "openai/gpt-5.3-codex", selectable: true },
      { id: "openai/gpt-5.5", selectable: true }
    ]);
    assert.equal(JSON.stringify(body).match(/profileId|email|token|secret|password/i), null);
  } finally {
    await app.close();
  }
});

test("agent capability contract is bearer-protected, redacted, and explicit about unavailable mutations", async () => {
  const app = createAccountCenterServer({ token: "test-token" });
  const address = await app.listen();
  try {
    assert.equal((await request(address.port, "/api/capabilities")).status, 401);
    const accepted = await request(address.port, "/api/capabilities", "test-token");
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get("cache-control"), "no-store");
    const body = await accepted.json() as { schemaVersion: string; target: string; actions: Array<{ id: string; mode: string; state: string; requires: string[]; endpoint?: { method: string; path: string }; reason?: string }> };
    assert.equal(body.schemaVersion, "account-center.agent-capabilities.v1");
    assert.equal(body.target, "account-center");
    assert.deepEqual(body.actions.find((action) => action.id === "status"), { id: "status", mode: "read", state: "available", endpoint: { method: "GET", path: "/api/status" }, requires: ["bearer_token"] });
    assert.deepEqual(body.actions.find((action) => action.id === "models.list"), { id: "models.list", mode: "read", state: "available", endpoint: { method: "GET", path: "/api/models" }, requires: ["bearer_token"] });
    assert.deepEqual(body.actions.find((action) => action.id === "auth_challenges.list"), { id: "auth_challenges.list", mode: "read", state: "available", endpoint: { method: "GET", path: "/api/auth-challenges" }, requires: ["bearer_token"] });
    assert.deepEqual(body.actions.find((action) => action.id === "auth_challenges.detail"), { id: "auth_challenges.detail", mode: "read", state: "available", endpoint: { method: "GET", path: "/api/auth-challenges/:id" }, requires: ["bearer_token", "opaque_challenge_id"] });
    assert.deepEqual(body.actions.find((action) => action.id === "auth_challenges.cancel"), { id: "auth_challenges.cancel", mode: "mutation", state: "available", endpoint: { method: "POST", path: "/api/auth-challenges/:id/cancel" }, requires: ["bearer_token", "same_origin", "opaque_challenge_id"] });
    assert.deepEqual(body.actions.find((action) => action.id === "audit.history"), { id: "audit.history", mode: "read", state: "available", endpoint: { method: "GET", path: "/api/audit" }, requires: ["bearer_token"] });
    assert.deepEqual(body.actions.find((action) => action.id === "mutation_operations.history"), { id: "mutation_operations.history", mode: "read", state: "available", endpoint: { method: "GET", path: "/api/mutation-operations" }, requires: ["bearer_token"] });
    assert.deepEqual(body.actions.find((action) => action.id === "account.delete"), {
      id: "account.delete",
      mode: "mutation",
      state: "blocked",
      reason: "no_stable_native_exact_profile_delete_api",
      requires: ["bearer_token", "canonical_target", "stable_native_exact_profile_delete_api", "atomic_transaction", "post_delete_authoritative_proof"]
    });
    assert.deepEqual(body.actions.find((action) => action.id === "guided_auth"), {
      id: "guided_auth",
      mode: "mutation",
      state: "unproven",
      reason: "protected_start_contract_missing_review_idempotency_runtime_proof",
      requires: ["bearer_token", "explicit_confirmation", "idempotency_key"]
    });
    assert.deepEqual(body.actions.find((action) => action.id === "routes"), {
      id: "routes",
      mode: "mutation",
      state: "unproven",
      reason: "protected_route_contract_missing_scoped_review_idempotency_runtime_proof",
      requires: ["bearer_token", "dry_run", "explicit_confirmation", "idempotency_key"]
    });
    assert.deepEqual(body.actions.find((action) => action.id === "models"), {
      id: "models",
      mode: "mutation",
      state: "unproven",
      reason: "protected_model_contract_missing_scoped_review_idempotency_runtime_proof",
      requires: ["bearer_token", "dry_run", "explicit_confirmation", "idempotency_key"]
    });
    assert.deepEqual(body.actions.find((action) => action.id === "updates"), {
      id: "updates",
      mode: "mutation",
      state: "blocked",
      reason: "macos_signed_artifact_package_supervisor_backup_restart_health_proof_missing",
      requires: ["bearer_token", "verified_release", "backup", "narrow_supervisor", "health_proof"]
    });
    assert.equal(JSON.stringify(body).match(/secret|password|accessToken|refreshToken/i), null);
  } finally {
    await app.close();
  }
});

test("audit history is bearer-protected, bounded, and redacted", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  const auditStore = new AuditStore(join(root, "audit.json"));
  await auditStore.append({
    action: "route.use",
    outcome: "blocked",
    proofState: "unproven",
    requestDigest: "request-digest",
    summary: "Route update for private@example.test was blocked.",
    warnings: ["no_live_mutation"]
  });
  const app = createAccountCenterServer({ token: "test-token", auditStore });
  const address = await app.listen();
  try {
    assert.equal((await request(address.port, "/api/audit")).status, 401);
    const accepted = await request(address.port, "/api/audit", "test-token");
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get("cache-control"), "no-store");
    const body = await accepted.json() as { schemaVersion: string; records: Array<Record<string, unknown>> };
    assert.equal(body.schemaVersion, "account-center.audit-history.v1");
    assert.equal(body.records.length, 1);
    assert.deepEqual(Object.keys(body.records[0]).sort(), ["action", "createdAt", "id", "outcome", "proofState", "summary", "warnings"]);
    assert.equal(JSON.stringify(body).includes("private@example.test"), false);
    assert.equal(JSON.stringify(body).includes("request-digest"), false);
  } finally {
    await app.close();
  }
});

test("mutation operation history is bearer-protected and exposes only redacted terminal evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  const repository = new MutationRepository(join(root, "mutations"), { operationId: () => "op_test" });
  const claim = await repository.claim({
    idempotencyKey: "s3ZMdvUKp3wnaAq8EKUla9B1",
    requestDigest: "a".repeat(64),
    audit: { action: "route.use", provider: "openai", runtime: "openclaw", scopeKind: "agent", scopeIdDigest: "b".repeat(64), targetDigest: "c".repeat(64) }
  });
  if (claim.kind !== "execute") throw new Error("expected executable test operation");
  await repository.complete({ operationId: claim.operationId, outcome: "blocked", warningCodes: ["runtime_unavailable"] });
  const app = createAccountCenterServer({ token: "test-token", mutationRepository: repository });
  const address = await app.listen();
  try {
    assert.equal((await request(address.port, "/api/mutation-operations")).status, 401);
    const accepted = await request(address.port, "/api/mutation-operations", "test-token");
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get("cache-control"), "no-store");
    const body = await accepted.json() as { schemaVersion: string; operations: Array<Record<string, unknown>> };
    assert.equal(body.schemaVersion, "account-center.mutation-operations.v1");
    assert.deepEqual(body.operations, [{
      operationId: "op_test", state: "completed", outcome: "blocked", createdAt: body.operations[0]?.createdAt,
      completedAt: body.operations[0]?.completedAt,
      audit: { action: "route.use", provider: "openai", runtime: "openclaw", scopeKind: "agent", warningCodes: ["runtime_unavailable"] }
    }]);
    assert.equal(JSON.stringify(body).match(/[abc]{64}|s3ZMdvUKp3wnaAq8EKUla9B1/), null);
  } finally {
    await app.close();
  }
});

test("guided-auth challenge inventory is bearer-protected and omits account targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  const challenges = new AuthChallengeStore(join(root, "challenges.json"));
  const expiresAt = "2030-01-01T00:00:00.000Z";
  await challenges.create({ mode: "reauth", provider: "openai", runtime: "openclaw", target: "private@example.test", scope: "agent:main", expiresAt });
  const app = createAccountCenterServer({ token: "test-token", challengeStore: challenges });
  const address = await app.listen();
  try {
    assert.equal((await request(address.port, "/api/auth-challenges")).status, 401);
    const accepted = await request(address.port, "/api/auth-challenges", "test-token");
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get("cache-control"), "no-store");
    const body = await accepted.json() as { schemaVersion: string; challenges: Array<Record<string, unknown>> };
    assert.equal(body.schemaVersion, "account-center.auth-challenges.v1");
    assert.equal(body.challenges.length, 1);
    assert.deepEqual(Object.keys(body.challenges[0]).sort(), ["createdAt", "expiresAt", "id", "mode", "provider", "runtime", "scope", "status", "updatedAt"]);
    assert.equal(body.challenges[0].expiresAt, expiresAt);
    assert.equal(JSON.stringify(body).includes("private@example.test"), false);
  } finally {
    await app.close();
  }
});

test("guided-auth challenge detail is bearer-protected, redacted, and returns not found for an unknown opaque id", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  const challenges = new AuthChallengeStore(join(root, "challenges.json"));
  const challenge = await challenges.create({ mode: "add", provider: "openai", runtime: "openclaw", target: "private@example.test", scope: "agent:main" });
  const app = createAccountCenterServer({ token: "test-token", challengeStore: challenges });
  const address = await app.listen();
  const path = `/api/auth-challenges/${challenge.id}`;
  try {
    assert.equal((await request(address.port, path)).status, 401);
    const accepted = await request(address.port, path, "test-token");
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get("cache-control"), "no-store");
    const body = await accepted.json() as { schemaVersion: string; challenge: Record<string, unknown> };
    assert.equal(body.schemaVersion, "account-center.auth-challenge.v1");
    assert.deepEqual(Object.keys(body.challenge).sort(), ["createdAt", "id", "mode", "provider", "runtime", "scope", "status", "updatedAt"]);
    assert.equal(JSON.stringify(body).includes("private@example.test"), false);
    assert.equal((await request(address.port, "/api/auth-challenges/auth_00000000-0000-4000-8000-000000000000", "test-token")).status, 404);
  } finally {
    await app.close();
  }
});

test("guided-auth cancellation is same-origin, bearer-protected, durable, and redacted", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  const challenges = new AuthChallengeStore(join(root, "challenges.json"));
  const challenge = await challenges.create({ mode: "reauth", provider: "openai", runtime: "openclaw", target: "private@example.test", scope: "agent:main" });
  const app = createAccountCenterServer({ token: "test-token", challengeStore: challenges });
  const address = await app.listen();
  const path = `/api/auth-challenges/${challenge.id}/cancel`;
  try {
    assert.equal((await request(address.port, path)).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${address.port}${path}`, { method: "POST", headers: { authorization: "Bearer test-token", origin: "http://attacker.invalid" } })).status, 403);
    const cancelled = await fetch(`http://127.0.0.1:${address.port}${path}`, { method: "POST", headers: { authorization: "Bearer test-token", origin: `http://127.0.0.1:${address.port}` } });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.headers.get("cache-control"), "no-store");
    const body = await cancelled.json() as { schemaVersion: string; challenge: Record<string, unknown> };
    assert.equal(body.schemaVersion, "account-center.auth-challenge-cancel.v1");
    assert.deepEqual(Object.keys(body.challenge).sort(), ["createdAt", "id", "mode", "provider", "runtime", "scope", "status", "updatedAt"]);
    assert.equal(body.challenge.status, "cancelled");
    assert.equal(JSON.stringify(body).includes("private@example.test"), false);
    assert.equal((await challenges.get(challenge.id))?.status, "cancelled");
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/auth-challenges/auth_00000000-0000-4000-8000-000000000000/cancel`, { method: "POST", headers: { authorization: "Bearer test-token", origin: `http://127.0.0.1:${address.port}` } })).status, 404);
  } finally {
    await app.close();
  }
});
