import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFilesystemUpdateAdapter, type UpdateApplyPlan } from "./update-center.js";

const bytes = Buffer.from("immutable account center release fixture");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const plan: Extract<UpdateApplyPlan, { state: "ready_for_confirmation" }> = {
  state: "ready_for_confirmation", planId: `ac-update-v1:${"a".repeat(64)}`, product: "account-center", installedVersion: "0.1.0",
  release: { version: "0.2.0", tag: "v0.2.0", artifact: { platform: "darwin", arch: "arm64", fileName: "account-center-0.2.0-darwin-arm64.tar.gz", url: "https://releases.example.invalid/account-center-0.2.0-darwin-arm64.tar.gz", sha256 } },
  supervisor: "account-center-local", requiredSteps: ["explicit_confirmation", "artifact_checksum", "protected_backup", "narrow_account_center_restart", "health_proof", "rollback_on_failed_health"]
};

test("Local updater stages only a checksum-matching artifact and creates a protected rollback backup", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-update-"));
  const artifactPath = join(root, "release.tar.gz");
  const installRoot = join(root, "install");
  const workRoot = join(root, "work");
  await writeFile(artifactPath, bytes);
  await mkdir(installRoot);
  await writeFile(join(installRoot, "current.txt"), "old-release");
  const adapter = new LocalFilesystemUpdateAdapter({ artifactPath, installRoot, workRoot });

  assert.deepEqual(await adapter.verifyArtifact(plan), { state: "verified" });
  const backup = await adapter.createBackup(plan);
  assert.equal(backup.state, "verified");
  if (backup.state !== "verified") return;
  assert.deepEqual(await adapter.installArtifact(plan), { state: "verified" });
  assert.equal((await readFile(join(installRoot, "staged", plan.release.artifact.fileName))).equals(bytes), true);
  assert.equal(await readFile(join(workRoot, "backups", backup.backupId, "current.txt"), "utf8"), "old-release");
  assert.deepEqual(await adapter.rollback(plan, backup.backupId), { state: "verified" });
  assert.equal(await readFile(join(installRoot, "current.txt"), "utf8"), "old-release");
});

test("Local updater refuses a checksum-mismatched artifact before it stages or backs up anything", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-update-"));
  const artifactPath = join(root, "release.tar.gz");
  const installRoot = join(root, "install");
  await writeFile(artifactPath, "tampered");
  await mkdir(installRoot);
  const adapter = new LocalFilesystemUpdateAdapter({ artifactPath, installRoot, workRoot: join(root, "work") });
  assert.deepEqual(await adapter.verifyArtifact(plan), { state: "failed" });
});
