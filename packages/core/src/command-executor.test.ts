import test from "node:test";
import assert from "node:assert/strict";
import { executeAccountCenterCommand } from "./command-executor.js";
import { FixtureRuntimeAdapter } from "./runtime-adapters.js";
import { createActiveScopeWarning, createMutationReview } from "./mutation-contract.js";
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

test("core executor refuses an implicit route scope before adapter invocation", async () => {
  let mutations = 0;
  const adapter = {
    source: "fixture" as const,
    readStatus: () => new FixtureRuntimeAdapter().readStatus(),
    doctor: async () => ({}),
    mutate: async () => { mutations += 1; throw new Error("adapter must not run"); }
  };
  const result = await executeAccountCenterCommand({ command: "route.auto", provider: "openai", runtime: "openclaw" }, { adapter });
  assert.equal(result.code, 2);
  assert.equal(result.kind, "mutation");
  assert.equal(result.mutation?.applied, false);
  assert.equal(mutations, 0);
  assert.equal((result.mutation as { reason?: string } | undefined)?.reason, "observed_agent_scope_required");
});

test("fixture-only protected context checks reject widened, malformed, and cross-runtime scopes before adapter mutation", async () => {
  let mutations = 0;
  const adapter = {
    source: "fixture" as const,
    readStatus: () => new FixtureRuntimeAdapter().readStatus(),
    doctor: async () => ({}),
    mutate: async () => { mutations += 1; throw new Error("adapter must not run"); }
  };
  const cases: Array<Parameters<typeof executeAccountCenterCommand>[0]> = [
    { command: "route.use", target: "openai:helper-2", provider: "openai", runtime: "openclaw", scope: { kind: "all", id: "all" } },
    { command: "route.use", target: "openai:helper-2", provider: "openai", runtime: "hermes", scope: { kind: "agent", id: "main" } },
    { command: "route.use", target: "openai:helper-2", provider: "openai", runtime: "openclaw", scope: { kind: "agent", id: "main/other" } },
    { command: "account.delete", target: "connected@example.test", provider: "openai", runtime: "hermes", scope: { kind: "default", id: "default" } },
    { command: "account.delete", target: "connected@example.test", provider: "openai", runtime: "openclaw", scope: { kind: "all", id: "all" } }
  ];
  for (const request of cases) {
    const result = await executeAccountCenterCommand(request, { adapter });
    assert.equal(result.code, 2);
    assert.equal(result.mutation?.applied, false);
  }
  assert.equal(mutations, 0, "fixture adversarial contexts never reach a runtime adapter");
});

test("unowned account and model mutation vocabulary is unavailable at the shared executor before adapter invocation", async () => {
  let mutations = 0;
  const adapter = {
    source: "fixture" as const,
    readStatus: () => new FixtureRuntimeAdapter().readStatus(),
    doctor: async () => ({}),
    mutate: async () => { mutations += 1; throw new Error("adapter must not run"); }
  };
  for (const command of ["account.enable", "account.disable", "model.enable", "model.disable"] as const) {
    const result = await executeAccountCenterCommand({ command, target: "fixture-target", apply: true, provider: "openai", runtime: "openclaw" }, { adapter });
    assert.equal(result.code, 2);
    assert.equal((result.mutation as { reason?: string } | undefined)?.reason, "mutation_action_unavailable");
  }
  assert.equal(mutations, 0);
});

test("route preview rejects a syntactically valid but unobserved agent scope before review minting or adapter invocation", async () => {
  let mutations = 0;
  const adapter = {
    source: "fixture" as const,
    readStatus: () => new FixtureRuntimeAdapter().readStatus(),
    doctor: async () => ({}),
    mutate: async () => { mutations += 1; throw new Error("adapter must not run"); }
  };
  const root = await mkdtemp(join(tmpdir(), "account-center-unobserved-scope-"));
  const result = await executeAccountCenterCommand({ command: "route.remove", target: "openai:helper-2", provider: "openai", runtime: "openclaw", scope: { kind: "agent", id: "not_observed" } }, { adapter, mutation: { secret: "test-shared-mutation-secret", repository: new MutationRepository(root) } });
  assert.equal(result.code, 2);
  assert.equal(mutations, 0);
  assert.equal((result.mutation as { confirmationToken?: string } | undefined)?.confirmationToken, undefined);
  assert.equal((result.mutation as { reason?: string } | undefined)?.reason, "observed_agent_scope_required");
});

test("core executor invokes route apply only after exact review confirmation and durable idempotency claim", async () => {
  let mutations = 0;
  const adapter = {
    source: "fixture" as const,
    readStatus: () => new FixtureRuntimeAdapter().readStatus(),
    doctor: async () => ({}),
    mutate: async () => { mutations += 1; return { code: 0, payload: { applied: true, dryRun: false, liveRuntimeMutation: true, verification: { kind: "verified" }, receipt: { id: "evt_test", action: "route.use", actor: "test", dryRun: false, createdAt: "2026-07-18T00:00:00.000Z", summary: "verified", warnings: [] } } }; }
  };
  const request = { command: "route.use" as const, target: "openai:helper-2", apply: true, provider: "openai", runtime: "openclaw", scope: { kind: "agent" as const, id: "main" } };
  const blocked = await executeAccountCenterCommand(request, { adapter });
  assert.equal(blocked.code, 2);
  assert.equal(mutations, 0);
  const secret = "test-shared-mutation-secret";
  const review = createMutationReview({ action: "route.use", provider: "openai", runtime: "openclaw", scope: request.scope, target: request.target }, { secret });
  const warning = createActiveScopeWarning({ action: "route.use", provider: "openai", runtime: "openclaw", scope: request.scope, target: request.target }, { secret });
  const root = await mkdtemp(join(tmpdir(), "account-center-command-executor-"));
  const missingAcknowledgement = await executeAccountCenterCommand({ ...request, review, reviewToken: review.token, idempotencyKey: "route-apply-idempotency-key-0001" }, { adapter, mutation: { secret, repository: new MutationRepository(root) } });
  assert.equal((missingAcknowledgement.mutation as unknown as { reason: string }).reason, "active_scope_acknowledgement_required");
  const forged = createActiveScopeWarning({ action: "route.remove", provider: "openai", runtime: "openclaw", scope: request.scope, target: request.target }, { secret });
  const forgedResult = await executeAccountCenterCommand({ ...request, review, reviewToken: review.token, activeScopeWarning: forged, activeScopeWarningToken: forged.token, idempotencyKey: "route-apply-idempotency-key-forged" }, { adapter, mutation: { secret, repository: new MutationRepository(root) } });
  assert.equal((forgedResult.mutation as unknown as { reason: string }).reason, "active_scope_acknowledgement_invalid");
  const stale = createActiveScopeWarning({ action: "route.use", provider: "openai", runtime: "openclaw", scope: request.scope, target: request.target }, { secret, now: new Date(0), ttlMs: 1 });
  const staleResult = await executeAccountCenterCommand({ ...request, review, reviewToken: review.token, activeScopeWarning: stale, activeScopeWarningToken: stale.token, idempotencyKey: "route-apply-idempotency-key-stale" }, { adapter, mutation: { secret, repository: new MutationRepository(root) } });
  assert.equal((staleResult.mutation as unknown as { reason: string }).reason, "active_scope_acknowledgement_expired");
  assert.equal(mutations, 0, "missing, forged, and stale acknowledgements never reach the adapter");
  const result = await executeAccountCenterCommand({ ...request, review, reviewToken: review.token, activeScopeWarning: warning, activeScopeWarningToken: warning.token, idempotencyKey: "route-apply-idempotency-key-0001" }, { adapter, mutation: { secret, repository: new MutationRepository(root) } });
  assert.equal(result.code, 0);
  assert.equal(mutations, 1);
  const replay = await executeAccountCenterCommand({ ...request, review, reviewToken: review.token, activeScopeWarning: warning, activeScopeWarningToken: warning.token, idempotencyKey: "route-apply-idempotency-key-0001" }, { adapter, mutation: { secret, repository: new MutationRepository(root) } });
  assert.equal(replay.mutation?.liveRuntimeMutation, false);
  assert.equal(replay.mutation?.replayed, true);
  assert.equal(replay.mutation?.historicalOutcome, "applied");
  assert.equal(replay.mutation?.dryRun, true, "replay is not a new live mutation");
  assert.equal((replay.mutation as { operationId?: string }).operationId?.startsWith("op_"), true, "replay retains the immutable operation reference");
  assert.equal(mutations, 1);
});

test("idempotency replay preserves an attempted-but-unproven historical outcome without claiming a fresh action", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-unproven-replay-"));
  const repository = new MutationRepository(root);
  const secret = "test-shared-mutation-secret";
  const scope = { kind: "agent" as const, id: "main" };
  const target = "openai:helper-2";
  const review = createMutationReview({ action: "route.remove", provider: "openai", runtime: "openclaw", scope, target }, { secret });
  const warning = createActiveScopeWarning({ action: "route.remove", provider: "openai", runtime: "openclaw", scope, target }, { secret });
  let mutations = 0;
  const adapter = {
    source: "fixture" as const,
    readStatus: () => new FixtureRuntimeAdapter().readStatus(),
    doctor: async () => ({}),
    mutate: async () => {
      mutations += 1;
      return { code: 2, payload: { applied: false, dryRun: false, liveRuntimeMutation: true, verification: { kind: "unproven" }, receipt: { id: "evt_attempt_unproven", action: "route.remove", actor: "test", dryRun: false, createdAt: "2026-07-18T00:00:00.000Z", summary: "private native details", warnings: [] } } };
    }
  };
  const request = { command: "route.remove" as const, target, apply: true, provider: "openai", runtime: "openclaw", scope, review, reviewToken: review.token, activeScopeWarning: warning, activeScopeWarningToken: warning.token, idempotencyKey: "route-unproven-replay-key-0001" };
  const first = await executeAccountCenterCommand(request, { adapter, mutation: { secret, repository } });
  assert.equal(first.mutation?.liveRuntimeMutation, true);
  const replay = await executeAccountCenterCommand(request, { adapter, mutation: { secret, repository } });
  assert.equal(mutations, 1);
  assert.equal(replay.mutation?.replayed, true);
  assert.equal(replay.mutation?.liveRuntimeMutation, false);
  assert.equal((replay.mutation as { historicalLiveRuntimeMutation?: boolean }).historicalLiveRuntimeMutation, true);
  assert.equal((replay.mutation as { historicalVerification?: string }).historicalVerification, "unproven");
  assert.equal(replay.mutation?.historicalOutcome, "failed");
});

test("verified route apply persists bounded opaque native and scoped before/after proof on its immutable operation", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-command-proof-"));
  const repository = new MutationRepository(root, { operationId: () => "op_route_proof" });
  const secret = "test-shared-mutation-secret";
  const scope = { kind: "agent" as const, id: "main" };
  const target = "openai:helper-2";
  const review = createMutationReview({ action: "route.use", provider: "openai", runtime: "openclaw", scope, target }, { secret });
  const warning = createActiveScopeWarning({ action: "route.use", provider: "openai", runtime: "openclaw", scope, target }, { secret });
  const adapter = {
    source: "fixture" as const,
    readStatus: () => new FixtureRuntimeAdapter().readStatus(), doctor: async () => ({}),
    mutate: async () => ({ code: 0, payload: {
      applied: true, dryRun: false, liveRuntimeMutation: true, verification: { kind: "verified" },
      receipt: { id: "evt_route_proof", action: "route.use", actor: "test", dryRun: false, createdAt: "2026-07-18T00:00:00.000Z", summary: "verified", warnings: [] },
      proof: { nativeEvent: { action: "route.use", scopeId: "id_aaaaaaaaaaaaaaaaaaaaaaaa", targetId: "id_bbbbbbbbbbbbbbbbbbbbbbbb", status: "verified" }, verification: { scopeId: "id_aaaaaaaaaaaaaaaaaaaaaaaa", before: { status: "observed", activeTargetId: "id_cccccccccccccccccccccccc", orderTargetIds: ["id_cccccccccccccccccccccccc"] }, after: { status: "observed", activeTargetId: "id_bbbbbbbbbbbbbbbbbbbbbbbb", orderTargetIds: ["id_bbbbbbbbbbbbbbbbbbbbbbbb"] } } }
    } })
  };
  await executeAccountCenterCommand({ command: "route.use", target, apply: true, provider: "openai", runtime: "openclaw", scope, review, reviewToken: review.token, activeScopeWarning: warning, activeScopeWarningToken: warning.token, idempotencyKey: "route-proof-idempotency-key-0001" }, { adapter, mutation: { secret, repository } });
  const raw = await (await import("node:fs/promises")).readFile(join(root, "mutation-repository.v1.json"), "utf8");
  assert.match(raw, /op_route_proof/);
  assert.match(raw, /nativeEvent/);
  assert.match(raw, /id_aaaaaaaaaaaaaaaaaaaaaaaa/);
  assert.doesNotMatch(raw, /helper-2|stdout|stderr|token|@|\//);
});

test("account delete requires the shared review/idempotency lifecycle and persists only opaque verified evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-delete-executor-"));
  const repository = new MutationRepository(root);
  const secret = "test-shared-mutation-secret";
  const scope = { kind: "default" as const, id: "default" };
  const target = "connected@example.test";
  let calls = 0;
  const adapter = {
    source: "fixture" as const,
    readStatus: () => new FixtureRuntimeAdapter().readStatus(),
    doctor: async () => ({}),
    mutate: async (input: { apply: boolean }) => {
      calls += 1;
      return { code: 0, payload: input.apply
        ? { applied: true, dryRun: false, liveRuntimeMutation: true, verification: { kind: "verified" }, nativeReceipt: { action: "account.delete", state: "DELETED", receipt: "opaque-owned-delete" }, receipt: { id: "evt_owned_delete", action: "account.delete", actor: "test", dryRun: false, createdAt: "2026-07-27T00:00:00.000Z", summary: "opaque verified delete", warnings: ["opaque_native_receipt"] } }
        : { applied: false, dryRun: true, liveRuntimeMutation: false, receipt: { id: "evt_delete_preview", action: "account.delete", actor: "test", dryRun: true, createdAt: "2026-07-27T00:00:00.000Z", summary: "preview", warnings: ["no_live_mutation"] } }
      };
    }
  };
  const request = { command: "account.delete" as const, target, apply: true, provider: "openai", runtime: "openclaw", scope };
  const blocked = await executeAccountCenterCommand(request, { adapter, mutation: { secret, repository } });
  assert.equal(blocked.code, 2);
  assert.equal(calls, 0, "no native adapter call occurs before signed review confirmation");
  const review = createMutationReview({ action: "account.delete", provider: "openai", runtime: "openclaw", scope, target }, { secret });
  const applied = await executeAccountCenterCommand({ ...request, review, reviewToken: review.token, idempotencyKey: "owned-delete-idempotency-key-0001" }, { adapter, mutation: { secret, repository } });
  assert.equal(applied.code, 0);
  assert.equal(calls, 1);
  assert.deepEqual((applied.mutation as unknown as { nativeReceipt: unknown }).nativeReceipt, { action: "account.delete", state: "DELETED", receipt: "opaque-owned-delete" });
  const replay = await executeAccountCenterCommand({ ...request, review, reviewToken: review.token, idempotencyKey: "owned-delete-idempotency-key-0001" }, { adapter, mutation: { secret, repository } });
  assert.equal(calls, 1, "replay must not invoke the native adapter");
  assert.equal(replay.mutation?.replayed, true);
  const persisted = await (await import("node:fs/promises")).readFile(join(root, "mutation-repository.v1.json"), "utf8");
  assert.doesNotMatch(persisted, /connected@example\.test|opaque-owned-delete/);
});
