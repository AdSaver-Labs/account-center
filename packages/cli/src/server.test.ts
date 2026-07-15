import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditStore, AuthChallengeStore, MutationRepository } from "@account-center/core";
import { createAccountCenterServer } from "./server.js";

async function request(port: number, path: string, token?: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
}

async function bodyRequest(port: number, path: string, token: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      path,
      method: "GET",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": "2" }
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) }));
    });
    request.once("error", reject);
    request.end("{}");
  });
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

test("status API omits OAuth device codes and verification URLs despite a noSecrets fixture assertion", async () => {
  const app = createAccountCenterServer({ token: "test-token" });
  const address = await app.listen();
  try {
    const response = await request(address.port, "/api/status", "test-token");
    assert.equal(response.status, 200);
    const body = await response.json() as { reauth: Array<Record<string, unknown>> };
    assert.deepEqual(body.reauth, [{
      id: "reauth_fixture",
      provider: "openai",
      profileHint: "account-4",
      expiresAt: "2026-07-09T00:15:00.000Z",
      status: "pending"
    }]);
    assert.equal(JSON.stringify(body).match(/userCode|verificationUri|ABCD-EFGH|example\.invalid\/device/), null);
  } finally {
    await app.close();
  }
});

test("status API exposes only opaque account references, including route and challenge metadata", async () => {
  const app = createAccountCenterServer({ token: "test-token" });
  const address = await app.listen();
  try {
    const response = await request(address.port, "/api/status", "test-token");
    assert.equal(response.status, 200);
    const body = await response.json() as {
      profiles: Array<{ id: string; label: string; usage: { profileId: string } }>;
      routes: Array<{ activeProfileId: string; order: string[] }>;
      reauth: Array<{ profileHint: string }>;
    };
    assert.deepEqual(body.profiles.map(({ id, label, usage }) => ({ id, label, profileId: usage.profileId })), [
      { id: "account-1", label: "account-1", profileId: "account-1" },
      { id: "account-2", label: "account-2", profileId: "account-2" },
      { id: "account-3", label: "account-3", profileId: "account-3" },
      { id: "account-4", label: "account-4", profileId: "account-4" }
    ]);
    assert.deepEqual(body.routes.map(({ activeProfileId, order }) => ({ activeProfileId, order })), [{
      activeProfileId: "account-1", order: ["account-1", "account-2", "account-3", "account-4"]
    }]);
    assert.deepEqual(body.reauth.map(({ profileHint }) => ({ profileHint })), [{ profileHint: "account-4" }]);
    assert.equal(JSON.stringify(body).match(/helper-|business-backup|openai:helper|openai:business/), null);
  } finally {
    await app.close();
  }
});

test("body-bearing API reads are rejected before status execution", async () => {
  const app = createAccountCenterServer({ token: "test-token" });
  const address = await app.listen();
  try {
    assert.deepEqual(await bodyRequest(address.port, "/api/status", "test-token"), {
      status: 413,
      body: { error: "request_body_not_allowed" }
    });
  } finally {
    await app.close();
  }
});

test("protected endpoint method rejection advertises the fixed allowed method", async () => {
  const app = createAccountCenterServer({ token: "test-token" });
  const address = await app.listen();
  try {
    const status = await fetch(`http://127.0.0.1:${address.port}/api/status`, {
      method: "POST",
      headers: { authorization: "Bearer test-token" }
    });
    assert.equal(status.status, 405);
    assert.equal(status.headers.get("allow"), "GET");

    const filteredAudit = await fetch(`http://127.0.0.1:${address.port}/api/audit?outcome=blocked`, {
      method: "POST",
      headers: { authorization: "Bearer test-token" }
    });
    assert.equal(filteredAudit.status, 405);
    assert.equal(filteredAudit.headers.get("allow"), "GET");

    const cancel = await fetch(`http://127.0.0.1:${address.port}/api/auth-challenges/auth_00000000-0000-4000-8000-000000000000/cancel`, {
      headers: { authorization: "Bearer test-token" }
    });
    assert.equal(cancel.status, 405);
    assert.equal(cancel.headers.get("allow"), "POST");
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

test("read-only limits inventory is bearer-protected, versioned, and uses redacted account references", async () => {
  const app = createAccountCenterServer({ token: "test-token" });
  const address = await app.listen();
  try {
    assert.equal((await request(address.port, "/api/limits")).status, 401);
    const accepted = await request(address.port, "/api/limits", "test-token");
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get("cache-control"), "no-store");
    const body = await accepted.json() as {
      schemaVersion: string;
      generatedAt: string;
      accounts: Array<{ accountRef: string; provider: string; health: string; authState: string; readable: boolean; windows: Array<{ name: string; remainingPct: number | null; resetsAt?: string }> }>;
    };
    assert.equal(body.schemaVersion, "account-center.limits.v1");
    assert.match(body.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(body.accounts.map(({ accountRef, provider, health, authState, readable }) => ({ accountRef, provider, health, authState, readable })), [
      { accountRef: "account-1", provider: "openai", health: "warn", authState: "ok", readable: true },
      { accountRef: "account-2", provider: "openai", health: "ok", authState: "ok", readable: true },
      { accountRef: "account-3", provider: "openai", health: "ok", authState: "ok", readable: true },
      { accountRef: "account-4", provider: "openai", health: "error", authState: "reauth-needed", readable: false }
    ]);
    assert.deepEqual(body.accounts[0]?.windows, [
      { name: "five-hour", remainingPct: 1 },
      { name: "weekly", remainingPct: 68 }
    ]);
    assert.equal(JSON.stringify(body).match(/profileId|email|label|token|secret|password/i), null);
  } finally {
    await app.close();
  }
});

test("read-only runtime scope catalog is bearer-protected, versioned, and exposes no profile metadata", async () => {
  const app = createAccountCenterServer({ token: "test-token" });
  const address = await app.listen();
  try {
    assert.equal((await request(address.port, "/api/scopes")).status, 401);
    const accepted = await request(address.port, "/api/scopes", "test-token");
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get("cache-control"), "no-store");
    const body = await accepted.json() as { schemaVersion: string; generatedAt: string; scopes: Array<Record<string, unknown>> };
    assert.equal(body.schemaVersion, "account-center.runtime-scopes.v1");
    assert.match(body.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(body.scopes, [
      { runtime: "hermes", scope: { kind: "default", id: "default" }, capabilities: { readStatus: true, mutateRoutes: false, startReauth: false, mutateModels: false } },
      { runtime: "openclaw", scope: { kind: "default", id: "default" }, capabilities: { readStatus: true, mutateRoutes: false, startReauth: false, mutateModels: false } }
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
    assert.deepEqual(body.actions.find((action) => action.id === "capabilities.list"), { id: "capabilities.list", mode: "read", state: "available", endpoint: { method: "GET", path: "/api/capabilities" }, requires: ["bearer_token"] });
    assert.deepEqual(body.actions.find((action) => action.id === "status"), { id: "status", mode: "read", state: "available", endpoint: { method: "GET", path: "/api/status" }, requires: ["bearer_token"] });
    assert.deepEqual(body.actions.find((action) => action.id === "limits.list"), { id: "limits.list", mode: "read", state: "available", endpoint: { method: "GET", path: "/api/limits" }, requires: ["bearer_token"] });
    assert.deepEqual(body.actions.find((action) => action.id === "models.list"), { id: "models.list", mode: "read", state: "available", endpoint: { method: "GET", path: "/api/models" }, requires: ["bearer_token"] });
    assert.deepEqual(body.actions.find((action) => action.id === "runtime_scopes.list"), { id: "runtime_scopes.list", mode: "read", state: "available", endpoint: { method: "GET", path: "/api/scopes" }, requires: ["bearer_token"] });
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
      state: "UNPROVEN",
      reason: "protected_start_contract_missing_review_idempotency_runtime_proof",
      requires: ["bearer_token", "explicit_runtime_scope", "explicit_confirmation", "idempotency_key"]
    });
    assert.deepEqual(body.actions.find((action) => action.id === "routes"), {
      id: "routes",
      mode: "mutation",
      state: "UNPROVEN",
      reason: "protected_route_contract_missing_scoped_review_idempotency_runtime_proof",
      requires: ["bearer_token", "explicit_runtime_scope", "dry_run", "explicit_confirmation", "idempotency_key"]
    });
    assert.deepEqual(body.actions.find((action) => action.id === "models"), {
      id: "models",
      mode: "mutation",
      state: "UNPROVEN",
      reason: "protected_model_contract_missing_scoped_review_idempotency_runtime_proof",
      requires: ["bearer_token", "explicit_runtime_scope", "dry_run", "explicit_confirmation", "idempotency_key"]
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

test("audit history supports bounded outcome filtering without accepting malformed query input", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  const auditStore = new AuditStore(join(root, "audit.json"));
  await auditStore.append({ action: "route.use", outcome: "blocked", proofState: "unproven", requestDigest: "a".repeat(64), summary: "Blocked for private@example.test", warnings: [] });
  await auditStore.append({ action: "route.use", outcome: "dry_run", proofState: "not_applicable", requestDigest: "b".repeat(64), summary: "Preview for private@example.test", warnings: [] });
  await auditStore.append({ action: "guided_auth.cancel", outcome: "blocked", proofState: "verified", requestDigest: "c".repeat(64), summary: "Cancelled private@example.test", warnings: [] });
  const app = createAccountCenterServer({ token: "test-token", auditStore });
  const address = await app.listen();
  try {
    const filtered = await request(address.port, "/api/audit?outcome=blocked&limit=1", "test-token");
    assert.equal(filtered.status, 200);
    const body = await filtered.json() as { schemaVersion: string; records: Array<{ action: string; outcome: string; summary: string }> };
    assert.equal(body.schemaVersion, "account-center.audit-history.v1");
    assert.deepEqual(body.records.map(({ action, outcome }) => ({ action, outcome })), [{ action: "guided_auth.cancel", outcome: "blocked" }]);
    assert.equal(JSON.stringify(body).includes("private@example.test"), false);

    const malformed = await request(address.port, "/api/audit?limit=101", "test-token");
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: "invalid_query" });
  } finally {
    await app.close();
  }
});

test("audit history exposes a bounded opaque-cursor page without leaking request digests", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  const auditStore = new AuditStore(join(root, "audit.json"));
  await auditStore.append({ action: "route.use", outcome: "blocked", proofState: "unproven", requestDigest: "a".repeat(64), summary: "First private@example.test event", warnings: [] });
  await auditStore.append({ action: "route.use", outcome: "dry_run", proofState: "not_applicable", requestDigest: "b".repeat(64), summary: "Second private@example.test event", warnings: [] });
  await auditStore.append({ action: "guided_auth.cancel", outcome: "blocked", proofState: "verified", requestDigest: "c".repeat(64), summary: "Third private@example.test event", warnings: [] });
  const app = createAccountCenterServer({ token: "test-token", auditStore });
  const address = await app.listen();
  try {
    const first = await request(address.port, "/api/audit?limit=2", "test-token");
    assert.equal(first.status, 200);
    const firstBody = await first.json() as { records: Array<{ summary: string }>; nextCursor?: string };
    assert.deepEqual(firstBody.records.map((record) => record.summary), ["Third [REDACTED_EMAIL] event", "Second [REDACTED_EMAIL] event"]);
    assert.match(firstBody.nextCursor ?? "", /^audit_[a-f0-9-]{36}$/);

    const second = await request(address.port, `/api/audit?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor ?? "")}`, "test-token");
    assert.equal(second.status, 200);
    const secondBody = await second.json() as { records: Array<{ summary: string }>; nextCursor?: string };
    assert.deepEqual(secondBody.records.map((record) => record.summary), ["First [REDACTED_EMAIL] event"]);
    assert.equal(secondBody.nextCursor, undefined);
    assert.equal(JSON.stringify([firstBody, secondBody]).match(/[abc]{64}|private@example\\.test/), null);

    const malformed = await request(address.port, "/api/audit?cursor=not-an-audit-id", "test-token");
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: "invalid_query" });
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

test("mutation operation history is bounded, newest-first, and paginates with an opaque redacted cursor", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  let sequence = 0;
  const repository = new MutationRepository(join(root, "mutations"), { operationId: () => `op_page_${++sequence}` });
  for (const outcome of ["applied", "blocked", "failed"] as const) {
    const claim = await repository.claim({
      idempotencyKey: `page-idempotency-key-${outcome}-000`,
      requestDigest: outcome[0].repeat(64),
      audit: { action: "route.use", provider: "openai", runtime: "openclaw", scopeKind: "default", scopeIdDigest: "a".repeat(64), targetDigest: "b".repeat(64) }
    });
    if (claim.kind !== "execute") throw new Error("expected executable operation");
    await repository.complete({ operationId: claim.operationId, outcome });
  }
  const app = createAccountCenterServer({ token: "test-token", mutationRepository: repository });
  const address = await app.listen();
  try {
    const first = await request(address.port, "/api/mutation-operations?limit=2", "test-token");
    assert.equal(first.status, 200);
    const firstBody = await first.json() as { schemaVersion: string; generatedAt: string; operations: Array<{ operationId: string; outcome?: string }>; nextCursor?: string };
    assert.equal(firstBody.schemaVersion, "account-center.mutation-operations.v1");
    assert.match(firstBody.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(firstBody.operations.map(({ operationId, outcome }) => ({ operationId, outcome })), [{ operationId: "op_page_3", outcome: "failed" }, { operationId: "op_page_2", outcome: "blocked" }]);
    assert.equal(firstBody.nextCursor, "op_page_2");

    const second = await request(address.port, `/api/mutation-operations?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor ?? "")}`, "test-token");
    assert.equal(second.status, 200);
    const secondBody = await second.json() as { operations: Array<{ operationId: string }>; nextCursor?: string };
    assert.deepEqual(secondBody.operations.map(({ operationId }) => operationId), ["op_page_1"]);
    assert.equal(secondBody.nextCursor, undefined);
    assert.equal(JSON.stringify([firstBody, secondBody]).match(/page-idempotency|[ab]{64}/), null);

    const malformed = await request(address.port, "/api/mutation-operations?limit=101", "test-token");
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: "invalid_query" });
  } finally {
    await app.close();
  }
});

test("protected API contains repository failures without returning internal error detail", async () => {
  const repository = { list: async () => { throw new Error("private@example.test mutation repository corrupt"); } } as unknown as MutationRepository;
  const app = createAccountCenterServer({ token: "test-token", mutationRepository: repository });
  const address = await app.listen();
  try {
    const response = await request(address.port, "/api/mutation-operations", "test-token");
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "internal_error" });
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

test("guided-auth cancellation rejects request bodies before changing local challenge state", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  const challenges = new AuthChallengeStore(join(root, "challenges.json"));
  const challenge = await challenges.create({ mode: "reauth", provider: "openai", runtime: "openclaw", target: "private@example.test", scope: "agent:main" });
  const app = createAccountCenterServer({ token: "test-token", challengeStore: challenges });
  const address = await app.listen();
  const path = `/api/auth-challenges/${challenge.id}/cancel`;
  try {
    const rejected = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", origin: `http://127.0.0.1:${address.port}`, "content-type": "application/json" },
      body: "{}"
    });
    assert.equal(rejected.status, 413);
    assert.deepEqual(await rejected.json(), { error: "request_body_not_allowed" });
    assert.equal((await challenges.get(challenge.id))?.status, "pending");
  } finally {
    await app.close();
  }
});
