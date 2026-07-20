import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MutationRepository } from "./mutation-repository.js";

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

test("mutation repository accepts only reauth evidence with a semantically consistent outcome", async () => {
  const valid = [
    { outcome: "applied", warnings: [], reauth: { verification: "verified", route: "not_requested" } },
    { outcome: "applied", warnings: [], reauth: { verification: "verified", route: "applied" } },
    { outcome: "not_applied", warnings: [], reauth: { verification: "verified", route: "not_applied" } },
    { outcome: "not_applied", warnings: [], reauth: { verification: "verified", route: "unproven" } },
    { outcome: "not_applied", warnings: [], reauth: { verification: "failed", route: "not_requested" } },
    { outcome: "not_applied", warnings: [], reauth: { verification: "unproven", route: "not_requested" } },
    { outcome: "failed", warnings: ["reauth_stage_failed"], reauth: { verification: "unproven", route: "not_requested" } }
  ] as const;
  for (const [index, { outcome, reauth, warnings }] of valid.entries()) {
    const root = await mkdtemp(join(tmpdir(), "account-center-mutations-reauth-valid-"));
    const repository = new MutationRepository(root);
    const claim = await repository.claim({ ...input, idempotencyKey: `${key.slice(0, -1)}${index}` });
    if (claim.kind !== "execute") throw new Error("expected executable operation");
    await repository.complete({ operationId: claim.operationId, outcome, warningCodes: [...warnings], evidence: { receiptId: `evt_reauth_valid_${index}`, verification: "unproven", reauth } });
  }
});

test("mutation repository rejects reauth evidence paired with a contradictory outcome", async () => {
  const invalid = [
    { outcome: "not_applied", reauth: { verification: "verified", route: "not_requested" } },
    { outcome: "not_applied", reauth: { verification: "verified", route: "applied" } },
    { outcome: "applied", reauth: { verification: "verified", route: "not_applied" } },
    { outcome: "applied", reauth: { verification: "verified", route: "unproven" } },
    { outcome: "applied", reauth: { verification: "unproven", route: "not_requested" } },
    { outcome: "failed", reauth: { verification: "unproven", route: "not_requested" } }
  ] as const;
  for (const [index, { outcome, reauth }] of invalid.entries()) {
    const root = await mkdtemp(join(tmpdir(), "account-center-mutations-reauth-outcome-invalid-"));
    const repository = new MutationRepository(root);
    const claim = await repository.claim({ ...input, idempotencyKey: `${key.slice(0, -1)}${index}` });
    if (claim.kind !== "execute") throw new Error("expected executable operation");
    await assert.rejects(() => repository.complete({ operationId: claim.operationId, outcome, evidence: { receiptId: `evt_reauth_outcome_invalid_${index}`, verification: "unproven", reauth } }), /invalid_receipt_evidence/);
  }
});

test("mutation repository permits reauth_stage_failed only for failed receipts", async () => {
  const invalid = [
    { outcome: "applied", reauth: { verification: "verified", route: "not_requested" } },
    { outcome: "not_applied", reauth: { verification: "failed", route: "not_requested" } }
  ] as const;
  for (const [index, { outcome, reauth }] of invalid.entries()) {
    const root = await mkdtemp(join(tmpdir(), "account-center-mutations-reauth-stage-warning-"));
    const repository = new MutationRepository(root);
    const claim = await repository.claim({ ...input, idempotencyKey: `${key.slice(0, -1)}${index}` });
    if (claim.kind !== "execute") throw new Error("expected executable operation");
    await assert.rejects(() => repository.complete({ operationId: claim.operationId, outcome, warningCodes: ["reauth_stage_failed"], evidence: { receiptId: `evt_reauth_stage_warning_${index}`, verification: "unproven", reauth } }), /invalid_receipt_evidence/);
  }
});

test("mutation repository requires a failed outcome for reauth_stage_failed even without evidence", async () => {
  for (const outcome of ["applied", "not_applied", "blocked"] as const) {
    const root = await mkdtemp(join(tmpdir(), "account-center-mutations-reauth-stage-warning-only-"));
    const repository = new MutationRepository(root);
    const claim = await repository.claim({ ...input, idempotencyKey: `${key.slice(0, -1)}${outcome[0]}` });
    if (claim.kind !== "execute") throw new Error("expected executable operation");
    await assert.rejects(() => repository.complete({ operationId: claim.operationId, outcome, warningCodes: ["reauth_stage_failed"] }), /invalid_receipt_evidence/);
  }
});

test("mutation repository rejects unknown and null nested receipt evidence structures on persistence and read", async () => {
  const proof = {
    nativeEvent: { action: "route.use", scopeId: "id_a1b2c3d4e5f60718293a4b5c", targetId: "id_b1b2c3d4e5f60718293a4b5c", status: "verified" as const },
    verification: {
      scopeId: "id_a1b2c3d4e5f60718293a4b5c",
      before: { status: "observed" as const, orderTargetIds: ["id_b1b2c3d4e5f60718293a4b5c"] },
      after: { status: "absent" as const, orderTargetIds: [] }
    }
  };
  const malformed = [
    { reauth: { verification: "verified", route: "not_requested", unexpected: true } },
    { proof: { ...proof, unexpected: true } },
    { proof: { ...proof, nativeEvent: { ...proof.nativeEvent, unexpected: true } } },
    { proof: { ...proof, verification: { ...proof.verification, unexpected: true } } },
    { proof: { ...proof, verification: { ...proof.verification, before: { ...proof.verification.before, unexpected: true } } } },
    { proof: { ...proof, verification: { ...proof.verification, after: { ...proof.verification.after, unexpected: true } } } },
    { proof: null },
    { proof: "not_an_object" },
    { proof: { ...proof, nativeEvent: null } },
    { proof: { ...proof, nativeEvent: [] } },
    { proof: { ...proof, verification: null } },
    { proof: { ...proof, verification: "not_an_object" } },
    { proof: { ...proof, verification: { ...proof.verification, before: null } } },
    { proof: { ...proof, verification: { ...proof.verification, before: [] } } },
    { proof: { ...proof, verification: { ...proof.verification, after: null } } },
    { proof: { ...proof, verification: { ...proof.verification, after: "not_an_object" } } }
  ];
  for (const [index, corruptEvidence] of malformed.entries()) {
    const root = await mkdtemp(join(tmpdir(), "account-center-mutations-nested-evidence-"));
    const repository = new MutationRepository(root, { operationId: () => `op_nested_${index}` });
    const claim = await repository.claim({ ...input, idempotencyKey: `${key.slice(0, -2)}n${index}` });
    if (claim.kind !== "execute") throw new Error("expected executable operation");
    const evidence = { receiptId: `evt_nested_${index}`, verification: "verified" as const, ...corruptEvidence };
    await assert.rejects(() => repository.complete({ operationId: claim.operationId, outcome: "applied", evidence: evidence as never }), /invalid_receipt_evidence/);

    await repository.complete({ operationId: claim.operationId, outcome: "applied", evidence: { receiptId: `evt_nested_${index}`, verification: "verified", proof } });
    const statePath = join(root, "mutation-repository.v1.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.operations[0].receipt.evidence = evidence;
    await writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
    await assert.rejects(() => new MutationRepository(root).claim({ ...input, idempotencyKey: `${key.slice(0, -2)}n${index}` }), /repository_corrupt/);
  }
});

test("mutation repository rejects persisted reauth route evidence without verified authentication", async () => {
  const invalid = [
    { verification: "failed", route: "applied" },
    { verification: "failed", route: "not_applied" },
    { verification: "failed", route: "unproven" },
    { verification: "unproven", route: "applied" },
    { verification: "unproven", route: "not_applied" },
    { verification: "unproven", route: "unproven" }
  ] as const;
  for (const [index, reauth] of invalid.entries()) {
    const root = await mkdtemp(join(tmpdir(), "account-center-mutations-reauth-invalid-"));
    const repository = new MutationRepository(root);
    const claim = await repository.claim({ ...input, idempotencyKey: `${key.slice(0, -1)}${index}` });
    if (claim.kind !== "execute") throw new Error("expected executable operation");
    await assert.rejects(() => repository.complete({ operationId: claim.operationId, outcome: "applied", evidence: { receiptId: `evt_reauth_invalid_${index}`, verification: "unproven", reauth } }), /invalid_receipt_evidence/);
  }
});

test("mutation repository fails closed when stored reauth evidence pairs an unproven verification with a route result", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-mutations-reauth-corrupt-"));
  const repository = new MutationRepository(root, { operationId: () => "op_reauth_corrupt" });
  const claim = await repository.claim(input);
  if (claim.kind !== "execute") throw new Error("expected executable operation");
  await repository.complete({ operationId: claim.operationId, outcome: "applied", evidence: { receiptId: "evt_reauth_corrupt", verification: "verified", reauth: { verification: "verified", route: "applied" } } });
  const statePath = join(root, "mutation-repository.v1.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.operations[0].receipt.evidence.reauth = { verification: "unproven", route: "applied" };
  await writeFile(statePath, JSON.stringify(state), { mode: 0o600 });

  await assert.rejects(() => new MutationRepository(root).claim(input), /repository_corrupt/);
});

test("mutation repository rejects unknown top-level evidence keys on persistence and read", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-mutations-evidence-keys-"));
  const repository = new MutationRepository(root, { operationId: () => "op_evidence_keys" });
  const claim = await repository.claim(input);
  if (claim.kind !== "execute") throw new Error("expected executable operation");
  await assert.rejects(() => repository.complete({ operationId: claim.operationId, outcome: "applied", evidence: { receiptId: "evt_evidence_keys", verification: "verified", unexpected: "rejected" } as never }), /invalid_receipt_evidence/);
  await repository.complete({ operationId: claim.operationId, outcome: "applied", evidence: { receiptId: "evt_evidence_keys", verification: "verified" } });
  const statePath = join(root, "mutation-repository.v1.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.operations[0].receipt.evidence.unexpected = "rejected";
  await writeFile(statePath, JSON.stringify(state), { mode: 0o600 });

  await assert.rejects(() => new MutationRepository(root).claim(input), /repository_corrupt/);
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

test("mutation repository normalizes malformed persisted JSON to repository_corrupt", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-mutations-malformed-json-"));
  await writeFile(join(root, "mutation-repository.v1.json"), "{not valid JSON", { mode: 0o600 });
  await chmod(root, 0o700);

  await assert.rejects(() => new MutationRepository(root).list(), /repository_corrupt/);
});

test("mutation repository rejects unknown durable envelope keys before history, replay, or dependencies", async () => {
  const corruptions: Array<[string, (state: { schemaVersion: string; operations: Array<Record<string, unknown>> }) => void]> = [
    ["top-level state", (state) => { (state as Record<string, unknown>).unexpected = true; }],
    ["pending operation", (state) => { state.operations[1].unexpected = true; }],
    ["completed operation wrapper", (state) => { state.operations[0].unexpected = true; }],
    ["receipt", (state) => { ((state.operations[0].receipt as Record<string, unknown>)).unexpected = true; }],
    ["audit", (state) => { (((state.operations[0].receipt as { audit: Record<string, unknown> }).audit)).unexpected = true; }]
  ];

  for (const [name, corrupt] of corruptions) {
    const root = await mkdtemp(join(tmpdir(), "account-center-mutations-envelope-corrupt-"));
    const operationIds = ["op_completed", "op_pending"];
    const seed = new MutationRepository(root, {
      now: () => new Date("2026-07-15T00:00:00.000Z"),
      operationId: () => operationIds.shift() ?? "op_unexpected"
    });
    const completedClaim = await seed.claim(input);
    if (completedClaim.kind !== "execute") throw new Error("expected completed operation to execute");
    const receipt = await seed.complete({ operationId: completedClaim.operationId, outcome: "not_applied" });
    const pendingClaim = await seed.claim({ ...input, idempotencyKey: `${key.slice(0, -1)}p`, requestDigest: "d".repeat(64) });
    if (pendingClaim.kind !== "execute") throw new Error("expected pending operation to execute");
    assert.deepEqual(await new MutationRepository(root).claim(input), { kind: "replay", operationId: "op_completed", outcome: "not_applied", receipt });

    const state = JSON.parse(await readFile(join(root, "mutation-repository.v1.json"), "utf8"));
    corrupt(state);
    await writeFile(join(root, "mutation-repository.v1.json"), JSON.stringify(state), { mode: 0o600 });

    let dependencyCalls = 0;
    const repository = new MutationRepository(root, {
      now: () => { dependencyCalls += 1; return new Date("2026-07-15T00:02:00.000Z"); },
      operationId: () => { dependencyCalls += 1; return "op_should_not_be_created"; }
    });
    await assert.rejects(() => repository.list(), new RegExp(`repository_corrupt`, "i"), name);
    await assert.rejects(() => repository.claim(input), /repository_corrupt/, name);
    await assert.rejects(() => repository.complete({ operationId: "op_completed", outcome: "not_applied" }), /repository_corrupt/, name);
    assert.equal(dependencyCalls, 0, `${name} must fail before dependencies are used`);
  }
});

test("mutation repository rejects prototype-inherited durable envelopes and fields", async () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const replaceObjectPrototype = (key: string, value: unknown): void => {
    descriptors.set(key, Object.getOwnPropertyDescriptor(Object.prototype, key));
    Object.defineProperty(Object.prototype, key, { configurable: true, enumerable: false, writable: true, value });
  };
  const restoreObjectPrototype = (): void => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(Object.prototype, key, descriptor);
      else delete (Object.prototype as Record<string, unknown>)[key];
    }
  };

  try {
    const emptyRoot = await mkdtemp(join(tmpdir(), "account-center-mutations-prototype-empty-"));
    replaceObjectPrototype("schemaVersion", "account-center.mutation-repository.v1");
    replaceObjectPrototype("operations", []);
    await writeFile(join(emptyRoot, "mutation-repository.v1.json"), "{}", { mode: 0o600 });
    await chmod(emptyRoot, 0o700);
    await assert.rejects(() => new MutationRepository(emptyRoot).list(), /repository_corrupt/);

    const receipt = {
      schemaVersion: "account-center.mutation-receipt.v1",
      operationId: "op_inherited_receipt",
      idempotencyKeyDigest: "a".repeat(64),
      requestDigest: "b".repeat(64),
      state: "completed",
      outcome: "not_applied",
      createdAt: "2026-07-15T00:00:00.000Z",
      completedAt: "2026-07-15T00:01:00.000Z",
      audit: { ...input.audit, warningCodes: [] }
    };
    const inheritedReceiptRoot = await mkdtemp(join(tmpdir(), "account-center-mutations-prototype-receipt-"));
    replaceObjectPrototype("receipt", receipt);
    await writeFile(join(inheritedReceiptRoot, "mutation-repository.v1.json"), JSON.stringify({
      schemaVersion: "account-center.mutation-repository.v1",
      operations: [{ operationId: "op_pending", idempotencyKeyDigest: "c".repeat(64), requestDigest: "d".repeat(64), state: "pending", createdAt: "2026-07-15T00:00:00.000Z", audit: input.audit }]
    }), { mode: 0o600 });
    await chmod(inheritedReceiptRoot, 0o700);
    await assert.rejects(() => new MutationRepository(inheritedReceiptRoot).list(), /repository_corrupt/);

    const inheritedEvidenceRoot = await mkdtemp(join(tmpdir(), "account-center-mutations-prototype-evidence-"));
    replaceObjectPrototype("evidence", { receiptId: "evt_inherited", verification: "verified" });
    await writeFile(join(inheritedEvidenceRoot, "mutation-repository.v1.json"), JSON.stringify({
      schemaVersion: "account-center.mutation-repository.v1",
      operations: [{ receipt }]
    }), { mode: 0o600 });
    await chmod(inheritedEvidenceRoot, 0o700);
    await assert.rejects(() => new MutationRepository(inheritedEvidenceRoot).list(), /repository_corrupt/);
  } finally {
    restoreObjectPrototype();
  }
});

test("mutation repository rejects null and prototype-inherited envelopes before history, replay, completion, or dependencies", async () => {
  for (const malformedEnvelope of ["null", "prototype-inherited"] as const) {
    const root = await mkdtemp(join(tmpdir(), `account-center-mutations-${malformedEnvelope}-envelope-`));
    const seed = new MutationRepository(root, { now: () => new Date("2026-07-15T00:00:00.000Z"), operationId: () => "op_replay" });
    const claim = await seed.claim(input);
    if (claim.kind !== "execute") throw new Error("expected executable operation");
    await seed.complete({ operationId: claim.operationId, outcome: "not_applied" });
    const statePath = join(root, "mutation-repository.v1.json");
    const persistedState = JSON.parse(await readFile(statePath, "utf8"));

    const assertFailsClosed = async (): Promise<void> => {
      let dependencyCalls = 0;
      const repository = new MutationRepository(root, {
        now: () => { dependencyCalls += 1; return new Date("2026-07-15T00:02:00.000Z"); },
        operationId: () => { dependencyCalls += 1; return "op_should_not_be_created"; }
      });
      await assert.rejects(() => repository.list(), /repository_corrupt/, `${malformedEnvelope} must fail before list`);
      await assert.rejects(() => repository.claim(input), /repository_corrupt/, `${malformedEnvelope} must fail before replay-capable claim`);
      await assert.rejects(() => repository.complete({ operationId: "op_replay", outcome: "not_applied" }), /repository_corrupt/, `${malformedEnvelope} must fail before complete`);
      assert.equal(dependencyCalls, 0, `${malformedEnvelope} must fail before injected dependencies are used`);
    };

    if (malformedEnvelope === "null") {
      await writeFile(statePath, "null", { mode: 0o600 });
      await assertFailsClosed();
      continue;
    }

    const descriptors = new Map<string, PropertyDescriptor | undefined>();
    try {
      for (const [key, value] of Object.entries(persistedState)) {
        descriptors.set(key, Object.getOwnPropertyDescriptor(Object.prototype, key));
        Object.defineProperty(Object.prototype, key, { configurable: true, enumerable: false, writable: true, value });
      }
      await writeFile(statePath, "{}", { mode: 0o600 });
      await assertFailsClosed();
    } finally {
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(Object.prototype, key, descriptor);
        else delete (Object.prototype as Record<string, unknown>)[key];
      }
    }
  }
});
