import test from "node:test";
import assert from "node:assert/strict";
import { executeUpdatePlan, type UpdateApplyPlan } from "./update-center.js";

const plan: Extract<UpdateApplyPlan, { state: "ready_for_confirmation" }> = {
  state: "ready_for_confirmation",
  planId: `ac-update-v1:${"a".repeat(64)}`,
  product: "account-center",
  installedVersion: "0.1.0",
  release: { version: "0.2.0", tag: "v0.2.0", artifact: { platform: "darwin", arch: "arm64", fileName: "account-center-0.2.0-darwin-arm64.tar.gz", url: "https://releases.example.invalid/account-center-0.2.0-darwin-arm64.tar.gz", sha256: "b".repeat(64) } },
  supervisor: "account-center-local",
  requiredSteps: ["explicit_confirmation", "artifact_checksum", "protected_backup", "narrow_account_center_restart", "health_proof", "rollback_on_failed_health"]
};

function adapter(overrides: Partial<Parameters<typeof executeUpdatePlan>[0]["adapter"]> = {}) {
  const calls: string[] = [];
  return {
    calls,
    value: {
      verifyArtifact: async () => { calls.push("verify"); return { state: "verified" as const }; },
      createBackup: async () => { calls.push("backup"); return { state: "verified" as const, backupId: "backup-1" }; },
      installArtifact: async () => { calls.push("install"); return { state: "verified" as const }; },
      restartAccountCenter: async () => { calls.push("restart"); return { state: "verified" as const }; },
      healthCheck: async () => { calls.push("health"); return { state: "verified" as const }; },
      rollback: async () => { calls.push("rollback"); return { state: "verified" as const }; },
      ...overrides
    }
  };
}

test("Update execution runs the checksum/backup/install/restart/health sequence only after exact confirmation", async () => {
  const fake = adapter();
  const result = await executeUpdatePlan({ plan, confirmationPlanId: plan.planId, adapter: fake.value });
  assert.deepEqual(fake.calls, ["verify", "backup", "install", "restart", "health"]);
  assert.deepEqual(result, { state: "applied", planId: plan.planId, backupId: "backup-1", health: "verified" });
});

test("Update execution blocks a mismatched confirmation before any side effect", async () => {
  const fake = adapter();
  const result = await executeUpdatePlan({ plan, confirmationPlanId: "wrong", adapter: fake.value });
  assert.deepEqual(fake.calls, []);
  assert.deepEqual(result, { state: "blocked", reason: "confirmation_mismatch" });
});

test("Update execution rolls back after failed health proof and marks rollback uncertainty honestly", async () => {
  const fake = adapter({ healthCheck: async () => { fake.calls.push("health"); return { state: "failed" as const }; } });
  const result = await executeUpdatePlan({ plan, confirmationPlanId: plan.planId, adapter: fake.value });
  assert.deepEqual(fake.calls, ["verify", "backup", "install", "restart", "health", "rollback"]);
  assert.deepEqual(result, { state: "rolled_back", planId: plan.planId, backupId: "backup-1", reason: "health_check_failed" });

  const uncertain = adapter({ healthCheck: async () => ({ state: "failed" as const }), rollback: async () => ({ state: "UNPROVEN" as const }) });
  const unproven = await executeUpdatePlan({ plan, confirmationPlanId: plan.planId, adapter: uncertain.value });
  assert.deepEqual(unproven, { state: "UNPROVEN", planId: plan.planId, backupId: "backup-1", stage: "rollback" });
});
