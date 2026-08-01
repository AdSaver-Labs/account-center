import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AuditStore } from "./audit-store.js";
import { AuthChallengeStore } from "./auth-challenge-store.js";
import { executeGuidedAuthCancel, executeGuidedAuthStart } from "./guided-auth-lifecycle-executor.js";

const input = { mode: "add" as const, provider: "openai", runtime: "openclaw", target: "private@example.test", scope: "default" };

test("guided-auth lifecycle executor owns local start idempotency without runtime authority", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "account-center-guided-auth-executor-")), "challenges.json");
  const store = new AuthChallengeStore(path);
  const created = await executeGuidedAuthStart(input, { challengeStore: store });
  const reused = await executeGuidedAuthStart(input, { challengeStore: store });
  assert.equal(created.kind, "created");
  assert.equal(reused.kind, "reused");
  assert.equal(reused.challenge.id, created.challenge.id);
  assert.equal((await readFile(path, "utf8")).includes("private@example.test"), false);
});

test("guided-auth lifecycle executor fails closed before cancel when audit evidence is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-guided-auth-executor-"));
  const challengePath = join(root, "challenges.json");
  const store = new AuthChallengeStore(challengePath);
  const started = await executeGuidedAuthStart(input, { challengeStore: store });
  const durable = await readFile(challengePath, "utf8");
  await writeFile(join(root, "audit.json"), "not-json");
  const cancelled = await executeGuidedAuthCancel(started.challenge.id, { challengeStore: store, auditStore: new AuditStore(join(root, "audit.json")) });
  assert.deepEqual(cancelled, { kind: "audit_unavailable" });
  assert.equal(await readFile(challengePath, "utf8"), durable);
});

test("guided-auth lifecycle executor appends bounded local audit evidence only for a changed cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-guided-auth-executor-"));
  const store = new AuthChallengeStore(join(root, "challenges.json"));
  const audit = new AuditStore(join(root, "audit.json"));
  const started = await executeGuidedAuthStart(input, { challengeStore: store });
  assert.equal((await executeGuidedAuthCancel(started.challenge.id, { challengeStore: store, auditStore: audit })).kind, "cancelled");
  assert.equal((await executeGuidedAuthCancel(started.challenge.id, { challengeStore: store, auditStore: audit })).kind, "unchanged");
  const records = await audit.list();
  assert.equal(records.length, 1);
  assert.deepEqual(Object.keys(records[0]!).sort(), ["action", "createdAt", "id", "outcome", "proofState", "requestDigest", "runtime", "scopeKind", "summary", "warnings"]);
  assert.equal(JSON.stringify(records).includes("private@example.test"), false);
});
