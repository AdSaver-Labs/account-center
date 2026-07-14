import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthChallengeStore } from "./auth-challenge-store.js";

test("challenge store persists redacted lifecycle state without credentials", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "account-center-challenges-")), "challenges.json");
  const store = new AuthChallengeStore(path);
  const created = await store.create({ mode: "add", provider: "openai", runtime: "openclaw", target: "new@example.com", scope: "agent:main" });
  const reloaded = await new AuthChallengeStore(path).get(created.id);
  assert.equal(reloaded?.mode, "add");
  const cancelled = await store.cancel(created.id);
  assert.equal(cancelled?.status, "cancelled");
  assert.equal(JSON.stringify(cancelled).includes("token"), false);
});
