import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditStore } from "./audit-store.js";

test("audit store appends redacted proof records with owner-only persistence", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-audit-"));
  const path = join(root, "state", "audit.json");
  const store = new AuditStore(path);
  const record = await store.append({
    action: "route.use",
    outcome: "blocked",
    proofState: "unproven",
    requestDigest: "request-digest",
    summary: "Route mutation requires a verified contract.",
    warnings: ["no_live_mutation"],
    unsafeContext: { target: "private@example.test", stdout: "access_token=secret" }
  });
  assert.match(record.id, /^audit_/);
  assert.deepEqual((await store.list()).map((item) => item.id), [record.id]);
  assert.equal((await stat(join(root, "state"))).mode & 0o777, 0o700);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const persisted = await readFile(path, "utf8");
  assert.equal(persisted.includes("private@example.test"), false);
  assert.equal(persisted.includes("access_token"), false);
});

test("audit store returns bounded newest-first pages", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "account-center-audit-pages-")), "audit.json");
  const store = new AuditStore(path);
  await store.append({ action: "route.use", outcome: "blocked", proofState: "unproven", requestDigest: "one", summary: "one", warnings: [] });
  await store.append({ action: "route.use", outcome: "blocked", proofState: "unproven", requestDigest: "two", summary: "two", warnings: [] });
  assert.equal((await store.list({ limit: 1 }))[0]?.requestDigest, "two");
  assert.equal((await store.list({ limit: 999 })).length, 2);
});
