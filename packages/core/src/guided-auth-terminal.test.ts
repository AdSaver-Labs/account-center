import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditStore } from "./audit-store.js";
import { AuthChallengeStore } from "./auth-challenge-store.js";
import { executeGuidedAuthReauthTerminal, executeGuidedAuthStart } from "./guided-auth-lifecycle-executor.js";

const now = new Date("2026-08-01T20:00:00.000Z");
const input = { mode: "reauth" as const, provider: "openai", runtime: "openclaw", target: "private@example.test", scope: "default" };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "account-center-terminal-proof-"));
  const challenges = new AuthChallengeStore(join(root, "challenges.json"));
  const audit = new AuditStore(join(root, "audit.json"));
  const started = await executeGuidedAuthStart(input, { challengeStore: challenges });
  const proof = { schemaVersion: "account-center.reauth-proof.v1", challengeId: started.challenge.id, provider: "openai", runtime: "openclaw", scope: "default", observedAt: "2026-08-01T19:59:00.000Z", identity: "matched", health: "ok", replacement: "verified", result: "completed" };
  return { challenges, audit, started, proof, root };
}

test("guided reauth terminal transition atomically persists only sealed completed metadata and bounded audit evidence", async () => {
  const { challenges, audit, started, proof, root } = await fixture();
  const result = await executeGuidedAuthReauthTerminal(started.challenge.id, proof, { challengeStore: challenges, auditStore: audit }, now);
  assert.equal(result.kind, "completed");
  assert.equal((await challenges.get(started.challenge.id))?.status, "completed");
  const durable = await readFile(join(root, "challenges.json"), "utf8");
  assert.doesNotMatch(durable, /private@example|token|proof|verified|replacement/i);
  const records = await audit.list();
  assert.equal(records.length, 1);
  assert.deepEqual(Object.keys(records[0]!).sort(), ["action", "createdAt", "id", "outcome", "proofState", "requestDigest", "runtime", "scopeKind", "summary", "warnings"]);
  assert.doesNotMatch(JSON.stringify(records), /private@example|token|replacement/i);
});

test("guided reauth terminal supports a verified failure but rejects malformed, stale, and replayed proof without mutation", async () => {
  const { challenges, audit, started, proof } = await fixture();
  assert.equal((await executeGuidedAuthReauthTerminal(started.challenge.id, { ...proof, token: "secret" }, { challengeStore: challenges, auditStore: audit }, now)).kind, "unchanged");
  assert.equal((await executeGuidedAuthReauthTerminal(started.challenge.id, { ...proof, observedAt: "2026-08-01T19:00:00.000Z" }, { challengeStore: challenges, auditStore: audit }, now)).kind, "unchanged");
  const failed = { ...proof, health: "failed", replacement: "not_replaced", result: "failed" };
  assert.equal((await executeGuidedAuthReauthTerminal(started.challenge.id, failed, { challengeStore: challenges, auditStore: audit }, now)).kind, "failed");
  assert.equal((await executeGuidedAuthReauthTerminal(started.challenge.id, failed, { challengeStore: challenges, auditStore: audit }, now)).kind, "unchanged");
  assert.equal((await challenges.get(started.challenge.id))?.status, "failed");
  assert.equal((await audit.list()).length, 1);
});

test("guided reauth terminal fails closed before durable transition when audit evidence is unavailable", async () => {
  const { challenges, started, proof, root } = await fixture();
  const unavailable = new AuditStore(join(root, "audit.json"));
  await (await import("node:fs/promises")).writeFile(join(root, "audit.json"), "not-json");
  assert.deepEqual(await executeGuidedAuthReauthTerminal(started.challenge.id, proof, { challengeStore: challenges, auditStore: unavailable }, now), { kind: "audit_unavailable" });
  assert.equal((await challenges.get(started.challenge.id))?.status, "pending");
});
