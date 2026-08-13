import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AuditStore, AuthChallengeStore, MutationRepository } from "@account-center/core";
import { createPersistentControlPanel } from "./index.js";
import { AccountUiPreferencesStore } from "./account-preferences-store.js";

test("migrates and safely deduplicates legacy global hides into Hermes/default without hiding the same account in OpenClaw/default", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-preferences-migration-"));
  try {
    const path = join(root, "account-ui-preferences.v1.json");
    await writeFile(path, JSON.stringify({ schemaVersion: "account-center.account-ui-preferences.v1", hiddenAccountRefs: ["account-2", "account-1", "account-2"] }), { mode: 0o600 });
    await chmod(path, 0o600);
    const store = new AccountUiPreferencesStore(root);
    assert.deepEqual(await store.view("hermes|default"), { schemaVersion: "account-center.account-ui-preferences.v1", hiddenAccountRefs: ["account-1", "account-2"] });
    assert.deepEqual(await store.view("openclaw|default"), { schemaVersion: "account-center.account-ui-preferences.v1", hiddenAccountRefs: [] });
    assert.deepEqual(await store.setAccountState("hermes|default", "account-1", "active"), { schemaVersion: "account-center.account-ui-preferences.v1", hiddenAccountRefs: ["account-2"] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local preference storage rejects generic-command as a durable public scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-preferences-public-scope-"));
  try {
    const store = new AccountUiPreferencesStore(root);
    await assert.rejects(store.view("generic-command|default"), /invalid_scope_key/);
    await assert.rejects(store.setAccountState("generic-command|default", "account-1", "hidden"), /invalid_scope_key/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
    const [challengeResponse, auditResponse, operationResponse, preferencesResponse] = await Promise.all([
      fetch(`http://127.0.0.1:${address.port}/api/auth-challenges?runtime=openclaw&scope=default`, { headers }),
      fetch(`http://127.0.0.1:${address.port}/api/audit`, { headers }),
      fetch(`http://127.0.0.1:${address.port}/api/mutation-operations`, { headers }),
      fetch(`http://127.0.0.1:${address.port}/api/account-ui-preferences?runtime=hermes&scope=default`, { headers })
    ]);
    assert.equal(challengeResponse.status, 200);
    assert.equal(auditResponse.status, 200);
    assert.equal(operationResponse.status, 200);
    assert.equal(preferencesResponse.status, 200);
    const challengesView = await challengeResponse.json() as { challenges: Array<{ target?: unknown }> };
    const auditView = await auditResponse.json() as { records: unknown[] };
    const operationsView = await operationResponse.json() as { operations: unknown[] };
    assert.equal(challengesView.challenges.length, 1);
    assert.equal("target" in challengesView.challenges[0], false);
    assert.equal(auditView.records.length, 1);
    assert.equal(operationsView.operations.length, 1);
    assert.deepEqual(await preferencesResponse.json(), { schemaVersion: "account-center.account-ui-preferences.v1", hiddenAccountRefs: [] });
    const origin = `http://127.0.0.1:${address.port}`;
    const hide = await fetch(`${origin}/api/account-ui-preferences?runtime=hermes&scope=default`, { method: "POST", headers: { ...headers, origin, "content-type": "application/json" }, body: JSON.stringify({ accountRef: "account-1", state: "hidden" }) });
    assert.equal(hide.status, 200);
    assert.deepEqual(await hide.json(), { schemaVersion: "account-center.account-ui-preferences.v1", hiddenAccountRefs: ["account-1"] });
    const restore = await fetch(`${origin}/api/account-ui-preferences?runtime=hermes&scope=default`, { method: "POST", headers: { ...headers, origin, "content-type": "application/json" }, body: JSON.stringify({ accountRef: "account-1", state: "active" }) });
    assert.equal(restore.status, 200);
    assert.deepEqual(await restore.json(), { schemaVersion: "account-center.account-ui-preferences.v1", hiddenAccountRefs: [] });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
