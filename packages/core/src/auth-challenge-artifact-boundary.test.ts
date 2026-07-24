import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const builtStoreModule = new URL("../dist/auth-challenge-store.js", import.meta.url);

test("compiled AuthChallengeStore.write rejects terminal, proof, verification, and arbitrary records before mutation", async () => {
  const { AuthChallengeStore } = await import(builtStoreModule.href);
  const root = await mkdtemp(join(tmpdir(), "account-center-artifact-challenges-"));
  const path = join(root, "nested", "challenges.json");
  const store = new AuthChallengeStore(path);
  const write = (store as { write(challenges: unknown): Promise<void> }).write.bind(store);
  const unsafe = {
    id: "auth_00000000-0000-4000-8000-000000000000", key: "key", mode: "add", status: "completed",
    provider: "openai", runtime: "openclaw", scope: "default", createdAt: "2026-07-14T00:00:00.000Z", updatedAt: "2026-07-14T00:00:00.000Z",
    proof: "attacker-controlled", verificationState: "VERIFIED", arbitrary: true
  };

  await assert.rejects(write([unsafe]), /challenge_store_unsafe_lifecycle/);
  await assert.rejects(access(path));
  await assert.rejects(access(`${path}.lock`));

  const pending = await store.create({ mode: "add", provider: "openai", runtime: "openclaw", target: "new@example.test", scope: "agent:main" });
  const before = await readFile(path, "utf8");
  for (const record of [
    { ...pending, status: "completed" },
    { ...pending, proof: "attacker-controlled" },
    { ...pending, verificationState: "VERIFIED" },
    { ...pending, arbitrary: true }
  ]) await assert.rejects(write([record]), /challenge_store_unsafe_lifecycle/);

  assert.equal(await readFile(path, "utf8"), before);
  assert.equal((await new AuthChallengeStore(path).get(pending.id))?.status, "pending");
});

test("compiled direct writes use the lifecycle lock rather than racing creation", async () => {
  const { AuthChallengeStore } = await import(builtStoreModule.href);
  const path = join(await mkdtemp(join(tmpdir(), "account-center-artifact-challenges-")), "challenges.json");
  const store = new AuthChallengeStore(path);
  const pending = await store.create({ mode: "add", provider: "openai", runtime: "openclaw", target: "first@example.test", scope: "default" });
  const direct = (store as { write(challenges: unknown): Promise<void> }).write.bind(store);
  await Promise.all([
    direct([{ ...pending, status: "cancelled", updatedAt: "2026-07-14T01:00:00.000Z" }]),
    store.create({ mode: "reauth", provider: "openai", runtime: "openclaw", target: "second@example.test", scope: "default" })
  ]);
  const persisted = await new AuthChallengeStore(path).list() as Array<{ status: string }>;
  assert.ok(persisted.length === 1 || persisted.length === 2);
  assert.ok(persisted.every((challenge: { status: string }) => ["pending", "cancelled", "expired"].includes(challenge.status)));
});
