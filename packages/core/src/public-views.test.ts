import test from "node:test";
import assert from "node:assert/strict";
import { publicDoctorView, publicLimitsInventoryView, publicModelCatalogView, publicRuntimeScopeCatalogView, publicStatusView } from "./public-views.js";
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

  const hostileSource = "/srv/private/account-center/adapter --source=production";
  const hostileStatusView = publicStatusView({ ...status, source: hostileSource } as unknown as AccountCenterStatus);
  assert.deepEqual(hostileStatusView, {
    ...publicStatusView(status),
    source: "unknown",
    verificationState: "UNPROVEN"
  });
  const hostileDoctorView = publicDoctorView(hostileSource, { ok: true, command: hostileSource });
  assert.deepEqual(hostileDoctorView, {
    schemaVersion: "account-center.public-doctor.v1",
    source: "unknown",
    state: "UNPROVEN"
  });
  assert.equal(JSON.stringify({ hostileStatusView, hostileDoctorView }).includes(hostileSource), false);
});

test("public runtime scope catalog omits distinct unknown runtime keys without combining capabilities", () => {
  const status = {
    schemaVersion: "account-center.status.v1",
    generatedAt: "2026-07-17T12:00:00.000Z",
    noSecrets: true,
    source: "generic-command",
    providers: [],
    runtimes: [
      { key: "generic-command", displayName: "trusted generic adapter", capabilities: { readStatus: true, mutateRoutes: true, startReauth: true, mutateModels: true } },
      { key: "custom:hostile-runtime-a", displayName: "private runtime A", capabilities: { readStatus: false, mutateRoutes: true, startReauth: false, mutateModels: false } },
      { key: "custom:hostile-runtime-b", displayName: "private runtime B", capabilities: { readStatus: false, mutateRoutes: false, startReauth: true, mutateModels: true } }
    ],
    profiles: [], routes: [], policy: { minFiveHourRemainingPct: 0, minWeeklyRemainingPct: 0, allowBackupWhenNormalAvailable: false, disabledModels: [], staleAfterSeconds: 60 }, leases: [], reauth: [], audit: [], warnings: []
  } as unknown as AccountCenterStatus;

  assert.deepEqual(publicRuntimeScopeCatalogView(status), {
    schemaVersion: "account-center.runtime-scopes.v1",
    generatedAt: "2026-07-17T12:00:00.000Z",
    scopes: [{ runtime: "generic-command", scope: { kind: "default", id: "default" }, capabilities: { readStatus: true, mutateRoutes: false, startReauth: false, mutateModels: false } }]
  });

  assert.deepEqual(publicRuntimeScopeCatalogView({ ...status, source: "openclaw" }), {
    schemaVersion: "account-center.runtime-scopes.v1",
    generatedAt: "2026-07-17T12:00:00.000Z",
    scopes: [{ runtime: "generic-command", scope: { kind: "default", id: "default" }, capabilities: { readStatus: true, mutateRoutes: true, startReauth: true, mutateModels: true } }]
  });
});

test("all status-derived protected read views reject fixture identity, secret, path, and adapter-error fields", () => {
  const status = {
    schemaVersion: "account-center.status.v1",
    generatedAt: "2026-07-17T12:00:00.000Z",
    noSecrets: true,
    source: "generic-command",
    providers: [{ key: "custom:fixture-person@example.test", displayName: "/fixture/private/path" }],
    runtimes: [{ key: "custom:fixture-adapter-error", displayName: "fixture adapter error", capabilities: { readStatus: true, mutateRoutes: true, startReauth: true, mutateModels: true } }],
    profiles: [{
      id: "custom:fixture-profile-identity",
      provider: "custom:fixture-person@example.test",
      label: "/fixture/private/path",
      role: "primary",
      runtimeCompatibility: ["custom:fixture-adapter-error"],
      models: ["sk-fixture-secret-value-123456789"],
      disabled: false,
      metadata: { adapterError: "fixture adapter error" },
      usage: {
        profileId: "custom:fixture-profile-identity",
        provider: "custom:fixture-person@example.test",
        generatedAt: "2026-07-17T12:00:00.000Z",
        readable: true,
        health: "ok",
        windows: [{ name: "/fixture/private/path", remainingPct: 50 }],
        auth: { state: "ok" },
        warnings: ["fixture adapter error"]
      }
    }],
    routes: [{ provider: "custom:fixture-person@example.test", runtime: "custom:fixture-adapter-error", activeProfileId: "custom:fixture-profile-identity", order: ["custom:fixture-profile-identity"] }],
    policy: { minFiveHourRemainingPct: 0, minWeeklyRemainingPct: 0, allowBackupWhenNormalAvailable: false, disabledModels: ["sk-fixture-secret-value-123456789"], staleAfterSeconds: 60 },
    leases: [], reauth: [], audit: [], warnings: ["fixture adapter error"]
  } as unknown as AccountCenterStatus;
  const output = JSON.stringify({
    status: publicStatusView(status),
    limits: publicLimitsInventoryView(status),
    models: publicModelCatalogView(status),
    scopes: publicRuntimeScopeCatalogView(status)
  });

  for (const forbidden of ["fixture-person@example.test", "sk-fixture-secret-value-123456789", "/fixture/private/path", "fixture adapter error", "fixture-profile-identity", "fixture-adapter-error"]) {
    assert.equal(output.includes(forbidden), false, `read view leaked ${forbidden}`);
  }
});
