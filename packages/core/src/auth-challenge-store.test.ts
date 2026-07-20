import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthChallengeStore } from "./auth-challenge-store.js";

test("challenge store persists redacted lifecycle state without credentials or account emails", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "account-center-challenges-")), "challenges.json");
  const store = new AuthChallengeStore(path);
  const created = await store.create({ mode: "add", provider: "openai", runtime: "openclaw", target: "new@example.com", scope: "agent:main" });
  const reloaded = await new AuthChallengeStore(path).get(created.id);
  assert.equal(reloaded?.mode, "add");
  assert.equal((await readFile(path, "utf8")).includes("new@example.com"), false);
  const cancelled = await store.cancel(created.id);
  assert.equal(cancelled?.status, "cancelled");
  assert.equal(JSON.stringify(cancelled).includes("token"), false);
  assert.equal(JSON.stringify(cancelled).includes("new@example.com"), false);
});

test("challenge store durably records verified completion or failure once and preserves invalid terminal states", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "account-center-challenges-")), "challenges.json");
  const store = new AuthChallengeStore(path);
  const complete = await store.create({ mode: "add", provider: "openai", runtime: "openclaw", target: "complete@example.test", scope: "default" });
  const failed = await store.create({ mode: "reauth", provider: "openai", runtime: "openclaw", target: "failed@example.test", scope: "default" });
  const cancelled = await store.create({ mode: "add", provider: "openai", runtime: "openclaw", target: "cancelled@example.test", scope: "default" });
  await store.cancel(cancelled.id);

  assert.deepEqual(await store.completeWithResult(complete.id), { challenge: { ...(await store.get(complete.id))!, status: "completed" }, changed: true });
  assert.equal((await store.completeWithResult(complete.id))?.changed, false);
  assert.equal((await store.failWithResult(failed.id))?.challenge.status, "failed");
  assert.equal((await store.failWithResult(failed.id))?.changed, false);
  assert.equal((await store.completeWithResult(cancelled.id))?.changed, false);
  assert.equal((await store.get(cancelled.id))?.status, "cancelled");
  const persisted = await readFile(path, "utf8");
  assert.equal(persisted.includes("@example.test"), false);
});

test("terminal audit verification remains redacted and is only exposed for verified completion or failure", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "account-center-challenges-")), "challenges.json");
  const store = new AuthChallengeStore(path);
  const completed = await store.create({ mode: "add", provider: "openai", runtime: "openclaw", target: "private@example.test", scope: "default" });
  const cancelled = await store.create({ mode: "reauth", provider: "openai", runtime: "openclaw", target: "cancelled@example.test", scope: "default" });

  await store.completeWithResult(completed.id);
  const verified = await store.markTerminalAuditVerified(completed.id);
  await store.cancel(cancelled.id);
  const nonTerminal = await store.markTerminalAuditVerified(cancelled.id);
  const persisted = await readFile(path, "utf8");

  assert.equal(verified?.auditState, "verified");
  assert.equal(nonTerminal?.auditState, undefined);
  assert.equal(persisted.includes("private@example.test"), false);
  assert.equal(persisted.includes("cancelled@example.test"), false);
  assert.equal(JSON.parse(persisted).find((challenge: { id: string }) => challenge.id === completed.id).auditState, "verified");
  assert.equal("auditState" in JSON.parse(persisted).find((challenge: { id: string }) => challenge.id === cancelled.id), false);
});

test("independent challenge stores serialize competing creation of the same active challenge", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "account-center-challenges-")), "challenges.json");
  const input = { mode: "reauth" as const, provider: "openai", runtime: "openclaw", target: "private@example.test", scope: "agent:main" };
  const [first, second] = await Promise.all([new AuthChallengeStore(path).create(input), new AuthChallengeStore(path).create(input)]);
  assert.equal(first.id, second.id);
  const persisted = await new AuthChallengeStore(path).list();
  assert.equal(persisted.length, 1);
  assert.equal(JSON.stringify(persisted).includes("private@example.test"), false);
});

test("challenge store reports whether durable guided-auth creation reused an active challenge", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "account-center-challenges-")), "challenges.json");
  const store = new AuthChallengeStore(path);
  const input = { mode: "add" as const, provider: "openai", runtime: "openclaw", target: "new@example.com", scope: "default" };
  const first = await store.createWithResult(input);
  const retry = await store.createWithResult({ ...input, target: "NEW@example.com" });
  const distinctMode = await store.createWithResult({ ...input, mode: "reauth" });
  assert.equal(first.created, true);
  assert.equal(retry.created, false);
  assert.equal(retry.challenge.id, first.challenge.id);
  assert.equal(distinctMode.created, true);
  assert.notEqual(distinctMode.challenge.id, first.challenge.id);
});

test("challenge store removes raw account targets from legacy records on read", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "account-center-challenges-")), "challenges.json");
  await writeFile(path, JSON.stringify([{ id: "auth_legacy", key: "key", mode: "add", status: "pending", target: "legacy@example.com", provider: "openai", runtime: "openclaw", scope: "agent:main", createdAt: "2026-07-14T00:00:00.000Z", updatedAt: "2026-07-14T00:00:00.000Z" }]));
  const challenges = await new AuthChallengeStore(path).list();
  assert.equal("target" in challenges[0], false);
  assert.equal((await readFile(path, "utf8")).includes("legacy@example.com"), false);
});

test("challenge store expires elapsed pending challenges durably when read", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "account-center-challenges-")), "challenges.json");
  await writeFile(path, JSON.stringify([{ id: "auth_expired", key: "key", mode: "add", status: "pending", provider: "openai", runtime: "openclaw", scope: "agent:main", expiresAt: "2020-01-01T00:00:00.000Z", createdAt: "2019-12-31T00:00:00.000Z", updatedAt: "2019-12-31T00:00:00.000Z" }]));
  const challenges = await new AuthChallengeStore(path).list();
  assert.equal(challenges[0]?.status, "expired");
  assert.equal(JSON.parse(await readFile(path, "utf8"))[0].status, "expired");
});

test("challenge store fails closed when a durable lifecycle record has an unknown status", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "account-center-challenges-")), "challenges.json");
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
  await assert.rejects(new AuthChallengeStore(path).list(), /challenge_store_corrupt/);
});

test("challenge store fails closed when a durable record contains unsafe public metadata", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "account-center-challenges-")), "challenges.json");
  await writeFile(path, JSON.stringify([{
    id: "auth_corrupt",
    key: "key",
    mode: "add",
    status: "pending",
    provider: "private@example.test",
    runtime: "openclaw",
    scope: "default",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z"
  }]));
  await assert.rejects(new AuthChallengeStore(path).list(), /challenge_store_corrupt/);
});
