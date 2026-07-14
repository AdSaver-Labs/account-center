import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { canonicalizeReleaseManifest, inspectSignedRelease } from "./update-center.js";

const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();

function signedManifest(overrides: Record<string, unknown> = {}) {
  const manifest = {
    schemaVersion: "account-center.release.v1",
    product: "account-center",
    version: "0.2.0",
    tag: "v0.2.0",
    commit: "a".repeat(40),
    channel: "stable",
    artifacts: [{ platform: "darwin", arch: "arm64", fileName: "account-center-0.2.0-darwin-arm64.tar.gz", url: "https://releases.example.invalid/account-center-0.2.0-darwin-arm64.tar.gz", sha256: "b".repeat(64) }],
    ...overrides
  };
  const signature = sign(null, Buffer.from(canonicalizeReleaseManifest(manifest)), keys.privateKey).toString("base64");
  return { manifest, signature };
}

test("Update Center verifies an immutable signed Account Center release artifact", () => {
  const { manifest, signature } = signedManifest();
  const result = inspectSignedRelease({ manifest, signature, publicKey, installedVersion: "0.1.0", platform: "darwin", arch: "arm64" });
  assert.deepEqual(result, { state: "verified", release: { version: "0.2.0", tag: "v0.2.0", artifact: manifest.artifacts[0] } });
});

test("Update Center treats a modified signed manifest as UNPROVEN", () => {
  const { manifest, signature } = signedManifest();
  const result = inspectSignedRelease({ manifest: { ...manifest, commit: "c".repeat(40) }, signature, publicKey, installedVersion: "0.1.0", platform: "darwin", arch: "arm64" });
  assert.deepEqual(result, { state: "UNPROVEN", reason: "invalid_signature" });
});

test("Update Center blocks non-Account-Center, wrong-platform, stale, and malformed manifests", () => {
  for (const [overrides, installedVersion, platform, expected] of [
    [{ product: "openclaw" }, "0.1.0", "darwin", "product_mismatch"],
    [{}, "0.1.0", "linux", "artifact_not_available"],
    [{}, "0.2.0", "darwin", "release_not_newer"],
    [{ tag: "main" }, "0.1.0", "darwin", "invalid_manifest"]
  ] as const) {
    const { manifest, signature } = signedManifest(overrides);
    const result = inspectSignedRelease({ manifest, signature, publicKey, installedVersion, platform, arch: "arm64" });
    assert.deepEqual(result, { state: "blocked", reason: expected });
  }
});
