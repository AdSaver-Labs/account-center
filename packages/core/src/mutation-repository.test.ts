import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { MutationRepository } from "./mutation-repository.js";

const execFile = promisify(execFileCallback);

const key = "s3ZMdvUKp3wnaAq8EKUla9B1";
const input = {
  idempotencyKey: key,
  requestDigest: "a".repeat(64),
  audit: { action: "route.use", provider: "openai", runtime: "openclaw", scopeKind: "agent" as const, scopeIdDigest: "b".repeat(64), targetDigest: "c".repeat(64) }
};

test("mutation repository durably blocks retry of a pending operation and replays an immutable terminal receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-mutations-"));
  const repository = new MutationRepository(root, { now: () => new Date("2026-07-14T17:30:00.000Z"), operationId: () => "op_test" });
  const claim = await repository.claim(input);
  assert.deepEqual(claim, { kind: "execute", operationId: "op_test" });
  assert.deepEqual(await new MutationRepository(root).claim(input), { kind: "blocked", reason: "operation_outcome_unknown" });
  const receipt = await repository.complete({ operationId: "op_test", outcome: "not_applied", warningCodes: ["runtime_unavailable"] });
  const replay = await new MutationRepository(root).claim(input);
  assert.deepEqual(replay, { kind: "replay", operationId: "op_test", outcome: "not_applied", receipt });
  assert.deepEqual(await repository.complete({ operationId: "op_test", outcome: "not_applied", warningCodes: ["runtime_unavailable"] }), receipt);
  await assert.rejects(() => repository.complete({ operationId: "op_test", outcome: "applied", warningCodes: [] }), /immutable/);
});

test("mutation repository persists only fixed redacted schema in owner-only state", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-mutations-safe-"));
  const repository = new MutationRepository(root);
  await repository.claim(input);
  const state = await readFile(join(root, "mutation-repository.v1.json"), "utf8");
  assert.equal(state.includes(key), false);
  assert.equal(state.includes("private@example.test"), false);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(join(root, "mutation-repository.v1.json"))).mode & 0o777, 0o600);
  assert.deepEqual(await repository.claim({ ...input, requestDigest: "d".repeat(64) }), { kind: "blocked", reason: "idempotency_key_reused_with_different_request" });
});

test("completed operation links only a redacted adapter receipt reference and verification state", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-mutations-evidence-"));
  const repository = new MutationRepository(root, { operationId: () => "op_evidence" });
  const claim = await repository.claim(input);
  if (claim.kind !== "execute") throw new Error("expected executable operation");
  await repository.complete({ operationId: claim.operationId, outcome: "applied", evidence: { receiptId: "evt_route_verified", verification: "verified", liveRuntimeMutation: true } });
  const raw = await readFile(join(root, "mutation-repository.v1.json"), "utf8");
  assert.match(raw, /evt_route_verified/);
  assert.doesNotMatch(raw, /helper-2|private@example/);
});

test("mutation repository rejects malformed persisted operations before a redacted history view can expose them", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-mutations-corrupt-"));
  const statePath = join(root, "mutation-repository.v1.json");
  await writeFile(statePath, JSON.stringify({
    schemaVersion: "account-center.mutation-repository.v1",
    operations: [{
      operationId: "op_test",
      idempotencyKeyDigest: "a".repeat(64),
      requestDigest: "b".repeat(64),
      state: "pending",
      createdAt: "2026-07-15T00:00:00.000Z",
      audit: { action: "route.use.private@example.test", provider: "openai", runtime: "openclaw", scopeKind: "agent", scopeIdDigest: "c".repeat(64), targetDigest: "d".repeat(64) }
    }]
  }), { mode: 0o600 });
  await chmod(root, 0o700);

  await assert.rejects(() => new MutationRepository(root).list(), /repository_corrupt/);
});

test("mutation repository rejects Object.prototype pollution added after module import", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-mutations-postimport-"));
  const prototypeKey = "accountCenterPostImportPollution";
  const originalDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, prototypeKey);

  Object.defineProperty(Object.prototype, prototypeKey, { configurable: true, value: true });
  try {
    await assert.rejects(() => new MutationRepository(root).list(), /repository_corrupt/);
  } finally {
    if (originalDescriptor) Object.defineProperty(Object.prototype, prototypeKey, originalDescriptor);
    else Reflect.deleteProperty(Object.prototype, prototypeKey);
  }
  assert.deepEqual(await new MutationRepository(root).list(), []);
  assert.equal(Object.getOwnPropertyDescriptor(Object.prototype, prototypeKey), originalDescriptor);
});

test("mutation repository rejects Object.prototype pollution present before module import without touching durable state", async () => {
  const parent = await mkdtemp(join(tmpdir(), "account-center-mutations-preimport-"));
  const root = join(parent, "repository");
  const moduleUrl = new URL("./mutation-repository.js", import.meta.url).href;
  const prototypeKey = "accountCenterPreImportPollution";
  const script = `
    import assert from "node:assert/strict";
    import { access } from "node:fs/promises";
    const [moduleUrl, root, prototypeKey] = process.argv.slice(1);
    Object.defineProperty(Object.prototype, prototypeKey, { configurable: true, value: true });
    try {
      const { MutationRepository } = await import(moduleUrl);
      await assert.rejects(() => new MutationRepository(root).list(), /repository_corrupt/);
      await assert.rejects(() => access(root));
    } finally {
      delete Object.prototype[prototypeKey];
    }
    assert.equal(Object.hasOwn(Object.prototype, prototypeKey), false);
    const { MutationRepository } = await import(moduleUrl);
    assert.deepEqual(await new MutationRepository(root).list(), []);
    process.stdout.write("pre-import pollution rejected and restored\\n");
  `;

  const { stdout, stderr } = await execFile(process.execPath, ["--input-type=module", "--eval", script, moduleUrl, root, prototypeKey]);
  assert.equal(stderr, "");
  assert.equal(stdout, "pre-import pollution rejected and restored\n");
  assert.equal(Object.hasOwn(Object.prototype, prototypeKey), false);
});
