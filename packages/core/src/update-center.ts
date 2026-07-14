import { createHash, verify } from "node:crypto";

export interface ReleaseArtifactV1 {
  platform: string;
  arch: string;
  fileName: string;
  url: string;
  sha256: string;
}

export interface ReleaseManifestV1 {
  schemaVersion: "account-center.release.v1";
  product: "account-center";
  version: string;
  tag: string;
  commit: string;
  channel: "stable";
  artifacts: ReleaseArtifactV1[];
}

export type ReleaseInspection =
  | { state: "verified"; release: { version: string; tag: string; artifact: ReleaseArtifactV1 } }
  | { state: "UNPROVEN"; reason: "invalid_signature" }
  | { state: "blocked"; reason: "invalid_manifest" | "product_mismatch" | "release_not_newer" | "artifact_not_available" };

export interface InspectSignedReleaseInput {
  manifest: unknown;
  signature: string;
  publicKey: string;
  installedVersion: string;
  platform: string;
  arch: string;
}

/** Produces the exact stable bytes covered by the detached release signature. */
export interface UpdateApplyPlanInput {
  inspection: ReleaseInspection;
  installedVersion: string;
  supervisor: string;
}

export type UpdateApplyPlan =
  | {
      state: "ready_for_confirmation";
      planId: string;
      product: "account-center";
      installedVersion: string;
      release: { version: string; tag: string; artifact: ReleaseArtifactV1 };
      supervisor: "account-center-local";
      requiredSteps: ["explicit_confirmation", "artifact_checksum", "protected_backup", "narrow_account_center_restart", "health_proof", "rollback_on_failed_health"];
    }
  | { state: "blocked"; reason: "release_not_verified" | "unsupported_supervisor" };

/**
 * Binds a verified immutable release to an Account-Center-only apply plan.
 * This is intentionally a plan, not an installer: it never downloads, writes,
 * restarts, or accepts a process name supplied by an agent/operator.
 */
export function createUpdateApplyPlan(input: UpdateApplyPlanInput): UpdateApplyPlan {
  if (input.inspection.state !== "verified") return { state: "blocked", reason: "release_not_verified" };
  if (input.supervisor !== "account-center-local") return { state: "blocked", reason: "unsupported_supervisor" };
  const release = input.inspection.release;
  const planInput = canonicalizeReleaseManifest({ product: "account-center", installedVersion: input.installedVersion, release, supervisor: input.supervisor });
  const planId = `ac-update-v1:${createHash("sha256").update(planInput).digest("hex")}`;
  return {
    state: "ready_for_confirmation",
    planId,
    product: "account-center",
    installedVersion: input.installedVersion,
    release,
    supervisor: "account-center-local",
    requiredSteps: ["explicit_confirmation", "artifact_checksum", "protected_backup", "narrow_account_center_restart", "health_proof", "rollback_on_failed_health"]
  };
}

export function canonicalizeReleaseManifest(manifest: unknown): string {
  return JSON.stringify(sortJson(manifest));
}

/**
 * Inspects a pre-fetched release manifest. It never downloads, applies, or
 * executes anything. The caller supplies a pinned public key, not a URL.
 */
export function inspectSignedRelease(input: InspectSignedReleaseInput): ReleaseInspection {
  if (!isManifest(input.manifest)) return { state: "blocked", reason: "invalid_manifest" };
  const manifest = input.manifest;
  if (manifest.product !== "account-center") return { state: "blocked", reason: "product_mismatch" };
  if (!isStrictSemver(manifest.version) || manifest.tag !== `v${manifest.version}` || !/^[a-f0-9]{40}$/i.test(manifest.commit) || manifest.channel !== "stable") {
    return { state: "blocked", reason: "invalid_manifest" };
  }
  const artifact = manifest.artifacts.find((candidate) => candidate.platform === input.platform && candidate.arch === input.arch);
  if (!artifact) return { state: "blocked", reason: "artifact_not_available" };
  if (!isArtifact(artifact, manifest.version)) return { state: "blocked", reason: "invalid_manifest" };
  if (!isStrictSemver(input.installedVersion) || compareSemver(manifest.version, input.installedVersion) <= 0) {
    return { state: "blocked", reason: "release_not_newer" };
  }
  try {
    const signature = Buffer.from(input.signature, "base64");
    const valid = signature.length > 0 && verify(null, Buffer.from(canonicalizeReleaseManifest(manifest)), input.publicKey, signature);
    if (!valid) return { state: "UNPROVEN", reason: "invalid_signature" };
  } catch {
    return { state: "UNPROVEN", reason: "invalid_signature" };
  }
  return { state: "verified", release: { version: manifest.version, tag: manifest.tag, artifact } };
}

function isManifest(value: unknown): value is ReleaseManifestV1 {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ReleaseManifestV1>;
  return candidate.schemaVersion === "account-center.release.v1" && typeof candidate.product === "string" && typeof candidate.version === "string" && typeof candidate.tag === "string" && typeof candidate.commit === "string" && typeof candidate.channel === "string" && Array.isArray(candidate.artifacts);
}

function isArtifact(artifact: ReleaseArtifactV1, version: string): boolean {
  const expected = new RegExp(`^account-center-${escapeRegExp(version)}-[a-z0-9]+-[a-z0-9]+\\.tar\\.gz$`);
  if (typeof artifact.fileName !== "string" || !expected.test(artifact.fileName) || typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(artifact.sha256)) return false;
  try { return new URL(artifact.url).protocol === "https:"; } catch { return false; }
}

function compareSemver(left: string, right: string): number {
  const l = left.split(".").map(Number);
  const r = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) if (l[index] !== r[index]) return l[index] - r[index];
  return 0;
}

function isStrictSemver(value: string): boolean { return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value); }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sortJson(child)]));
  return value;
}
