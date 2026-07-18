import test from "node:test";
import assert from "node:assert/strict";
import { executeAccountCenterCommand } from "./command-executor.js";
import { FixtureRuntimeAdapter } from "./runtime-adapters.js";
import { createMutationReview } from "./mutation-contract.js";
import { MutationRepository } from "./mutation-repository.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("core executor returns status without a UI or CLI renderer", async () => {
  const result = await executeAccountCenterCommand({ command: "status" }, { adapter: new FixtureRuntimeAdapter() });
  assert.equal(result.code, 0);
  assert.equal(result.kind, "status");
  assert.equal(result.status?.schemaVersion, "account-center.status.v1");
});

test("core executor plans routing by default and returns a receipt", async () => {
  const result = await executeAccountCenterCommand({ command: "route.auto", provider: "openai", runtime: "openclaw" }, { adapter: new FixtureRuntimeAdapter() });
  assert.equal(result.code, 0);
  assert.equal(result.kind, "mutation");
  assert.equal(result.mutation?.applied, false);
  assert.equal(result.mutation?.receipt.action, "route.auto");
});

test("core executor invokes route apply only after exact review confirmation and durable idempotency claim", async () => {
  let mutations = 0;
  const adapter = {
    source: "fixture" as const,
    readStatus: () => new FixtureRuntimeAdapter().readStatus(),
    doctor: async () => ({}),
    mutate: async () => { mutations += 1; return { code: 0, payload: { applied: true, dryRun: false, liveRuntimeMutation: true, receipt: { id: "evt_test", action: "route.use", actor: "test", dryRun: false, createdAt: "2026-07-18T00:00:00.000Z", summary: "verified", warnings: [] } } }; }
  };
  const request = { command: "route.use" as const, target: "openai:helper-2", apply: true, provider: "openai", runtime: "openclaw", scope: { kind: "agent" as const, id: "main" } };
  const blocked = await executeAccountCenterCommand(request, { adapter });
  assert.equal(blocked.code, 2);
  assert.equal(mutations, 0);
  const secret = "test-shared-mutation-secret";
  const review = createMutationReview({ action: "route.use", provider: "openai", runtime: "openclaw", scope: request.scope, target: request.target }, { secret });
  const root = await mkdtemp(join(tmpdir(), "account-center-command-executor-"));
  const result = await executeAccountCenterCommand({ ...request, review, reviewToken: review.token, idempotencyKey: "route-apply-idempotency-key-0001" }, { adapter, mutation: { secret, repository: new MutationRepository(root) } });
  assert.equal(result.code, 0);
  assert.equal(mutations, 1);
  const replay = await executeAccountCenterCommand({ ...request, review, reviewToken: review.token, idempotencyKey: "route-apply-idempotency-key-0001" }, { adapter, mutation: { secret, repository: new MutationRepository(root) } });
  assert.equal(replay.mutation?.liveRuntimeMutation, false);
  assert.equal(replay.mutation?.replayed, true);
  assert.equal(replay.mutation?.historicalOutcome, "applied");
  assert.equal(replay.mutation?.dryRun, true, "replay is not a new live mutation");
  assert.equal((replay.mutation as { operationId?: string }).operationId?.startsWith("op_"), true, "replay retains the immutable operation reference");
  assert.equal(mutations, 1);
});

test("verified route apply persists bounded opaque native and scoped before/after proof on its immutable operation", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-command-proof-"));
  const repository = new MutationRepository(root, { operationId: () => "op_route_proof" });
  const secret = "test-shared-mutation-secret";
  const scope = { kind: "agent" as const, id: "main" };
  const target = "openai:helper-2";
  const review = createMutationReview({ action: "route.use", provider: "openai", runtime: "openclaw", scope, target }, { secret });
  const adapter = {
    source: "fixture" as const,
    readStatus: () => new FixtureRuntimeAdapter().readStatus(), doctor: async () => ({}),
    mutate: async () => ({ code: 0, payload: {
      applied: true, dryRun: false, liveRuntimeMutation: true,
      receipt: { id: "evt_route_proof", action: "route.use", actor: "test", dryRun: false, createdAt: "2026-07-18T00:00:00.000Z", summary: "verified", warnings: [] },
      proof: { nativeEvent: { action: "route.use", scopeId: "id_aaaaaaaaaaaaaaaaaaaaaaaa", targetId: "id_bbbbbbbbbbbbbbbbbbbbbbbb", status: "verified" }, verification: { scopeId: "id_aaaaaaaaaaaaaaaaaaaaaaaa", before: { status: "observed", activeTargetId: "id_cccccccccccccccccccccccc", orderTargetIds: ["id_cccccccccccccccccccccccc"] }, after: { status: "observed", activeTargetId: "id_bbbbbbbbbbbbbbbbbbbbbbbb", orderTargetIds: ["id_bbbbbbbbbbbbbbbbbbbbbbbb"] } } }
    } })
  };
  await executeAccountCenterCommand({ command: "route.use", target, apply: true, provider: "openai", runtime: "openclaw", scope, review, reviewToken: review.token, idempotencyKey: "route-proof-idempotency-key-0001" }, { adapter, mutation: { secret, repository } });
  const raw = await (await import("node:fs/promises")).readFile(join(root, "mutation-repository.v1.json"), "utf8");
  assert.match(raw, /op_route_proof/);
  assert.match(raw, /nativeEvent/);
  assert.match(raw, /id_aaaaaaaaaaaaaaaaaaaaaaaa/);
  assert.doesNotMatch(raw, /helper-2|stdout|stderr|token|@|\//);
});
