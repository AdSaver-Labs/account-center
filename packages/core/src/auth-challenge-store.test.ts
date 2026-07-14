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

test("independent challenge stores serialize competing creation of the same active challenge", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "account-center-challenges-")), "challenges.json");
  const input = { mode: "reauth" as const, provider: "openai", runtime: "openclaw", target: "private@example.test", scope: "agent:main" };
  const [first, second] = await Promise.all([new AuthChallengeStore(path).create(input), new AuthChallengeStore(path).create(input)]);
  assert.equal(first.id, second.id);
  const persisted = await new AuthChallengeStore(path).list();
  assert.equal(persisted.length, 1);
  assert.equal(JSON.stringify(persisted).includes("private@example.test"), false);
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
