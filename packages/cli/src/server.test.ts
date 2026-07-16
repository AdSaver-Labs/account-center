import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
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
      { id: "openai/gpt-4.1", selectable: false, reason: "disabled_by_policy", observedProfileCount: 0, readableProfileCount: 0, runtimeCompatibility: [], verificationState: "UNPROVEN" },
      { id: "openai/gpt-5.3-codex", selectable: true, observedProfileCount: 2, readableProfileCount: 2, runtimeCompatibility: ["codex", "hermes", "openclaw"], verificationState: "UNPROVEN" },
      { id: "openai/gpt-5.5", selectable: true, observedProfileCount: 4, readableProfileCount: 3, runtimeCompatibility: ["codex", "hermes", "openclaw"], verificationState: "UNPROVEN" }
    ]);
    assert.equal(JSON.stringify(body).match(/profileId|email|token|secret|password/i), null);
  } finally {
    await app.close();
  }
});

test("read-only model catalog separates absent selection evidence from observed catalog eligibility", async () => {
  const app = createAccountCenterServer({ token: "test-token" });
  const address = await app.listen();
  try {
    const accepted = await request(address.port, "/api/models?runtime=hermes&scope=default", "test-token");
    assert.equal(accepted.status, 200);
    const body = await accepted.json() as {
      selection: {
        requestedPolicy: { state: string };
        effectiveRuntimeModel: { state: string };
        fallbackChain: { state: string };
        verificationState: string;
      };
      models: Array<{ id: string; selectable: boolean; verificationState: string }>;
    };
    assert.deepEqual(body.selection, {
      requestedPolicy: { state: "not_reported" },
      effectiveRuntimeModel: { state: "not_reported" },
      fallbackChain: { state: "not_reported" },
      verificationState: "UNPROVEN"
    });
    assert.deepEqual(body.models.map(({ id, selectable, verificationState }) => ({ id, selectable, verificationState })), [
      { id: "openai/gpt-4.1", selectable: false, verificationState: "UNPROVEN" },
      { id: "openai/gpt-5.3-codex", selectable: true, verificationState: "UNPROVEN" },
      { id: "openai/gpt-5.5", selectable: true, verificationState: "UNPROVEN" }
    ]);
    assert.equal(JSON.stringify(body).match(/profileId|email|label|token|secret|password/i), null);
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

test("selected-runtime inventory reads are bearer-protected, bounded to compatible redacted records, and reject malformed filters", async () => {
  const app = createAccountCenterServer({ token: "test-token" });
  const address = await app.listen();
  try {
    assert.equal((await request(address.port, "/api/limits?runtime=hermes")).status, 401);
    const limits = await request(address.port, "/api/limits?runtime=hermes", "test-token");
    assert.equal(limits.status, 200);
    const limitsBody = await limits.json() as { accounts: Array<{ accountRef: string }> };
    assert.deepEqual(limitsBody.accounts.map((account) => account.accountRef), ["account-1", "account-2", "account-3"]);
    assert.equal(JSON.stringify(limitsBody).match(/profileId|email|label|token|secret|password/i), null);

    const models = await request(address.port, "/api/models?runtime=hermes", "test-token");
    assert.equal(models.status, 200);
    const modelsBody = await models.json() as { models: Array<{ id: string; observedProfileCount: number; runtimeCompatibility: string[] }> };
    assert.deepEqual(modelsBody.models.map(({ id, observedProfileCount, runtimeCompatibility }) => ({ id, observedProfileCount, runtimeCompatibility })), [
      { id: "openai/gpt-4.1", observedProfileCount: 0, runtimeCompatibility: [] },
      { id: "openai/gpt-5.3-codex", observedProfileCount: 2, runtimeCompatibility: ["hermes"] },
      { id: "openai/gpt-5.5", observedProfileCount: 3, runtimeCompatibility: ["hermes"] }
    ]);
    assert.equal(JSON.stringify(modelsBody).match(/profileId|email|label|token|secret|password/i), null);

    // A syntactically valid but unobserved runtime is not a safe selected
    // context. Reject it instead of returning a misleading empty inventory.
    for (const path of ["/api/limits?runtime=Hermes", "/api/models?runtime=hermes&runtime=openclaw", "/api/models?scope=default", "/api/limits?runtime=codex", "/api/models?runtime=codex"]) {
      const response = await request(address.port, path, "test-token");
      assert.equal(response.status, 400, path);
      assert.deepEqual(await response.json(), { error: "invalid_query" });
    }
  } finally {
    await app.close();
  }
});

test("selected default-scope inventory reads require an exact observed runtime scope", async () => {
  const app = createAccountCenterServer({ token: "test-token" });
  const address = await app.listen();
  try {
    const limits = await request(address.port, "/api/limits?runtime=hermes&scope=default", "test-token");
    assert.equal(limits.status, 200);
    assert.deepEqual((await limits.json() as { accounts: Array<{ accountRef: string }> }).accounts.map(({ accountRef }) => accountRef), ["account-1", "account-2", "account-3"]);

    const models = await request(address.port, "/api/models?runtime=hermes&scope=default", "test-token");
    assert.equal(models.status, 200);
    assert.deepEqual((await models.json() as { models: Array<{ id: string }> }).models.map(({ id }) => id), ["openai/gpt-4.1", "openai/gpt-5.3-codex", "openai/gpt-5.5"]);

    for (const path of ["/api/limits?scope=default", "/api/models?runtime=hermes&scope=agent:qa", "/api/limits?runtime=codex&scope=default", "/api/models?runtime=hermes&scope=default&scope=default"]) {
      const response = await request(address.port, path, "test-token");
      assert.equal(response.status, 400, path);
      assert.deepEqual(await response.json(), { error: "invalid_query" });
    }
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
    assert.deepEqual(body.actions.find((action) => action.id === "auth_challenges.cancel"), {
      id: "auth_challenges.cancel",
      mode: "mutation",
      state: "blocked",
      reason: "durable_challenge_store_unavailable",
      requires: ["bearer_token", "same_origin", "opaque_challenge_id", "durable_challenge_store", "durable_audit_store"]
    });
    assert.deepEqual(body.actions.find((action) => action.id === "audit.history"), { id: "audit.history", mode: "read", state: "available", endpoint: { method: "GET", path: "/api/audit" }, requires: ["bearer_token"] });
    assert.deepEqual(body.actions.find((action) => action.id === "audit.detail"), { id: "audit.detail", mode: "read", state: "available", endpoint: { method: "GET", path: "/api/audit/:auditId" }, requires: ["bearer_token", "opaque_audit_id"] });
    assert.deepEqual(body.actions.find((action) => action.id === "mutation_operations.history"), { id: "mutation_operations.history", mode: "read", state: "available", endpoint: { method: "GET", path: "/api/mutation-operations" }, requires: ["bearer_token"] });
    assert.deepEqual(body.actions.find((action) => action.id === "mutation_operations.detail"), { id: "mutation_operations.detail", mode: "read", state: "available", endpoint: { method: "GET", path: "/api/mutation-operations/:operationId" }, requires: ["bearer_token", "opaque_operation_id"] });
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
    const body = await accepted.json() as { schemaVersion: string; generatedAt: string; records: Array<Record<string, unknown>> };
    assert.equal(body.schemaVersion, "account-center.audit-history.v1");
    assert.match(body.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(body.records.length, 1);
    assert.deepEqual(Object.keys(body.records[0]).sort(), ["action", "createdAt", "id", "outcome", "proofState", "summary", "warnings"]);
    assert.equal(JSON.stringify(body).includes("private@example.test"), false);
    assert.equal(JSON.stringify(body).includes("request-digest"), false);
  } finally {
    await app.close();
  }
});

test("audit evidence detail is bearer-protected, redacted, and does not expose request digests", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  const auditStore = new AuditStore(join(root, "audit.json"));
  const record = await auditStore.append({
    action: "route.use",
    outcome: "blocked",
    proofState: "unproven",
    requestDigest: "sensitive-request-digest",
    summary: "Route update for private@example.test was blocked.",
    warnings: ["no_live_mutation"],
    runtime: "openclaw",
    scopeKind: "agent"
  });
  const app = createAccountCenterServer({ token: "test-token", auditStore });
  const address = await app.listen();
  const path = `/api/audit/${record.id}`;
  try {
    assert.equal((await request(address.port, path)).status, 401);
    const accepted = await request(address.port, path, "test-token");
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get("cache-control"), "no-store");
    const body = await accepted.json() as { schemaVersion: string; generatedAt: string; record: Record<string, unknown> };
    assert.equal(body.schemaVersion, "account-center.audit-record.v1");
    assert.match(body.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(body.record, {
      id: record.id,
      createdAt: record.createdAt,
      action: "route.use",
      outcome: "blocked",
      proofState: "unproven",
      summary: "Route update for [REDACTED_EMAIL] was blocked.",
      warnings: ["no_live_mutation"],
      runtime: "openclaw",
      scopeKind: "agent"
    });
    assert.equal(JSON.stringify(body).match(/private@example\.test|sensitive-request-digest/), null);

    const wrongMethod = await fetch(`http://127.0.0.1:${address.port}${path}`, { method: "POST", headers: { authorization: "Bearer test-token" } });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "GET");
    const missing = await request(address.port, "/api/audit/audit_00000000-0000-4000-8000-000000000000", "test-token");
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "not_found" });
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

test("audit history supports bounded UTC calendar-date filters without accepting malformed dates", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  const auditStore = new AuditStore(join(root, "audit.json"));
  await auditStore.append({ action: "route.use", outcome: "blocked", proofState: "unproven", requestDigest: "d".repeat(64), summary: "Blocked for private@example.test", warnings: [] });
  const app = createAccountCenterServer({ token: "test-token", auditStore });
  const address = await app.listen();
  try {
    const today = new Date().toISOString().slice(0, 10);
    const accepted = await request(address.port, `/api/audit?from=${today}&to=${today}`, "test-token");
    assert.equal(accepted.status, 200);
    const body = await accepted.json() as { records: Array<{ action: string }> };
    assert.deepEqual(body.records.map(({ action }) => action), ["route.use"]);

    for (const path of ["/api/audit?from=2026-7-1", "/api/audit?to=2026-02-30", "/api/audit?from=2026-07-02&to=2026-07-01", "/api/audit?from=2026-07-01&from=2026-07-01"]) {
      const malformed = await request(address.port, path, "test-token");
      assert.equal(malformed.status, 400, path);
      assert.deepEqual(await malformed.json(), { error: "invalid_query" });
    }
  } finally {
    await app.close();
  }
});

test("audit history filters an exact safe action category without broadening the response", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  const auditStore = new AuditStore(join(root, "audit.json"));
  await auditStore.append({ action: "route.use", outcome: "blocked", proofState: "unproven", requestDigest: "a".repeat(64), summary: "Route action for private@example.test", warnings: [] });
  await auditStore.append({ action: "guided_auth.cancel", outcome: "applied", proofState: "verified", requestDigest: "b".repeat(64), summary: "Guided-auth action for private@example.test", warnings: [] });
  await auditStore.append({ action: "route.use.private@example.test", outcome: "blocked", proofState: "unproven", requestDigest: "c".repeat(64), summary: "Legacy unsafe action for private@example.test", warnings: [] });
  const app = createAccountCenterServer({ token: "test-token", auditStore });
  const address = await app.listen();
  try {
    const filtered = await request(address.port, "/api/audit?action=route.use", "test-token");
    assert.equal(filtered.status, 200);
    const body = await filtered.json() as { records: Array<{ action: string; summary: string }> };
    assert.deepEqual(body.records.map(({ action }) => action), ["route.use"]);
    assert.equal(JSON.stringify(body).includes("private@example.test"), false);

    const all = await request(address.port, "/api/audit", "test-token");
    assert.equal(all.status, 200);
    const allBody = await all.json() as { records: Array<{ action: string }> };
    assert.deepEqual(allBody.records.map(({ action }) => action), ["action_redacted", "guided_auth.cancel", "route.use"]);
    assert.equal(JSON.stringify(allBody).includes("private@example.test"), false);

    const malformed = await request(address.port, "/api/audit?action=route%20use", "test-token");
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: "invalid_query" });
  } finally {
    await app.close();
  }
});

test("audit history filters redacted runtime and scope-kind context without exposing scope identifiers", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  const auditStore = new AuditStore(join(root, "audit.json"));
  await auditStore.append({ action: "route.use", outcome: "blocked", proofState: "unproven", requestDigest: "a".repeat(64), summary: "OpenClaw route change for private@example.test", warnings: [], runtime: "openclaw", scopeKind: "agent" });
  await auditStore.append({ action: "model.use", outcome: "unproven", proofState: "unproven", requestDigest: "b".repeat(64), summary: "Hermes model change for private@example.test", warnings: [], runtime: "hermes", scopeKind: "profile" });
  const app = createAccountCenterServer({ token: "test-token", auditStore });
  const address = await app.listen();
  try {
    const filtered = await request(address.port, "/api/audit?runtime=openclaw&scopeKind=agent", "test-token");
    assert.equal(filtered.status, 200);
    const body = await filtered.json() as { records: Array<{ id: string; createdAt: string; action: string; runtime?: string; scopeKind?: string }> };
    assert.deepEqual(body.records, [{
      id: body.records[0]?.id,
      createdAt: body.records[0] && (body.records[0] as { createdAt?: string }).createdAt,
      action: "route.use",
      outcome: "blocked",
      proofState: "unproven",
      summary: "OpenClaw route change for [REDACTED_EMAIL]",
      warnings: [],
      runtime: "openclaw",
      scopeKind: "agent"
    }]);
    assert.equal(JSON.stringify(body).match(/private@example\.test|[ab]{64}/), null);

    for (const path of ["/api/audit?runtime=OpenClaw", "/api/audit?scopeKind=agent", "/api/audit?runtime=openclaw&scopeKind=bogus", "/api/audit?runtime=openclaw&runtime=hermes"]) {
      const malformed = await request(address.port, path, "test-token");
      assert.equal(malformed.status, 400, path);
      assert.deepEqual(await malformed.json(), { error: "invalid_query" });
    }
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

test("protected operation detail is bearer-protected, redacted, and does not expose receipt digests", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  const repository = new MutationRepository(join(root, "mutations"), { operationId: () => "op_detail" });
  const claim = await repository.claim({
    idempotencyKey: "detail-idempotency-key-0000",
    requestDigest: "a".repeat(64),
    audit: { action: "route.use", provider: "openai", runtime: "openclaw", scopeKind: "agent", scopeIdDigest: "b".repeat(64), targetDigest: "c".repeat(64) }
  });
  if (claim.kind !== "execute") throw new Error("expected executable test operation");
  await repository.complete({ operationId: claim.operationId, outcome: "blocked", warningCodes: ["runtime_unavailable"] });
  const app = createAccountCenterServer({ token: "test-token", mutationRepository: repository });
  const address = await app.listen();
  try {
    assert.equal((await request(address.port, "/api/mutation-operations/op_detail")).status, 401);
    const accepted = await request(address.port, "/api/mutation-operations/op_detail", "test-token");
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get("cache-control"), "no-store");
    const body = await accepted.json() as { schemaVersion: string; generatedAt: string; operation: Record<string, unknown> };
    assert.equal(body.schemaVersion, "account-center.mutation-operation.v1");
    assert.match(body.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(body.operation, {
      operationId: "op_detail", state: "completed", outcome: "blocked",
      createdAt: body.operation.createdAt, completedAt: body.operation.completedAt,
      audit: { action: "route.use", provider: "openai", runtime: "openclaw", scopeKind: "agent", warningCodes: ["runtime_unavailable"] }
    });
    assert.equal(JSON.stringify(body).match(/detail-idempotency|[abc]{64}/), null);

    const wrongMethod = await fetch(`http://127.0.0.1:${address.port}/api/mutation-operations/op_detail`, {
      method: "POST", headers: { authorization: "Bearer test-token" }
    });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "GET");

    const missing = await request(address.port, "/api/mutation-operations/op_missing", "test-token");
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "not_found" });
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

    const filtered = await request(address.port, "/api/mutation-operations?outcome=blocked", "test-token");
    assert.equal(filtered.status, 200);
    const filteredBody = await filtered.json() as { operations: Array<{ operationId: string; outcome?: string }> };
    assert.deepEqual(filteredBody.operations.map(({ operationId, outcome }) => ({ operationId, outcome })), [{ operationId: "op_page_2", outcome: "blocked" }]);

    const malformed = await request(address.port, "/api/mutation-operations?limit=101", "test-token");
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: "invalid_query" });
    const malformedOutcome = await request(address.port, "/api/mutation-operations?outcome=UNPROVEN", "test-token");
    assert.equal(malformedOutcome.status, 400);
    assert.deepEqual(await malformedOutcome.json(), { error: "invalid_query" });
  } finally {
    await app.close();
  }
});

test("mutation operation history filters by the redacted runtime and scope kind", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  let sequence = 0;
  const repository = new MutationRepository(join(root, "mutations"), { operationId: () => `op_filter_${++sequence}` });
  for (const audit of [
    { action: "route.use", provider: "openai", runtime: "openclaw", scopeKind: "default" },
    { action: "model.use", provider: "openai", runtime: "hermes", scopeKind: "profile" },
    { action: "route.use", provider: "openai", runtime: "openclaw", scopeKind: "agent" }
  ] as const) {
    const claim = await repository.claim({
      idempotencyKey: `operation-filter-${++sequence}-key`,
      requestDigest: String(sequence).repeat(64),
      audit: { ...audit, scopeIdDigest: "a".repeat(64), targetDigest: "b".repeat(64) }
    });
    if (claim.kind !== "execute") throw new Error("expected executable operation");
    await repository.complete({ operationId: claim.operationId, outcome: "blocked" });
  }
  const app = createAccountCenterServer({ token: "test-token", mutationRepository: repository });
  const address = await app.listen();
  try {
    const filtered = await request(address.port, "/api/mutation-operations?runtime=openclaw&scopeKind=agent", "test-token");
    assert.equal(filtered.status, 200);
    const body = await filtered.json() as { operations: Array<{ operationId: string; audit: { runtime: string; scopeKind: string } }> };
    assert.deepEqual(body.operations.map(({ operationId, audit }) => ({ operationId, runtime: audit.runtime, scopeKind: audit.scopeKind })), [
      { operationId: "op_filter_6", runtime: "openclaw", scopeKind: "agent" }
    ]);
    assert.equal(JSON.stringify(body).match(/operation-filter|[ab]{64}/), null);

    // A scope kind without an explicit runtime would broaden the selected
    // context into cross-runtime evidence. It must be rejected, not treated
    // as a global scope-kind search.
    for (const path of ["/api/mutation-operations?runtime=OpenClaw", "/api/mutation-operations?scopeKind=agent"]) {
      const malformed = await request(address.port, path, "test-token");
      assert.equal(malformed.status, 400, path);
      assert.deepEqual(await malformed.json(), { error: "invalid_query" });
    }
  } finally {
    await app.close();
  }
});

test("mutation operation history filters an exact safe action category without broadening evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  let sequence = 0;
  const repository = new MutationRepository(join(root, "mutations"), { operationId: () => `op_action_${++sequence}` });
  for (const action of ["route.use", "model.use"] as const) {
    const claim = await repository.claim({
      idempotencyKey: `operation-action-${++sequence}-key`,
      requestDigest: String(sequence).repeat(64),
      audit: { action, provider: "openai", runtime: "openclaw", scopeKind: "default", scopeIdDigest: "a".repeat(64), targetDigest: "b".repeat(64) }
    });
    if (claim.kind !== "execute") throw new Error("expected executable operation");
    await repository.complete({ operationId: claim.operationId, outcome: "blocked" });
  }
  const app = createAccountCenterServer({ token: "test-token", mutationRepository: repository });
  const address = await app.listen();
  try {
    const filtered = await request(address.port, "/api/mutation-operations?action=route.use", "test-token");
    assert.equal(filtered.status, 200);
    const body = await filtered.json() as { operations: Array<{ operationId: string; audit: { action: string } }> };
    assert.deepEqual(body.operations.map(({ operationId, audit }) => ({ operationId, action: audit.action })), [
      { operationId: "op_action_2", action: "route.use" }
    ]);
    assert.equal(JSON.stringify(body).match(/private@example\.test|operation-action|[ab]{64}/), null);

    const malformed = await request(address.port, "/api/mutation-operations?action=route%20use", "test-token");
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: "invalid_query" });
  } finally {
    await app.close();
  }
});

test("mutation operation history supports bounded UTC calendar-date filters without accepting malformed dates", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  const repository = new MutationRepository(join(root, "mutations"), { operationId: () => "op_date_filter" });
  const claim = await repository.claim({
    idempotencyKey: "operation-date-filter-key-000",
    requestDigest: "d".repeat(64),
    audit: { action: "route.use", provider: "openai", runtime: "openclaw", scopeKind: "default", scopeIdDigest: "a".repeat(64), targetDigest: "b".repeat(64) }
  });
  if (claim.kind !== "execute") throw new Error("expected executable operation");
  await repository.complete({ operationId: claim.operationId, outcome: "blocked" });
  const app = createAccountCenterServer({ token: "test-token", mutationRepository: repository });
  const address = await app.listen();
  try {
    const today = new Date().toISOString().slice(0, 10);
    const accepted = await request(address.port, `/api/mutation-operations?from=${today}&to=${today}`, "test-token");
    assert.equal(accepted.status, 200);
    const body = await accepted.json() as { operations: Array<{ operationId: string }> };
    assert.deepEqual(body.operations.map(({ operationId }) => operationId), ["op_date_filter"]);

    for (const path of ["/api/mutation-operations?from=2026-7-1", "/api/mutation-operations?to=2026-02-30", "/api/mutation-operations?from=2026-07-02&to=2026-07-01", "/api/mutation-operations?from=2026-07-01&from=2026-07-01"]) {
      const malformed = await request(address.port, path, "test-token");
      assert.equal(malformed.status, 400, path);
      assert.deepEqual(await malformed.json(), { error: "invalid_query" });
    }
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
    const body = await accepted.json() as { schemaVersion: string; generatedAt: string; challenges: Array<Record<string, unknown>> };
    assert.equal(body.schemaVersion, "account-center.auth-challenges.v1");
    assert.match(body.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(body.challenges.length, 1);
    assert.deepEqual(Object.keys(body.challenges[0]).sort(), ["createdAt", "expiresAt", "id", "mode", "provider", "runtime", "scope", "status", "updatedAt"]);
    assert.equal(body.challenges[0].expiresAt, expiresAt);
    assert.equal(JSON.stringify(body).includes("private@example.test"), false);
  } finally {
    await app.close();
  }
});

test("guided-auth challenge inventory can be bounded to the selected runtime and exact scope without exposing targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  const challenges = new AuthChallengeStore(join(root, "challenges.json"));
  await challenges.create({ mode: "add", provider: "openai", runtime: "openclaw", target: "openclaw-private@example.test", scope: "default" });
  await challenges.create({ mode: "reauth", provider: "openai", runtime: "hermes", target: "hermes-default@example.test", scope: "default" });
  await challenges.create({ mode: "add", provider: "openai", runtime: "hermes", target: "hermes-agent@example.test", scope: "agent:recovery" });
  const app = createAccountCenterServer({ token: "test-token", challengeStore: challenges });
  const address = await app.listen();
  try {
    assert.equal((await request(address.port, "/api/auth-challenges?runtime=hermes&scope=agent%3Arecovery")).status, 401);
    const accepted = await request(address.port, "/api/auth-challenges?runtime=hermes&scope=agent%3Arecovery", "test-token");
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get("cache-control"), "no-store");
    const body = await accepted.json() as { schemaVersion: string; challenges: Array<{ runtime: string; scope: string }> };
    assert.equal(body.schemaVersion, "account-center.auth-challenges.v1");
    assert.deepEqual(body.challenges.map(({ runtime, scope }) => ({ runtime, scope })), [{ runtime: "hermes", scope: "agent:recovery" }]);
    assert.equal(JSON.stringify(body).match(/private@example\.test/), null);

    // A syntactically valid but unobserved runtime is not a safe selected
    // context. Reject it rather than presenting its empty history as evidence.
    for (const path of ["/api/auth-challenges?runtime=codex", "/api/auth-challenges?runtime=Hermes", "/api/auth-challenges?runtime=hermes&runtime=openclaw", "/api/auth-challenges?scope=", "/api/auth-challenges?scope=default", "/api/auth-challenges?scope=agent%3Arecovery&scope=default", "/api/auth-challenges?scope=agent%3Arecovery%0A", "/api/auth-challenges?unknown=default"]) {
      const malformed = await request(address.port, path, "test-token");
      assert.equal(malformed.status, 400, path);
      assert.deepEqual(await malformed.json(), { error: "invalid_query" });
    }
  } finally {
    await app.close();
  }
});

test("guided-auth challenge history is newest-first, cursor-paginated, and remains redacted", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  const challenges = new AuthChallengeStore(join(root, "challenges.json"));
  const first = await challenges.create({ mode: "add", provider: "openai", runtime: "openclaw", target: "first-private@example.test", scope: "default" });
  const second = await challenges.create({ mode: "reauth", provider: "openai", runtime: "openclaw", target: "second-private@example.test", scope: "default" });
  const third = await challenges.create({ mode: "add", provider: "openai", runtime: "openclaw", target: "third-private@example.test", scope: "default" });
  const app = createAccountCenterServer({ token: "test-token", challengeStore: challenges });
  const address = await app.listen();
  try {
    const newest = await request(address.port, "/api/auth-challenges?limit=1", "test-token");
    assert.equal(newest.status, 200);
    const newestBody = await newest.json() as { challenges: Array<{ id: string }>; nextCursor?: string };
    assert.deepEqual(newestBody.challenges.map(({ id }) => id), [third.id]);
    assert.equal(newestBody.nextCursor, third.id);
    assert.equal(JSON.stringify(newestBody).match(/(?:first|second|third)-private@example\.test/), null);

    const older = await request(address.port, `/api/auth-challenges?limit=1&cursor=${encodeURIComponent(third.id)}`, "test-token");
    assert.equal(older.status, 200);
    const olderBody = await older.json() as { challenges: Array<{ id: string }>; nextCursor?: string };
    assert.deepEqual(olderBody.challenges.map(({ id }) => id), [second.id]);
    assert.equal(olderBody.nextCursor, second.id);

    const oldest = await request(address.port, `/api/auth-challenges?limit=1&cursor=${encodeURIComponent(second.id)}`, "test-token");
    assert.equal(oldest.status, 200);
    const oldestBody = await oldest.json() as { challenges: Array<{ id: string }>; nextCursor?: string };
    assert.deepEqual(oldestBody.challenges.map(({ id }) => id), [first.id]);
    assert.equal(oldestBody.nextCursor, undefined);

    for (const path of ["/api/auth-challenges?limit=0", "/api/auth-challenges?limit=101", "/api/auth-challenges?cursor=auth_not-a-uuid", "/api/auth-challenges?cursor=auth_00000000-0000-4000-8000-000000000000", `/api/auth-challenges?cursor=${encodeURIComponent(first.id)}&cursor=${encodeURIComponent(second.id)}`]) {
      const malformed = await request(address.port, path, "test-token");
      assert.equal(malformed.status, 400, path);
      assert.deepEqual(await malformed.json(), { error: "invalid_query" });
    }
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
    const body = await accepted.json() as { schemaVersion: string; generatedAt: string; challenge: Record<string, unknown> };
    assert.equal(body.schemaVersion, "account-center.auth-challenge.v1");
    assert.match(body.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(Object.keys(body.challenge).sort(), ["createdAt", "id", "mode", "provider", "runtime", "scope", "status", "updatedAt"]);
    assert.equal(JSON.stringify(body).includes("private@example.test"), false);
    assert.equal((await request(address.port, "/api/auth-challenges/auth_00000000-0000-4000-8000-000000000000", "test-token")).status, 404);
  } finally {
    await app.close();
  }
});

test("guided-auth API fails closed and redacts a corrupt durable lifecycle record", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  const path = join(root, "challenges.json");
  await writeFile(path, JSON.stringify([{
    id: "auth_corrupt",
    key: "key",
    mode: "add",
    status: "completed-with-unverified-runtime-output",
    provider: "openai",
    runtime: "openclaw",
    scope: "default",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z"
  }]));
  const app = createAccountCenterServer({ token: "test-token", challengeStore: new AuthChallengeStore(path) });
  const address = await app.listen();
  try {
    const response = await request(address.port, "/api/auth-challenges", "test-token");
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "internal_error" });
  } finally {
    await app.close();
  }
});

test("guided-auth cancellation capability remains blocked when durable challenge state is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  const auditStore = new AuditStore(join(root, "audit.json"));
  const app = createAccountCenterServer({ token: "test-token", auditStore });
  const address = await app.listen();
  try {
    const response = await request(address.port, "/api/capabilities", "test-token");
    assert.equal(response.status, 200);
    const body = await response.json() as { actions: Array<{ id: string; mode: string; state: string; reason?: string; requires: string[] }> };
    assert.deepEqual(body.actions.find((action) => action.id === "auth_challenges.cancel"), {
      id: "auth_challenges.cancel",
      mode: "mutation",
      state: "blocked",
      reason: "durable_challenge_store_unavailable",
      requires: ["bearer_token", "same_origin", "opaque_challenge_id", "durable_challenge_store", "durable_audit_store"]
    });
  } finally {
    await app.close();
  }
});

test("guided-auth cancellation is same-origin, bearer-protected, durable, redacted, and records bounded audit evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  const challenges = new AuthChallengeStore(join(root, "challenges.json"));
  const auditStore = new AuditStore(join(root, "audit.json"));
  const challenge = await challenges.create({ mode: "reauth", provider: "openai", runtime: "openclaw", target: "private@example.test", scope: "agent:main" });
  const app = createAccountCenterServer({ token: "test-token", challengeStore: challenges, auditStore });
  const address = await app.listen();
  const path = `/api/auth-challenges/${challenge.id}/cancel`;
  try {
    assert.equal((await request(address.port, path)).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${address.port}${path}`, { method: "POST", headers: { authorization: "Bearer test-token", origin: "http://attacker.invalid" } })).status, 403);
    const cancelled = await fetch(`http://127.0.0.1:${address.port}${path}`, { method: "POST", headers: { authorization: "Bearer test-token", origin: `http://127.0.0.1:${address.port}` } });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.headers.get("cache-control"), "no-store");
    const body = await cancelled.json() as { schemaVersion: string; generatedAt: string; challenge: Record<string, unknown> };
    assert.equal(body.schemaVersion, "account-center.auth-challenge-cancel.v1");
    assert.match(body.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(Object.keys(body.challenge).sort(), ["createdAt", "id", "mode", "provider", "runtime", "scope", "status", "updatedAt"]);
    assert.equal(body.challenge.status, "cancelled");
    assert.equal(JSON.stringify(body).includes("private@example.test"), false);
    assert.equal((await challenges.get(challenge.id))?.status, "cancelled");
    const capabilities = await request(address.port, "/api/capabilities", "test-token");
    const capabilityBody = await capabilities.json() as { actions: Array<{ id: string; mode: string; state: string; endpoint?: { method: string; path: string }; requires: string[] }> };
    assert.deepEqual(capabilityBody.actions.find((action) => action.id === "auth_challenges.cancel"), {
      id: "auth_challenges.cancel", mode: "mutation", state: "available", endpoint: { method: "POST", path: "/api/auth-challenges/:id/cancel" }, requires: ["bearer_token", "same_origin", "opaque_challenge_id", "durable_challenge_store", "durable_audit_store"]
    });
    const audit = await request(address.port, "/api/audit", "test-token");
    assert.equal(audit.status, 200);
    const auditBody = await audit.json() as { records: Array<{ action: string; outcome: string; proofState: string; summary: string }> };
    assert.deepEqual(auditBody.records.map(({ action, outcome, proofState, summary }) => ({ action, outcome, proofState, summary })), [{
      action: "guided_auth.cancel",
      outcome: "applied",
      proofState: "verified",
      summary: "Local guided-auth challenge cancelled."
    }]);
    assert.equal(JSON.stringify(auditBody).match(/private@example\.test|auth_[a-f0-9-]{36}|[a-f0-9]{64}/), null);
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/auth-challenges/auth_00000000-0000-4000-8000-000000000000/cancel`, { method: "POST", headers: { authorization: "Bearer test-token", origin: `http://127.0.0.1:${address.port}` } })).status, 404);
  } finally {
    await app.close();
  }
});

test("guided-auth cancellation fails closed before changing challenge state when durable audit evidence is corrupt", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  const challenges = new AuthChallengeStore(join(root, "challenges.json"));
  const auditPath = join(root, "audit.json");
  const auditStore = new AuditStore(auditPath);
  const challenge = await challenges.create({ mode: "reauth", provider: "openai", runtime: "openclaw", target: "private@example.test", scope: "agent:main" });
  await writeFile(auditPath, "{not valid durable audit evidence");
  const app = createAccountCenterServer({ token: "test-token", challengeStore: challenges, auditStore });
  const address = await app.listen();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/auth-challenges/${challenge.id}/cancel`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", origin: `http://127.0.0.1:${address.port}` }
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "audit_unavailable" });
    assert.equal((await challenges.get(challenge.id))?.status, "pending");
  } finally {
    await app.close();
  }
});

test("repeating a guided-auth cancellation is idempotent and does not duplicate durable audit evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  const challenges = new AuthChallengeStore(join(root, "challenges.json"));
  const auditStore = new AuditStore(join(root, "audit.json"));
  const challenge = await challenges.create({ mode: "reauth", provider: "openai", runtime: "openclaw", target: "private@example.test", scope: "agent:main" });
  const app = createAccountCenterServer({ token: "test-token", challengeStore: challenges, auditStore });
  const address = await app.listen();
  const path = `/api/auth-challenges/${challenge.id}/cancel`;
  const headers = { authorization: "Bearer test-token", origin: `http://127.0.0.1:${address.port}` };
  try {
    const first = await fetch(`http://127.0.0.1:${address.port}${path}`, { method: "POST", headers });
    assert.equal(first.status, 200);
    const repeated = await fetch(`http://127.0.0.1:${address.port}${path}`, { method: "POST", headers });
    assert.equal(repeated.status, 200);
    assert.equal((await repeated.json() as { challenge: { status: string } }).challenge.status, "cancelled");
    const audit = await request(address.port, "/api/audit", "test-token");
    assert.equal(audit.status, 200);
    assert.equal((await audit.json() as { records: unknown[] }).records.length, 1);
  } finally {
    await app.close();
  }
});

test("cancelling an elapsed guided-auth challenge reports expiry without recording a false cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  const challenges = new AuthChallengeStore(join(root, "challenges.json"));
  const auditStore = new AuditStore(join(root, "audit.json"));
  const challenge = await challenges.create({
    mode: "reauth",
    provider: "openai",
    runtime: "openclaw",
    target: "private@example.test",
    scope: "agent:main",
    expiresAt: "2020-01-01T00:00:00.000Z"
  });
  const app = createAccountCenterServer({ token: "test-token", challengeStore: challenges, auditStore });
  const address = await app.listen();
  const path = `/api/auth-challenges/${challenge.id}/cancel`;
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", origin: `http://127.0.0.1:${address.port}` }
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { challenge: { status: string } }).challenge.status, "expired");
    assert.equal((await challenges.get(challenge.id))?.status, "expired");
    assert.deepEqual((await auditStore.list()).map((record) => record.action), []);
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
