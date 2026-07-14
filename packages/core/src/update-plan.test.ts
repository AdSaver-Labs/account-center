import test from "node:test";
import assert from "node:assert/strict";
import { createUpdateApplyPlan } from "./update-center.js";

const verified = {
  state: "verified" as const,
  release: {
    version: "0.2.0",
    tag: "v0.2.0",
    artifact: {
      platform: "darwin",
      arch: "arm64",
      fileName: "account-center-0.2.0-darwin-arm64.tar.gz",
      url: "https://releases.example.invalid/account-center-0.2.0-darwin-arm64.tar.gz",
      sha256: "b".repeat(64)
    }
  }
};

test("Update Center creates an immutable, Account-Center-only apply plan for a verified release", () => {
  const plan = createUpdateApplyPlan({ inspection: verified, installedVersion: "0.1.0", supervisor: "account-center-local" });
  assert.equal(plan.state, "ready_for_confirmation");
  if (plan.state !== "ready_for_confirmation") return;
  assert.equal(plan.product, "account-center");
  assert.equal(plan.release.version, "0.2.0");
  assert.equal(plan.release.artifact.sha256, "b".repeat(64));
  assert.equal(plan.supervisor, "account-center-local");
  assert.deepEqual(plan.requiredSteps, ["explicit_confirmation", "artifact_checksum", "protected_backup", "narrow_account_center_restart", "health_proof", "rollback_on_failed_health"]);
  assert.match(plan.planId, /^ac-update-v1:[a-f0-9]{64}$/);
});

test("Update Center never creates an apply plan for unverified releases or arbitrary supervisors", () => {
  assert.deepEqual(createUpdateApplyPlan({ inspection: { state: "UNPROVEN", reason: "invalid_signature" }, installedVersion: "0.1.0", supervisor: "account-center-local" }), { state: "blocked", reason: "release_not_verified" });
  assert.deepEqual(createUpdateApplyPlan({ inspection: verified, installedVersion: "0.1.0", supervisor: "openclaw-gateway.service" }), { state: "blocked", reason: "unsupported_supervisor" });
});
