import test from "node:test";
import assert from "node:assert/strict";
import { publicDoctorView, publicStatusView } from "./public-views.js";
import type { AccountCenterStatus } from "./schemas.js";

const hostileValues = [
  "/srv/private/account-center/workspace",
  "/usr/local/bin/private-adapter --dump-config",
  "adapter stderr: connection refused",
  "minFiveHourRemainingPct=73",
  "person@example.test",
  "openai:private-profile-id",
  "target:production-account",
  "sk-hostile-token-value-123456789"
];

test("public status and doctor DTOs never serialize adapter diagnostics or private runtime values", () => {
  const status = {
    schemaVersion: "account-center.status.v1",
    generatedAt: "2026-07-17T12:00:00.000Z",
    noSecrets: true,
    source: "openclaw",
    providers: [{ key: "custom:person@example.test", displayName: "/srv/private/account-center/workspace" }],
    runtimes: [{ key: "custom:/usr/local/bin/private-adapter", displayName: "adapter stderr: connection refused", capabilities: { readStatus: true, mutateRoutes: true, startReauth: true, mutateModels: true } }],
    profiles: [{
      id: "openai:private-profile-id",
      provider: "custom:person@example.test",
      label: "target:production-account",
      role: "primary",
      runtimeCompatibility: ["custom:/usr/local/bin/private-adapter"],
      models: ["sk-hostile-token-value-123456789"],
      disabled: false,
      metadata: { policy: "minFiveHourRemainingPct=73" },
      usage: {
        profileId: "openai:private-profile-id",
        provider: "custom:person@example.test",
        generatedAt: "2026-07-17T12:00:00.000Z",
        readable: true,
        health: "ok",
        windows: [{ name: "/srv/private/account-center/workspace", remainingPct: 80, displayLabel: "/usr/local/bin/private-adapter --dump-config" }],
        auth: { state: "ok", tokenExpiresAt: "2026-07-17T13:00:00.000Z" },
        warnings: ["adapter stderr: connection refused"]
      }
    }],
    routes: [{ provider: "custom:person@example.test", runtime: "custom:/usr/local/bin/private-adapter", activeProfileId: "openai:private-profile-id", order: ["openai:private-profile-id"], updatedAt: "2026-07-17T12:00:00.000Z" }],
    policy: { minFiveHourRemainingPct: 73, minWeeklyRemainingPct: 12, allowBackupWhenNormalAvailable: true, disabledModels: ["sk-hostile-token-value-123456789"], staleAfterSeconds: 42 },
    leases: [{ id: "target:production-account", profileId: "openai:private-profile-id", holder: "person@example.test", reason: "adapter stderr: connection refused", expiresAt: "2026-07-17T13:00:00.000Z" }],
    reauth: [{ id: "reauth-private-profile-id", provider: "custom:person@example.test", profileHint: "openai:private-profile-id", userCode: "sk-hostile-token-value-123456789", verificationUri: "/srv/private/account-center/workspace", expiresAt: "2026-07-17T13:00:00.000Z", status: "pending" }],
    audit: [],
    warnings: ["adapter stderr: connection refused"]
  } as unknown as AccountCenterStatus;

  const publicOutput = JSON.stringify({ status: publicStatusView(status), doctor: publicDoctorView("openclaw", { ok: false, error: "adapter stderr: connection refused", workspace: "/srv/private/account-center/workspace" }) });
  for (const value of hostileValues) assert.equal(publicOutput.includes(value), false, value);
  assert.deepEqual(Object.keys(publicStatusView(status)).sort(), ["generatedAt", "profiles", "reauth", "routes", "runtimes", "schemaVersion", "source", "verificationState"]);
  assert.deepEqual(publicDoctorView("openclaw", { ok: false, error: "adapter stderr: connection refused" }), {
    schemaVersion: "account-center.public-doctor.v1",
    source: "openclaw",
    state: "UNPROVEN"
  });
});
