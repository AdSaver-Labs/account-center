import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountCenterStatus, AuditStore, AuthChallengeStore, MutationRepository } from "@account-center/core";
import { createAccountCenterServer } from "./server.js";
import { AccountUiPreferencesStore } from "./account-preferences-store.js";

async function request(port: number, path: string, token?: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
}

async function bodyRequest(port: number, path: string, token: string | undefined, method = "GET", body = "{}"): Promise<{ status: number; body: unknown; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      path,
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) }
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: text ? JSON.parse(text) : undefined, headers: response.headers }));
    });
    request.once("error", reject);
    request.end(body);
  });
}

async function createChallenge(port: number, token: string, body: unknown, origin = true): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/auth-challenges`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(origin ? { origin: `http://127.0.0.1:${port}` } : {})
    },
    body: JSON.stringify(body)
  });
}

async function rawChallengeRequest(port: number, options: { token?: string; origin?: string; host?: string; contentType?: string; body?: string }): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/auth-challenges`, {
    method: "POST",
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.origin ? { origin: options.origin } : {}),
      ...(options.host ? { host: options.host } : {}),
      ...(options.contentType ? { "content-type": options.contentType } : {})
    },
    ...(options.body === undefined ? {} : { body: options.body })
  });
}

async function rawPreferenceRequest(port: number, options: { token?: string; origin?: string; contentType?: string; body?: string }): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/account-ui-preferences?runtime=hermes&scope=default`, {
    method: "POST",
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.origin ? { origin: options.origin } : {}),
      ...(options.contentType ? { "content-type": options.contentType } : {})
    },
    ...(options.body === undefined ? {} : { body: options.body })
  });
}

async function rawAuthorizationChallengeRequest(port: number, authorization: string | string[], body: string): Promise<{ status: number; body: unknown; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let response = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk: string) => { response += chunk; });
    socket.on("end", () => {
      const [head, text = ""] = response.split("\r\n\r\n", 2);
      const [statusLine = "", ...headerLines] = head.split("\r\n");
      const status = Number(/^HTTP\/\d\.\d (\d{3})/.exec(statusLine)?.[1] ?? 0);
      const headers: Record<string, string> = {};
      for (const line of headerLines) {
        const separator = line.indexOf(":");
        if (separator > 0) headers[line.slice(0, separator).toLowerCase()] = line.slice(separator + 1).trim();
      }
      resolve({ status, body: text ? JSON.parse(text) : undefined, headers });
    });
    socket.on("connect", () => {
      const credentials = (Array.isArray(authorization) ? authorization : [authorization]).map((value) => `Authorization: ${value}\r\n`).join("");
      socket.end(`POST /api/auth-challenges HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${credentials}Origin: http://127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    });
  });
}

function assertHardenedJsonError(response: Response, expectedStatus: number, expectedError: string, suppliedText: string): Promise<void> {
  return response.text().then((body) => {
    assert.equal(response.status, expectedStatus);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(response.headers.get("content-security-policy"), "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; connect-src 'self'; img-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.deepEqual(JSON.parse(body), { error: expectedError });
    assert.equal(body.length <= 4_096, true);
    assert.equal(body.includes(suppliedText), false);
  });
}

test("protected guided-auth creation persists distinct redacted add and reauth challenges idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-guided-auth-"));
  const app = createAccountCenterServer({
    token: "test-token",
    challengeStore: new AuthChallengeStore(join(root, "auth-challenges.json"))
  });
  const address = await app.listen();
  const body = { provider: "openai", runtime: "openclaw", scope: "default", target: "new@example.com" };
  try {
    const add = await createChallenge(address.port, "test-token", { ...body, mode: "add" });
    assert.equal(add.status, 201);
    const addPayload = await add.json() as { challenge: { id: string; mode: string }; idempotent: boolean };
    assert.equal(addPayload.challenge.mode, "add");
    assert.equal(addPayload.idempotent, false);
    assert.equal(JSON.stringify(addPayload).includes("new@example.com"), false);

    const retry = await createChallenge(address.port, "test-token", { ...body, mode: "add", target: "NEW@example.com" });
    assert.equal(retry.status, 200);
    const retryPayload = await retry.json() as { challenge: { id: string; mode: string }; idempotent: boolean };
    assert.equal(retryPayload.challenge.id, addPayload.challenge.id);
    assert.equal(retryPayload.idempotent, true);

    const reauth = await createChallenge(address.port, "test-token", { ...body, mode: "reauth" });
    assert.equal(reauth.status, 201);
    const reauthPayload = await reauth.json() as { challenge: { id: string; mode: string }; idempotent: boolean };
    assert.equal(reauthPayload.challenge.mode, "reauth");
    assert.notEqual(reauthPayload.challenge.id, addPayload.challenge.id);
    assert.equal(JSON.stringify(reauthPayload).includes("new@example.com"), false);
  } finally {
    await app.close();
  }
});

test("guided-auth creation rejects unscoped, unsupported, malformed, and cross-origin requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-guided-auth-"));
  const app = createAccountCenterServer({ token: "test-token", challengeStore: new AuthChallengeStore(join(root, "auth-challenges.json")) });
  const address = await app.listen();
  try {
    for (const body of [
      { mode: "add", provider: "openai", runtime: "openclaw", target: "new@example.com" },
      { mode: "add", provider: "openai", runtime: "codex", scope: "default", target: "new@example.com" },
      { mode: "add", provider: "openai", runtime: "openclaw", scope: "agent:main", target: "new@example.com" },
      { mode: "add", provider: "openai", runtime: "openclaw", scope: "default", target: "not-an-email" },
      { mode: "replace", provider: "openai", runtime: "openclaw", scope: "default", target: "new@example.com" }
    ]) {
      const response = await createChallenge(address.port, "test-token", body);
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: "invalid_guided_auth_request" });
    }
    const crossOrigin = await createChallenge(address.port, "test-token", { mode: "add", provider: "openai", runtime: "openclaw", scope: "default", target: "new@example.com" }, false);
    assert.equal(crossOrigin.status, 403);
    assert.deepEqual(await crossOrigin.json(), { error: "origin_forbidden" });
  } finally {
    await app.close();
  }
});

test("local API requires bearer token and returns no-store status", async () => {
  const app = createAccountCenterServer({ token: "test-token" });
  const address = await app.listen();
  try {
    const denied = await request(address.port, "/api/status");
    assert.equal(denied.status, 401);
    const accepted = await request(address.port, "/api/status", "test-token");
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get("cache-control"), "no-store");
    assert.equal(accepted.headers.get("access-control-allow-origin"), null);
    assert.equal(accepted.headers.get("content-security-policy"), "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; connect-src 'self'; img-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'");
    assert.equal(accepted.headers.get("referrer-policy"), "no-referrer");
    assert.equal(accepted.headers.get("x-content-type-options"), "nosniff");
    assert.equal(accepted.headers.get("x-frame-options"), "DENY");
  } finally {
    await app.close();
  }
});

test("protected API rejects bearer near-misses and unsafe mutation representations without echoing input", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-api-security-"));
  const app = createAccountCenterServer({ token: "test-token", challengeStore: new AuthChallengeStore(join(root, "auth-challenges.json")) });
  const address = await app.listen();
  const validBody = JSON.stringify({ mode: "add", provider: "openai", runtime: "openclaw", scope: "default", target: "private@example.test" });
  try {
    for (const token of ["test-token-x", "Test-Token", "test-token-private@example.test"]) {
      const response = await request(address.port, "/api/status", token);
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: "unauthorized" });
    }
    const crossOrigin = await rawChallengeRequest(address.port, { token: "test-token", origin: "https://attacker.invalid", contentType: "application/json", body: validBody });
    assert.equal(crossOrigin.status, 403);
    assert.deepEqual(await crossOrigin.json(), { error: "origin_forbidden" });
    const forgedHostAndOrigin = await rawChallengeRequest(address.port, { token: "test-token", host: "attacker.invalid", origin: "http://attacker.invalid", contentType: "application/json", body: validBody });
    assert.equal(forgedHostAndOrigin.status, 403);
    assert.deepEqual(await forgedHostAndOrigin.json(), { error: "origin_forbidden" });
    const form = await rawChallengeRequest(address.port, { token: "test-token", origin: `http://127.0.0.1:${address.port}`, contentType: "application/x-www-form-urlencoded", body: validBody });
    assert.equal(form.status, 415);
    assert.deepEqual(await form.json(), { error: "json_content_type_required" });
    const oversized = await rawChallengeRequest(address.port, { token: "test-token", origin: `http://127.0.0.1:${address.port}`, contentType: "application/json; charset=utf-8", body: `{\"target\":\"${"x".repeat(4_100)}\"}` });
    assert.equal(oversized.status, 413);
    assert.deepEqual(await oversized.json(), { error: "request_body_too_large" });
  } finally {
    await app.close();
  }
});

test("protected API rejects malformed and duplicate bearer credentials before every collaborator", async () => {
  const forbiddenCollaborator = new Proxy({}, { get() { throw new Error("rejected_bearer_must_not_access_collaborator"); } });
  const app = createAccountCenterServer({
    token: "test-token",
    source: null,
    challengeStore: forbiddenCollaborator as AuthChallengeStore,
    auditStore: forbiddenCollaborator as AuditStore,
    mutationRepository: forbiddenCollaborator as MutationRepository,
    accountUiPreferencesStore: forbiddenCollaborator as AccountUiPreferencesStore
  });
  const address = await app.listen();
  const hostile = "private@example.test";
  const body = JSON.stringify({ mode: "add", provider: "openai", runtime: "openclaw", scope: "default", target: hostile });
  try {
    for (const authorization of [
      "bearer test-token",
      "Bearer",
      "Bearer  test-token",
      "Bearer test-token extra",
      "Basic test-token",
      "Bearer test-token, Bearer other-token",
      "Bearer x-test-token",
      "Bearer test-token-x",
      "Bearer x",
      `Bearer ${"x".repeat(8_192)}`,
      ["Bearer test-token", "Bearer test-token"]
    ] as Array<string | string[]>) {
      const response = await rawAuthorizationChallengeRequest(address.port, authorization, body);
      assert.equal(response.status, 401);
      assert.equal(response.headers["cache-control"], "no-store");
      assert.deepEqual(response.body, { error: "unauthorized" });
      assert.equal(JSON.stringify(response.body).includes(hostile), false);
    }
    const accepted = await rawAuthorizationChallengeRequest(address.port, "Bearer test-token", body);
    assert.equal(accepted.status, 503);
    assert.deepEqual(accepted.body, { error: "status_unavailable" });
  } finally {
    await app.close();
  }
});

test("guided-auth writes reject bearer, listener-origin, and body attacks before every collaborator", async () => {
  // The start and cancel endpoints are the only protected writes. Each
  // collaborator throws on access, so every fixed rejection here proves that
  // hostile requests cannot reach status discovery, challenge/audit state, or
  // lifecycle execution. Cancel also pins origin precedence over body shape.
  const forbiddenCollaborator = new Proxy({}, { get() { throw new Error("rejected_guided_auth_write_must_not_access_collaborator"); } });
  const app = createAccountCenterServer({
    token: "test-token",
    source: null,
    challengeStore: forbiddenCollaborator as AuthChallengeStore,
    auditStore: forbiddenCollaborator as AuditStore
  });
  const address = await app.listen();
  const origin = `http://127.0.0.1:${address.port}`;
  const hostile = "private@example.test";
  const startBody = JSON.stringify({ mode: "add", provider: "openai", runtime: "openclaw", scope: "default", target: hostile });
  const cancelPath = "/api/auth-challenges/auth_00000000-0000-4000-8000-000000000000/cancel";
  try {
    await assertHardenedJsonError(await rawChallengeRequest(address.port, { origin, contentType: "application/json", body: startBody }), 401, "unauthorized", hostile);
    await assertHardenedJsonError(await rawChallengeRequest(address.port, { token: "test-token", contentType: "application/json", body: startBody }), 403, "origin_forbidden", hostile);
    await assertHardenedJsonError(await rawChallengeRequest(address.port, { token: "test-token", origin: "https://attacker.invalid", contentType: "application/json", body: startBody }), 403, "origin_forbidden", hostile);
    await assertHardenedJsonError(await rawChallengeRequest(address.port, { token: "test-token", origin, contentType: "text/plain", body: hostile }), 415, "json_content_type_required", hostile);
    await assertHardenedJsonError(await rawChallengeRequest(address.port, { token: "test-token", origin, contentType: "application/json", body: `{\"target\":\"${"x".repeat(4_100)}\"}` }), 413, "request_body_too_large", hostile);

    const cancel = (token: string | undefined, requestOrigin: string | undefined, body?: string) => fetch(`http://127.0.0.1:${address.port}${cancelPath}`, {
      method: "POST",
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(requestOrigin ? { origin: requestOrigin } : {}), ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body } : {})
    });
    await assertHardenedJsonError(await cancel(undefined, origin, hostile), 401, "unauthorized", hostile);
    await assertHardenedJsonError(await cancel("test-token", undefined, hostile), 403, "origin_forbidden", hostile);
    await assertHardenedJsonError(await cancel("test-token", "https://attacker.invalid", hostile), 403, "origin_forbidden", hostile);
    await assertHardenedJsonError(await cancel("test-token", origin, hostile), 413, "request_body_not_allowed", hostile);
  } finally {
    await app.close();
  }
});

test("preference updates reject bearer and listener-origin attacks before every collaborator", async () => {
  // The source and store both throw on access. Fixed rejections therefore prove
  // hostile writes cannot inspect runtime state or open local preferences.
  const forbiddenCollaborator = new Proxy({}, { get() { throw new Error("rejected_preference_write_must_not_access_collaborator"); } });
  const app = createAccountCenterServer({
    token: "test-token",
    source: null,
    accountUiPreferencesStore: forbiddenCollaborator as AccountUiPreferencesStore
  });
  const address = await app.listen();
  const origin = `http://127.0.0.1:${address.port}`;
  const hostile = "private@example.test";
  const body = JSON.stringify({ accountRef: hostile, state: "hidden" });
  try {
    await assertHardenedJsonError(await rawPreferenceRequest(address.port, { origin, contentType: "application/json", body }), 401, "unauthorized", hostile);
    await assertHardenedJsonError(await rawPreferenceRequest(address.port, { token: "test-token", contentType: "application/json", body }), 403, "origin_forbidden", hostile);
    await assertHardenedJsonError(await rawPreferenceRequest(address.port, { token: "test-token", origin: "https://attacker.invalid", contentType: "application/json", body }), 403, "origin_forbidden", hostile);
  } finally {
    await app.close();
  }
});

test("protected response failures share hardened headers and preference reads reject bodies before store access", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-response-contract-"));
  const suppliedText = "private@example.test";
  const app = createAccountCenterServer({
    token: "test-token",
    challengeStore: new AuthChallengeStore(join(root, "auth-challenges.json")),
    accountUiPreferencesStore: { view: async () => { throw new Error("store_must_not_be_opened"); } } as unknown as AccountUiPreferencesStore
  });
  const address = await app.listen();
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const panel = await fetch(`${origin}/`);
    assert.equal(panel.status, 200);
    assert.equal(panel.headers.get("cache-control"), "no-store");
    assert.equal(panel.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(panel.headers.get("x-frame-options"), "DENY");

    await assertHardenedJsonError(await request(address.port, "/api/status", `test-token-${suppliedText}`), 401, "unauthorized", suppliedText);
    await assertHardenedJsonError(await rawChallengeRequest(address.port, { token: "test-token", origin: "https://attacker.invalid", contentType: "application/json", body: JSON.stringify({ target: suppliedText }) }), 403, "origin_forbidden", suppliedText);
    await assertHardenedJsonError(await rawChallengeRequest(address.port, { token: "test-token", origin, contentType: "text/plain", body: suppliedText }), 415, "json_content_type_required", suppliedText);
    await assertHardenedJsonError(await fetch(`${origin}/api/status`, { method: "POST", headers: { authorization: "Bearer test-token" } }), 405, "method_not_allowed", suppliedText);
    await assertHardenedJsonError(await request(address.port, `/api/missing-${suppliedText}`, "test-token"), 404, "not_found", suppliedText);
    const preferenceBodyRead = await bodyRequest(address.port, "/api/account-ui-preferences?runtime=hermes&scope=default", "test-token");
    assert.deepEqual({ status: preferenceBodyRead.status, body: preferenceBodyRead.body }, { status: 413, body: { error: "request_body_not_allowed" } });
    assert.equal(preferenceBodyRead.headers["cache-control"], "no-store");
    assert.equal(preferenceBodyRead.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(preferenceBodyRead.headers["content-security-policy"], "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; connect-src 'self'; img-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'");
    assert.equal(preferenceBodyRead.headers["referrer-policy"], "no-referrer");
    assert.equal(preferenceBodyRead.headers["x-content-type-options"], "nosniff");
    assert.equal(preferenceBodyRead.headers["x-frame-options"], "DENY");
    assert.equal(preferenceBodyRead.headers["access-control-allow-origin"], undefined);
  } finally {
    await app.close();
  }
});

test("unsupported preference methods fail closed before local state or runtime discovery", async () => {
  // An explicit invalid source makes accidental runtime discovery observable as
  // a 500. The throwing store independently proves the 405 path opens neither
  // durable preferences nor status before rejecting the method.
  const app = createAccountCenterServer({
    token: "test-token",
    source: null,
    accountUiPreferencesStore: { view: async () => { throw new Error("preference_store_must_not_be_opened"); } } as unknown as AccountUiPreferencesStore
  });
  const address = await app.listen();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/account-ui-preferences?runtime=hermes&scope=default`, {
      method: "DELETE",
      headers: { authorization: "Bearer test-token" }
    });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET, POST");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { error: "method_not_allowed" });
  } finally {
    await app.close();
  }
});

test("agent connection inventory requires an exact observed context and is protected, redacted, and weekly-only", async () => {
  const app = createAccountCenterServer({ token: "test-token" });
  const address = await app.listen();
  try {
    assert.equal((await request(address.port, "/api/agent-connections")).status, 401);
    for (const path of [
      "/api/agent-connections",
      "/api/agent-connections?runtime=hermes",
      "/api/agent-connections?scope=default",
      "/api/agent-connections?runtime=hermes&scope=default&scope=default",
      "/api/agent-connections?runtime=codex&scope=default",
      "/api/agent-connections?runtime=hermes&scope=agent:qa"
    ]) {
      const rejected = await request(address.port, path, "test-token");
      assert.equal(rejected.status, 400, path);
      assert.deepEqual(await rejected.json(), { error: "invalid_query" }, path);
      assert.equal(rejected.headers.get("cache-control"), "no-store", path);
    }
    const accepted = await request(address.port, "/api/agent-connections?runtime=openclaw&scope=default", "test-token");
    assert.equal(accepted.status, 200);
    const body = await accepted.json() as { inventory: Array<{ runtime: string; state: string; accounts: Array<{ accountRef: string; state: string; pairing: string; weeklyRemainingPct: number | null; lease?: unknown }> }> };
    assert.deepEqual(body.inventory.map((item) => ({ runtime: item.runtime, state: item.state, account: item.accounts[0] })), [
      { runtime: "openclaw", state: "connected", account: { accountRef: "account-1", state: "usable", pairing: "paired-verified", weeklyRemainingPct: 68, routeState: "selected", lease: { schemaVersion: "account-center.scoped-account-lease.v1", leaseRef: "lease-connection-7ccd485d48f8e6adc2d8b251-account-1", connectionRef: "connection-7ccd485d48f8e6adc2d8b251", accountRef: "account-1", runtime: "openclaw", state: "verified" } } }
    ]);
    assert.equal(JSON.stringify(body).match(/helper-|five-hour|token|secret|agent:|--scope|connect-agent/i), null);
  } finally {
    await app.close();
  }
});

test("status API fails closed for a hostile adapter source label without echoing it", async () => {
  const hostileSource = "/srv/private/account-center/adapter --source=production";
  const app = createAccountCenterServer({ token: "test-token", source: hostileSource });
  const address = await app.listen();
  try {
    const response = await request(address.port, "/api/status", "test-token");
    await assertHardenedJsonError(response, 503, "status_unavailable", hostileSource);
  } finally {
    await app.close();
  }
});

test("status API fails closed for an explicit null source instead of selecting the fixture", async () => {
  const app = createAccountCenterServer({ token: "test-token", source: null });
  const address = await app.listen();
  try {
    const response = await request(address.port, "/api/status", "test-token");
    await assertHardenedJsonError(response, 503, "status_unavailable", "null");
  } finally {
    await app.close();
  }
});

test("status API fails closed for an explicitly undefined source instead of selecting the fixture", async () => {
  const app = createAccountCenterServer({ token: "test-token", source: undefined });
  const address = await app.listen();
  try {
    const response = await request(address.port, "/api/status", "test-token");
    await assertHardenedJsonError(response, 503, "status_unavailable", "undefined");
  } finally {
    await app.close();
  }
});

test("status API fails closed when the authoritative status command exits non-zero", async () => {
  const previousCommand = process.env.ACCOUNT_CENTER_GENERIC_COMMAND;
  process.env.ACCOUNT_CENTER_GENERIC_COMMAND = process.execPath;
  const app = createAccountCenterServer({ token: "test-token", source: "generic-command" });
  const address = await app.listen();
  try {
    await assertHardenedJsonError(await request(address.port, "/api/status", "test-token"), 503, "status_unavailable", "--json");
  } finally {
    await app.close();
    if (previousCommand === undefined) delete process.env.ACCOUNT_CENTER_GENERIC_COMMAND;
    else process.env.ACCOUNT_CENTER_GENERIC_COMMAND = previousCommand;
  }
});

test("status API fails closed when a zero-exit status command returns no usable snapshot", async () => {
  const previousCommand = process.env.ACCOUNT_CENTER_GENERIC_COMMAND;
  const previousArgs = process.env.ACCOUNT_CENTER_GENERIC_ARGS;
  process.env.ACCOUNT_CENTER_GENERIC_COMMAND = process.execPath;
  process.env.ACCOUNT_CENTER_GENERIC_ARGS = "-e \"process.stdout.write('{}')\"";
  const app = createAccountCenterServer({ token: "test-token", source: "generic-command" });
  const address = await app.listen();
  try {
    await assertHardenedJsonError(await request(address.port, "/api/status", "test-token"), 503, "status_unavailable", "{} ");
  } finally {
    await app.close();
    if (previousCommand === undefined) delete process.env.ACCOUNT_CENTER_GENERIC_COMMAND;
    else process.env.ACCOUNT_CENTER_GENERIC_COMMAND = previousCommand;
    if (previousArgs === undefined) delete process.env.ACCOUNT_CENTER_GENERIC_ARGS;
    else process.env.ACCOUNT_CENTER_GENERIC_ARGS = previousArgs;
  }
});

test("status API omits OAuth device codes and verification URLs despite a noSecrets fixture assertion", async () => {
  const app = createAccountCenterServer({ token: "test-token" });
  const address = await app.listen();
  try {
    const response = await request(address.port, "/api/status", "test-token");
    assert.equal(response.status, 200);
    const body = await response.json() as { reauth: Array<Record<string, unknown>> };
    assert.deepEqual(body.reauth, [{
      id: "reauth-1",
      provider: "openai",
      profileHint: "account-4",
      expiresAt: "2026-07-09T00:15:00.000Z",
      status: "pending"
    }]);
    assert.equal(JSON.stringify(body).match(/userCode|verificationUri|ABCD-EFGH|example\.invalid\/device/), null);
  } finally {
    await app.close();
  }
});

test("status API exposes only opaque account references, including route and challenge metadata", async () => {
  const app = createAccountCenterServer({ token: "test-token" });
  const address = await app.listen();
  try {
    const response = await request(address.port, "/api/status", "test-token");
    assert.equal(response.status, 200);
    const body = await response.json() as {
      profiles: Array<{ id: string; label: string; usage: { profileId: string } }>;
      routes: Array<{ activeProfileId: string; order: string[] }>;
      reauth: Array<{ profileHint: string }>;
    };
    assert.deepEqual(body.profiles.map(({ id, label, usage }) => ({ id, label, profileId: usage.profileId })), [
      { id: "account-1", label: "account-1", profileId: "account-1" },
      { id: "account-2", label: "account-2", profileId: "account-2" },
      { id: "account-3", label: "account-3", profileId: "account-3" },
      { id: "account-4", label: "account-4", profileId: "account-4" }
    ]);
    assert.deepEqual(body.routes.map(({ activeProfileId, order }) => ({ activeProfileId, order })), [{
      activeProfileId: "account-1", order: ["account-1", "account-2", "account-3", "account-4"]
    }]);
    assert.deepEqual(body.reauth.map(({ profileHint }) => ({ profileHint })), [{ profileHint: "account-4" }]);
    assert.equal(JSON.stringify(body).match(/helper-|business-backup|openai:helper|openai:business/), null);
  } finally {
    await app.close();
  }
});

test("body-bearing API reads are rejected before status execution", async () => {
  const app = createAccountCenterServer({ token: "test-token" });
  const address = await app.listen();
  try {
    const response = await bodyRequest(address.port, "/api/status", "test-token");
    assert.deepEqual({ status: response.status, body: response.body }, {
      status: 413,
      body: { error: "request_body_not_allowed" }
    });
  } finally {
    await app.close();
  }
});

test("protected-route method matrix rejects every unsupported body-bearing variant before collaborators", async () => {
  // Every collaborator throws on property access. A 405 from every matrix row
  // therefore proves rejection precedes durable-state access and runtime work.
  const forbiddenCollaborator = new Proxy({}, { get() { throw new Error("rejected_method_must_not_access_collaborator"); } });
  const app = createAccountCenterServer({
    token: "test-token",
    source: null,
    challengeStore: forbiddenCollaborator as AuthChallengeStore,
    auditStore: forbiddenCollaborator as AuditStore,
    mutationRepository: forbiddenCollaborator as MutationRepository,
    accountUiPreferencesStore: forbiddenCollaborator as AccountUiPreferencesStore
  });
  const address = await app.listen();
  try {
    const hostile = "private@example.test";
    const routes: Array<[string, string[]]> = [
      ["/api/capabilities", ["GET"]], ["/api/status", ["GET"]], ["/api/scopes", ["GET"]],
      ["/api/models?runtime=hermes&scope=default", ["GET"]], ["/api/limits?runtime=hermes&scope=default", ["GET"]],
      ["/api/agent-connections?runtime=hermes&scope=default", ["GET"]], ["/api/audit?runtime=hermes&scopeKind=default", ["GET"]],
      ["/api/audit/audit_00000000-0000-4000-8000-000000000000?runtime=hermes&scopeKind=default", ["GET"]],
      ["/api/mutation-operations?runtime=hermes&scopeKind=default", ["GET"]], ["/api/mutation-operations/op_test?runtime=hermes&scopeKind=default", ["GET"]],
      ["/api/auth-challenges?runtime=hermes&scope=default", ["GET", "POST"]],
      ["/api/auth-challenges/auth_00000000-0000-4000-8000-000000000000?runtime=hermes&scope=default", ["GET"]],
      ["/api/auth-challenges/auth_00000000-0000-4000-8000-000000000000/cancel", ["POST"]],
      ["/api/account-ui-preferences?runtime=hermes&scope=default", ["GET", "POST"]]
    ];
    for (const [path, allowed] of routes) for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
      if (allowed.includes(method)) continue;
      const rejected = await bodyRequest(address.port, path, "test-token", method, hostile);
      assert.equal(rejected.status, 405, `${method} ${path}`);
      assert.equal(rejected.headers.allow, allowed.join(", "), `${method} ${path}`);
      assert.equal(rejected.headers["cache-control"], "no-store", `${method} ${path}`);
      // Node correctly suppresses a response body for HEAD, even though the
      // handler selected the same fixed error status and headers.
      assert.deepEqual(rejected.body, method === "HEAD" ? undefined : { error: "method_not_allowed" }, `${method} ${path}`);
      assert.equal(JSON.stringify(rejected.body ?? null).includes(hostile), false, `${method} ${path}`);
      const unauthorized = await bodyRequest(address.port, path, undefined, method, hostile);
      assert.equal(unauthorized.status, 401, `unauthorized ${method} ${path}`);
      assert.deepEqual(unauthorized.body, method === "HEAD" ? undefined : { error: "unauthorized" }, `unauthorized ${method} ${path}`);
    }
  } finally {
    await app.close();
  }
});

test("protected routes reject unsupported queries before durable stores or runtime discovery", async () => {
  const forbiddenCollaborator = new Proxy({}, { get() { throw new Error("invalid_query_must_not_access_collaborator"); } });
  const app = createAccountCenterServer({
    token: "test-token",
    source: null,
    challengeStore: forbiddenCollaborator as AuthChallengeStore,
    auditStore: forbiddenCollaborator as AuditStore,
    mutationRepository: forbiddenCollaborator as MutationRepository,
    accountUiPreferencesStore: forbiddenCollaborator as AccountUiPreferencesStore
  });
  const address = await app.listen();
  try {
    const hostile = "private@example.test";
    const routes: Array<[string, string]> = [
      ["/api/capabilities", "GET"], ["/api/status", "GET"], ["/api/scopes", "GET"], ["/api/agent-connections?runtime=hermes&scope=default", "GET"],
      ["/api/audit/audit_00000000-0000-4000-8000-000000000000", "GET"], ["/api/mutation-operations/op_test", "GET"],
      ["/api/auth-challenges/auth_00000000-0000-4000-8000-000000000000?runtime=hermes&scope=default", "GET"],
      ["/api/auth-challenges/auth_00000000-0000-4000-8000-000000000000/cancel", "POST"], ["/api/auth-challenges", "POST"]
    ];
    for (const [path, method] of routes) for (const query of [`${path.includes("?") ? "&" : "?"}probe=${encodeURIComponent(hostile)}`, "?"]) {
      const target = query === "?" ? `${path}?` : `${path}${query}`;
      const rejected = await bodyRequest(address.port, target, "test-token", method, hostile);
      assert.equal(rejected.status, 400, `${method} ${target}`);
      assert.deepEqual(rejected.body, { error: "invalid_query" }, `${method} ${target}`);
      assert.equal(rejected.headers["cache-control"], "no-store", `${method} ${target}`);
      assert.equal(JSON.stringify(rejected.body).includes(hostile), false, `${method} ${target}`);
    }
  } finally {
    await app.close();
  }
});

test("protected collection query matrix rejects duplicate and unknown selectors before collaborators", async () => {
  // Collection handlers own their bounded query grammars. Keep those parsers at
  // the same protected boundary as exact-route query rejection: none may reach
  // status discovery or a local store when a selector is ambiguous or unknown.
  const forbiddenCollaborator = new Proxy({}, { get() { throw new Error("invalid_collection_query_must_not_access_collaborator"); } });
  const app = createAccountCenterServer({
    token: "test-token",
    source: null,
    challengeStore: forbiddenCollaborator as AuthChallengeStore,
    auditStore: forbiddenCollaborator as AuditStore,
    mutationRepository: forbiddenCollaborator as MutationRepository,
    accountUiPreferencesStore: forbiddenCollaborator as AccountUiPreferencesStore
  });
  const address = await app.listen();
  try {
    const hostile = "private@example.test";
    const paths: Array<[string, string]> = [
      ["/api/models?runtime=hermes&runtime=openclaw", "invalid_query"],
      ["/api/limits?scope=default", "invalid_query"],
      ["/api/account-ui-preferences?runtime=hermes&scope=default&scope=default", "invalid_runtime_scope"],
      ["/api/audit?runtime=hermes&runtime=openclaw", "invalid_query"],
      ["/api/mutation-operations?scopeKind=default", "invalid_query"],
      ["/api/auth-challenges?runtime=hermes&runtime=openclaw", "invalid_query"],
      [`/api/models?probe=${encodeURIComponent(hostile)}`, "invalid_query"],
      [`/api/limits?probe=${encodeURIComponent(hostile)}`, "invalid_query"],
      [`/api/account-ui-preferences?probe=${encodeURIComponent(hostile)}`, "invalid_runtime_scope"],
      [`/api/audit?probe=${encodeURIComponent(hostile)}`, "invalid_query"],
      [`/api/mutation-operations?probe=${encodeURIComponent(hostile)}`, "invalid_query"],
      [`/api/auth-challenges?probe=${encodeURIComponent(hostile)}`, "invalid_query"]
    ];
    for (const [path, error] of paths) {
      const rejected = await request(address.port, path, "test-token");
      const body = await rejected.json();
      assert.equal(rejected.status, 400, path);
      assert.deepEqual(body, { error }, path);
      assert.equal(rejected.headers.get("cache-control"), "no-store", path);
      assert.equal(JSON.stringify(body).includes(hostile), false, path);
    }
  } finally {
    await app.close();
  }
});

test("protected GET matrix rejects request bodies before status or durable collaborators", async () => {
  // Every readable protected endpoint has one body-free representation. Prove a
  // body cannot select a weaker handler, including canonical collection/detail
  // URLs whose query parsing normally precedes runtime or durable access.
  const forbiddenCollaborator = new Proxy({}, { get() { throw new Error("read_body_must_not_access_collaborator"); } });
  const app = createAccountCenterServer({
    token: "test-token",
    source: null,
    challengeStore: forbiddenCollaborator as AuthChallengeStore,
    auditStore: forbiddenCollaborator as AuditStore,
    mutationRepository: forbiddenCollaborator as MutationRepository,
    accountUiPreferencesStore: forbiddenCollaborator as AccountUiPreferencesStore
  });
  const address = await app.listen();
  try {
    for (const path of [
      "/api/capabilities", "/api/status", "/api/scopes", "/api/agent-connections?runtime=hermes&scope=default",
      "/api/models?runtime=hermes&scope=default", "/api/limits?runtime=hermes&scope=default",
      "/api/account-ui-preferences?runtime=hermes&scope=default", "/api/audit?runtime=hermes&scopeKind=default",
      "/api/audit/audit_00000000-0000-4000-8000-000000000000?runtime=hermes&scopeKind=default",
      "/api/mutation-operations?runtime=hermes&scopeKind=default",
      "/api/mutation-operations/op_test?runtime=hermes&scopeKind=default",
      "/api/auth-challenges?runtime=hermes&scope=default",
      "/api/auth-challenges/auth_00000000-0000-4000-8000-000000000000?runtime=hermes&scope=default"
    ]) {
      const rejected = await bodyRequest(address.port, path, "test-token", "GET", "private@example.test");
      assert.equal(rejected.status, 413, path);
      assert.deepEqual(rejected.body, { error: "request_body_not_allowed" }, path);
      assert.equal(rejected.headers["cache-control"], "no-store", path);
      assert.equal(JSON.stringify(rejected.body).includes("private@example.test"), false, path);
    }
  } finally {
    await app.close();
  }
});

test("read-only model catalog is bearer-protected, versioned, and reflects disabled policy without profile metadata", async () => {
  const app = createAccountCenterServer({ token: "test-token" });
  const address = await app.listen();
  try {
    assert.equal((await request(address.port, "/api/models")).status, 401);
    const accepted = await request(address.port, "/api/models", "test-token");
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get("cache-control"), "no-store");
    const body = await accepted.json() as { schemaVersion: string; generatedAt: string; models: Array<{ id: string; selectable: boolean; reason?: string }> };
    assert.equal(body.schemaVersion, "account-center.models.v1");
    assert.match(body.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(body.models, [
      { id: "openai/gpt-4.1", selectable: false, reason: "disabled_by_policy", observedProfileCount: 0, readableProfileCount: 0, runtimeCompatibility: [], verificationState: "UNPROVEN" },
      { id: "openai/gpt-5.3-codex", selectable: true, observedProfileCount: 2, readableProfileCount: 2, runtimeCompatibility: ["codex", "hermes", "openclaw"], verificationState: "UNPROVEN" },
      { id: "openai/gpt-5.5", selectable: true, observedProfileCount: 4, readableProfileCount: 3, runtimeCompatibility: ["codex", "hermes", "openclaw"], verificationState: "UNPROVEN" }
    ]);
    assert.equal(JSON.stringify(body).match(/profileId|email|token|secret|password/i), null);
  } finally {
    await app.close();
  }
});

test("read-only model catalog separates absent selection evidence from observed catalog eligibility", async () => {
  const app = createAccountCenterServer({ token: "test-token" });
  const address = await app.listen();
  try {
    const accepted = await request(address.port, "/api/models?runtime=hermes&scope=default", "test-token");
    assert.equal(accepted.status, 200);
    const body = await accepted.json() as {
      selection: {
        requestedPolicy: { state: string };
        effectiveRuntimeModel: { state: string };
        fallbackChain: { state: string };
        verificationState: string;
      };
      models: Array<{ id: string; selectable: boolean; verificationState: string }>;
    };
    assert.deepEqual(body.selection, {
      requestedPolicy: { state: "not_reported" },
      effectiveRuntimeModel: { state: "not_reported" },
      fallbackChain: { state: "not_reported" },
      verificationState: "UNPROVEN"
    });
    assert.deepEqual(body.models.map(({ id, selectable, verificationState }) => ({ id, selectable, verificationState })), [
      { id: "openai/gpt-4.1", selectable: false, verificationState: "UNPROVEN" },
      { id: "openai/gpt-5.3-codex", selectable: true, verificationState: "UNPROVEN" },
      { id: "openai/gpt-5.5", selectable: true, verificationState: "UNPROVEN" }
    ]);
    assert.equal(JSON.stringify(body).match(/profileId|email|label|token|secret|password/i), null);
  } finally {
    await app.close();
  }
});

test("read-only limits inventory is bearer-protected, versioned, and uses redacted account references", async () => {
  const app = createAccountCenterServer({ token: "test-token" });
  const address = await app.listen();
  try {
    assert.equal((await request(address.port, "/api/limits")).status, 401);
    const accepted = await request(address.port, "/api/limits", "test-token");
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get("cache-control"), "no-store");
    const body = await accepted.json() as {
      schemaVersion: string;
      generatedAt: string;
      accounts: Array<{ accountRef: string; provider: string; health: string; authState: string; readable: boolean; windows: Array<{ name: string; remainingPct: number | null; resetsAt?: string }> }>;
    };
    assert.equal(body.schemaVersion, "account-center.limits.v1");
    assert.match(body.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(body.accounts.map(({ accountRef, provider, health, authState, readable }) => ({ accountRef, provider, health, authState, readable })), [
      { accountRef: "account-1", provider: "openai", health: "warn", authState: "ok", readable: true },
      { accountRef: "account-2", provider: "openai", health: "ok", authState: "ok", readable: true },
      { accountRef: "account-3", provider: "openai", health: "ok", authState: "ok", readable: true },
      { accountRef: "account-4", provider: "openai", health: "error", authState: "reauth-needed", readable: false }
    ]);
    assert.deepEqual(body.accounts[0]?.windows, [{ name: "weekly", remainingPct: 68 }]);
    assert.equal(JSON.stringify(body).match(/profileId|email|label|token|secret|password/i), null);
  } finally {
    await app.close();
  }
});

test("selected-runtime inventory reads are bearer-protected, bounded to compatible redacted records, and reject malformed filters", async () => {
  const app = createAccountCenterServer({ token: "test-token" });
  const address = await app.listen();
  try {
    assert.equal((await request(address.port, "/api/limits?runtime=hermes")).status, 401);
    const limits = await request(address.port, "/api/limits?runtime=hermes", "test-token");
    assert.equal(limits.status, 200);
    const limitsBody = await limits.json() as { accounts: Array<{ accountRef: string }> };
    assert.deepEqual(limitsBody.accounts.map((account) => account.accountRef), ["account-1", "account-2", "account-3"]);
    assert.equal(JSON.stringify(limitsBody).match(/profileId|email|label|token|secret|password/i), null);

    const models = await request(address.port, "/api/models?runtime=hermes", "test-token");
    assert.equal(models.status, 200);
    const modelsBody = await models.json() as { models: Array<{ id: string; observedProfileCount: number; runtimeCompatibility: string[] }> };
    assert.deepEqual(modelsBody.models.map(({ id, observedProfileCount, runtimeCompatibility }) => ({ id, observedProfileCount, runtimeCompatibility })), [
      { id: "openai/gpt-4.1", observedProfileCount: 0, runtimeCompatibility: [] },
      { id: "openai/gpt-5.3-codex", observedProfileCount: 2, runtimeCompatibility: ["hermes"] },
      { id: "openai/gpt-5.5", observedProfileCount: 3, runtimeCompatibility: ["hermes"] }
    ]);
    assert.equal(JSON.stringify(modelsBody).match(/profileId|email|label|token|secret|password/i), null);

    // A syntactically valid but unobserved runtime is not a safe selected
    // context. Reject it instead of returning a misleading empty inventory.
    for (const path of ["/api/limits?runtime=Hermes", "/api/models?runtime=hermes&runtime=openclaw", "/api/models?scope=default", "/api/limits?runtime=codex", "/api/models?runtime=codex"]) {
      const response = await request(address.port, path, "test-token");
      assert.equal(response.status, 400, path);
      assert.deepEqual(await response.json(), { error: "invalid_query" });
    }
  } finally {
    await app.close();
  }
});

test("selected default-scope inventory reads require an exact observed runtime scope", async () => {
  const app = createAccountCenterServer({ token: "test-token" });
  const address = await app.listen();
  try {
    const limits = await request(address.port, "/api/limits?runtime=hermes&scope=default", "test-token");
    assert.equal(limits.status, 200);
    assert.deepEqual((await limits.json() as { accounts: Array<{ accountRef: string }> }).accounts.map(({ accountRef }) => accountRef), ["account-1", "account-2", "account-3"]);

    const models = await request(address.port, "/api/models?runtime=hermes&scope=default", "test-token");
    assert.equal(models.status, 200);
    assert.deepEqual((await models.json() as { models: Array<{ id: string }> }).models.map(({ id }) => id), ["openai/gpt-4.1", "openai/gpt-5.3-codex", "openai/gpt-5.5"]);

    for (const path of ["/api/limits?scope=default", "/api/models?runtime=hermes&scope=agent:qa", "/api/limits?runtime=codex&scope=default", "/api/models?runtime=hermes&scope=default&scope=default"]) {
      const response = await request(address.port, path, "test-token");
      assert.equal(response.status, 400, path);
      assert.deepEqual(await response.json(), { error: "invalid_query" });
    }
  } finally {
    await app.close();
  }
});

test("protected inventories fail closed on unavailable status without reflecting adapter failures or opening challenge state", async () => {
  const hostile = "private@example.test adapter failure";
  const inventoryPaths = [
    "/api/models?runtime=hermes&scope=default",
    "/api/limits?runtime=hermes&scope=default",
    "/api/agent-connections?runtime=hermes&scope=default",
    "/api/scopes",
    "/api/auth-challenges?runtime=hermes&scope=default"
  ];
  const forbiddenChallenges = new Proxy({}, { get() { throw new Error("challenge_store_must_not_be_opened"); } }) as AuthChallengeStore;

  async function assertUnavailableInventories(source: unknown): Promise<void> {
    const app = createAccountCenterServer({ token: "test-token", source, challengeStore: forbiddenChallenges });
    const address = await app.listen();
    try {
      for (const path of inventoryPaths) {
        await assertHardenedJsonError(await request(address.port, path, "test-token"), 503, "status_unavailable", hostile);
      }
      // Parsing remains ahead of status discovery: malformed and repeated
      // selectors must retain their fixed client-error contract.
      for (const path of ["/api/models?runtime=hermes&runtime=openclaw", "/api/limits?scope=default"]) {
        await assertHardenedJsonError(await request(address.port, path, "test-token"), 400, "invalid_query", hostile);
      }
    } finally {
      await app.close();
    }
  }

  await assertUnavailableInventories(null);

  const directory = await mkdtemp(join(tmpdir(), "account-center-failed-status-"));
  const command = join(directory, "status-failure.js");
  await writeFile(command, `process.stderr.write(${JSON.stringify(hostile)}); process.exit(1);\n`);
  const previousCommand = process.env.ACCOUNT_CENTER_GENERIC_COMMAND;
  const previousArgs = process.env.ACCOUNT_CENTER_GENERIC_ARGS;
  process.env.ACCOUNT_CENTER_GENERIC_COMMAND = `${process.execPath} ${command}`;
  process.env.ACCOUNT_CENTER_GENERIC_ARGS = "";
  try {
    await assertUnavailableInventories("generic-command");
  } finally {
    if (previousCommand === undefined) delete process.env.ACCOUNT_CENTER_GENERIC_COMMAND;
    else process.env.ACCOUNT_CENTER_GENERIC_COMMAND = previousCommand;
    if (previousArgs === undefined) delete process.env.ACCOUNT_CENTER_GENERIC_ARGS;
    else process.env.ACCOUNT_CENTER_GENERIC_ARGS = previousArgs;
  }
});

test("read-only runtime scope catalog is bearer-protected, versioned, and exposes no profile metadata", async () => {
  const app = createAccountCenterServer({ token: "test-token" });
  const address = await app.listen();
  try {
    assert.equal((await request(address.port, "/api/scopes")).status, 401);
    const accepted = await request(address.port, "/api/scopes", "test-token");
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get("cache-control"), "no-store");
    const body = await accepted.json() as { schemaVersion: string; generatedAt: string; scopes: Array<Record<string, unknown>> };
    assert.equal(body.schemaVersion, "account-center.runtime-scopes.v1");
    assert.match(body.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(body.scopes, [
      { runtime: "hermes", scope: { kind: "default", id: "default" }, capabilities: { readStatus: true, mutateRoutes: false, startReauth: false, mutateModels: false } },
      { runtime: "openclaw", scope: { kind: "default", id: "default" }, capabilities: { readStatus: true, mutateRoutes: false, startReauth: false, mutateModels: false } }
    ]);
    assert.equal(JSON.stringify(body).match(/profileId|email|token|secret|password/i), null);
  } finally {
    await app.close();
  }
});

test("generic-command status cannot establish public mutation scopes for recognized runtimes", async () => {
  const hostileValues = [
    "person@example.test",
    "sk-hostile-token-value-123456789",
    "/srv/private/account-center/config.json",
    "/usr/local/bin/private-adapter --dump-config",
    "provider=private-account; routing=production",
    "window=private-weekly-limit",
    "model=private-provider/internal-model"
  ];
  const status = {
    schemaVersion: "account-center.status.v1",
    generatedAt: "/srv/private/account-center/config.json",
    noSecrets: true,
    source: "generic-command",
    providers: [{ key: "custom:person@example.test", displayName: "provider=private-account; routing=production" }],
    runtimes: [
      { key: "generic-command", displayName: "/usr/local/bin/private-adapter --dump-config", capabilities: { readStatus: true, mutateRoutes: true, startReauth: true, mutateModels: true } },
      { key: "codex", displayName: "runtime=private", capabilities: { readStatus: true, mutateRoutes: true, startReauth: true, mutateModels: true } },
      { key: "hermes", displayName: "runtime=private", capabilities: { readStatus: true, mutateRoutes: true, startReauth: true, mutateModels: true } },
      { key: "openclaw", displayName: "runtime=private", capabilities: { readStatus: true, mutateRoutes: true, startReauth: true, mutateModels: true } },
      { key: "custom:/srv/private/account-center/config.json", displayName: "runtime=private", capabilities: { readStatus: false, mutateRoutes: false, startReauth: false, mutateModels: false } }
    ],
    profiles: [{
      id: "private-profile-person@example.test",
      provider: "custom:person@example.test",
      label: "sk-hostile-token-value-123456789",
      role: "primary",
      runtimeCompatibility: ["generic-command", "custom:/srv/private/account-center/config.json"],
      models: ["model=private-provider/internal-model"],
      disabled: false,
      metadata: { config: "provider=private-account; routing=production" },
      usage: {
        profileId: "private-profile-person@example.test",
        provider: "custom:person@example.test",
        generatedAt: "/srv/private/account-center/config.json",
        readable: "yes",
        health: "adapter stderr: private failure",
        windows: [{ name: "window=private-weekly-limit", remainingPct: 101, resetsAt: "/srv/private/account-center/config.json", displayLabel: "/usr/local/bin/private-adapter --dump-config" }],
        auth: { state: "token=private" },
        warnings: ["sk-hostile-token-value-123456789"]
      }
    }],
    routes: [],
    policy: { minFiveHourRemainingPct: 0, minWeeklyRemainingPct: 0, allowBackupWhenNormalAvailable: false, disabledModels: ["model=private-provider/internal-model"], staleAfterSeconds: 60 },
    leases: [],
    reauth: [],
    audit: [],
    warnings: ["provider=private-account; routing=production"]
  } as unknown as AccountCenterStatus;
  const directory = await mkdtemp(join(tmpdir(), "account-center-hostile-status-"));
  const command = join(directory, "status.js");
  await writeFile(command, `process.stdout.write(${JSON.stringify(JSON.stringify(status))});\n`);
  const previousCommand = process.env.ACCOUNT_CENTER_GENERIC_COMMAND;
  const previousArgs = process.env.ACCOUNT_CENTER_GENERIC_ARGS;
  process.env.ACCOUNT_CENTER_GENERIC_COMMAND = `${process.execPath} ${command}`;
  process.env.ACCOUNT_CENTER_GENERIC_ARGS = "";
  const app = createAccountCenterServer({ token: "test-token", source: "generic-command" });
  const address = await app.listen();
  try {
    for (const path of ["/api/limits", "/api/models", "/api/scopes"]) {
      assert.equal((await request(address.port, path)).status, 401, path);
      const response = await request(address.port, path, "test-token");
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get("cache-control"), "no-store", path);
      const serialized = await response.text();
      for (const value of hostileValues) assert.equal(serialized.includes(value), false, `${path}: ${value}`);
      if (path === "/api/limits") assert.deepEqual(JSON.parse(serialized), {
        schemaVersion: "account-center.limits.v1",
        generatedAt: "unknown",
        accounts: [{ accountRef: "account-1", provider: "custom", health: "unknown", authState: "unknown", readable: false, windows: [] }]
      });
      if (path === "/api/models") assert.deepEqual(JSON.parse(serialized).models, []);
      if (path === "/api/scopes") assert.deepEqual(JSON.parse(serialized), {
        schemaVersion: "account-center.runtime-scopes.v1",
        generatedAt: "unknown",
        scopes: [
          { runtime: "codex", scope: { kind: "default", id: "default" }, capabilities: { readStatus: true, mutateRoutes: false, startReauth: false, mutateModels: false } },
          { runtime: "generic-command", scope: { kind: "default", id: "default" }, capabilities: { readStatus: true, mutateRoutes: false, startReauth: false, mutateModels: false } },
          { runtime: "hermes", scope: { kind: "default", id: "default" }, capabilities: { readStatus: true, mutateRoutes: false, startReauth: false, mutateModels: false } },
          { runtime: "openclaw", scope: { kind: "default", id: "default" }, capabilities: { readStatus: true, mutateRoutes: false, startReauth: false, mutateModels: false } }
        ]
      });
    }
    // A syntactically safe adapter key is still private implementation detail,
    // not an authoritative runtime/scope selector. Every protected public
    // consumer rejects it rather than exposing an empty or cross-context view.
    for (const path of [
      "/api/limits?runtime=custom%3Aprivate-adapter",
      "/api/models?runtime=custom%3Aprivate-adapter&scope=default",
      "/api/auth-challenges?runtime=custom%3Aprivate-adapter&scope=default",
      "/api/audit?runtime=custom%3Aprivate-adapter&scopeKind=default",
      "/api/mutation-operations?runtime=custom%3Aprivate-adapter&scopeKind=default"
    ]) {
      const response = await request(address.port, path, "test-token");
      assert.equal(response.status, 400, path);
      assert.deepEqual(await response.json(), { error: "invalid_query" }, path);
    }
  } finally {
    await app.close();
    if (previousCommand === undefined) delete process.env.ACCOUNT_CENTER_GENERIC_COMMAND;
    else process.env.ACCOUNT_CENTER_GENERIC_COMMAND = previousCommand;
    if (previousArgs === undefined) delete process.env.ACCOUNT_CENTER_GENERIC_ARGS;
    else process.env.ACCOUNT_CENTER_GENERIC_ARGS = previousArgs;
  }
});

test("agent capability contract is bearer-protected, redacted, and explicit about unavailable mutations", async () => {
  const app = createAccountCenterServer({ token: "test-token" });
  const address = await app.listen();
  try {
    assert.equal((await request(address.port, "/api/capabilities")).status, 401);
    const accepted = await request(address.port, "/api/capabilities", "test-token");
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get("cache-control"), "no-store");
    const body = await accepted.json() as { schemaVersion: string; target: string; actions: Array<{ id: string; mode: string; state: string; requires: string[]; endpoint?: { method: string; path: string }; reason?: string }> };
    assert.equal(body.schemaVersion, "account-center.agent-capabilities.v1");
    assert.equal(body.target, "account-center");
    assert.deepEqual(body.actions.find((action) => action.id === "capabilities.list"), { id: "capabilities.list", mode: "read", state: "available", endpoint: { method: "GET", path: "/api/capabilities" }, requires: ["bearer_token"] });
    assert.deepEqual(body.actions.find((action) => action.id === "status"), { id: "status", mode: "read", state: "available", endpoint: { method: "GET", path: "/api/status" }, requires: ["bearer_token"] });
    assert.deepEqual(body.actions.find((action) => action.id === "limits.list"), { id: "limits.list", mode: "read", state: "available", endpoint: { method: "GET", path: "/api/limits" }, requires: ["bearer_token"] });
    assert.deepEqual(body.actions.find((action) => action.id === "models.list"), { id: "models.list", mode: "read", state: "available", endpoint: { method: "GET", path: "/api/models" }, requires: ["bearer_token"] });
    assert.deepEqual(body.actions.find((action) => action.id === "runtime_scopes.list"), { id: "runtime_scopes.list", mode: "read", state: "available", endpoint: { method: "GET", path: "/api/scopes" }, requires: ["bearer_token"] });
    assert.deepEqual(body.actions.find((action) => action.id === "account_ui_preferences.mutate"), { id: "account_ui_preferences.mutate", mode: "mutation", state: "blocked", reason: "account_ui_preferences_store_unavailable", requires: ["bearer_token", "same_origin", "explicit_runtime_scope", "durable_account_ui_preferences_store"] });
    assert.deepEqual(body.actions.find((action) => action.id === "auth_challenges.list"), { id: "auth_challenges.list", mode: "read", state: "blocked", reason: "durable_challenge_store_unavailable", requires: ["bearer_token", "explicit_runtime_scope", "durable_challenge_store"] });
    assert.deepEqual(body.actions.find((action) => action.id === "auth_challenges.detail"), { id: "auth_challenges.detail", mode: "read", state: "blocked", reason: "durable_challenge_store_unavailable", requires: ["bearer_token", "opaque_challenge_id", "explicit_runtime_scope", "durable_challenge_store"] });
    assert.deepEqual(body.actions.find((action) => action.id === "auth_challenges.start"), { id: "auth_challenges.start", mode: "mutation", state: "blocked", reason: "durable_challenge_store_unavailable", requires: ["bearer_token", "same_origin", "explicit_runtime_scope", "email_target", "durable_challenge_store"] });
    assert.deepEqual(body.actions.find((action) => action.id === "auth_challenges.cancel"), {
      id: "auth_challenges.cancel",
      mode: "mutation",
      state: "blocked",
      reason: "durable_challenge_store_unavailable",
      requires: ["bearer_token", "same_origin", "opaque_challenge_id", "explicit_runtime_scope", "durable_challenge_store", "durable_audit_store"]
    });
    assert.deepEqual(body.actions.find((action) => action.id === "audit.history"), { id: "audit.history", mode: "read", state: "blocked", reason: "durable_audit_store_unavailable", requires: ["bearer_token", "durable_audit_store"] });
    assert.deepEqual(body.actions.find((action) => action.id === "audit.detail"), { id: "audit.detail", mode: "read", state: "blocked", reason: "durable_audit_store_unavailable", requires: ["bearer_token", "opaque_audit_id", "explicit_runtime_scope", "durable_audit_store"] });
    assert.deepEqual(body.actions.find((action) => action.id === "mutation_operations.history"), { id: "mutation_operations.history", mode: "read", state: "blocked", reason: "mutation_repository_unavailable", requires: ["bearer_token", "mutation_repository"] });
    assert.deepEqual(body.actions.find((action) => action.id === "mutation_operations.detail"), { id: "mutation_operations.detail", mode: "read", state: "blocked", reason: "mutation_repository_unavailable", requires: ["bearer_token", "opaque_operation_id", "explicit_runtime_scope", "mutation_repository"] });
    assert.deepEqual(body.actions.find((action) => action.id === "account.delete"), {
      id: "account.delete",
      mode: "mutation",
      state: "blocked",
      reason: "account_center_cli_review_confirmation_required",
      requires: ["bearer_token", "exact_connected_target", "owned_exact_account_transaction", "explicit_confirmation", "idempotency_key", "verified_opaque_receipt"]
    });
    assert.deepEqual(body.actions.find((action) => action.id === "guided_auth"), {
      id: "guided_auth",
      mode: "mutation",
      state: "blocked",
      reason: "durable_challenge_store_unavailable",
      requires: ["bearer_token", "same_origin", "explicit_runtime_scope", "email_target", "durable_challenge_store"]
    });
    assert.deepEqual(body.actions.find((action) => action.id === "routes"), {
      id: "routes",
      mode: "mutation",
      state: "UNPROVEN",
      reason: "protected_route_contract_missing_scoped_review_idempotency_runtime_proof",
      requires: ["bearer_token", "explicit_runtime_scope", "dry_run", "explicit_confirmation", "idempotency_key"]
    });
    assert.deepEqual(body.actions.find((action) => action.id === "models"), {
      id: "models",
      mode: "mutation",
      state: "UNPROVEN",
      reason: "protected_model_contract_missing_scoped_review_idempotency_runtime_proof",
      requires: ["bearer_token", "explicit_runtime_scope", "dry_run", "explicit_confirmation", "idempotency_key"]
    });
    assert.deepEqual(body.actions.find((action) => action.id === "updates"), {
      id: "updates",
      mode: "mutation",
      state: "blocked",
      reason: "macos_signed_artifact_package_supervisor_backup_restart_health_proof_missing",
      requires: ["bearer_token", "verified_release", "backup", "narrow_supervisor", "health_proof"]
    });
    assert.equal(JSON.stringify(body).match(/secret|password|accessToken|refreshToken/i), null);
  } finally {
    await app.close();
  }
});

test("capability discovery fails closed on unavailable authority before constructing a manifest or opening durable collaborators", async () => {
  // The hostile source would previously return a 200 manifest based only on
  // store presence. Throwing collaborators ensure the unavailable-authority
  // response cannot inspect durable state while redacting source diagnostics.
  const hostileSource = "/srv/private/account-center/adapter --source=production";
  const forbiddenCollaborator = new Proxy({}, { get() { throw new Error("capabilities_must_not_open_durable_collaborator"); } });
  const app = createAccountCenterServer({
    token: "test-token",
    source: hostileSource,
    challengeStore: forbiddenCollaborator as AuthChallengeStore,
    auditStore: forbiddenCollaborator as AuditStore,
    mutationRepository: forbiddenCollaborator as MutationRepository,
    accountUiPreferencesStore: forbiddenCollaborator as AccountUiPreferencesStore
  });
  const address = await app.listen();
  try {
    await assertHardenedJsonError(await request(address.port, "/api/capabilities", "test-token"), 503, "status_unavailable", hostileSource);
  } finally {
    await app.close();
  }
});

test("capability discovery uses the same fixed unavailable contract for absent, non-zero, and unusable authority", async () => {
  for (const [source, hostileText] of [[null, "null"], [undefined, "undefined"]] as const) {
    const app = createAccountCenterServer({ token: "test-token", source });
    const address = await app.listen();
    try {
      await assertHardenedJsonError(await request(address.port, "/api/capabilities", "test-token"), 503, "status_unavailable", hostileText);
    } finally {
      await app.close();
    }
  }

  const previousCommand = process.env.ACCOUNT_CENTER_GENERIC_COMMAND;
  const previousArgs = process.env.ACCOUNT_CENTER_GENERIC_ARGS;
  process.env.ACCOUNT_CENTER_GENERIC_COMMAND = process.execPath;
  try {
    let app = createAccountCenterServer({ token: "test-token", source: "generic-command" });
    let address = await app.listen();
    try {
      await assertHardenedJsonError(await request(address.port, "/api/capabilities", "test-token"), 503, "status_unavailable", "--json");
    } finally {
      await app.close();
    }
    process.env.ACCOUNT_CENTER_GENERIC_ARGS = "-e \"process.stdout.write('{}')\"";
    app = createAccountCenterServer({ token: "test-token", source: "generic-command" });
    address = await app.listen();
    try {
      await assertHardenedJsonError(await request(address.port, "/api/capabilities", "test-token"), 503, "status_unavailable", "{} ");
    } finally {
      await app.close();
    }
  } finally {
    if (previousCommand === undefined) delete process.env.ACCOUNT_CENTER_GENERIC_COMMAND;
    else process.env.ACCOUNT_CENTER_GENERIC_COMMAND = previousCommand;
    if (previousArgs === undefined) delete process.env.ACCOUNT_CENTER_GENERIC_ARGS;
    else process.env.ACCOUNT_CENTER_GENERIC_ARGS = previousArgs;
  }
});

test("unavailable protected local stores fail closed before runtime discovery and never look like empty history", async () => {
  // An explicit invalid source would produce an internal error if the
  // challenge inventory reached runtime discovery. Its 503 therefore proves
  // unavailable durable state is rejected first.
  const app = createAccountCenterServer({ token: "test-token", source: undefined });
  const address = await app.listen();
  try {
    const hostileText = "private@example.test";
    for (const [path, error] of [
      ["/api/auth-challenges?runtime=hermes&scope=default", "auth_challenges_unavailable"],
      ["/api/auth-challenges/auth_123e4567-e89b-12d3-a456-426614174000?runtime=hermes&scope=default", "auth_challenges_unavailable"],
      ["/api/audit", "audit_unavailable"],
      ["/api/audit/audit_123e4567-e89b-12d3-a456-426614174000?runtime=hermes&scopeKind=default", "audit_unavailable"],
      ["/api/mutation-operations", "mutation_operations_unavailable"],
      ["/api/mutation-operations/op_private_example?runtime=hermes&scopeKind=default", "mutation_operations_unavailable"]
    ]) await assertHardenedJsonError(await request(address.port, path, "test-token"), 503, error, hostileText);
    await assertHardenedJsonError(await fetch(`http://127.0.0.1:${address.port}/api/auth-challenges/auth_123e4567-e89b-12d3-a456-426614174000/cancel?runtime=hermes&scope=default`, {
      method: "POST", headers: { authorization: "Bearer test-token", origin: `http://127.0.0.1:${address.port}` }
    }), 503, "auth_challenges_unavailable", hostileText);
  } finally {
    await app.close();
  }

  const root = await mkdtemp(join(tmpdir(), "account-center-unavailable-audit-"));
  const auditUnavailableApp = createAccountCenterServer({ token: "test-token", source: undefined, challengeStore: new AuthChallengeStore(join(root, "auth-challenges.json")) });
  const auditUnavailableAddress = await auditUnavailableApp.listen();
  try {
    await assertHardenedJsonError(await fetch(`http://127.0.0.1:${auditUnavailableAddress.port}/api/auth-challenges/auth_123e4567-e89b-12d3-a456-426614174000/cancel?runtime=hermes&scope=default`, {
      method: "POST", headers: { authorization: "Bearer test-token", origin: `http://127.0.0.1:${auditUnavailableAddress.port}` }
    }), 503, "audit_unavailable", "private@example.test");
  } finally {
    await auditUnavailableApp.close();
  }
});

test("selected protected histories require the observed exact default scope before durable history access", async () => {
  // `codex` is a valid public selector but is absent from the fixture status.
  // Throwing collaborators prove a stale selected context cannot become an
  // authoritative-looking empty history.
  const forbiddenCollaborator = new Proxy({}, { get() { throw new Error("unobserved_runtime_must_not_access_history"); } });
  const app = createAccountCenterServer({
    token: "test-token",
    source: "fixture",
    auditStore: forbiddenCollaborator as AuditStore,
    mutationRepository: forbiddenCollaborator as MutationRepository
  });
  const address = await app.listen();
  try {
    for (const path of ["/api/audit?runtime=codex&scopeKind=default", "/api/mutation-operations?runtime=codex&scopeKind=default"]) {
      await assertHardenedJsonError(await request(address.port, path, "test-token"), 400, "unknown_runtime_scope", "codex");
    }
  } finally {
    await app.close();
  }
});

test("selected protected histories match durable detail 503 status-unavailable semantics before durable access", async () => {
  const forbiddenCollaborator = new Proxy({}, { get() { throw new Error("unavailable_status_must_not_access_history"); } });
  const app = createAccountCenterServer({
    token: "test-token",
    source: null,
    auditStore: forbiddenCollaborator as AuditStore,
    mutationRepository: forbiddenCollaborator as MutationRepository
  });
  const address = await app.listen();
  try {
    for (const path of ["/api/audit?runtime=hermes&scopeKind=default", "/api/mutation-operations?runtime=hermes&scopeKind=default"]) {
      await assertHardenedJsonError(await request(address.port, path, "test-token"), 503, "status_unavailable", "hermes");
    }
  } finally {
    await app.close();
  }
});

test("unsupported selected history scopes reject before status or durable collaborators", async () => {
  const hostile = "agent:private@example.test%0A";
  const forbiddenCollaborator = new Proxy({}, { get() { throw new Error("selected_history_must_not_open_collaborator"); } });
  const app = createAccountCenterServer({
    token: "test-token",
    source: null,
    auditStore: forbiddenCollaborator as AuditStore,
    mutationRepository: forbiddenCollaborator as MutationRepository
  });
  const address = await app.listen();
  try {
    for (const path of [
      "/api/audit?runtime=hermes",
      "/api/mutation-operations?runtime=hermes",
      "/api/audit?scopeKind=default",
      "/api/mutation-operations?scopeKind=default",
      "/api/audit?runtime=hermes&scopeKind=agent",
      "/api/mutation-operations?runtime=hermes&scopeKind=profile",
      "/api/audit?runtime=hermes&scopeKind=session",
      "/api/mutation-operations?runtime=hermes&scopeKind=all",
      `/api/audit?runtime=hermes&scopeKind=${hostile}`,
      `/api/mutation-operations?runtime=hermes&scopeKind=${hostile}`
    ]) await assertHardenedJsonError(await request(address.port, path, "test-token"), 400, "invalid_query", "private@example.test");
  } finally {
    await app.close();
  }
});

test("account preference contexts fail closed before local preference access", async () => {
  // The store throws on either read or write. This proves neither a stale
  // selected context nor unavailable authority can inspect or mutate owner-only
  // preference state; the POST bodies also contain text that must not reflect.
  const forbiddenPreferences = new Proxy({}, { get() { throw new Error("preference_state_must_not_be_accessed"); } }) as AccountUiPreferencesStore;
  const preferenceRequests = (port: number, runtime: string) => [
    request(port, `/api/account-ui-preferences?runtime=${runtime}&scope=default`, "test-token"),
    fetch(`http://127.0.0.1:${port}/api/account-ui-preferences?runtime=${runtime}&scope=default`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", origin: `http://127.0.0.1:${port}`, "content-type": "application/json" },
      body: JSON.stringify({ accountRef: "private@example.test", state: "hidden" })
    })
  ];
  const unobservedApp = createAccountCenterServer({ token: "test-token", source: "fixture", accountUiPreferencesStore: forbiddenPreferences });
  const unobservedAddress = await unobservedApp.listen();
  try {
    for (const response of preferenceRequests(unobservedAddress.port, "codex")) {
      await assertHardenedJsonError(await response, 400, "unknown_runtime_scope", "private@example.test");
    }
  } finally {
    await unobservedApp.close();
  }

  async function assertUnavailablePreferences(source: unknown): Promise<void> {
    const unavailableApp = createAccountCenterServer({ token: "test-token", source, accountUiPreferencesStore: forbiddenPreferences });
    const unavailableAddress = await unavailableApp.listen();
    try {
      // Hermes is observed in the fixture, so only unavailable authority—not an
      // unobserved selector—can explain this fixed fail-closed response.
      for (const response of preferenceRequests(unavailableAddress.port, "hermes")) {
        await assertHardenedJsonError(await response, 503, "status_unavailable", "private@example.test");
      }
    } finally {
      await unavailableApp.close();
    }
  }

  // Explicit null and undefined both reject adapter construction; neither may
  // turn a protected preference read or update into durable collaborator work.
  await assertUnavailablePreferences(null);
  await assertUnavailablePreferences(undefined);

  const directory = await mkdtemp(join(tmpdir(), "account-center-failed-preference-status-"));
  const command = join(directory, "status-failure.js");
  const hostileDiagnostic = "adapter-private@example.test";
  await writeFile(command, `process.stderr.write(${JSON.stringify(hostileDiagnostic)}); process.exit(1);\n`);
  const previousCommand = process.env.ACCOUNT_CENTER_GENERIC_COMMAND;
  const previousArgs = process.env.ACCOUNT_CENTER_GENERIC_ARGS;
  process.env.ACCOUNT_CENTER_GENERIC_COMMAND = `${process.execPath} ${command}`;
  process.env.ACCOUNT_CENTER_GENERIC_ARGS = "";
  try {
    await assertUnavailablePreferences("generic-command");
    // Invoke Node directly for the zero-exit case: its only output is an
    // unusable object, so this is distinct from the preceding non-zero command.
    process.env.ACCOUNT_CENTER_GENERIC_COMMAND = process.execPath;
    process.env.ACCOUNT_CENTER_GENERIC_ARGS = "-e \"process.stdout.write('{}')\"";
    await assertUnavailablePreferences("generic-command");
  } finally {
    if (previousCommand === undefined) delete process.env.ACCOUNT_CENTER_GENERIC_COMMAND;
    else process.env.ACCOUNT_CENTER_GENERIC_COMMAND = previousCommand;
    if (previousArgs === undefined) delete process.env.ACCOUNT_CENTER_GENERIC_ARGS;
    else process.env.ACCOUNT_CENTER_GENERIC_ARGS = previousArgs;
  }
});

test("guided-auth creation rejects an unavailable challenge store before runtime discovery", async () => {
  const hostileText = "private@example.test";
  // An explicit invalid source makes accidental status discovery observable as
  // a different response. The missing durable dependency must win instead.
  const app = createAccountCenterServer({ token: "test-token", source: null });
  const address = await app.listen();
  try {
    await assertHardenedJsonError(await rawChallengeRequest(address.port, {
      token: "test-token",
      origin: `http://127.0.0.1:${address.port}`,
      contentType: "application/json",
      body: JSON.stringify({ provider: "openai", runtime: "openclaw", scope: "default", mode: "add", target: hostileText })
    }), 503, "challenge_store_unavailable", hostileText);
  } finally {
    await app.close();
  }
});

test("guided-auth creation fails closed on unavailable status before opening challenge state", async () => {
  const hostile = "private@example.test";
  const adapterFailure = "adapter failure";
  const forbiddenChallenges = new Proxy({}, { get() { throw new Error("challenge_store_must_not_be_opened"); } }) as AuthChallengeStore;
  // Keep the request semantically valid: the status boundary, not lifecycle
  // validation, must determine this result.
  const validBody = JSON.stringify({ mode: "add", provider: "openai", runtime: "openclaw", scope: "default", target: hostile });

  async function assertUnavailableStart(source: unknown): Promise<void> {
    const app = createAccountCenterServer({ token: "test-token", source, challengeStore: forbiddenChallenges });
    const address = await app.listen();
    try {
      await assertHardenedJsonError(await rawChallengeRequest(address.port, {
        token: "test-token", origin: `http://127.0.0.1:${address.port}`, contentType: "application/json", body: validBody
      }), 503, "status_unavailable", hostile);
    } finally {
      await app.close();
    }
  }

  await assertUnavailableStart(null);

  const directory = await mkdtemp(join(tmpdir(), "account-center-failed-start-status-"));
  const command = join(directory, "status-failure.js");
  await writeFile(command, `process.stderr.write(${JSON.stringify(adapterFailure)}); process.exit(1);\n`);
  const previousCommand = process.env.ACCOUNT_CENTER_GENERIC_COMMAND;
  const previousArgs = process.env.ACCOUNT_CENTER_GENERIC_ARGS;
  process.env.ACCOUNT_CENTER_GENERIC_COMMAND = `${process.execPath} ${command}`;
  process.env.ACCOUNT_CENTER_GENERIC_ARGS = "";
  try {
    await assertUnavailableStart("generic-command");
  } finally {
    if (previousCommand === undefined) delete process.env.ACCOUNT_CENTER_GENERIC_COMMAND;
    else process.env.ACCOUNT_CENTER_GENERIC_COMMAND = previousCommand;
    if (previousArgs === undefined) delete process.env.ACCOUNT_CENTER_GENERIC_ARGS;
    else process.env.ACCOUNT_CENTER_GENERIC_ARGS = previousArgs;
  }
});

test("audit history is bearer-protected, bounded, and redacted", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  const auditStore = new AuditStore(join(root, "audit.json"));
  await auditStore.append({
    action: "route.use",
    outcome: "blocked",
    proofState: "unproven",
    requestDigest: "request-digest",
    summary: "Route update for private@example.test was blocked.",
    warnings: ["no_live_mutation"]
  });
  const app = createAccountCenterServer({ token: "test-token", auditStore });
  const address = await app.listen();
  try {
    assert.equal((await request(address.port, "/api/audit")).status, 401);
    const accepted = await request(address.port, "/api/audit", "test-token");
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get("cache-control"), "no-store");
    const body = await accepted.json() as { schemaVersion: string; generatedAt: string; records: Array<Record<string, unknown>> };
    assert.equal(body.schemaVersion, "account-center.audit-history.v1");
    assert.match(body.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(body.records.length, 1);
    assert.deepEqual(Object.keys(body.records[0]).sort(), ["action", "createdAt", "id", "outcome", "proofState", "summary", "warnings"]);
    assert.equal(JSON.stringify(body).includes("private@example.test"), false);
    assert.equal(JSON.stringify(body).includes("request-digest"), false);
  } finally {
    await app.close();
  }
});

test("audit evidence detail is bearer-protected, redacted, and does not expose request digests", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  const auditStore = new AuditStore(join(root, "audit.json"));
  const record = await auditStore.append({
    action: "route.use",
    outcome: "blocked",
    proofState: "unproven",
    requestDigest: "sensitive-request-digest",
    summary: "Route update for private@example.test was blocked.",
    warnings: ["no_live_mutation"],
    runtime: "openclaw",
    scopeKind: "default"
  });
  const app = createAccountCenterServer({ token: "test-token", auditStore });
  const address = await app.listen();
  const path = `/api/audit/${record.id}?runtime=openclaw&scopeKind=default`;
  try {
    assert.equal((await request(address.port, path)).status, 401);
    const accepted = await request(address.port, path, "test-token");
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get("cache-control"), "no-store");
    const body = await accepted.json() as { schemaVersion: string; generatedAt: string; record: Record<string, unknown> };
    assert.equal(body.schemaVersion, "account-center.audit-record.v1");
    assert.match(body.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(body.record, {
      id: record.id,
      createdAt: record.createdAt,
      action: "route.use",
      outcome: "blocked",
      proofState: "unproven",
      summary: "Route update for [REDACTED_EMAIL] was blocked.",
      warnings: ["no_live_mutation"],
      runtime: "openclaw",
      scopeKind: "default"
    });
    assert.equal(JSON.stringify(body).match(/private@example\.test|sensitive-request-digest/), null);

    const wrongMethod = await fetch(`http://127.0.0.1:${address.port}${path}`, { method: "POST", headers: { authorization: "Bearer test-token" } });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "GET");
    const missing = await request(address.port, "/api/audit/audit_00000000-0000-4000-8000-000000000000?runtime=openclaw&scopeKind=default", "test-token");
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "not_found" });
  } finally {
    await app.close();
  }
});

test("audit history supports bounded outcome filtering without accepting malformed query input", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  const auditStore = new AuditStore(join(root, "audit.json"));
  await auditStore.append({ action: "route.use", outcome: "blocked", proofState: "unproven", requestDigest: "a".repeat(64), summary: "Blocked for private@example.test", warnings: [] });
  await auditStore.append({ action: "route.use", outcome: "dry_run", proofState: "not_applicable", requestDigest: "b".repeat(64), summary: "Preview for private@example.test", warnings: [] });
  await auditStore.append({ action: "guided_auth.cancel", outcome: "blocked", proofState: "verified", requestDigest: "c".repeat(64), summary: "Cancelled private@example.test", warnings: [] });
  const app = createAccountCenterServer({ token: "test-token", auditStore });
  const address = await app.listen();
  try {
    const filtered = await request(address.port, "/api/audit?outcome=blocked&limit=1", "test-token");
    assert.equal(filtered.status, 200);
    const body = await filtered.json() as { schemaVersion: string; records: Array<{ action: string; outcome: string; summary: string }> };
    assert.equal(body.schemaVersion, "account-center.audit-history.v1");
    assert.deepEqual(body.records.map(({ action, outcome }) => ({ action, outcome })), [{ action: "guided_auth.cancel", outcome: "blocked" }]);
    assert.equal(JSON.stringify(body).includes("private@example.test"), false);

    const malformed = await request(address.port, "/api/audit?limit=101", "test-token");
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: "invalid_query" });
  } finally {
    await app.close();
  }
});

test("audit history supports bounded UTC calendar-date filters without accepting malformed dates", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  const auditStore = new AuditStore(join(root, "audit.json"));
  await auditStore.append({ action: "route.use", outcome: "blocked", proofState: "unproven", requestDigest: "d".repeat(64), summary: "Blocked for private@example.test", warnings: [] });
  const app = createAccountCenterServer({ token: "test-token", auditStore });
  const address = await app.listen();
  try {
    const today = new Date().toISOString().slice(0, 10);
    const accepted = await request(address.port, `/api/audit?from=${today}&to=${today}`, "test-token");
    assert.equal(accepted.status, 200);
    const body = await accepted.json() as { records: Array<{ action: string }> };
    assert.deepEqual(body.records.map(({ action }) => action), ["route.use"]);

    for (const path of ["/api/audit?from=2026-7-1", "/api/audit?to=2026-02-30", "/api/audit?from=2026-07-02&to=2026-07-01", "/api/audit?from=2026-07-01&from=2026-07-01"]) {
      const malformed = await request(address.port, path, "test-token");
      assert.equal(malformed.status, 400, path);
      assert.deepEqual(await malformed.json(), { error: "invalid_query" });
    }
  } finally {
    await app.close();
  }
});

test("audit history filters an exact safe action category without broadening the response", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  const auditStore = new AuditStore(join(root, "audit.json"));
  await auditStore.append({ action: "route.use", outcome: "blocked", proofState: "unproven", requestDigest: "a".repeat(64), summary: "Route action for private@example.test", warnings: [] });
  await auditStore.append({ action: "guided_auth.cancel", outcome: "applied", proofState: "verified", requestDigest: "b".repeat(64), summary: "Guided-auth action for private@example.test", warnings: [] });
  await auditStore.append({ action: "route.use.private@example.test", outcome: "blocked", proofState: "unproven", requestDigest: "c".repeat(64), summary: "Legacy unsafe action for private@example.test", warnings: [] });
  const app = createAccountCenterServer({ token: "test-token", auditStore });
  const address = await app.listen();
  try {
    const filtered = await request(address.port, "/api/audit?action=route.use", "test-token");
    assert.equal(filtered.status, 200);
    const body = await filtered.json() as { records: Array<{ action: string; summary: string }> };
    assert.deepEqual(body.records.map(({ action }) => action), ["route.use"]);
    assert.equal(JSON.stringify(body).includes("private@example.test"), false);

    const all = await request(address.port, "/api/audit", "test-token");
    assert.equal(all.status, 200);
    const allBody = await all.json() as { records: Array<{ action: string }> };
    assert.deepEqual(allBody.records.map(({ action }) => action), ["action_redacted", "guided_auth.cancel", "route.use"]);
    assert.equal(JSON.stringify(allBody).includes("private@example.test"), false);

    const malformed = await request(address.port, "/api/audit?action=route%20use", "test-token");
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: "invalid_query" });
  } finally {
    await app.close();
  }
});

test("audit history filters the observed exact default runtime context without exposing scope identifiers", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  const auditStore = new AuditStore(join(root, "audit.json"));
  await auditStore.append({ action: "route.use", outcome: "blocked", proofState: "unproven", requestDigest: "a".repeat(64), summary: "OpenClaw route change for private@example.test", warnings: [], runtime: "openclaw", scopeKind: "default" });
  await auditStore.append({ action: "model.use", outcome: "unproven", proofState: "unproven", requestDigest: "b".repeat(64), summary: "Hermes model change for private@example.test", warnings: [], runtime: "hermes", scopeKind: "default" });
  const app = createAccountCenterServer({ token: "test-token", auditStore });
  const address = await app.listen();
  try {
    const filtered = await request(address.port, "/api/audit?runtime=openclaw&scopeKind=default", "test-token");
    assert.equal(filtered.status, 200);
    const body = await filtered.json() as { records: Array<{ id: string; createdAt: string; action: string; runtime?: string; scopeKind?: string }> };
    assert.deepEqual(body.records, [{
      id: body.records[0]?.id,
      createdAt: body.records[0] && (body.records[0] as { createdAt?: string }).createdAt,
      action: "route.use",
      outcome: "blocked",
      proofState: "unproven",
      summary: "OpenClaw route change for [REDACTED_EMAIL]",
      warnings: [],
      runtime: "openclaw",
      scopeKind: "default"
    }]);
    assert.equal(JSON.stringify(body).match(/private@example\.test|[ab]{64}/), null);

    for (const path of ["/api/audit?runtime=OpenClaw", "/api/audit?scopeKind=agent", "/api/audit?runtime=openclaw&scopeKind=bogus", "/api/audit?runtime=openclaw&runtime=hermes"]) {
      const malformed = await request(address.port, path, "test-token");
      assert.equal(malformed.status, 400, path);
      assert.deepEqual(await malformed.json(), { error: "invalid_query" });
    }
  } finally {
    await app.close();
  }
});

test("audit history exposes a bounded opaque-cursor page without leaking request digests", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  const auditStore = new AuditStore(join(root, "audit.json"));
  await auditStore.append({ action: "route.use", outcome: "blocked", proofState: "unproven", requestDigest: "a".repeat(64), summary: "First private@example.test event", warnings: [] });
  await auditStore.append({ action: "route.use", outcome: "dry_run", proofState: "not_applicable", requestDigest: "b".repeat(64), summary: "Second private@example.test event", warnings: [] });
  await auditStore.append({ action: "guided_auth.cancel", outcome: "blocked", proofState: "verified", requestDigest: "c".repeat(64), summary: "Third private@example.test event", warnings: [] });
  const app = createAccountCenterServer({ token: "test-token", auditStore });
  const address = await app.listen();
  try {
    const first = await request(address.port, "/api/audit?limit=2", "test-token");
    assert.equal(first.status, 200);
    const firstBody = await first.json() as { records: Array<{ summary: string }>; nextCursor?: string };
    assert.deepEqual(firstBody.records.map((record) => record.summary), ["Third [REDACTED_EMAIL] event", "Second [REDACTED_EMAIL] event"]);
    assert.match(firstBody.nextCursor ?? "", /^audit_[a-f0-9-]{36}$/);

    const second = await request(address.port, `/api/audit?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor ?? "")}`, "test-token");
    assert.equal(second.status, 200);
    const secondBody = await second.json() as { records: Array<{ summary: string }>; nextCursor?: string };
    assert.deepEqual(secondBody.records.map((record) => record.summary), ["First [REDACTED_EMAIL] event"]);
    assert.equal(secondBody.nextCursor, undefined);
    assert.equal(JSON.stringify([firstBody, secondBody]).match(/[abc]{64}|private@example\\.test/), null);

    const malformed = await request(address.port, "/api/audit?cursor=not-an-audit-id", "test-token");
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: "invalid_query" });
  } finally {
    await app.close();
  }
});

test("mutation operation history is bearer-protected and exposes only redacted terminal evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  const repository = new MutationRepository(join(root, "mutations"), { operationId: () => "op_test" });
  const claim = await repository.claim({
    idempotencyKey: "s3ZMdvUKp3wnaAq8EKUla9B1",
    requestDigest: "a".repeat(64),
    audit: { action: "route.use", provider: "openai", runtime: "openclaw", scopeKind: "agent", scopeIdDigest: "b".repeat(64), targetDigest: "c".repeat(64) }
  });
  if (claim.kind !== "execute") throw new Error("expected executable test operation");
  await repository.complete({ operationId: claim.operationId, outcome: "blocked", warningCodes: ["runtime_unavailable"] });
  const app = createAccountCenterServer({ token: "test-token", mutationRepository: repository });
  const address = await app.listen();
  try {
    assert.equal((await request(address.port, "/api/mutation-operations")).status, 401);
    const accepted = await request(address.port, "/api/mutation-operations", "test-token");
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get("cache-control"), "no-store");
    const body = await accepted.json() as { schemaVersion: string; operations: Array<Record<string, unknown>> };
    assert.equal(body.schemaVersion, "account-center.mutation-operations.v1");
    assert.deepEqual(body.operations, [{
      operationId: "op_test", state: "completed", outcome: "blocked", createdAt: body.operations[0]?.createdAt,
      completedAt: body.operations[0]?.completedAt,
      audit: { action: "route.use", provider: "openai", runtime: "openclaw", scopeKind: "agent", warningCodes: ["runtime_unavailable"] }
    }]);
    assert.equal(JSON.stringify(body).match(/[abc]{64}|s3ZMdvUKp3wnaAq8EKUla9B1/), null);
  } finally {
    await app.close();
  }
});

test("an empty protected operation history exposes an explicit terminal cursor", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  const repository = new MutationRepository(join(root, "mutations"));
  const app = createAccountCenterServer({ token: "test-token", mutationRepository: repository });
  const address = await app.listen();
  try {
    const accepted = await request(address.port, "/api/mutation-operations", "test-token");
    assert.equal(accepted.status, 200);
    const body = await accepted.json() as { operations: Array<Record<string, unknown>>; nextCursor: string | null };
    assert.deepEqual(body.operations, []);
    assert.equal(body.nextCursor, null);
  } finally {
    await app.close();
  }
});

test("protected operation detail is bearer-protected, redacted, and does not expose receipt digests", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  const repository = new MutationRepository(join(root, "mutations"), { operationId: () => "op_detail" });
  const claim = await repository.claim({
    idempotencyKey: "detail-idempotency-key-0000",
    requestDigest: "a".repeat(64),
    audit: { action: "route.use", provider: "openai", runtime: "openclaw", scopeKind: "default", scopeIdDigest: "b".repeat(64), targetDigest: "c".repeat(64) }
  });
  if (claim.kind !== "execute") throw new Error("expected executable test operation");
  await repository.complete({ operationId: claim.operationId, outcome: "blocked", warningCodes: ["runtime_unavailable"] });
  const app = createAccountCenterServer({ token: "test-token", mutationRepository: repository });
  const address = await app.listen();
  try {
    assert.equal((await request(address.port, "/api/mutation-operations/op_detail?runtime=openclaw&scopeKind=default")).status, 401);
    const accepted = await request(address.port, "/api/mutation-operations/op_detail?runtime=openclaw&scopeKind=default", "test-token");
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get("cache-control"), "no-store");
    const body = await accepted.json() as { schemaVersion: string; generatedAt: string; operation: Record<string, unknown> };
    assert.equal(body.schemaVersion, "account-center.mutation-operation.v1");
    assert.match(body.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(body.operation, {
      operationId: "op_detail", state: "completed", outcome: "blocked",
      createdAt: body.operation.createdAt, completedAt: body.operation.completedAt,
      audit: { action: "route.use", provider: "openai", runtime: "openclaw", scopeKind: "default", warningCodes: ["runtime_unavailable"] }
    });
    assert.equal(JSON.stringify(body).match(/detail-idempotency|[abc]{64}/), null);

    const capabilities = await request(address.port, "/api/capabilities", "test-token");
    const capabilityBody = await capabilities.json() as { actions: Array<{ id: string; mode: string; state: string; endpoint?: { method: string; path: string }; requires: string[] }> };
    assert.deepEqual(capabilityBody.actions.find((action) => action.id === "mutation_operations.detail"), {
      id: "mutation_operations.detail", mode: "read", state: "available", endpoint: { method: "GET", path: "/api/mutation-operations/:operationId" }, requires: ["bearer_token", "opaque_operation_id", "explicit_runtime_scope"]
    });

    const wrongMethod = await fetch(`http://127.0.0.1:${address.port}/api/mutation-operations/op_detail`, {
      method: "POST", headers: { authorization: "Bearer test-token" }
    });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "GET");

    const missing = await request(address.port, "/api/mutation-operations/op_missing?runtime=openclaw&scopeKind=default", "test-token");
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "not_found" });
  } finally {
    await app.close();
  }
});

test("durable detail reads require observed default context before store access and do not enumerate mismatches", async () => {
  const forbiddenAudit = new Proxy({}, { get() { throw new Error("detail_must_not_read_audit"); } }) as AuditStore;
  const forbiddenOperations = new Proxy({}, { get() { throw new Error("detail_must_not_read_operations"); } }) as MutationRepository;
  const unavailable = createAccountCenterServer({ token: "test-token", source: null, auditStore: forbiddenAudit, mutationRepository: forbiddenOperations });
  const unavailableAddress = await unavailable.listen();
  try {
    for (const path of [
      "/api/audit/audit_00000000-0000-4000-8000-000000000000?runtime=hermes&scopeKind=default",
      "/api/mutation-operations/op_missing?runtime=hermes&scopeKind=default"
    ]) await assertHardenedJsonError(await request(unavailableAddress.port, path, "test-token"), 503, "status_unavailable", "detail_must_not_read");
  } finally { await unavailable.close(); }

  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  const auditStore = new AuditStore(join(root, "audit.json"));
  const record = await auditStore.append({ action: "route.use", outcome: "blocked", proofState: "unproven", requestDigest: "a".repeat(64), summary: "private@example.test", warnings: [], runtime: "openclaw", scopeKind: "agent" });
  const repository = new MutationRepository(join(root, "operations"), { operationId: () => "op_context" });
  const claim = await repository.claim({ idempotencyKey: "detail-context-operation-key", requestDigest: "b".repeat(64), audit: { action: "route.use", provider: "openai", runtime: "openclaw", scopeKind: "agent", scopeIdDigest: "c".repeat(64), targetDigest: "d".repeat(64) } });
  if (claim.kind !== "execute") throw new Error("expected operation");
  await repository.complete({ operationId: claim.operationId, outcome: "blocked" });
  const app = createAccountCenterServer({ token: "test-token", auditStore, mutationRepository: repository });
  const address = await app.listen();
  try {
    for (const path of [
      `/api/audit/${record.id}?runtime=openclaw&scopeKind=default`,
      "/api/mutation-operations/op_context?runtime=openclaw&scopeKind=default"
    ]) await assertHardenedJsonError(await request(address.port, path, "test-token"), 404, "not_found", "private@example.test");
    for (const path of [
      `/api/audit/${record.id}`,
      `/api/audit/${record.id}?runtime=openclaw&scopeKind=agent`,
      "/api/mutation-operations/op_context?runtime=openclaw&scopeKind=default&scopeKind=default"
    ]) await assertHardenedJsonError(await request(address.port, path, "test-token"), 400, "invalid_query", "private@example.test");
  } finally { await app.close(); }
});

test("mutation operation history is bounded, newest-first, and paginates with an opaque redacted cursor", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  let sequence = 0;
  const repository = new MutationRepository(join(root, "mutations"), { operationId: () => `op_page_${++sequence}` });
  for (const outcome of ["applied", "blocked", "failed"] as const) {
    const claim = await repository.claim({
      idempotencyKey: `page-idempotency-key-${outcome}-000`,
      requestDigest: outcome[0].repeat(64),
      audit: { action: "route.use", provider: "openai", runtime: "openclaw", scopeKind: "default", scopeIdDigest: "a".repeat(64), targetDigest: "b".repeat(64) }
    });
    if (claim.kind !== "execute") throw new Error("expected executable operation");
    await repository.complete({ operationId: claim.operationId, outcome });
  }
  const app = createAccountCenterServer({ token: "test-token", mutationRepository: repository });
  const address = await app.listen();
  try {
    const first = await request(address.port, "/api/mutation-operations?limit=2", "test-token");
    assert.equal(first.status, 200);
    const firstBody = await first.json() as { schemaVersion: string; generatedAt: string; operations: Array<{ operationId: string; outcome?: string }>; nextCursor: string | null };
    assert.equal(firstBody.schemaVersion, "account-center.mutation-operations.v1");
    assert.match(firstBody.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(firstBody.operations.map(({ operationId, outcome }) => ({ operationId, outcome })), [{ operationId: "op_page_3", outcome: "failed" }, { operationId: "op_page_2", outcome: "blocked" }]);
    assert.equal(firstBody.nextCursor, "op_page_2");

    const second = await request(address.port, `/api/mutation-operations?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor ?? "")}`, "test-token");
    assert.equal(second.status, 200);
    const secondBody = await second.json() as { operations: Array<{ operationId: string }>; nextCursor: string | null };
    assert.deepEqual(secondBody.operations.map(({ operationId }) => operationId), ["op_page_1"]);
    assert.equal(secondBody.nextCursor, null);
    assert.equal(JSON.stringify([firstBody, secondBody]).match(/page-idempotency|[ab]{64}/), null);

    const filtered = await request(address.port, "/api/mutation-operations?outcome=blocked", "test-token");
    assert.equal(filtered.status, 200);
    const filteredBody = await filtered.json() as { operations: Array<{ operationId: string; outcome?: string }>; nextCursor: string | null };
    assert.deepEqual(filteredBody.operations.map(({ operationId, outcome }) => ({ operationId, outcome })), [{ operationId: "op_page_2", outcome: "blocked" }]);
    assert.equal(filteredBody.nextCursor, null);

    const noMatch = await request(address.port, "/api/mutation-operations?outcome=applied&runtime=hermes&scopeKind=default", "test-token");
    assert.equal(noMatch.status, 200);
    const noMatchBody = await noMatch.json() as { operations: Array<Record<string, unknown>>; nextCursor: string | null };
    assert.deepEqual(noMatchBody.operations, []);
    assert.equal(noMatchBody.nextCursor, null);

    const malformed = await request(address.port, "/api/mutation-operations?limit=101", "test-token");
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: "invalid_query" });
    const malformedOutcome = await request(address.port, "/api/mutation-operations?outcome=UNPROVEN", "test-token");
    assert.equal(malformedOutcome.status, 400);
    assert.deepEqual(await malformedOutcome.json(), { error: "invalid_query" });
  } finally {
    await app.close();
  }
});

test("mutation operation history filters by the observed exact default runtime context", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  let sequence = 0;
  const repository = new MutationRepository(join(root, "mutations"), { operationId: () => `op_filter_${++sequence}` });
  for (const audit of [
    { action: "route.use", provider: "openai", runtime: "openclaw", scopeKind: "default" },
    { action: "model.use", provider: "openai", runtime: "hermes", scopeKind: "profile" },
    { action: "route.use", provider: "openai", runtime: "openclaw", scopeKind: "agent" }
  ] as const) {
    const claim = await repository.claim({
      idempotencyKey: `operation-filter-${++sequence}-key`,
      requestDigest: String(sequence).repeat(64),
      audit: { ...audit, scopeIdDigest: "a".repeat(64), targetDigest: "b".repeat(64) }
    });
    if (claim.kind !== "execute") throw new Error("expected executable operation");
    await repository.complete({ operationId: claim.operationId, outcome: "blocked" });
  }
  const app = createAccountCenterServer({ token: "test-token", mutationRepository: repository });
  const address = await app.listen();
  try {
    const filtered = await request(address.port, "/api/mutation-operations?runtime=openclaw&scopeKind=default", "test-token");
    assert.equal(filtered.status, 200);
    const body = await filtered.json() as { operations: Array<{ operationId: string; audit: { runtime: string; scopeKind: string } }> };
    assert.deepEqual(body.operations.map(({ operationId, audit }) => ({ operationId, runtime: audit.runtime, scopeKind: audit.scopeKind })), [
      { operationId: "op_filter_2", runtime: "openclaw", scopeKind: "default" }
    ]);
    assert.equal(JSON.stringify(body).match(/operation-filter|[ab]{64}/), null);

    // A scope kind without an explicit runtime would broaden the selected
    // context into cross-runtime evidence. It must be rejected, not treated
    // as a global scope-kind search.
    for (const path of ["/api/mutation-operations?runtime=OpenClaw", "/api/mutation-operations?scopeKind=agent"]) {
      const malformed = await request(address.port, path, "test-token");
      assert.equal(malformed.status, 400, path);
      assert.deepEqual(await malformed.json(), { error: "invalid_query" });
    }
  } finally {
    await app.close();
  }
});

test("mutation operation history filters an exact safe action category without broadening evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  let sequence = 0;
  const repository = new MutationRepository(join(root, "mutations"), { operationId: () => `op_action_${++sequence}` });
  for (const action of ["route.use", "model.use"] as const) {
    const claim = await repository.claim({
      idempotencyKey: `operation-action-${++sequence}-key`,
      requestDigest: String(sequence).repeat(64),
      audit: { action, provider: "openai", runtime: "openclaw", scopeKind: "default", scopeIdDigest: "a".repeat(64), targetDigest: "b".repeat(64) }
    });
    if (claim.kind !== "execute") throw new Error("expected executable operation");
    await repository.complete({ operationId: claim.operationId, outcome: "blocked" });
  }
  const app = createAccountCenterServer({ token: "test-token", mutationRepository: repository });
  const address = await app.listen();
  try {
    const filtered = await request(address.port, "/api/mutation-operations?action=route.use", "test-token");
    assert.equal(filtered.status, 200);
    const body = await filtered.json() as { operations: Array<{ operationId: string; audit: { action: string } }> };
    assert.deepEqual(body.operations.map(({ operationId, audit }) => ({ operationId, action: audit.action })), [
      { operationId: "op_action_2", action: "route.use" }
    ]);
    assert.equal(JSON.stringify(body).match(/private@example\.test|operation-action|[ab]{64}/), null);

    const noMatch = await request(address.port, "/api/mutation-operations?action=account.enable", "test-token");
    assert.equal(noMatch.status, 200);
    const noMatchBody = await noMatch.json() as { schemaVersion: string; generatedAt: string; operations: Array<Record<string, unknown>>; nextCursor: string | null };
    assert.equal(noMatchBody.schemaVersion, "account-center.mutation-operations.v1");
    assert.match(noMatchBody.generatedAt, /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/);
    assert.deepEqual(noMatchBody.operations, []);
    assert.equal(noMatchBody.nextCursor, null);
    assert.equal(JSON.stringify(noMatchBody).includes("private@example.test"), false);

    const malformed = await request(address.port, "/api/mutation-operations?action=route%20use", "test-token");
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: "invalid_query" });
  } finally {
    await app.close();
  }
});

test("mutation operation history supports bounded UTC calendar-date filters without accepting malformed dates", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  const repository = new MutationRepository(join(root, "mutations"), { operationId: () => "op_date_filter" });
  const claim = await repository.claim({
    idempotencyKey: "operation-date-filter-key-000",
    requestDigest: "d".repeat(64),
    audit: { action: "route.use", provider: "openai", runtime: "openclaw", scopeKind: "default", scopeIdDigest: "a".repeat(64), targetDigest: "b".repeat(64) }
  });
  if (claim.kind !== "execute") throw new Error("expected executable operation");
  await repository.complete({ operationId: claim.operationId, outcome: "blocked" });
  const app = createAccountCenterServer({ token: "test-token", mutationRepository: repository });
  const address = await app.listen();
  try {
    const today = new Date().toISOString().slice(0, 10);
    const accepted = await request(address.port, `/api/mutation-operations?from=${today}&to=${today}`, "test-token");
    assert.equal(accepted.status, 200);
    const body = await accepted.json() as { operations: Array<{ operationId: string }> };
    assert.deepEqual(body.operations.map(({ operationId }) => operationId), ["op_date_filter"]);

    for (const path of ["/api/mutation-operations?from=2026-7-1", "/api/mutation-operations?to=2026-02-30", "/api/mutation-operations?from=2026-07-02&to=2026-07-01", "/api/mutation-operations?from=2026-07-01&from=2026-07-01"]) {
      const malformed = await request(address.port, path, "test-token");
      assert.equal(malformed.status, 400, path);
      assert.deepEqual(await malformed.json(), { error: "invalid_query" });
    }
  } finally {
    await app.close();
  }
});

test("protected API contains repository failures without returning internal error detail", async () => {
  const repository = { list: async () => { throw new Error("private@example.test mutation repository corrupt"); } } as unknown as MutationRepository;
  const app = createAccountCenterServer({ token: "test-token", mutationRepository: repository });
  const address = await app.listen();
  try {
    const response = await request(address.port, "/api/mutation-operations", "test-token");
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "internal_error" });
  } finally {
    await app.close();
  }
});

test("guided-auth challenge inventory requires its exact selected context and omits account targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  const challenges = new AuthChallengeStore(join(root, "challenges.json"));
  const expiresAt = "2030-01-01T00:00:00.000Z";
  await challenges.create({ mode: "reauth", provider: "openai", runtime: "openclaw", target: "private@example.test", scope: "default", expiresAt });
  const app = createAccountCenterServer({ token: "test-token", challengeStore: challenges });
  const address = await app.listen();
  try {
    assert.equal((await request(address.port, "/api/auth-challenges?runtime=openclaw&scope=default")).status, 401);
    const accepted = await request(address.port, "/api/auth-challenges?runtime=openclaw&scope=default", "test-token");
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get("cache-control"), "no-store");
    const body = await accepted.json() as { schemaVersion: string; generatedAt: string; challenges: Array<Record<string, unknown>> };
    assert.equal(body.schemaVersion, "account-center.auth-challenges.v1");
    assert.match(body.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(body.challenges.length, 1);
    assert.deepEqual(Object.keys(body.challenges[0]).sort(), ["createdAt", "expiresAt", "id", "mode", "provider", "runtime", "scope", "status", "updatedAt"]);
    assert.equal(body.challenges[0].expiresAt, expiresAt);
    assert.equal(JSON.stringify(body).includes("private@example.test"), false);
  } finally {
    await app.close();
  }
});

test("guided-auth challenge inventory can be bounded to an authoritative selected runtime and default scope without exposing targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  const challenges = new AuthChallengeStore(join(root, "challenges.json"));
  await challenges.create({ mode: "add", provider: "openai", runtime: "openclaw", target: "openclaw-private@example.test", scope: "default" });
  await challenges.create({ mode: "reauth", provider: "openai", runtime: "hermes", target: "hermes-default@example.test", scope: "default" });
  const foreignScope = await challenges.create({ mode: "add", provider: "openai", runtime: "hermes", target: "hermes-agent@example.test", scope: "agent:recovery" });
  const app = createAccountCenterServer({ token: "test-token", challengeStore: challenges });
  const address = await app.listen();
  try {
    assert.equal((await request(address.port, "/api/auth-challenges?runtime=hermes&scope=default")).status, 401);
    const accepted = await request(address.port, "/api/auth-challenges?runtime=hermes&scope=default", "test-token");
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get("cache-control"), "no-store");
    const body = await accepted.json() as { schemaVersion: string; challenges: Array<{ runtime: string; scope: string }> };
    assert.equal(body.schemaVersion, "account-center.auth-challenges.v1");
    assert.deepEqual(body.challenges.map(({ runtime, scope }) => ({ runtime, scope })), [{ runtime: "hermes", scope: "default" }]);
    assert.equal(JSON.stringify(body).match(/private@example\.test/), null);

    // Invalid syntax is rejected at the input boundary; unavailable selected
    // contexts have a distinct authority error below.
    for (const path of ["/api/auth-challenges", "/api/auth-challenges?runtime=hermes", "/api/auth-challenges?scope=default", "/api/auth-challenges?runtime=Hermes&scope=default", "/api/auth-challenges?runtime=hermes&runtime=openclaw&scope=default", "/api/auth-challenges?runtime=hermes&scope=agent%3Arecovery&scope=default", "/api/auth-challenges?runtime=hermes&scope=agent%3Arecovery%0A", "/api/auth-challenges?runtime=hermes&scope=default&unknown=default"]) {
      const malformed = await request(address.port, path, "test-token");
      assert.equal(malformed.status, 400, path);
      assert.deepEqual(await malformed.json(), { error: "invalid_query" });
    }
  } finally {
    await app.close();
  }
});

test("guided-auth challenge inventory rejects unavailable selected scopes before durable access", async () => {
  const forbiddenChallenges = new Proxy({}, { get() { throw new Error("unpublished_scope_must_not_open_challenge_store"); } }) as AuthChallengeStore;
  const app = createAccountCenterServer({ token: "test-token", challengeStore: forbiddenChallenges });
  const address = await app.listen();
  try {
    for (const path of [
      "/api/auth-challenges?runtime=hermes&scope=agent%3Arecovery",
      "/api/auth-challenges?runtime=codex&scope=default"
    ]) {
      await assertHardenedJsonError(await request(address.port, path, "test-token"), 400, "unknown_runtime_scope", "unpublished_scope_must_not_open");
    }
    for (const path of [
      "/api/auth-challenges?runtime=hermes&scope=default&scope=default",
      "/api/auth-challenges?runtime=hermes&scope=agent%3Arecovery%0A"
    ]) {
      await assertHardenedJsonError(await request(address.port, path, "test-token"), 400, "invalid_query", "unpublished_scope_must_not_open");
    }
  } finally {
    await app.close();
  }
});

test("guided-auth challenge history is newest-first, cursor-paginated, and remains redacted", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  const challenges = new AuthChallengeStore(join(root, "challenges.json"));
  const first = await challenges.create({ mode: "add", provider: "openai", runtime: "openclaw", target: "first-private@example.test", scope: "default" });
  const second = await challenges.create({ mode: "reauth", provider: "openai", runtime: "openclaw", target: "second-private@example.test", scope: "default" });
  const third = await challenges.create({ mode: "add", provider: "openai", runtime: "openclaw", target: "third-private@example.test", scope: "default" });
  const foreign = await challenges.create({ mode: "add", provider: "openai", runtime: "hermes", target: "foreign-private@example.test", scope: "default" });
  const app = createAccountCenterServer({ token: "test-token", challengeStore: challenges });
  const address = await app.listen();
  try {
    const newest = await request(address.port, "/api/auth-challenges?runtime=openclaw&scope=default&limit=1", "test-token");
    assert.equal(newest.status, 200);
    const newestBody = await newest.json() as { challenges: Array<{ id: string }>; nextCursor?: string };
    assert.deepEqual(newestBody.challenges.map(({ id }) => id), [third.id]);
    assert.equal(newestBody.nextCursor, third.id);
    assert.equal(JSON.stringify(newestBody).match(/(?:first|second|third)-private@example\.test/), null);

    const older = await request(address.port, `/api/auth-challenges?runtime=openclaw&scope=default&limit=1&cursor=${encodeURIComponent(third.id)}`, "test-token");
    assert.equal(older.status, 200);
    const olderBody = await older.json() as { challenges: Array<{ id: string }>; nextCursor?: string };
    assert.deepEqual(olderBody.challenges.map(({ id }) => id), [second.id]);
    assert.equal(olderBody.nextCursor, second.id);

    const oldest = await request(address.port, `/api/auth-challenges?runtime=openclaw&scope=default&limit=1&cursor=${encodeURIComponent(second.id)}`, "test-token");
    assert.equal(oldest.status, 200);
    const oldestBody = await oldest.json() as { challenges: Array<{ id: string }>; nextCursor?: string };
    assert.deepEqual(oldestBody.challenges.map(({ id }) => id), [first.id]);
    assert.equal(oldestBody.nextCursor, undefined);

    const foreignCursor = await request(address.port, `/api/auth-challenges?runtime=openclaw&scope=default&cursor=${encodeURIComponent(foreign.id)}`, "test-token");
    assert.equal(foreignCursor.status, 400);
    assert.equal(JSON.stringify(await foreignCursor.json()).includes("foreign-private@example.test"), false);

    for (const path of ["/api/auth-challenges?runtime=openclaw&scope=default&limit=0", "/api/auth-challenges?runtime=openclaw&scope=default&limit=101", "/api/auth-challenges?runtime=openclaw&scope=default&cursor=auth_not-a-uuid", "/api/auth-challenges?runtime=openclaw&scope=default&cursor=auth_00000000-0000-4000-8000-000000000000", `/api/auth-challenges?runtime=openclaw&scope=default&cursor=${encodeURIComponent(first.id)}&cursor=${encodeURIComponent(second.id)}`]) {
      const malformed = await request(address.port, path, "test-token");
      assert.equal(malformed.status, 400, path);
      assert.deepEqual(await malformed.json(), { error: "invalid_query" });
    }
  } finally {
    await app.close();
  }
});

test("guided-auth challenge detail is bearer-protected, redacted, and bound to its authoritative exact selected context", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  const challenges = new AuthChallengeStore(join(root, "challenges.json"));
  const challenge = await challenges.create({ mode: "add", provider: "openai", runtime: "hermes", target: "private@example.test", scope: "default" });
  const app = createAccountCenterServer({ token: "test-token", challengeStore: challenges });
  const address = await app.listen();
  const path = `/api/auth-challenges/${challenge.id}?runtime=hermes&scope=default`;
  try {
    const capabilities = await request(address.port, "/api/capabilities", "test-token");
    assert.equal(capabilities.status, 200);
    const capabilityBody = await capabilities.json() as { actions: Array<{ id: string; mode: string; state: string; endpoint?: { method: string; path: string }; requires: string[] }> };
    assert.deepEqual(capabilityBody.actions.find((action) => action.id === "auth_challenges.detail"), {
      id: "auth_challenges.detail", mode: "read", state: "available", endpoint: { method: "GET", path: "/api/auth-challenges/:id?runtime=:runtime&scope=:scope" }, requires: ["bearer_token", "opaque_challenge_id", "explicit_runtime_scope"]
    });
    assert.equal((await request(address.port, path)).status, 401);
    const accepted = await request(address.port, path, "test-token");
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get("cache-control"), "no-store");
    const body = await accepted.json() as { schemaVersion: string; generatedAt: string; challenge: Record<string, unknown> };
    assert.equal(body.schemaVersion, "account-center.auth-challenge.v1");
    assert.match(body.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(Object.keys(body.challenge).sort(), ["createdAt", "id", "mode", "provider", "runtime", "scope", "status", "updatedAt"]);
    assert.equal(JSON.stringify(body).includes("private@example.test"), false);
    const unpublishedScope = await request(address.port, `/api/auth-challenges/${challenge.id}?runtime=hermes&scope=agent%3Amain`, "test-token");
    assert.equal(unpublishedScope.status, 400);
    assert.deepEqual(await unpublishedScope.json(), { error: "unknown_runtime_scope" });
    assert.equal((await request(address.port, `/api/auth-challenges/${challenge.id}?runtime=openclaw&scope=default`, "test-token")).status, 404);
    for (const suffix of ["", "?runtime=hermes", "?scope=default", "?runtime=hermes&scope=default&scope=default", "?runtime=hermes&scope=default&probe=private%40example.test"]) {
      const rejected = await request(address.port, `/api/auth-challenges/${challenge.id}${suffix}`, "test-token");
      assert.equal(rejected.status, 400, suffix);
      assert.deepEqual(await rejected.json(), { error: "invalid_query" }, suffix);
      assert.equal(rejected.headers.get("cache-control"), "no-store", suffix);
    }
    assert.equal((await request(address.port, "/api/auth-challenges/auth_00000000-0000-4000-8000-000000000000?runtime=hermes&scope=default", "test-token")).status, 404);
  } finally {
    await app.close();
  }
});

test("guided-auth detail and cancellation reject an unpublished exact scope before durable lifecycle access", async () => {
  const id = "auth_00000000-0000-4000-8000-000000000000";
  const forbiddenChallenges = new Proxy({}, { get() { throw new Error("unpublished_scope_must_not_open_challenge_store"); } }) as AuthChallengeStore;
  const forbiddenAudit = new Proxy({}, { get() { throw new Error("unpublished_scope_must_not_open_audit_store"); } }) as AuditStore;
  const app = createAccountCenterServer({ token: "test-token", challengeStore: forbiddenChallenges, auditStore: forbiddenAudit });
  const address = await app.listen();
  const origin = `http://127.0.0.1:${address.port}`;
  const detailPath = `/api/auth-challenges/${id}?runtime=hermes&scope=agent%3Amain`;
  const cancelPath = `/api/auth-challenges/${id}/cancel?runtime=hermes&scope=agent%3Amain`;
  try {
    await assertHardenedJsonError(await fetch(`${origin}${detailPath}`, { headers: { authorization: "Bearer test-token" } }), 400, "unknown_runtime_scope", "unpublished_scope_must_not_open");
    await assertHardenedJsonError(await fetch(`${origin}${cancelPath}`, {
      method: "POST", headers: { authorization: "Bearer test-token", origin }
    }), 400, "unknown_runtime_scope", "unpublished_scope_must_not_open");
  } finally {
    await app.close();
  }
});

test("guided-auth API fails closed and redacts a corrupt durable lifecycle record", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  const path = join(root, "challenges.json");
  await writeFile(path, JSON.stringify([{
    id: "auth_corrupt",
    key: "key",
    mode: "add",
    status: "completed-with-unverified-runtime-output",
    provider: "openai",
    runtime: "openclaw",
    scope: "default",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z"
  }]));
  const app = createAccountCenterServer({ token: "test-token", challengeStore: new AuthChallengeStore(path) });
  const address = await app.listen();
  try {
    const response = await request(address.port, "/api/auth-challenges?runtime=openclaw&scope=default", "test-token");
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "internal_error" });
  } finally {
    await app.close();
  }
});

test("guided-auth cancellation capability remains blocked when durable challenge state is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  const auditStore = new AuditStore(join(root, "audit.json"));
  const app = createAccountCenterServer({ token: "test-token", auditStore });
  const address = await app.listen();
  try {
    const response = await request(address.port, "/api/capabilities", "test-token");
    assert.equal(response.status, 200);
    const body = await response.json() as { actions: Array<{ id: string; mode: string; state: string; reason?: string; requires: string[] }> };
    assert.deepEqual(body.actions.find((action) => action.id === "auth_challenges.cancel"), {
      id: "auth_challenges.cancel",
      mode: "mutation",
      state: "blocked",
      reason: "durable_challenge_store_unavailable",
      requires: ["bearer_token", "same_origin", "opaque_challenge_id", "explicit_runtime_scope", "durable_challenge_store", "durable_audit_store"]
    });
  } finally {
    await app.close();
  }
});

test("guided-auth cancellation fails closed on unavailable status before opening lifecycle stores", async () => {
  const hostile = "private@example.test";
  const id = "auth_00000000-0000-4000-8000-000000000000";
  // These collaborators make any read, write, or lifecycle handoff observable.
  // A valid selected context ensures unavailable authority—not parsing or a
  // dependency branch—selects the fixed response.
  const forbiddenChallenges = new Proxy({}, { get() { throw new Error("challenge_store_must_not_be_opened"); } }) as AuthChallengeStore;
  const forbiddenAudit = new Proxy({}, { get() { throw new Error("audit_store_must_not_be_opened"); } }) as AuditStore;

  async function assertUnavailableCancel(source: unknown): Promise<void> {
    const app = createAccountCenterServer({ token: "test-token", source, challengeStore: forbiddenChallenges, auditStore: forbiddenAudit });
    const address = await app.listen();
    try {
      await assertHardenedJsonError(await fetch(`http://127.0.0.1:${address.port}/api/auth-challenges/${id}/cancel?runtime=openclaw&scope=default`, {
        method: "POST", headers: { authorization: "Bearer test-token", origin: `http://127.0.0.1:${address.port}` }
      }), 503, "status_unavailable", hostile);
    } finally {
      await app.close();
    }
  }

  await assertUnavailableCancel(null);
  await assertUnavailableCancel("/srv/private/account-center/adapter private@example.test");

  const directory = await mkdtemp(join(tmpdir(), "account-center-failed-cancel-status-"));
  const command = join(directory, "status-failure.js");
  await writeFile(command, `process.stderr.write(${JSON.stringify(hostile)}); process.exit(1);\n`);
  const previousCommand = process.env.ACCOUNT_CENTER_GENERIC_COMMAND;
  const previousArgs = process.env.ACCOUNT_CENTER_GENERIC_ARGS;
  process.env.ACCOUNT_CENTER_GENERIC_COMMAND = `${process.execPath} ${command}`;
  process.env.ACCOUNT_CENTER_GENERIC_ARGS = "";
  try {
    await assertUnavailableCancel("generic-command");
    process.env.ACCOUNT_CENTER_GENERIC_COMMAND = process.execPath;
    process.env.ACCOUNT_CENTER_GENERIC_ARGS = "-e \"process.stdout.write('{}')\"";
    await assertUnavailableCancel("generic-command");
  } finally {
    if (previousCommand === undefined) delete process.env.ACCOUNT_CENTER_GENERIC_COMMAND;
    else process.env.ACCOUNT_CENTER_GENERIC_COMMAND = previousCommand;
    if (previousArgs === undefined) delete process.env.ACCOUNT_CENTER_GENERIC_ARGS;
    else process.env.ACCOUNT_CENTER_GENERIC_ARGS = previousArgs;
  }
});

test("guided-auth cancellation is same-origin, bearer-protected, durable, redacted, and records bounded audit evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  const challenges = new AuthChallengeStore(join(root, "challenges.json"));
  const auditStore = new AuditStore(join(root, "audit.json"));
  const challenge = await challenges.create({ mode: "reauth", provider: "openai", runtime: "openclaw", target: "private@example.test", scope: "default" });
  const app = createAccountCenterServer({ token: "test-token", challengeStore: challenges, auditStore });
  const address = await app.listen();
  const path = `/api/auth-challenges/${challenge.id}/cancel?runtime=openclaw&scope=default`;
  try {
    assert.equal((await request(address.port, path)).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${address.port}${path}`, { method: "POST", headers: { authorization: "Bearer test-token", origin: "http://attacker.invalid" } })).status, 403);
    const cancelled = await fetch(`http://127.0.0.1:${address.port}${path}`, { method: "POST", headers: { authorization: "Bearer test-token", origin: `http://127.0.0.1:${address.port}` } });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.headers.get("cache-control"), "no-store");
    const body = await cancelled.json() as { schemaVersion: string; generatedAt: string; challenge: Record<string, unknown> };
    assert.equal(body.schemaVersion, "account-center.auth-challenge-cancel.v1");
    assert.match(body.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(Object.keys(body.challenge).sort(), ["createdAt", "id", "mode", "provider", "runtime", "scope", "status", "updatedAt"]);
    assert.equal(body.challenge.status, "cancelled");
    assert.equal(JSON.stringify(body).includes("private@example.test"), false);
    assert.equal((await challenges.get(challenge.id))?.status, "cancelled");
    const capabilities = await request(address.port, "/api/capabilities", "test-token");
    const capabilityBody = await capabilities.json() as { actions: Array<{ id: string; mode: string; state: string; endpoint?: { method: string; path: string }; requires: string[] }> };
    assert.deepEqual(capabilityBody.actions.find((action) => action.id === "auth_challenges.cancel"), {
      id: "auth_challenges.cancel", mode: "mutation", state: "available", endpoint: { method: "POST", path: "/api/auth-challenges/:id/cancel?runtime=:runtime&scope=:scope" }, requires: ["bearer_token", "same_origin", "opaque_challenge_id", "explicit_runtime_scope", "durable_challenge_store", "durable_audit_store"]
    });
    assert.deepEqual(capabilityBody.actions.find((action) => action.id === "audit.detail"), {
      id: "audit.detail", mode: "read", state: "available", endpoint: { method: "GET", path: "/api/audit/:auditId" }, requires: ["bearer_token", "opaque_audit_id", "explicit_runtime_scope"]
    });
    assert.deepEqual(capabilityBody.actions.find((action) => action.id === "mutation_operations.detail"), {
      id: "mutation_operations.detail", mode: "read", state: "blocked", reason: "mutation_repository_unavailable", requires: ["bearer_token", "opaque_operation_id", "explicit_runtime_scope", "mutation_repository"]
    });
    const audit = await request(address.port, "/api/audit", "test-token");
    assert.equal(audit.status, 200);
    const auditBody = await audit.json() as { records: Array<{ action: string; outcome: string; proofState: string; summary: string }> };
    assert.deepEqual(auditBody.records.map(({ action, outcome, proofState, summary }) => ({ action, outcome, proofState, summary })), [{
      action: "guided_auth.cancel",
      outcome: "applied",
      proofState: "verified",
      summary: "Local guided-auth challenge cancelled."
    }]);
    assert.equal(JSON.stringify(auditBody).match(/private@example\.test|auth_[a-f0-9-]{36}|[a-f0-9]{64}/), null);
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/auth-challenges/auth_00000000-0000-4000-8000-000000000000/cancel?runtime=openclaw&scope=default`, { method: "POST", headers: { authorization: "Bearer test-token", origin: `http://127.0.0.1:${address.port}` } })).status, 404);
  } finally {
    await app.close();
  }
});

test("guided-auth cancellation fails closed before changing challenge state when durable audit evidence is corrupt", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  const challenges = new AuthChallengeStore(join(root, "challenges.json"));
  const auditPath = join(root, "audit.json");
  const auditStore = new AuditStore(auditPath);
  const challenge = await challenges.create({ mode: "reauth", provider: "openai", runtime: "openclaw", target: "private@example.test", scope: "default" });
  await writeFile(auditPath, "{not valid durable audit evidence");
  const app = createAccountCenterServer({ token: "test-token", challengeStore: challenges, auditStore });
  const address = await app.listen();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/auth-challenges/${challenge.id}/cancel?runtime=openclaw&scope=default`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", origin: `http://127.0.0.1:${address.port}` }
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "audit_unavailable" });
    assert.equal((await challenges.get(challenge.id))?.status, "pending");
  } finally {
    await app.close();
  }
});

test("repeating a guided-auth cancellation is idempotent and does not duplicate durable audit evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  const challenges = new AuthChallengeStore(join(root, "challenges.json"));
  const auditStore = new AuditStore(join(root, "audit.json"));
  const challenge = await challenges.create({ mode: "reauth", provider: "openai", runtime: "openclaw", target: "private@example.test", scope: "default" });
  const app = createAccountCenterServer({ token: "test-token", challengeStore: challenges, auditStore });
  const address = await app.listen();
  const path = `/api/auth-challenges/${challenge.id}/cancel?runtime=openclaw&scope=default`;
  const headers = { authorization: "Bearer test-token", origin: `http://127.0.0.1:${address.port}` };
  try {
    const first = await fetch(`http://127.0.0.1:${address.port}${path}`, { method: "POST", headers });
    assert.equal(first.status, 200);
    const repeated = await fetch(`http://127.0.0.1:${address.port}${path}`, { method: "POST", headers });
    assert.equal(repeated.status, 200);
    assert.equal((await repeated.json() as { challenge: { status: string } }).challenge.status, "cancelled");
    const audit = await request(address.port, "/api/audit", "test-token");
    assert.equal(audit.status, 200);
    assert.equal((await audit.json() as { records: unknown[] }).records.length, 1);
  } finally {
    await app.close();
  }
});

test("cancelling an elapsed guided-auth challenge reports expiry without recording a false cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  const challenges = new AuthChallengeStore(join(root, "challenges.json"));
  const auditStore = new AuditStore(join(root, "audit.json"));
  const challenge = await challenges.create({
    mode: "reauth",
    provider: "openai",
    runtime: "openclaw",
    target: "private@example.test",
    scope: "default",
    expiresAt: "2020-01-01T00:00:00.000Z"
  });
  const app = createAccountCenterServer({ token: "test-token", challengeStore: challenges, auditStore });
  const address = await app.listen();
  const path = `/api/auth-challenges/${challenge.id}/cancel?runtime=openclaw&scope=default`;
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", origin: `http://127.0.0.1:${address.port}` }
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { challenge: { status: string } }).challenge.status, "expired");
    assert.equal((await challenges.get(challenge.id))?.status, "expired");
    assert.deepEqual((await auditStore.list()).map((record) => record.action), []);
  } finally {
    await app.close();
  }
});

test("guided-auth cancellation rejects request bodies before changing local challenge state", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  const challenges = new AuthChallengeStore(join(root, "challenges.json"));
  const challenge = await challenges.create({ mode: "reauth", provider: "openai", runtime: "openclaw", target: "private@example.test", scope: "agent:main" });
  const app = createAccountCenterServer({ token: "test-token", challengeStore: challenges });
  const address = await app.listen();
  const path = `/api/auth-challenges/${challenge.id}/cancel`;
  try {
    const rejected = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", origin: `http://127.0.0.1:${address.port}`, "content-type": "application/json" },
      body: "{}"
    });
    assert.equal(rejected.status, 413);
    assert.deepEqual(await rejected.json(), { error: "request_body_not_allowed" });
    assert.equal((await challenges.get(challenge.id))?.status, "pending");
  } finally {
    await app.close();
  }
});

test("guided-auth cancellation binds an opaque ID to one selected runtime and scope before lifecycle mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  const challenges = new AuthChallengeStore(join(root, "challenges.json"));
  const auditStore = new AuditStore(join(root, "audit.json"));
  const challenge = await challenges.create({ mode: "reauth", provider: "openai", runtime: "openclaw", target: "private@example.test", scope: "default" });
  const app = createAccountCenterServer({ token: "test-token", challengeStore: challenges, auditStore });
  const address = await app.listen();
  const origin = `http://127.0.0.1:${address.port}`;
  const headers = { authorization: "Bearer test-token", origin };
  const path = `/api/auth-challenges/${challenge.id}/cancel`;
  try {
    for (const suffix of ["", "?runtime=openclaw", "?scope=default", "?runtime=openclaw&scope=default&scope=default", "?runtime=openclaw&scope=default&extra=1", "?runtime=OpenClaw&scope=default", "?runtime=openclaw&scope=default%0A"]) {
      const response = await fetch(`${origin}${path}${suffix}`, { method: "POST", headers });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: "invalid_query" });
      assert.equal((await challenges.get(challenge.id))?.status, "pending");
      assert.equal((await auditStore.list()).length, 0);
    }
    const [unknown, crossRuntime, crossScope] = await Promise.all([
      fetch(`${origin}/api/auth-challenges/auth_00000000-0000-4000-8000-000000000000/cancel?runtime=openclaw&scope=default`, { method: "POST", headers }),
      fetch(`${origin}${path}?runtime=hermes&scope=default`, { method: "POST", headers }),
      fetch(`${origin}${path}?runtime=openclaw&scope=agent%3Amain`, { method: "POST", headers })
    ]);
    const failures = await Promise.all([unknown, crossRuntime, crossScope].map(async (response) => ({ status: response.status, cache: response.headers.get("cache-control"), body: await response.text() })));
    assert.deepEqual(failures, [
      { status: 404, cache: "no-store", body: '{"error":"not_found"}' },
      { status: 404, cache: "no-store", body: '{"error":"not_found"}' },
      { status: 400, cache: "no-store", body: '{"error":"unknown_runtime_scope"}' }
    ]);
    assert.equal((await challenges.get(challenge.id))?.status, "pending");
    assert.equal((await auditStore.list()).length, 0);
    assert.equal((await fetch(`${origin}${path}?runtime=openclaw&scope=default`, { method: "POST", headers })).status, 200);
  } finally {
    await app.close();
  }
});

test("protected guided-auth GET routes retain executor-validated context and never persist expiry", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-server-"));
  const path = join(root, "challenges.json");
  const durable = JSON.stringify([{ id: "auth_00000000-0000-4000-8000-000000000000", key: "key", mode: "add", status: "pending", provider: "openai", runtime: "openclaw", scope: "default", expiresAt: "2020-01-01T00:00:00.000Z", createdAt: "2019-12-31T00:00:00.000Z", updatedAt: "2019-12-31T00:00:00.000Z" }]);
  await writeFile(path, durable);
  const app = createAccountCenterServer({ token: "test-token", challengeStore: new AuthChallengeStore(path) });
  const address = await app.listen();
  try {
    const inventory = await request(address.port, "/api/auth-challenges?runtime=openclaw&scope=default", "test-token");
    assert.equal(inventory.status, 200);
    assert.equal((await inventory.json() as { challenges: Array<{ status: string }> }).challenges[0]?.status, "expired");
    const detail = await request(address.port, "/api/auth-challenges/auth_00000000-0000-4000-8000-000000000000?runtime=openclaw&scope=default", "test-token");
    assert.equal(detail.status, 200);
    assert.equal((await detail.json() as { challenge: { status: string } }).challenge.status, "expired");
    assert.equal(await readFile(path, "utf8"), durable);
  } finally {
    await app.close();
  }
});
