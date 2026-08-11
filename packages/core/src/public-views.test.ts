import test from "node:test";
import assert from "node:assert/strict";
import { publicDoctorView, publicModelCatalogView, publicRuntimeScopeCatalogView, publicStatusView } from "./public-views.js";
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

test("Codex capability declarations remain read-only in public status and scope catalogs", () => {
  const status = {
    schemaVersion: "account-center.status.v1", generatedAt: "2026-07-17T12:00:00.000Z", noSecrets: true, source: "openclaw",
    providers: [], profiles: [], routes: [], leases: [], reauth: [], audit: [], warnings: [],
    policy: { minFiveHourRemainingPct: 0, minWeeklyRemainingPct: 0, allowBackupWhenNormalAvailable: false, disabledModels: [], staleAfterSeconds: 60 },
    runtimes: [{ key: "codex", displayName: "private", capabilities: { readStatus: true, mutateRoutes: true, startReauth: true, mutateModels: true } }]
  } as unknown as AccountCenterStatus;
  const expected = { readStatus: true, mutateRoutes: false, startReauth: false, mutateModels: false };
  assert.deepEqual(publicStatusView(status).runtimes, [{ key: "codex", capabilities: expected }]);
  assert.deepEqual(publicRuntimeScopeCatalogView(status), {
    schemaVersion: "account-center.runtime-scopes.v1", generatedAt: "2026-07-17T12:00:00.000Z",
    scopes: [{ runtime: "codex", scope: { kind: "default", id: "default" }, capabilities: expected }]
  });
});

test("model truth remains bounded when catalog evidence is missing, malformed, stale, contradictory, or cross-runtime", () => {
  const status = {
    schemaVersion: "account-center.status.v1",
    generatedAt: "not-a-timestamp",
    noSecrets: true,
    source: "fixture",
    providers: [], runtimes: [], routes: [], leases: [], reauth: [], audit: [], warnings: [],
    policy: { disabledModels: ["openai/gpt-5.5", "/private/policy-model", 7] },
    profiles: [
      // A stale/unreadable Hermes observation is catalog evidence only; it
      // cannot become selection, eligibility, fallback, or verification.
      { models: ["openai/gpt-5.5", "private/provider-model"], runtimeCompatibility: ["hermes"], usage: { readable: false, generatedAt: "1999-01-01T00:00:00.000Z" } },
      // This contradictory OpenClaw entry cannot bleed into Hermes scope.
      { models: ["openai/gpt-5.3-codex"], runtimeCompatibility: ["openclaw"], usage: { readable: true } },
      // Adapter-shape failures are ignored rather than rendered or throwing.
      { models: "openai/gpt-4.1", runtimeCompatibility: "hermes", usage: null }
    ]
  } as unknown as AccountCenterStatus;

  assert.deepEqual(publicModelCatalogView(status, "hermes"), {
    schemaVersion: "account-center.models.v1",
    generatedAt: "unknown",
    selection: {
      requestedPolicy: { state: "not_reported" },
      effectiveRuntimeModel: { state: "not_reported" },
      fallbackChain: { state: "not_reported" },
      verificationState: "UNPROVEN"
    },
    models: [{
      id: "openai/gpt-5.3-codex",
      selectable: true,
      observedProfileCount: 0,
      readableProfileCount: 0,
      runtimeCompatibility: [],
      verificationState: "UNPROVEN"
    }, {
      id: "openai/gpt-5.5",
      selectable: false,
      reason: "disabled_by_policy",
      observedProfileCount: 1,
      readableProfileCount: 0,
      runtimeCompatibility: ["hermes"],
      verificationState: "UNPROVEN"
    }]
  });

  // An unsupported selected runtime is not a license to borrow observations.
  // The known catalog remains visible, but every scoped observation is empty.
  const unsupported = publicModelCatalogView(status, "invented-runtime");
  assert.deepEqual(unsupported.models.map((model) => ({ id: model.id, observed: model.observedProfileCount, compatibility: model.runtimeCompatibility })), [
    { id: "openai/gpt-5.3-codex", observed: 0, compatibility: [] },
    { id: "openai/gpt-5.5", observed: 0, compatibility: [] }
  ]);
  assert.equal(JSON.stringify(unsupported).match(/private|1999|invented-runtime/i), null);
});
