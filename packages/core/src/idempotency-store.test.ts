import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableIdempotencyStore } from "./idempotency-store.js";

test("durable idempotency store persists replay decisions with owner-only files and no raw key", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-idempotency-"));
  const path = join(root, "state", "idempotency.json");
  const store = new DurableIdempotencyStore(path);
  assert.deepEqual(await store.claim("client-key-123", "request-digest-a"), { kind: "new" });
  assert.deepEqual(await new DurableIdempotencyStore(path).claim("client-key-123", "request-digest-a"), { kind: "replay" });
  assert.deepEqual(await store.claim("client-key-123", "request-digest-b"), { kind: "blocked", reason: "idempotency_key_reused_with_different_request" });
  assert.equal((await stat(join(root, "state"))).mode & 0o777, 0o700);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await readFile(path, "utf8")).includes("client-key-123"), false);
});

test("independent durable stores serialize competing claims for the same key", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "account-center-idempotency-race-")), "idempotency.json");
  const [first, second] = await Promise.all([
    new DurableIdempotencyStore(path).claim("same-client-key", "same-request"),
    new DurableIdempotencyStore(path).claim("same-client-key", "same-request")
  ]);
  assert.deepEqual([first.kind, second.kind].sort(), ["new", "replay"]);
});
