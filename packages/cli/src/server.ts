import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { AccountCenterStatus, AuditRecord, AuditStore, AuthChallengeStore, createRuntimeAdapter, executeAccountCenterCommand, MutationRepository, redactJson, RuntimeSource } from "@account-center/core";

export interface AccountCenterServerOptions {
  token: string;
  source?: RuntimeSource;
  auditStore?: AuditStore;
  challengeStore?: AuthChallengeStore;
  mutationRepository?: MutationRepository;
}

export function createAccountCenterServer(options: AccountCenterServerOptions) {
  const server = createServer(async (request, response) => {
    try {
      setSafetyHeaders(response);
    if (request.method === "GET" && request.url === "/") return sendHtml(response, controlPanelHtml());
    if (!authorized(request, options.token)) return send(response, 401, { error: "unauthorized" });
    if (hasRequestBody(request)) {
      request.resume();
      return send(response, 413, { error: "request_body_not_allowed" });
    }
    const cancelId = request.method === "POST" ? authChallengeCancelId(request.url) : undefined;
    if (cancelId) {
      if (!sameOrigin(request)) return send(response, 403, { error: "origin_forbidden" });
      // Cancellation changes durable lifecycle state. Refuse the change rather than
      // creating an unaudited mutation when its durable evidence store is absent.
      if (!options.auditStore) return send(response, 503, { error: "audit_unavailable" });
      const challenge = options.challengeStore ? await options.challengeStore.cancel(cancelId) : undefined;
      if (!challenge) return send(response, 404, { error: "not_found" });
      await options.auditStore.append({
        action: "guided_auth.cancel",
        outcome: "applied",
        proofState: "verified",
        requestDigest: createHash("sha256").update(`guided_auth.cancel\0${challenge.id}`).digest("hex"),
        summary: "Local guided-auth challenge cancelled.",
        warnings: []
      });
      return send(response, 200, { schemaVersion: "account-center.auth-challenge-cancel.v1", generatedAt: new Date().toISOString(), challenge: authChallengeView(challenge) });
    }
    const allowedMethod = endpointMethod(request.url);
    if (allowedMethod && request.method !== allowedMethod) {
      response.setHeader("Allow", allowedMethod);
      return send(response, 405, { error: "method_not_allowed" });
    }
    if (request.method !== "GET") return send(response, 405, { error: "method_not_allowed" });
    if (request.method === "GET" && request.url === "/api/capabilities") return send(response, 200, agentCapabilities(Boolean(options.auditStore)));
    if (request.method === "GET" && new URL(request.url ?? "/", "http://account-center.local").pathname === "/api/audit") {
      const query = auditQuery(request.url ?? "/");
      if (!query) return send(response, 400, { error: "invalid_query" });
      const history = await auditHistory(options.auditStore, query);
      return history ? send(response, 200, history) : send(response, 400, { error: "invalid_query" });
    }
    if (request.method === "GET" && new URL(request.url ?? "/", "http://account-center.local").pathname === "/api/mutation-operations") {
      const query = mutationOperationQuery(request.url ?? "/");
      if (!query) return send(response, 400, { error: "invalid_query" });
      const history = await mutationOperationHistory(options.mutationRepository, query);
      return history ? send(response, 200, history) : send(response, 400, { error: "invalid_query" });
    }
    const pathname = new URL(request.url ?? "/", "http://account-center.local").pathname;
    if (pathname === "/api/models") {
      const query = runtimeInventoryQuery(request.url ?? "/");
      if (!query) return send(response, 400, { error: "invalid_query" });
      const adapter = createRuntimeAdapter(options.source ?? "fixture");
      const result = await executeAccountCenterCommand({ command: "status" }, { adapter });
      return send(response, result.code === 0 && result.status ? 200 : 500, result.status ? modelCatalog(result.status, query.runtime) : { error: "status_unavailable" });
    }
    if (pathname === "/api/limits") {
      const query = runtimeInventoryQuery(request.url ?? "/");
      if (!query) return send(response, 400, { error: "invalid_query" });
      const adapter = createRuntimeAdapter(options.source ?? "fixture");
      const result = await executeAccountCenterCommand({ command: "status" }, { adapter });
      return send(response, result.code === 0 && result.status ? 200 : 500, result.status ? limitsInventory(result.status, query.runtime) : { error: "status_unavailable" });
    }
    if (request.url === "/api/scopes") {
      const adapter = createRuntimeAdapter(options.source ?? "fixture");
      const result = await executeAccountCenterCommand({ command: "status" }, { adapter });
      return send(response, result.code === 0 && result.status ? 200 : 500, result.status ? runtimeScopeCatalog(result.status) : { error: "status_unavailable" });
    }
    if (pathname === "/api/auth-challenges") {
      const query = authChallengeInventoryQuery(request.url ?? "/");
      if (!query) return send(response, 400, { error: "invalid_query" });
      return send(response, 200, await authChallengeInventory(options.challengeStore, query));
    }
    const challengeId = authChallengeId(request.url);
    if (challengeId) {
      const challenge = options.challengeStore ? await options.challengeStore.get(challengeId) : undefined;
      if (!challenge) return send(response, 404, { error: "not_found" });
      return send(response, 200, { schemaVersion: "account-center.auth-challenge.v1", generatedAt: new Date().toISOString(), challenge: authChallengeView(challenge) });
    }
    if (request.url === "/api/status") {
      const adapter = createRuntimeAdapter(options.source ?? "fixture");
      const result = await executeAccountCenterCommand({ command: "status" }, { adapter });
      return send(response, result.code === 0 ? 200 : 500, result.status ? statusView(result.status) : { error: "status_unavailable" });
    }
      return send(response, 404, { error: "not_found" });
    } catch {
      if (!response.writableEnded) send(response, 500, { error: "internal_error" });
    }
  });
  return {
    async listen(port = 0): Promise<{ port: number }> {
      await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
      return { port: (server.address() as AddressInfo).port };
    },
    async close(): Promise<void> {
      // A local control-plane caller (including a headless gate) can retain an
      // idle keep-alive socket after its last response. Closing this ephemeral
      // server must not wait for the peer's keep-alive timeout.
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

interface AuthChallengeInventoryQuery extends RuntimeInventoryQuery { limit: number; scope?: string; cursor?: string; }

async function authChallengeInventory(store: AuthChallengeStore | undefined, query: AuthChallengeInventoryQuery): Promise<unknown> {
  const matching = store ? (await store.list()).slice().reverse().filter((challenge) =>
    (!query.runtime || challenge.runtime === query.runtime) && (!query.scope || challenge.scope === query.scope)
  ) : [];
  const cursorIndex = query.cursor ? matching.findIndex((challenge) => challenge.id === query.cursor) : -1;
  if (query.cursor && cursorIndex < 0) return undefined;
  const challenges = matching.slice(cursorIndex + 1, cursorIndex + 1 + query.limit);
  const nextCursor = cursorIndex + 1 + query.limit < matching.length ? challenges.at(-1)?.id : undefined;
  return {
    schemaVersion: "account-center.auth-challenges.v1",
    generatedAt: new Date().toISOString(),
    challenges: challenges.map(authChallengeView),
    ...(nextCursor ? { nextCursor } : {})
  };
}

interface AuditQuery { limit: number; outcome?: AuditRecord["outcome"]; action?: string; cursor?: string; }

async function auditHistory(store: AuditStore | undefined, query: AuditQuery = { limit: 50 }): Promise<unknown | undefined> {
  const matching = store ? (await store.list({ limit: 1_000 })).filter((record) =>
    (!query.outcome || record.outcome === query.outcome) &&
    (!query.action || record.action === query.action)
  ) : [];
  const cursorIndex = query.cursor ? matching.findIndex((record) => record.id === query.cursor) : -1;
  if (query.cursor && cursorIndex < 0) return undefined;
  const records = matching.slice(cursorIndex + 1, cursorIndex + 1 + query.limit);
  const nextCursor = cursorIndex + 1 + query.limit < matching.length ? records.at(-1)?.id : undefined;
  return {
    schemaVersion: "account-center.audit-history.v1",
    generatedAt: new Date().toISOString(),
    records: records.map(auditRecordView),
    ...(nextCursor ? { nextCursor } : {})
  };
}

function auditQuery(path: string): AuditQuery | undefined {
  const parameters = new URL(path, "http://account-center.local").searchParams;
  if ([...parameters.keys()].some((key) => key !== "limit" && key !== "outcome" && key !== "action" && key !== "cursor") || parameters.getAll("limit").length > 1 || parameters.getAll("outcome").length > 1 || parameters.getAll("action").length > 1 || parameters.getAll("cursor").length > 1) return undefined;
  const limitValue = parameters.get("limit");
  const limit = limitValue === null ? 50 : Number(limitValue);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return undefined;
  const outcome = parameters.get("outcome");
  if (outcome !== null && !["dry_run", "started", "applied", "blocked", "failed_no_change_verified", "unproven", "recovery_required"].includes(outcome)) return undefined;
  const action = parameters.get("action");
  if (action !== null && !/^[a-z][a-z0-9._-]{0,63}$/.test(action)) return undefined;
  const cursor = parameters.get("cursor");
  if (cursor !== null && !/^audit_[a-f0-9-]{36}$/.test(cursor)) return undefined;
  return { limit, ...(outcome === null ? {} : { outcome: outcome as AuditRecord["outcome"] }), ...(action === null ? {} : { action }), ...(cursor === null ? {} : { cursor }) };
}

interface MutationOperationQuery {
  limit: number;
  outcome?: "applied" | "not_applied" | "blocked" | "failed";
  runtime?: string;
  scopeKind?: "agent" | "profile" | "session" | "default" | "all";
  cursor?: string;
}

interface RuntimeInventoryQuery { runtime?: string; }

function runtimeInventoryQuery(path: string): RuntimeInventoryQuery | undefined {
  const parameters = new URL(path, "http://account-center.local").searchParams;
  if ([...parameters.keys()].some((key) => key !== "runtime") || parameters.getAll("runtime").length > 1) return undefined;
  const runtime = parameters.get("runtime");
  if (runtime !== null && !/^[a-z][a-z0-9._-]{0,63}$/.test(runtime)) return undefined;
  return runtime === null ? {} : { runtime };
}

function authChallengeInventoryQuery(path: string): AuthChallengeInventoryQuery | undefined {
  const parameters = new URL(path, "http://account-center.local").searchParams;
  if ([...parameters.keys()].some((key) => key !== "runtime" && key !== "scope" && key !== "limit" && key !== "cursor") || ["runtime", "scope", "limit", "cursor"].some((key) => parameters.getAll(key).length > 1)) return undefined;
  const runtime = parameters.get("runtime");
  const scope = parameters.get("scope");
  const limitValue = parameters.get("limit");
  const limit = limitValue === null ? 50 : Number(limitValue);
  const cursor = parameters.get("cursor");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return undefined;
  if (runtime !== null && !/^[a-z][a-z0-9._-]{0,63}$/.test(runtime)) return undefined;
  // Scope is an exact, API-observed selector. Reject separators, whitespace, and
  // controls so it cannot be broadened or treated as an arbitrary search term.
  if (scope !== null && !/^[a-z][a-z0-9_-]{0,31}(?::[A-Za-z0-9._-]{1,96})?$/.test(scope)) return undefined;
  if (cursor !== null && !/^auth_[a-f0-9-]{36}$/.test(cursor)) return undefined;
  return { limit, ...(runtime === null ? {} : { runtime }), ...(scope === null ? {} : { scope }), ...(cursor === null ? {} : { cursor }) };
}

function mutationOperationQuery(path: string): MutationOperationQuery | undefined {
  const parameters = new URL(path, "http://account-center.local").searchParams;
  if ([...parameters.keys()].some((key) => key !== "limit" && key !== "outcome" && key !== "runtime" && key !== "scopeKind" && key !== "cursor") || ["limit", "outcome", "runtime", "scopeKind", "cursor"].some((key) => parameters.getAll(key).length > 1)) return undefined;
  const limitValue = parameters.get("limit");
  const limit = limitValue === null ? 50 : Number(limitValue);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return undefined;
  const outcome = parameters.get("outcome");
  if (outcome !== null && !["applied", "not_applied", "blocked", "failed"].includes(outcome)) return undefined;
  const runtime = parameters.get("runtime");
  if (runtime !== null && !/^[a-z][a-z0-9._-]{0,63}$/.test(runtime)) return undefined;
  const scopeKind = parameters.get("scopeKind");
  if (scopeKind !== null && !["agent", "profile", "session", "default", "all"].includes(scopeKind)) return undefined;
  const cursor = parameters.get("cursor");
  if (cursor !== null && !/^op_[A-Za-z0-9_-]{1,100}$/.test(cursor)) return undefined;
  return {
    limit,
    ...(outcome === null ? {} : { outcome: outcome as MutationOperationQuery["outcome"] }),
    ...(runtime === null ? {} : { runtime }),
    ...(scopeKind === null ? {} : { scopeKind: scopeKind as MutationOperationQuery["scopeKind"] }),
    ...(cursor === null ? {} : { cursor })
  };
}

async function mutationOperationHistory(repository: MutationRepository | undefined, query: MutationOperationQuery = { limit: 50 }): Promise<unknown | undefined> {
  const matching = repository ? (await repository.list()).slice().reverse().filter((operation) =>
    (!query.outcome || operation.outcome === query.outcome) &&
    (!query.runtime || operation.audit.runtime === query.runtime) &&
    (!query.scopeKind || operation.audit.scopeKind === query.scopeKind)
  ) : [];
  const cursorIndex = query.cursor ? matching.findIndex((operation) => operation.operationId === query.cursor) : -1;
  if (query.cursor && cursorIndex < 0) return undefined;
  const operations = matching.slice(cursorIndex + 1, cursorIndex + 1 + query.limit);
  const nextCursor = cursorIndex + 1 + query.limit < matching.length ? operations.at(-1)?.operationId : undefined;
  return {
    schemaVersion: "account-center.mutation-operations.v1",
    generatedAt: new Date().toISOString(),
    operations,
    ...(nextCursor ? { nextCursor } : {})
  };
}

function modelCatalog(status: AccountCenterStatus, runtime?: string): unknown {
  const known = new Set([...status.profiles.flatMap((profile) => profile.models), ...status.policy.disabledModels]);
  return {
    schemaVersion: "account-center.models.v1",
    generatedAt: status.generatedAt,
    models: Array.from(known).sort().map((id) => {
      const observedProfiles = status.profiles.filter((profile) => profile.models.includes(id) && (!runtime || profile.runtimeCompatibility.includes(runtime as typeof profile.runtimeCompatibility[number])));
      // Profile declarations are useful inventory evidence, but are not authoritative
      // proof that a runtime has accepted or applied a model policy.
      return {
        id,
        selectable: !status.policy.disabledModels.includes(id),
        ...(status.policy.disabledModels.includes(id) ? { reason: "disabled_by_policy" } : {}),
        observedProfileCount: observedProfiles.length,
        readableProfileCount: observedProfiles.filter((profile) => profile.usage.readable).length,
        runtimeCompatibility: Array.from(new Set(observedProfiles.flatMap((profile) => profile.runtimeCompatibility).filter((compatibleRuntime) => !runtime || compatibleRuntime === runtime as typeof compatibleRuntime))).sort(),
        verificationState: "UNPROVEN"
      };
    })
  };
}

function limitsInventory(status: AccountCenterStatus, runtime?: string): unknown {
  return {
    schemaVersion: "account-center.limits.v1",
    generatedAt: status.generatedAt,
    accounts: status.profiles.map((profile, index) => ({ profile, index })).filter(({ profile }) => !runtime || profile.runtimeCompatibility.includes(runtime as typeof profile.runtimeCompatibility[number])).map(({ profile, index }) => ({
      accountRef: `account-${index + 1}`,
      provider: profile.provider,
      health: profile.usage.health,
      authState: profile.usage.auth.state,
      readable: profile.usage.readable,
      windows: profile.usage.windows.map(({ name, remainingPct, resetsAt }) => ({ name, remainingPct, ...(resetsAt ? { resetsAt } : {}) }))
    }))
  };
}

function runtimeScopeCatalog(status: AccountCenterStatus): unknown {
  return {
    schemaVersion: "account-center.runtime-scopes.v1",
    generatedAt: status.generatedAt,
    scopes: [...status.runtimes]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((runtime) => ({
        runtime: runtime.key,
        scope: { kind: "default", id: "default" },
        capabilities: runtime.capabilities
      }))
  };
}

function statusView(status: AccountCenterStatus): AccountCenterStatus {
  // The status endpoint is an inventory view, not a runtime configuration dump.
  // Keep a stable response-local reference so route and usage observations can be
  // correlated without revealing runtime profile names, labels, or identifiers.
  const accountRefById = new Map(status.profiles.map((profile, index) => [profile.id, `account-${index + 1}`]));
  const accountRef = (profileId: string): string => accountRefById.get(profileId) ?? "account-redacted";
  const challengeProfileRef = (profileHint: string): string => {
    const profile = status.profiles.find((candidate) => candidate.id === profileHint || candidate.label === profileHint);
    return profile ? accountRef(profile.id) : "account-redacted";
  };
  return redactJson({
    ...status,
    profiles: status.profiles.map((profile) => ({
      id: accountRef(profile.id),
      provider: profile.provider,
      label: accountRef(profile.id),
      role: profile.role,
      runtimeCompatibility: profile.runtimeCompatibility,
      models: profile.models,
      disabled: profile.disabled,
      ...(profile.cooldownUntil ? { cooldownUntil: profile.cooldownUntil } : {}),
      usage: {
        profileId: accountRef(profile.id),
        provider: profile.usage.provider,
        generatedAt: profile.usage.generatedAt,
        readable: profile.usage.readable,
        health: profile.usage.health,
        windows: profile.usage.windows.map(({ name, remainingPct, resetsAt }) => ({ name, remainingPct, ...(resetsAt ? { resetsAt } : {}) })),
        auth: { state: profile.usage.auth.state },
        warnings: []
      }
    })),
    routes: status.routes.map((route) => ({
      provider: route.provider,
      runtime: route.runtime,
      activeProfileId: accountRef(route.activeProfileId),
      order: route.order.map(accountRef),
      updatedAt: route.updatedAt
    })),
    leases: [],
    reauth: status.reauth.map(({ id, provider, profileHint, expiresAt, status: challengeStatus }) => ({ id, provider, profileHint: challengeProfileRef(profileHint), expiresAt, status: challengeStatus })),
    audit: [],
    warnings: []
  }) as AccountCenterStatus;
}

function auditRecordView({ id, createdAt, action, outcome, proofState, summary, warnings }: AuditRecord) {
  return { id, createdAt, action: safeAuditAction(action), outcome, proofState, summary, warnings };
}

function safeAuditAction(action: string): string {
  return /^[a-z][a-z0-9._-]{0,63}$/.test(action) ? action : "action_redacted";
}

function authChallengeView({ id, mode, provider, runtime, scope, status, expiresAt, createdAt, updatedAt }: Awaited<ReturnType<AuthChallengeStore["create"]>>) {
  return { id, mode, provider, runtime, scope, status, ...(expiresAt ? { expiresAt } : {}), createdAt, updatedAt };
}

function endpointMethod(path: string | undefined): "GET" | "POST" | undefined {
  const pathname = path ? new URL(path, "http://account-center.local").pathname : undefined;
  if (["/api/capabilities", "/api/audit", "/api/mutation-operations", "/api/models", "/api/limits", "/api/scopes", "/api/auth-challenges", "/api/status"].includes(pathname ?? "")) return "GET";
  if (authChallengeCancelId(pathname)) return "POST";
  if (authChallengeId(pathname)) return "GET";
  return undefined;
}

function authChallengeCancelId(path: string | undefined): string | undefined {
  return path?.match(/^\/api\/auth-challenges\/(auth_[a-f0-9-]{36})\/cancel$/)?.[1];
}
function authChallengeId(path: string | undefined): string | undefined {
  return path?.match(/^\/api\/auth-challenges\/(auth_[a-f0-9-]{36})$/)?.[1];
}

function agentCapabilities(auditAvailable: boolean): unknown {
  return {
    schemaVersion: "account-center.agent-capabilities.v1",
    target: "account-center",
    transport: { loopbackOnly: true, authentication: "bearer_token", cacheControl: "no-store" },
    actions: [
      { id: "capabilities.list", mode: "read", state: "available", endpoint: { method: "GET", path: "/api/capabilities" }, requires: ["bearer_token"] },
      { id: "status", mode: "read", state: "available", endpoint: { method: "GET", path: "/api/status" }, requires: ["bearer_token"] },
      { id: "limits.list", mode: "read", state: "available", endpoint: { method: "GET", path: "/api/limits" }, requires: ["bearer_token"] },
      { id: "models.list", mode: "read", state: "available", endpoint: { method: "GET", path: "/api/models" }, requires: ["bearer_token"] },
      { id: "runtime_scopes.list", mode: "read", state: "available", endpoint: { method: "GET", path: "/api/scopes" }, requires: ["bearer_token"] },
      { id: "auth_challenges.list", mode: "read", state: "available", endpoint: { method: "GET", path: "/api/auth-challenges" }, requires: ["bearer_token"] },
      { id: "auth_challenges.detail", mode: "read", state: "available", endpoint: { method: "GET", path: "/api/auth-challenges/:id" }, requires: ["bearer_token", "opaque_challenge_id"] },
      auditAvailable
        ? { id: "auth_challenges.cancel", mode: "mutation", state: "available", endpoint: { method: "POST", path: "/api/auth-challenges/:id/cancel" }, requires: ["bearer_token", "same_origin", "opaque_challenge_id", "durable_audit_store"] }
        : { id: "auth_challenges.cancel", mode: "mutation", state: "blocked", reason: "durable_audit_store_unavailable", requires: ["bearer_token", "same_origin", "opaque_challenge_id", "durable_audit_store"] },
      { id: "audit.history", mode: "read", state: "available", endpoint: { method: "GET", path: "/api/audit" }, requires: ["bearer_token"] },
      { id: "mutation_operations.history", mode: "read", state: "available", endpoint: { method: "GET", path: "/api/mutation-operations" }, requires: ["bearer_token"] },
      { id: "account.delete", mode: "mutation", state: "blocked", reason: "no_stable_native_exact_profile_delete_api", requires: ["bearer_token", "canonical_target", "stable_native_exact_profile_delete_api", "atomic_transaction", "post_delete_authoritative_proof"] },
      { id: "routes", mode: "mutation", state: "UNPROVEN", reason: "protected_route_contract_missing_scoped_review_idempotency_runtime_proof", requires: ["bearer_token", "explicit_runtime_scope", "dry_run", "explicit_confirmation", "idempotency_key"] },
      { id: "guided_auth", mode: "mutation", state: "UNPROVEN", reason: "protected_start_contract_missing_review_idempotency_runtime_proof", requires: ["bearer_token", "explicit_runtime_scope", "explicit_confirmation", "idempotency_key"] },
      { id: "models", mode: "mutation", state: "UNPROVEN", reason: "protected_model_contract_missing_scoped_review_idempotency_runtime_proof", requires: ["bearer_token", "explicit_runtime_scope", "dry_run", "explicit_confirmation", "idempotency_key"] },
      { id: "updates", mode: "mutation", state: "blocked", reason: "macos_signed_artifact_package_supervisor_backup_restart_health_proof_missing", requires: ["bearer_token", "verified_release", "backup", "narrow_supervisor", "health_proof"] }
    ],
    rules: [
      "Agents must discover capabilities before attempting an operation.",
      "Agents must treat blocked, unsupported, failed, and UNPROVEN as non-success.",
      "Agents must not scrape the browser UI, supply shell commands, branches, URLs, tokens, or credential material.",
      "Mutations become available only through protected endpoints with explicit confirmation and idempotency handling."
    ]
  };
}

function authorized(request: IncomingMessage, token: string): boolean {
  return request.headers.authorization === `Bearer ${token}`;
}
function hasRequestBody(request: IncomingMessage): boolean {
  return request.headers["transfer-encoding"] !== undefined || (request.headers["content-length"] !== undefined && request.headers["content-length"] !== "0");
}
function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  return typeof origin === "string" && origin === `http://${request.headers.host}`;
}
function setSafetyHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Access-Control-Allow-Origin", "null");
}
function send(response: ServerResponse, code: number, body: unknown): void {
  response.statusCode = code;
  response.end(JSON.stringify(body));
}

function sendHtml(response: ServerResponse, html: string): void {
  response.statusCode = 200;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(html);
}

function controlPanelHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>Account Center · Local control plane</title>
  <style>
    :root{--bg:#0c1117;--panel:#141b23;--panel-2:#101720;--line:#2a3541;--muted:#9eabb9;--text:#edf3f8;--accent:#79d4b4;--warn:#f1bd67;--danger:#ee8290;--blue:#8ec5ff;--radius:10px;--prose:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--technical:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-family:var(--prose)}
    *{box-sizing:border-box}body{margin:0;min-width:320px;overflow-x:hidden;background:var(--bg);color:var(--text);font-size:14px;line-height:1.45}button,input,select{font:inherit}button{cursor:pointer}button:focus-visible,input:focus-visible,select:focus-visible,a:focus-visible{outline:3px solid var(--blue);outline-offset:2px}.skip{position:absolute;left:12px;top:-56px;min-height:44px;padding:11px 12px;background:var(--text);color:#000;z-index:10}.skip:focus{top:12px}.shell{max-width:1440px;min-width:0;margin:auto;padding:20px 24px 36px}.topbar{display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:1px solid var(--line);padding-bottom:17px}.eyebrow,.caption,.count,.pill,.technical{font-family:var(--technical)}.eyebrow,.caption{margin:0;color:var(--muted);font-size:11px;letter-spacing:.11em;text-transform:uppercase}.brand{display:flex;align-items:center;gap:12px;min-width:0}.mark{width:29px;height:29px;border:1px solid var(--accent);border-radius:7px;display:grid;place-items:center;color:var(--accent);font-family:var(--technical);font-weight:800}.brand h1{font-size:18px;margin:0;letter-spacing:-.03em}.local{border:1px solid #376858;border-radius:999px;padding:4px 9px;color:var(--accent);font-family:var(--technical);font-size:11px}.connection{display:grid;grid-template-columns:minmax(240px,1fr) auto;gap:16px;align-items:end;padding:18px 0}.connection h2,.section-title h2{font-size:14px;margin:0}.connection p{margin:4px 0 0;color:var(--muted);font-size:13px}.token-form{display:flex;align-items:end;gap:8px;min-width:0}.field{min-width:0;flex:1}.field label{display:block;margin-bottom:5px;color:var(--muted);font-size:12px}.field input,.field select{width:100%;min-height:44px;border:1px solid var(--line);border-radius:6px;background:#090e13;color:var(--text);padding:0 9px;font-family:var(--technical)}.primary,.quiet{min-height:44px;border-radius:6px;padding:0 12px;border:1px solid transparent;font-weight:700;font-size:12px;white-space:nowrap}.primary{background:var(--accent);color:#082119}.primary:hover{background:#a0e4cc}.primary[disabled]{opacity:.6;cursor:wait}.quiet{background:transparent;color:var(--muted);border-color:var(--line);cursor:not-allowed}.quiet:not(:disabled){cursor:pointer}.notice{display:flex;gap:9px;align-items:center;border:1px solid var(--line);border-radius:7px;background:var(--panel-2);padding:9px 11px;color:var(--muted);font-size:13px}.notice[data-state="error"]{border-color:#8b4350;color:#ffd4da}.notice[data-state="ready"]{border-color:#356b5a;color:#d0f5e8}.notice-dot{width:7px;height:7px;border-radius:50%;background:currentColor;flex:none}.dashboard{display:grid;grid-template-columns:1.05fr .95fr;gap:14px;margin-top:14px}.panel{border:1px solid var(--line);border-radius:var(--radius);background:var(--panel);min-width:0}.panel-header{display:flex;align-items:start;justify-content:space-between;gap:10px;padding:14px 15px;border-bottom:1px solid var(--line)}.section-title{display:flex;align-items:baseline;gap:9px;min-width:0}.count{color:var(--muted);font-size:11px;overflow-wrap:anywhere}.panel-body{padding:14px 15px}.health-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.metric{padding:10px;border:1px solid var(--line);border-radius:7px;background:var(--panel-2)}.metric strong{display:block;font-family:var(--technical);font-size:18px;line-height:1.1}.metric span{display:block;margin-top:4px;color:var(--muted);font-size:11px}.status-line{display:flex;align-items:center;gap:7px;font-family:var(--technical);font-size:12px;overflow-wrap:anywhere}.dot{width:7px;height:7px;border-radius:50%;background:var(--muted);flex:none}.dot.ok{background:var(--accent)}.dot.warn{background:var(--warn)}.dot.error{background:var(--danger)}.dot.unknown{background:var(--muted)}.runtime-list,.action-list{display:grid;gap:8px}.runtime-row,.action-row{display:flex;justify-content:space-between;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid var(--line)}.runtime-row:last-child,.action-row:last-child{border-bottom:0}.runtime-name{font-family:var(--technical);font-weight:700;overflow-wrap:anywhere}.runtime-meta{color:var(--muted);font-size:12px;overflow-wrap:anywhere}.pill{display:inline-flex;align-items:center;border:1px solid var(--line);border-radius:999px;padding:2px 7px;color:var(--muted);font-size:10px;letter-spacing:.05em;text-transform:uppercase;white-space:nowrap}.pill.good{border-color:#376858;color:var(--accent)}.pill.warn{border-color:#735a2c;color:#ffd58c}.wide{grid-column:1/-1}.account-records{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.account-record{min-width:0;border:1px solid var(--line);border-radius:7px;background:var(--panel-2);padding:11px}.account-name{font-family:var(--technical);font-weight:700;overflow-wrap:anywhere}.subtle{color:var(--muted);font-family:var(--technical);font-size:12px;overflow-wrap:anywhere}.account-details{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;margin:11px 0 0}.account-details div{min-width:0}.account-details dt{color:var(--muted);font-size:10px;letter-spacing:.08em;text-transform:uppercase}.account-details dd{margin:3px 0 0;font-family:var(--technical);font-size:12px;overflow-wrap:anywhere}.usage{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.bar{display:inline-block;width:46px;height:5px;background:#293440;border-radius:99px;overflow:hidden}.bar i{display:block;height:100%;background:var(--accent)}.bar i.low{background:var(--warn)}.bar i.bad{background:var(--danger)}.route-list{display:grid;gap:10px}.route{padding:10px;border-left:3px solid var(--blue);background:var(--panel-2)}.route strong{display:block;font-family:var(--technical);font-size:12px;overflow-wrap:anywhere}.route p{margin:4px 0 0;color:var(--muted);font-size:12px;overflow-wrap:anywhere}.empty{color:var(--muted);font-size:13px;padding:10px 0}.model-list{display:flex;flex-wrap:wrap;gap:6px}.model{border:1px solid var(--line);border-radius:5px;padding:4px 6px;font-family:var(--technical);font-size:11px;overflow-wrap:anywhere}.model.disabled{border-color:#75434b;color:#f3aab2;text-decoration:line-through}.action-row p{margin:2px 0 0;color:var(--muted);font-size:11px;overflow-wrap:anywhere}.footer{display:flex;justify-content:space-between;gap:12px;padding-top:14px;color:var(--muted);font-size:11px}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}@media(max-width:760px){.shell{padding:16px}.connection,.dashboard{grid-template-columns:1fr}.token-form{align-items:stretch}.health-grid,.account-records{grid-template-columns:1fr}.topbar{align-items:start}.footer{flex-direction:column}.account-details{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:430px){.shell{padding:12px}.token-form{flex-direction:column}.primary,.token-form .quiet{width:100%}.local{display:none}.panel-header,.view-heading{flex-wrap:wrap}.account-details{grid-template-columns:1fr}.runtime-row,.action-row{align-items:flex-start;flex-direction:column}.runtime-row .pill,.action-row .quiet{width:100%;justify-content:center}}@media(max-width:320px){.shell{padding:10px}.brand{gap:8px}.mark{flex:none}.panel-body,.panel-header{padding-left:11px;padding-right:11px}}
  </style>
  <style>
    .context-selector{display:flex;align-items:end;justify-content:space-between;gap:16px;margin:0 0 14px;padding:12px 14px;border:1px solid var(--line);border-radius:var(--radius);background:var(--panel)}.context-selector h2{margin:0;font-size:13px}.context-selector p{max-width:580px;margin:4px 0 0;color:var(--muted);font-size:12px}.context-selector .field{width:min(340px,100%)}.context-selector select:disabled{opacity:1;color:var(--muted);cursor:not-allowed}.tabs{display:flex;gap:8px;overflow-x:auto;overscroll-behavior-x:contain;padding:4px 0 14px}.tab{min-height:44px;border:1px solid var(--line);border-radius:6px;background:transparent;color:var(--muted);padding:0 11px;white-space:nowrap}.tab[aria-selected="true"]{border-color:#376858;color:var(--accent);background:var(--panel-2)}.view[hidden]{display:none}.view-heading{display:flex;justify-content:space-between;gap:12px;align-items:baseline;margin:4px 0 14px}.view-heading h2{font-size:16px;margin:0}.view-heading p{margin:0;color:var(--muted);font-size:13px}.record-list{display:grid;gap:8px}.record{border:1px solid var(--line);border-radius:7px;background:var(--panel-2);padding:11px;min-width:0}.record strong{display:block;font-family:var(--technical);overflow-wrap:anywhere}.record p{margin:5px 0 0;color:var(--muted);font-size:12px;overflow-wrap:anywhere}.catalog-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.secondary{margin-top:14px}.state{border-left:3px solid var(--muted)}.state[data-ui-state="blocked"],.state[data-ui-state="unproven"]{border-left-color:var(--warn)}.state[data-ui-state="error"]{border-left-color:var(--danger)}.state[data-ui-state="read-only"]{border-left-color:var(--blue)}.state[data-ui-state="loading"]{border-left-color:var(--accent)}.confirmation-dialog{width:min(520px,calc(100vw - 28px));border:1px solid var(--line);border-radius:var(--radius);background:var(--panel);color:var(--text);padding:0}.confirmation-dialog::backdrop{background:rgba(0,0,0,.72)}.confirmation-dialog form{padding:18px}.confirmation-dialog h2{margin:0;font-size:17px}.confirmation-dialog p{color:var(--muted);margin:10px 0 0}.dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}.confirmation-dialog[data-state="submitting"] .quiet{cursor:wait}@media(max-width:760px){.context-selector{align-items:stretch;flex-direction:column}.catalog-grid{grid-template-columns:1fr}.tabs{margin:0 -2px}}@media(max-width:430px){.tabs{flex-wrap:wrap;overflow-x:visible}.tab{flex:1 1 130px}.context-selector{padding:12px}.view-heading{align-items:flex-start}.dialog-actions{flex-direction:column-reverse}.dialog-actions button{width:100%}}
  </style>
</head>
<body>
  <a class="skip" href="#workspace">Skip to workspace</a>
  <main class="shell" id="workspace" tabindex="-1">
    <header class="topbar"><div class="brand"><span class="mark" aria-hidden="true">AC</span><div><p class="eyebrow">Local control plane</p><h1>Account Center</h1></div></div><span class="local">Local-only · bearer protected</span></header>
    <section class="connection" aria-labelledby="connect-heading"><div><h2 id="connect-heading">Status connection</h2><p>Use the launch token for this local server. It is used only for this request and is never displayed.</p></div><form class="token-form" id="token-form"><div class="field"><label for="token">Launch token</label><input id="token" name="token" type="password" autocomplete="off" spellcheck="false" required aria-describedby="token-help"><span id="token-help" class="sr-only">Required to load current runtime status.</span></div><button class="primary" id="refresh" type="submit">Refresh status</button></form></section>
    <p class="notice" id="notice" data-state="idle" role="status" aria-live="polite"><span class="notice-dot" aria-hidden="true"></span><span>Awaiting a launch token. No runtime data is loaded.</span></p>
    <section class="context-selector" id="context-selector" aria-labelledby="context-heading"><div><h2 id="context-heading">Operator context <span class="pill" id="context-capability">Unavailable</span></h2><p id="context-help">Scope-filtered reads are UNPROVEN until the protected API supplies them.</p></div><div class="field"><label for="runtime-scope">Runtime &amp; scope</label><span class="pill" id="context-chip" hidden aria-describedby="context-help">No readable scopes are available.</span><select id="runtime-scope" disabled aria-describedby="context-help"><option>No readable scopes are available.</option></select></div></section>
    <nav class="tabs" aria-label="Account Center views" role="tablist"><button class="tab" type="button" role="tab" tabindex="0" aria-selected="true" aria-controls="dashboard-view" id="dashboard-tab" data-tab="dashboard">Dashboard</button><button class="tab" type="button" role="tab" tabindex="-1" aria-selected="false" aria-controls="accounts-routing-view" id="accounts-routing-tab" data-tab="accounts-routing">Accounts &amp; routing</button><button class="tab" type="button" role="tab" tabindex="-1" aria-selected="false" aria-controls="guided-view" id="guided-tab" data-tab="guided">Guided auth</button><button class="tab" type="button" role="tab" tabindex="-1" aria-selected="false" aria-controls="catalogs-view" id="catalogs-tab" data-tab="catalogs">Runtime catalogs</button><button class="tab" type="button" role="tab" tabindex="-1" aria-selected="false" aria-controls="models-fallbacks-view" id="models-fallbacks-tab" data-tab="models-fallbacks">Models &amp; fallbacks</button><button class="tab" type="button" role="tab" tabindex="-1" aria-selected="false" aria-controls="audit-view" id="audit-tab" data-tab="audit">Receipts &amp; audit</button><button class="tab" type="button" role="tab" tabindex="-1" aria-selected="false" aria-controls="settings-view" id="settings-tab" data-tab="settings">Settings</button></nav>
    <section class="dashboard view" id="dashboard-view" data-view="dashboard" role="tabpanel" aria-labelledby="dashboard-tab" tabindex="-1">
      <article class="panel"><div class="panel-header"><div class="section-title"><h2>Runtime health</h2><span class="count" id="source">Not connected</span></div><span class="pill" id="freshness">Unverified</span></div><div class="panel-body"><div class="health-grid" id="metrics"><div class="metric"><strong>—</strong><span>accounts readable</span></div><div class="metric"><strong>—</strong><span>routing health</span></div><div class="metric"><strong>—</strong><span>active warnings</span></div></div><div class="runtime-list" id="runtimes"><p class="empty">Runtime capability will appear after status loads.</p></div></div></article>
      <article class="panel"><div class="panel-header"><div class="section-title"><h2>Routing</h2><span class="count" id="route-count">No routes</span></div><span class="pill warn">Read-only view</span></div><div class="panel-body"><div class="route-list" id="routes"><p class="empty">No routing state loaded.</p></div></div></article>
      <article class="panel"><div class="panel-header"><div class="section-title"><h2>Attention &amp; pending work</h2><span class="count" id="attention-count">No signals</span></div><span class="pill warn">Review</span></div><div class="panel-body"><div class="record-list" id="attention"><p class="empty">Load status to identify recovery work.</p></div></div></article>
      <article class="panel wide"><div class="panel-header"><div class="section-title"><h2>Connected accounts</h2><span class="count" id="account-count">No accounts</span></div><span class="pill">Status data</span></div><div class="panel-body"><div class="account-records" id="accounts" role="list" aria-label="Connected accounts"><p class="empty">Load status to inspect connected accounts.</p></div></div></article>
      <article class="panel"><div class="panel-header"><div class="section-title"><h2>Model policy</h2><span class="count" id="model-count">No catalog</span></div><span class="pill">Observed</span></div><div class="panel-body"><div class="model-list" id="models"><p class="empty">Models are derived from connected account status.</p></div></div></article>
      <article class="panel"><div class="panel-header"><div class="section-title"><h2>Operator actions</h2><span class="count">Capability discovery</span></div><span class="pill warn">Guarded</span></div><div class="panel-body"><div class="action-list" id="operator-actions"><p class="empty">Load status to discover protected action availability.</p></div></div></article>
    </section>
    <section class="view secondary" id="accounts-routing-view" data-view="accounts-routing" role="tabpanel" aria-labelledby="accounts-routing-tab" tabindex="-1" hidden><header class="view-heading"><div><h2>Accounts &amp; routing</h2><p>Observed connected accounts and the reported route for the selected runtime and scope.</p></div><span class="pill" id="accounts-routing-badge">Loading</span></header><div class="catalog-grid"><article class="panel"><div class="panel-header"><div class="section-title"><h2>Selected route</h2></div><span class="pill">Observed</span></div><div class="panel-body record-list" id="routing-route-state"></div></article><article class="panel"><div class="panel-header"><div class="section-title"><h2>Route controls</h2></div><span class="pill warn">Capability gated</span></div><div class="panel-body record-list" id="routing-action-state"></div></article></div><article class="panel secondary"><div class="panel-header"><div class="section-title"><h2>Connected accounts</h2></div><span class="pill">Status data</span></div><div class="panel-body record-list" id="routing-accounts-state"></div></article></section>
    <section class="view secondary" id="guided-view" data-view="guided" role="tabpanel" aria-labelledby="guided-tab" tabindex="-1" hidden><header class="view-heading"><div><h2>Guided auth</h2><p>Durable local challenge history. Starting or completing authentication is not available until runtime proof exists.</p></div><span class="pill warn" id="guided-freshness">UNPROVEN</span></header><div class="record-list" id="guided-records"><p class="empty">Load status to inspect local challenges.</p></div><section class="record-list secondary" id="guided-detail" aria-live="polite" aria-label="Guided-auth challenge detail"></section><button class="quiet secondary" id="guided-load-more" type="button" hidden>Load older guided-auth challenges</button></section>
    <section class="view secondary" id="catalogs-view" data-view="catalogs" role="tabpanel" aria-labelledby="catalogs-tab" tabindex="-1" hidden><header class="view-heading"><div><h2>Runtime catalogs</h2><p>Observed scopes and models. Catalog visibility does not grant mutation permission.</p></div><span class="pill">Observed</span></header><div class="catalog-grid"><article class="panel"><div class="panel-header"><div class="section-title"><h2>Scopes</h2></div><span class="pill">Read-only</span></div><div class="panel-body record-list" id="scope-records"><p class="empty">Load status to inspect available scopes.</p></div></article><article class="panel"><div class="panel-header"><div class="section-title"><h2>Models</h2></div><span class="pill">Read-only</span></div><div class="panel-body record-list" id="catalog-models"><p class="empty">Load status to inspect observed models.</p></div></article></div></section>
    <section class="view secondary" id="models-fallbacks-view" data-view="models-fallbacks" role="tabpanel" aria-labelledby="models-fallbacks-tab" tabindex="-1" hidden><header class="view-heading"><div><h2>Models &amp; fallbacks</h2><p>Observed catalog evidence for the selected runtime. Policy and fallback changes remain unavailable until a protected scoped mutation contract and runtime proof exist.</p></div><span class="pill" id="models-fallbacks-badge">Loading</span></header><div class="catalog-grid"><article class="panel"><div class="panel-header"><div class="section-title"><h2>Current selection</h2></div><span class="pill">Read-only</span></div><div class="panel-body record-list" id="model-policy-state"><article class="record state" data-ui-state="loading" role="status"><strong>Loading model evidence</strong><p>Loading the protected model catalog for the selected runtime.</p><span class="pill">Loading</span></article></div></article><article class="panel"><div class="panel-header"><div class="section-title"><h2>Model controls</h2></div><span class="pill warn">Capability gated</span></div><div class="panel-body record-list" id="model-action-state"><article class="record state" data-ui-state="loading" role="status"><strong>Checking model capability</strong><p>No model action is available until protected capability discovery completes.</p><span class="pill">Loading</span></article></div></article></div><article class="panel secondary"><div class="panel-header"><div class="section-title"><h2>Observed model catalog</h2></div><span class="pill">Read-only</span></div><div class="panel-body record-list" id="model-catalog-state"><p class="empty">Load status to inspect observed models.</p></div></article></section>
    <section class="view secondary" id="audit-view" data-view="audit" role="tabpanel" aria-labelledby="audit-tab" tabindex="-1" hidden><header class="view-heading"><div><h2>Receipts &amp; audit</h2><p>Redacted Account Center evidence only. This is not a raw runtime log.</p></div><span class="pill">Local evidence</span></header><div class="catalog-grid"><article class="panel"><div class="panel-header"><div class="section-title"><h2>Audit history</h2></div><span class="pill warn" id="audit-freshness">UNPROVEN</span></div><form class="token-form" id="audit-filter"><div class="field"><label for="audit-outcome">Outcome</label><select id="audit-outcome" name="outcome"><option value="">All outcomes</option><option value="applied">Applied</option><option value="dry_run">Dry run</option><option value="blocked">Blocked</option><option value="failed_no_change_verified">Failed, no change verified</option><option value="unproven">UNPROVEN</option></select></div><div class="field"><label for="audit-action">Action category</label><input id="audit-action" name="action" type="text" autocomplete="off" spellcheck="false" pattern="[a-z][a-z0-9._-]{0,63}" placeholder="For example: route.use"></div><button class="quiet" id="audit-filter-submit" type="submit">Filter audit history</button></form><div class="panel-body record-list" id="audit-records"><p class="empty">Load status to inspect recorded actions.</p></div><button class="quiet secondary" id="audit-load-more" type="button" hidden>Load older audit records</button></article><article class="panel"><div class="panel-header"><div class="section-title"><h2>Operation history</h2></div><span class="pill warn" id="operation-freshness">UNPROVEN</span></div><p class="caption">Filtered to the selected runtime and scope kind when a readable context is available.</p><form class="token-form" id="operation-filter"><div class="field"><label for="operation-outcome">Outcome</label><select id="operation-outcome" name="outcome"><option value="">All outcomes</option><option value="applied">Applied</option><option value="not_applied">Not applied</option><option value="blocked">Blocked</option><option value="failed">Failed</option></select></div><button class="quiet" id="operation-filter-submit" type="submit">Filter operation history</button></form><div class="panel-body record-list" id="operation-records"><p class="empty">Load status to inspect protected operations.</p></div><button class="quiet secondary" id="operation-load-more" type="button" hidden>Load older protected operations</button></article></div></section>
    <section class="view secondary" id="settings-view" data-view="settings" role="tabpanel" aria-labelledby="settings-tab" tabindex="-1" hidden><header class="view-heading"><div><h2>Settings / Update Center</h2><p>Account Center release information only. This surface cannot update Codex, Hermes, or OpenClaw.</p></div><span class="pill warn">Protected</span></header><div class="catalog-grid"><article class="panel"><div class="panel-header"><div class="section-title"><h2>Release status</h2></div><span class="pill">Read API required</span></div><div class="panel-body record-list" id="update-release-state"></div></article><article class="panel"><div class="panel-header"><div class="section-title"><h2>Update Center</h2></div><span class="pill warn">No mutation</span></div><div class="panel-body record-list" id="update-action-state"></div></article></div></section>
    <dialog class="confirmation-dialog" id="cancel-challenge-dialog" aria-labelledby="cancel-challenge-heading" aria-describedby="cancel-challenge-description"><form method="dialog"><h2 id="cancel-challenge-heading" tabindex="-1">Cancel guided-auth challenge?</h2><p id="cancel-challenge-description">This cancels only Account Center's local guided-auth challenge record. It does not delete or change runtime credentials.</p><p id="cancel-challenge-status" class="sr-only" role="status" aria-live="polite"></p><div class="dialog-actions"><button class="quiet" id="cancel-challenge-dismiss" type="button">Keep challenge</button><button class="primary" id="cancel-challenge-confirm" type="button">Cancel local challenge</button></div></form></dialog>
    <footer class="footer"><span id="updated">No successful status request yet.</span><span>Status payloads are expected to contain no secrets.</span></footer>
  </main>
  <script>
    (function () {
      var form = document.getElementById('token-form'); var token = document.getElementById('token'); var refresh = document.getElementById('refresh'); var notice = document.getElementById('notice');
      var source = document.getElementById('source'); var freshness = document.getElementById('freshness'); var metrics = document.getElementById('metrics'); var runtimes = document.getElementById('runtimes'); var routes = document.getElementById('routes'); var accounts = document.getElementById('accounts'); var models = document.getElementById('models'); var attention = document.getElementById('attention'); var attentionCount = document.getElementById('attention-count'); var operatorActions = document.getElementById('operator-actions'); var contextSelector = document.getElementById('context-selector'); var contextHelp = document.getElementById('context-help'); var contextCapability = document.getElementById('context-capability'); var contextChip = document.getElementById('context-chip'); var runtimeScope = document.getElementById('runtime-scope'); var selectedContext = ''; var latestStatus;
      var guidedRecords = document.getElementById('guided-records'); var guidedDetail = document.getElementById('guided-detail'); var guidedFreshness = document.getElementById('guided-freshness'); var guidedLoadMore = document.getElementById('guided-load-more'); var challengeCursor = ''; var scopeRecords = document.getElementById('scope-records'); var catalogModels = document.getElementById('catalog-models'); var modelsFallbacksBadge = document.getElementById('models-fallbacks-badge'); var modelPolicyState = document.getElementById('model-policy-state'); var modelActionState = document.getElementById('model-action-state'); var modelCatalogState = document.getElementById('model-catalog-state'); var auditRecords = document.getElementById('audit-records'); var auditFreshnessBadge = document.getElementById('audit-freshness'); var auditLoadMore = document.getElementById('audit-load-more'); var auditCursor = ''; var operationRecords = document.getElementById('operation-records'); var operationFreshnessBadge = document.getElementById('operation-freshness'); var operationLoadMore = document.getElementById('operation-load-more'); var operationCursor = ''; var auditFilter = document.getElementById('audit-filter'); var auditOutcome = document.getElementById('audit-outcome'); var auditAction = document.getElementById('audit-action'); var auditFilterSubmit = document.getElementById('audit-filter-submit'); var operationFilter = document.getElementById('operation-filter'); var operationOutcome = document.getElementById('operation-outcome'); var operationFilterSubmit = document.getElementById('operation-filter-submit'); var accountsRoutingBadge = document.getElementById('accounts-routing-badge'); var routingRouteState = document.getElementById('routing-route-state'); var routingActionState = document.getElementById('routing-action-state'); var routingAccountsState = document.getElementById('routing-accounts-state'); var updateReleaseState = document.getElementById('update-release-state'); var updateActionState = document.getElementById('update-action-state'); var cancelChallengeDialog = document.getElementById('cancel-challenge-dialog'); var cancelChallengeHeading = document.getElementById('cancel-challenge-heading'); var cancelChallengeStatus = document.getElementById('cancel-challenge-status'); var cancelChallengeDismiss = document.getElementById('cancel-challenge-dismiss'); var cancelChallengeConfirm = document.getElementById('cancel-challenge-confirm'); var cancelChallengeId = ''; var cancelChallengeTrigger; var cancellationInFlight = false;
      var tabs = Array.prototype.slice.call(document.querySelectorAll('[data-tab]')); var views = Array.prototype.slice.call(document.querySelectorAll('[data-view]'));
      function selectView(name, focusPanel) { tabs.forEach(function (tab) { var selected = tab.dataset.tab === name; tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1; }); views.forEach(function (view) { view.hidden = view.dataset.view !== name; }); if (focusPanel !== false) document.getElementById(name + '-view').focus({ preventScroll: true }); }
      tabs.forEach(function (tab, index) { tab.addEventListener('click', function () { selectView(tab.dataset.tab); }); tab.addEventListener('keydown', function (event) { var targetIndex = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1; if (targetIndex < 0) return; event.preventDefault(); var target = tabs[targetIndex]; selectView(target.dataset.tab, false); target.focus(); }); });
      function text(value) { return String(value == null ? '—' : value); }

      function escapeHtml(value) { var box = document.createElement('span'); box.textContent = text(value); return box.innerHTML; }
      function setNotice(message, state) { notice.dataset.state = state; notice.lastElementChild.textContent = message; }
      function restoreCancelChallengeFocus() { if (cancelChallengeTrigger && document.contains(cancelChallengeTrigger)) cancelChallengeTrigger.focus(); cancelChallengeTrigger = undefined; }
      function closeCancelChallengeDialog(restoreFocus) { if (cancellationInFlight) return; if (cancelChallengeDialog.open) cancelChallengeDialog.close(); cancelChallengeId = ''; cancelChallengeStatus.textContent = ''; if (restoreFocus) restoreCancelChallengeFocus(); }
      function dialogControls() { return Array.prototype.slice.call(cancelChallengeDialog.querySelectorAll('button:not([disabled])')); }
      function openCancelChallengeDialog(id, trigger) { if (!id || cancellationInFlight) return; cancelChallengeId = id; cancelChallengeTrigger = trigger; cancelChallengeDismiss.disabled = false; cancelChallengeConfirm.disabled = false; cancelChallengeConfirm.textContent = 'Cancel local challenge'; cancelChallengeDialog.dataset.state = 'ready'; cancelChallengeStatus.textContent = ''; cancelChallengeDialog.showModal(); cancelChallengeHeading.focus(); }
      async function confirmCancelChallenge() { if (!cancelChallengeId || cancellationInFlight) return; cancellationInFlight = true; cancelChallengeDialog.dataset.state = 'submitting'; cancelChallengeDismiss.disabled = true; cancelChallengeConfirm.disabled = true; cancelChallengeConfirm.textContent = 'Cancelling…'; cancelChallengeStatus.textContent = 'Cancelling the local guided-auth challenge.'; setNotice('Cancelling the pending guided-auth challenge…', 'loading'); try { await api('/api/auth-challenges/' + encodeURIComponent(cancelChallengeId) + '/cancel', { method: 'POST' }); var incomplete = await loadWorkspace(); cancellationInFlight = false; closeCancelChallengeDialog(false); setNotice(incomplete ? 'Guided-auth challenge cancelled; some evidence is UNPROVEN.' : 'Guided-auth challenge cancelled. No credentials were changed.', incomplete ? 'error' : 'ready'); } catch (_) { cancellationInFlight = false; cancelChallengeDialog.dataset.state = 'ready'; cancelChallengeDismiss.disabled = false; cancelChallengeConfirm.disabled = false; cancelChallengeConfirm.textContent = 'Cancel local challenge'; cancelChallengeStatus.textContent = 'Cancellation could not be verified. You can keep the challenge or retry cancellation.'; cancelChallengeHeading.focus(); setNotice('The guided-auth challenge could not be cancelled. Refresh to verify its state.', 'error'); } }
      cancelChallengeDismiss.addEventListener('click', function () { closeCancelChallengeDialog(true); });
      cancelChallengeConfirm.addEventListener('click', confirmCancelChallenge);
      cancelChallengeDialog.addEventListener('cancel', function (event) { event.preventDefault(); if (!cancellationInFlight) closeCancelChallengeDialog(true); });
      cancelChallengeDialog.addEventListener('click', function (event) { if (event.target === cancelChallengeDialog && !cancellationInFlight) closeCancelChallengeDialog(true); });
      cancelChallengeDialog.addEventListener('keydown', function (event) { if (event.key !== 'Tab') return; var controls = dialogControls(); if (!controls.length) return; var first = controls[0]; var last = controls[controls.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } });
      // A shared, truthful state renderer. Destinations only choose an allowed state
      // from protected data; it never upgrades unavailable evidence to success.
      function renderViewState(target, state, title, detail, actionLabel) { var allowed = ['loading', 'empty', 'error', 'blocked', 'read-only', 'unproven']; var safeState = allowed.indexOf(state) === -1 ? 'unproven' : state; var badge = safeState === 'unproven' ? 'UNPROVEN' : safeState === 'read-only' ? 'Read-only' : safeState.charAt(0).toUpperCase() + safeState.slice(1); target.innerHTML = '<article class="record state" data-ui-state="' + safeState + '" role="status"><strong>' + escapeHtml(title) + '</strong><p>' + escapeHtml(detail) + '</p><span class="pill ' + (safeState === 'blocked' || safeState === 'unproven' ? 'warn' : '') + '">' + escapeHtml(badge) + '</span>' + (actionLabel ? '<button class="quiet retry-workspace" type="button">' + escapeHtml(actionLabel) + '</button>' : '') + '</article>'; }
      function selectedRuntime() { return selectedContext ? selectedContext.split('|')[0] : ''; }
      function selectedRuntimeQuery() { var runtime = selectedRuntime(); return runtime ? '?runtime=' + encodeURIComponent(runtime) : ''; }
      function selectedScopeQuery() { var runtime = selectedRuntime(); var scope = selectedContext ? selectedContext.split('|').slice(1).join('|') : ''; var parameters = new URLSearchParams(); if (runtime) parameters.set('runtime', runtime); if (scope) parameters.set('scope', scope); var query = parameters.toString(); return query ? '?' + query : ''; }
      function selectedScopeKind() { return selectedContext ? selectedContext.split('|')[1].split(':')[0] : ''; }
      function actionById(capabilityData, id) { var actions = capabilityData && Array.isArray(capabilityData.actions) ? capabilityData.actions : []; return actions.filter(function (action) { return action.id === id; })[0]; }
      function actionReason(action, fallback) { return action && action.reason ? action.reason.replaceAll('_', ' ') : fallback; }
      function renderAccountsRouting(capabilityData, unavailable) { var runtime = selectedRuntime(); var route = latestStatus && Array.isArray(latestStatus.routes) ? latestStatus.routes.filter(function (item) { return item.runtime === runtime; })[0] : undefined; var profiles = latestStatus && Array.isArray(latestStatus.profiles) ? latestStatus.profiles.filter(function (profile) { return !runtime || Array.isArray(profile.runtimeCompatibility) && profile.runtimeCompatibility.indexOf(runtime) !== -1; }) : []; var routeAction = actionById(capabilityData, 'routes'); if (!latestStatus) { accountsRoutingBadge.textContent = 'Loading'; renderViewState(routingRouteState, 'loading', 'Loading Accounts & routing', 'Load protected runtime status to inspect the selected context.'); renderViewState(routingActionState, 'loading', 'Checking route capability', 'No route action is available until capability discovery completes.'); renderViewState(routingAccountsState, 'loading', 'Loading connected accounts', 'Account status has not been requested.'); return; } accountsRoutingBadge.textContent = runtime ? 'Observed ' + runtime : 'UNPROVEN'; if (!runtime) renderViewState(routingRouteState, 'unproven', 'Selected context is unavailable', 'No readable runtime scope was supplied by the protected API.', 'Retry workspace data'); else if (!route) renderViewState(routingRouteState, 'empty', 'No route reported', 'The protected status response reports no route for ' + runtime + '. This does not prove routing is disabled.'); else routingRouteState.innerHTML = record(routingRouteState, route.provider + ' → ' + route.runtime, 'Active: ' + (route.activeProfileId || 'Not reported') + ' · ' + (route.order || []).length + ' account(s) in API-reported order.', 'read-only'); if (unavailable.capabilities) renderViewState(routingActionState, 'unproven', 'Route capability unavailable', 'The protected capability response could not be verified.', 'Retry workspace data'); else if (!routeAction) renderViewState(routingActionState, 'unproven', 'Route capability not reported', 'No protected route operation contract was supplied.'); else if (routeAction.state === 'available') renderViewState(routingActionState, 'read-only', 'Route mutation is not rendered here', 'A capability exists, but this UI slice exposes no route mutation.'); else renderViewState(routingActionState, routeAction.state === 'blocked' ? 'blocked' : 'unproven', 'Route changes unavailable', actionReason(routeAction, 'The selected route cannot be changed safely.')); if (!profiles.length) renderViewState(routingAccountsState, 'empty', 'No connected accounts reported', 'No connected accounts were reported as compatible with the selected runtime.'); else routingAccountsState.innerHTML = profiles.map(function (profile) { var usage = profile.usage || {}; return record(routingAccountsState, profile.label || profile.id, 'Auth: ' + ((usage.auth || {}).state || 'Not reported') + ' · Health: ' + (usage.health || 'Not reported') + ' · Routing role: ' + (profile.role || 'Not reported'), usage.readable ? 'read-only' : 'UNPROVEN'); }).join(''); }
      function renderSettings(capabilityData, unavailable) { var updates = actionById(capabilityData, 'updates'); if (unavailable.capabilities) { renderViewState(updateReleaseState, 'unproven', 'Release status unavailable', 'The protected capability response could not be verified.', 'Retry workspace data'); renderViewState(updateActionState, 'unproven', 'Update Center unavailable', 'No protected update capability can be established.'); return; } renderViewState(updateReleaseState, 'empty', 'No verified release status reported', 'A protected read API for Account Center release provenance is not available. No release is eligible for Apply.'); if (!updates) renderViewState(updateActionState, 'unproven', 'Update capability not reported', 'No protected update operation contract was supplied.'); else renderViewState(updateActionState, updates.state === 'blocked' ? 'blocked' : updates.state === 'available' ? 'read-only' : 'unproven', 'Update Center is unavailable', actionReason(updates, 'Account Center updates require a protected, verified release flow.')); }
      function renderModelsFallbacks(modelData, unavailable) { var runtime = selectedRuntime(); var catalog = modelData && Array.isArray(modelData.models) ? modelData.models : []; if (unavailable) { modelsFallbacksBadge.textContent = 'UNPROVEN'; renderViewState(modelPolicyState, 'unproven', 'Model evidence unavailable', 'The protected model catalog could not be verified.', 'Retry workspace data'); renderViewState(modelActionState, 'unproven', 'Model policy is UNPROVEN', 'No protected scoped model mutation contract could be verified.'); modelCatalogState.innerHTML = unavailableRecord('Model catalog'); return; } modelsFallbacksBadge.textContent = runtime ? 'Read-only ' + runtime : 'Read-only'; renderViewState(modelPolicyState, 'read-only', 'Current model selection is not reported', 'Requested policy: Not reported. Effective runtime model: Not reported. Fallback chain: Not reported. The observed catalog does not establish applied runtime configuration.'); renderViewState(modelActionState, 'unproven', 'Model policy is UNPROVEN', 'Model selection and fallback changes are unavailable until a protected scoped mutation contract and runtime proof exist.'); modelCatalogState.innerHTML = catalog.length ? catalog.map(function (item) { var state = item.selectable ? 'UNPROVEN' : item.reason || 'blocked'; var compatibility = Array.isArray(item.runtimeCompatibility) && item.runtimeCompatibility.length ? item.runtimeCompatibility.join(', ') : 'Not reported'; return record(modelCatalogState, item.id, 'Compatible runtimes: ' + compatibility + '. Verification: ' + (item.verificationState || 'UNPROVEN') + '.', state); }).join('') : '<p class="empty">No observed models were reported for this runtime.</p>'; }
      function healthClass(value) { return value === 'ok' ? 'ok' : value === 'warn' ? 'warn' : value === 'error' ? 'error' : 'unknown'; }
      function percent(value) { return typeof value === 'number' ? Math.max(0, Math.min(100, value)) : 0; }
      function capability(runtime) { var c = runtime.capabilities || {}; var labels = []; if (c.readStatus) labels.push('status'); if (c.mutateRoutes) labels.push('routes'); if (c.startReauth) labels.push('reauth'); if (c.mutateModels) labels.push('models'); return labels.length ? labels.join(' · ') : 'no capabilities reported'; }
      async function api(path, init) { var response = await fetch(path, { method: init && init.method || 'GET', credentials: 'same-origin', headers: { authorization: 'Bearer ' + token.value } }); if (!response.ok) { var error = new Error(response.status === 401 ? 'Launch token rejected' : 'Local API request failed (' + response.status + ')'); error.status = response.status; throw error; } return response.json(); }
      function record(target, title, detail, badge) { return '<article class="record"><strong>' + escapeHtml(title) + '</strong><p>' + escapeHtml(detail) + '</p><span class="pill">' + escapeHtml(badge || 'observed') + '</span></article>'; }
      function auditRecord(item) { var action = item && typeof item.action === 'string' ? item.action : 'Audit action not reported'; var summary = item && typeof item.summary === 'string' ? item.summary : 'No summary supplied.'; var outcome = item && typeof item.outcome === 'string' ? item.outcome : 'UNPROVEN'; var proof = item && typeof item.proofState === 'string' ? item.proofState : 'UNPROVEN'; var recorded = item && typeof item.createdAt === 'string' ? item.createdAt : 'Not reported'; var auditId = item && typeof item.id === 'string' ? item.id : 'Not reported'; var warnings = item && Array.isArray(item.warnings) ? item.warnings.length : 0; return '<article class="record"><strong>' + escapeHtml(action) + '</strong><p>' + escapeHtml(summary) + '</p><p>Recorded: ' + escapeHtml(recorded) + ' · Proof: ' + escapeHtml(proof) + ' · Warnings: ' + escapeHtml(warnings) + ' · Audit ID: ' + escapeHtml(auditId) + '</p><span class="pill">' + escapeHtml(outcome) + '</span></article>'; }
      function operationRecord(item) { var operationId = item && typeof item.operationId === 'string' ? item.operationId : 'Operation ID not reported'; var audit = item && item.audit && typeof item.audit === 'object' ? item.audit : {}; var action = typeof audit.action === 'string' ? audit.action : 'Protected operation'; var provider = typeof audit.provider === 'string' ? audit.provider : 'provider not reported'; var runtime = typeof audit.runtime === 'string' ? audit.runtime : 'runtime not reported'; var scopeKind = typeof audit.scopeKind === 'string' ? audit.scopeKind : 'scope kind not reported'; var outcome = item && typeof item.outcome === 'string' ? item.outcome : 'UNPROVEN'; var state = item && typeof item.state === 'string' ? item.state : 'UNPROVEN'; var completed = item && typeof item.completedAt === 'string' ? item.completedAt : 'Not reported'; var warnings = Array.isArray(audit.warningCodes) ? audit.warningCodes.length : 0; return '<article class="record"><strong>' + escapeHtml(action) + '</strong><p>Provider: ' + escapeHtml(provider) + ' · Runtime: ' + escapeHtml(runtime) + ' · Scope: ' + escapeHtml(scopeKind) + '</p><p>Operation ID: ' + escapeHtml(operationId) + ' · Completed: ' + escapeHtml(completed) + ' · Warnings: ' + escapeHtml(warnings) + '</p><span class="pill">' + escapeHtml(outcome + ' · ' + state) + '</span></article>'; }
      function scopeLabel(scope) { return scope && typeof scope === 'object' && typeof scope.kind === 'string' && typeof scope.id === 'string' ? scope.kind + ':' + scope.id : typeof scope === 'string' ? scope : 'scope not reported'; }
      function contextValue(item) { return item.runtime + '|' + scopeLabel(item.scope); }
      function contextOption(item) { return '<option value="' + escapeHtml(contextValue(item)) + '">' + escapeHtml(item.runtime + ' / ' + scopeLabel(item.scope)) + '</option>'; }
      function contextCapabilityLabel(capabilities) { if (!capabilities || capabilities.readStatus !== true) return 'UNPROVEN'; return capabilities.mutateRoutes || capabilities.startReauth || capabilities.mutateModels ? 'Declared actions' : 'Read-only'; }
      function contextCapabilityDetail(item) { var capabilities = item && item.capabilities || {}; if (capabilities.readStatus !== true) return 'This scope has no verified readable status capability.'; var actions = []; if (capabilities.mutateRoutes) actions.push('routing'); if (capabilities.startReauth) actions.push('guided authentication'); if (capabilities.mutateModels) actions.push('model policy'); return actions.length ? 'Readable status; declared ' + actions.join(', ') + ' capability. Each action remains gated by its protected API result.' : 'Readable status only. Routing, guided authentication, and model changes are not declared for this scope.'; }
      function renderContextSelector(scopeData, scopesUnavailable) { var scopes = scopeData && Array.isArray(scopeData.scopes) ? scopeData.scopes.filter(function (item) { return item && typeof item.runtime === 'string' && item.scope && item.capabilities && item.capabilities.readStatus === true; }) : []; if (scopesUnavailable || !scopes.length) { runtimeScope.disabled = true; runtimeScope.hidden = false; contextChip.hidden = true; runtimeScope.innerHTML = '<option>No readable scopes are available.</option>'; selectedContext = ''; contextCapability.textContent = scopesUnavailable ? 'UNPROVEN' : 'Unavailable'; contextHelp.textContent = scopesUnavailable ? 'The protected scope catalog could not be verified. Scoped actions remain unavailable.' : 'No readable scopes were supplied by the protected API. Scoped actions remain unavailable.'; contextSelector.dataset.state = scopesUnavailable ? 'unproven' : 'empty'; return; } var prior = scopes.some(function (item) { return contextValue(item) === selectedContext; }) ? selectedContext : contextValue(scopes[0]); runtimeScope.innerHTML = scopes.map(contextOption).join(''); runtimeScope.value = prior; selectedContext = runtimeScope.value; var selected = scopes.filter(function (item) { return contextValue(item) === selectedContext; })[0]; contextCapability.textContent = contextCapabilityLabel(selected.capabilities); contextHelp.textContent = contextCapabilityDetail(selected); runtimeScope.disabled = false; runtimeScope.hidden = scopes.length === 1; contextChip.hidden = scopes.length !== 1; if (scopes.length === 1) { contextChip.textContent = selected.runtime + ' / ' + scopeLabel(selected.scope); contextChip.setAttribute('aria-label', 'Runtime and scope: ' + contextChip.textContent); } contextSelector.dataset.state = scopes.length === 1 ? 'single' : 'multiple'; }
      function challengeFreshness(challengeData) { var generatedAt = challengeData && typeof challengeData.generatedAt === 'string' ? challengeData.generatedAt : ''; var timestamp = generatedAt && !Number.isNaN(Date.parse(generatedAt)) ? generatedAt : ''; guidedFreshness.textContent = timestamp ? 'Server snapshot: ' + new Date(timestamp).toLocaleString() : 'UNPROVEN'; guidedFreshness.className = timestamp ? 'pill good' : 'pill warn'; }
      function auditFreshness(auditData) { var generatedAt = auditData && typeof auditData.generatedAt === 'string' ? auditData.generatedAt : ''; var timestamp = generatedAt && !Number.isNaN(Date.parse(generatedAt)) ? generatedAt : ''; auditFreshnessBadge.textContent = timestamp ? 'Audit snapshot: ' + new Date(timestamp).toLocaleString() : 'UNPROVEN'; auditFreshnessBadge.className = timestamp ? 'pill good' : 'pill warn'; }
      function operationFreshness(operationData) { var generatedAt = operationData && typeof operationData.generatedAt === 'string' ? operationData.generatedAt : ''; var timestamp = generatedAt && !Number.isNaN(Date.parse(generatedAt)) ? generatedAt : ''; operationFreshnessBadge.textContent = timestamp ? 'Operation snapshot: ' + new Date(timestamp).toLocaleString() : 'UNPROVEN'; operationFreshnessBadge.className = timestamp ? 'pill good' : 'pill warn'; }
      function challengeRecord(item) { var cancel = item.status === 'pending' ? '<button class="quiet cancel-challenge" type="button" data-challenge-id="' + escapeHtml(item.id) + '" aria-label="Cancel pending challenge">Cancel pending challenge</button>' : ''; return '<article class="record"><strong>' + escapeHtml(item.mode + ' · ' + item.provider) + '</strong><p>' + escapeHtml(item.runtime + ' · ' + scopeLabel(item.scope)) + '</p><span class="pill">' + escapeHtml(item.status) + '</span><button class="quiet view-challenge" type="button" data-challenge-id="' + escapeHtml(item.id) + '" aria-label="View challenge details">View challenge details</button>' + cancel + '</article>'; }
      function isChallengeDetail(challenge) { var fields = ['id', 'mode', 'provider', 'runtime', 'scope', 'status', 'expiresAt', 'createdAt', 'updatedAt']; if (!challenge || typeof challenge !== 'object' || Object.keys(challenge).some(function (key) { return fields.indexOf(key) === -1; })) return false; var scope = challenge.scope; // scope is an exact redacted API selector, not a browser-owned scope object.
        return typeof challenge.id === 'string' && /^auth_[a-f0-9-]{36}$/.test(challenge.id) && (challenge.mode === 'add' || challenge.mode === 'reauth') && typeof challenge.provider === 'string' && typeof challenge.runtime === 'string' && typeof scope === 'string' && /^[a-z][a-z0-9_-]{0,31}(?::[A-Za-z0-9._-]{1,96})?$/.test(scope) && ['pending', 'completed', 'failed', 'cancelled', 'expired'].indexOf(challenge.status) !== -1 && typeof challenge.createdAt === 'string' && typeof challenge.updatedAt === 'string' && (!challenge.expiresAt || typeof challenge.expiresAt === 'string'); }
      function challengeDetailState(challenge) { var states = { pending: { badge: 'Pending', detail: 'Pending — complete verification outside Account Center. No credentials are held in this browser.' }, completed: { badge: 'Completed', detail: 'Completed — runtime routing verification is not reported by this read-only challenge record.' }, failed: { badge: 'Failed', detail: 'Failed — inspect a protected receipt when one is supplied; retry is unavailable until the protected API supports it.' }, cancelled: { badge: 'Cancelled', detail: 'Cancelled — no credentials were changed by cancellation.' }, expired: { badge: 'Expired', detail: 'Expired — start a new guided-auth challenge only when the protected API supports it.' } }; return states[challenge.status] || { badge: 'UNPROVEN', detail: 'UNPROVEN — guided-auth lifecycle state is not recognized.' }; }
      function renderChallengeDetail(challenge) { if (!isChallengeDetail(challenge)) { guidedDetail.innerHTML = '<article class="record state" data-ui-state="unproven" role="status"><strong>UNPROVEN — data unavailable</strong><p>Guided-auth challenge detail was malformed or incomplete. Refresh the challenge inventory and try again.</p><span class="pill warn">UNPROVEN</span></article>'; return; } var expiry = challenge.expiresAt ? 'Expires: ' + challenge.expiresAt : 'Expiry not reported'; var state = challengeDetailState(challenge); guidedDetail.innerHTML = '<article class="record"><strong>Challenge detail</strong><p>' + escapeHtml(challenge.mode) + ' · ' + escapeHtml(challenge.provider) + ' · ' + escapeHtml(challenge.runtime) + ' · ' + escapeHtml(scopeLabel(challenge.scope)) + '</p><p>' + escapeHtml(expiry) + ' · Created: ' + escapeHtml(challenge.createdAt) + ' · Updated: ' + escapeHtml(challenge.updatedAt) + '</p><p>' + escapeHtml(state.detail) + '</p><span class="pill">' + escapeHtml(state.badge) + '</span></article>'; }
      async function loadChallengeDetail(id) { return api('/api/auth-challenges/' + encodeURIComponent(id)); }
      function unavailableRecord(label) { return '<article class="record" role="status"><strong>UNPROVEN — data unavailable</strong><p>' + escapeHtml(label) + ' could not be verified. Previously loaded evidence is not shown as current.</p><button class="quiet retry-workspace" type="button">Retry workspace data</button></article>'; }
      function renderAttention(challengeData, challengesUnavailable) { if (!latestStatus) return; var signals = []; var profiles = Array.isArray(latestStatus.profiles) ? latestStatus.profiles : []; profiles.forEach(function (profile) { var usage = profile.usage || {}; var firstWindow = usage.windows && usage.windows[0] || {}; if (usage.health === 'error' || usage.auth && usage.auth.state === 'reauth-needed') signals.push({ title: 'Authentication needs attention', detail: profile.label || profile.id, badge: 'reauth-needed' }); else if (!usage.readable || firstWindow.remainingPct == null || firstWindow.remainingPct < 10) signals.push({ title: 'Capacity needs review', detail: profile.label || profile.id, badge: firstWindow.remainingPct == null ? 'unreadable' : firstWindow.remainingPct + '% remaining' }); }); (latestStatus.warnings || []).forEach(function (warning) { signals.push({ title: 'Runtime warning', detail: warning, badge: 'review' }); }); if (challengesUnavailable) signals.push({ title: 'Guided-auth evidence is UNPROVEN', detail: 'Refresh workspace data before treating challenge status as current.', badge: 'unproven' }); else { var pending = challengeData && challengeData.challenges || []; pending.filter(function (item) { return item.status === 'pending'; }).forEach(function (item) { signals.push({ title: 'Pending guided auth', detail: item.mode + ' · ' + item.provider + ' · ' + item.runtime + ' · ' + scopeLabel(item.scope), badge: 'pending', guided: true }); }); } attentionCount.textContent = signals.length ? signals.length + (signals.length === 1 ? ' signal' : ' signals') : 'No signals'; attention.innerHTML = signals.length ? signals.map(function (item) { return '<article class="record"><strong>' + escapeHtml(item.title) + '</strong><p>' + escapeHtml(item.detail) + '</p><span class="pill">' + escapeHtml(item.badge) + '</span>' + (item.guided ? '<button class="quiet view-guided" type="button">View guided auth</button>' : '') + '</article>'; }).join('') : '<p class="empty">No recovery work is currently reported by verified local evidence.</p>'; }
      function renderOperatorActions(capabilityData, unavailable) { var names = { routes: 'Switch route', guided_auth: 'Start guided auth', models: 'Change model policy', 'account.delete': 'Delete credentials', updates: 'Update Account Center' }; if (unavailable) { operatorActions.innerHTML = unavailableRecord('Action capability contract'); return; } var actions = capabilityData && capabilityData.actions || []; operatorActions.innerHTML = Object.keys(names).map(function (id) { var action = actions.filter(function (item) { return item.id === id; })[0]; var state = action && action.state || 'UNPROVEN'; var reason = action && action.reason ? action.reason.replaceAll('_', ' ') : 'No protected action contract was reported.'; return '<div class="action-row"><div><strong>' + escapeHtml(names[id]) + '</strong><p>' + escapeHtml(reason) + '</p></div><button class="quiet" type="button" disabled>' + escapeHtml(state) + '</button></div>'; }).join(''); }
      function renderLimits(limitData, limitsUnavailable) { if (limitsUnavailable) return; var limitAccounts = limitData && Array.isArray(limitData.accounts) ? limitData.accounts.filter(function (item) { return item && typeof item.accountRef === 'string' && typeof item.provider === 'string' && Array.isArray(item.windows); }) : []; document.getElementById('account-count').textContent = limitAccounts.length + (limitAccounts.length === 1 ? ' account' : ' accounts'); accounts.innerHTML = limitAccounts.length ? limitAccounts.map(function (item) { var windowText = item.windows.map(function (window) { return text(window.name) + ': ' + (window.remainingPct == null ? 'unreadable' : text(window.remainingPct) + '% remaining') + (window.resetsAt ? ' · resets ' + text(window.resetsAt) : ''); }).join(' · '); return '<article class="account-record" role="listitem"><div class="account-name">' + escapeHtml(item.accountRef) + '</div><dl class="account-details"><div><dt>Provider</dt><dd>' + escapeHtml(item.provider) + '</dd></div><div><dt>Health / auth</dt><dd>' + escapeHtml(text(item.health)) + ' · ' + escapeHtml(text(item.authState)) + '</dd></div><div><dt>Capacity</dt><dd>' + escapeHtml(windowText || 'Not reported') + '</dd></div><div><dt>Proof</dt><dd>' + (item.readable === true ? 'Observed readable status' : 'UNPROVEN — unreadable status') + '</dd></div></dl></article>'; }).join('') : '<p class="empty">No account limits were reported by the protected API.</p>'; }
      function renderWorkspace(data, unavailable) {
        renderContextSelector(data.scopes, unavailable.scopes);
        renderAttention(data.challenges, unavailable.challenges);
        renderLimits(data.limits, unavailable.limits);
        renderModelsFallbacks(data.models, unavailable.models);
        renderOperatorActions(data.capabilities, unavailable.capabilities);
        renderAccountsRouting(data.capabilities, unavailable);
        renderSettings(data.capabilities, unavailable);
        challengeFreshness(unavailable.challenges ? undefined : data.challenges);
        auditFreshness(unavailable.audit ? undefined : data.audit);
        operationFreshness(unavailable.operations ? undefined : data.operations);
        var challenges = data.challenges && data.challenges.challenges || []; challengeCursor = !unavailable.challenges && data.challenges && typeof data.challenges.nextCursor === 'string' ? data.challenges.nextCursor : ''; guidedLoadMore.hidden = !challengeCursor; guidedRecords.innerHTML = unavailable.challenges ? unavailableRecord('Guided-auth challenge inventory') : challenges.length ? challenges.map(challengeRecord).join('') : '<p class="empty">No durable guided-auth challenges are recorded.</p>';
        var scopes = data.scopes && data.scopes.scopes || []; scopeRecords.innerHTML = unavailable.scopes ? unavailableRecord('Runtime scope catalog') : scopes.length ? scopes.map(function (item) { return record(scopeRecords, item.runtime, item.scope.kind + ':' + item.scope.id, (item.capabilities && item.capabilities.readStatus) ? 'readable' : 'unproven'); }).join('') : '<p class="empty">No readable runtime scopes were reported.</p>';
        var catalog = data.models && data.models.models || []; catalogModels.innerHTML = unavailable.models ? unavailableRecord('Model catalog') : catalog.length ? catalog.map(function (item) { var observed = typeof item.observedProfileCount === 'number' ? item.observedProfileCount : 0; var readable = typeof item.readableProfileCount === 'number' ? item.readableProfileCount : 0; var compatible = Array.isArray(item.runtimeCompatibility) ? item.runtimeCompatibility.join(', ') : 'Not reported'; var proof = item.verificationState === 'UNPROVEN' ? 'UNPROVEN — runtime application is not verified.' : 'Runtime proof not reported.'; return record(catalogModels, item.id, (item.selectable ? 'Observed in ' + observed + ' account record(s), ' + readable + ' readable; compatible runtimes: ' + compatible + '. ' : 'Not selectable in this observed policy. ') + proof, item.selectable ? 'UNPROVEN' : item.reason || 'blocked'); }).join('') : '<p class="empty">No observed models were reported.</p>';
        var audit = data.audit && data.audit.records || []; auditCursor = !unavailable.audit && data.audit && typeof data.audit.nextCursor === 'string' ? data.audit.nextCursor : ''; auditLoadMore.hidden = !auditCursor; auditRecords.innerHTML = unavailable.audit ? unavailableRecord('Audit history') : audit.length ? audit.map(auditRecord).join('') : '<p class="empty">No Account Center audit records are available.</p>';
        var operations = data.operations && data.operations.operations || []; operationCursor = !unavailable.operations && data.operations && typeof data.operations.nextCursor === 'string' ? data.operations.nextCursor : ''; operationLoadMore.hidden = !operationCursor; operationRecords.innerHTML = unavailable.operations ? unavailableRecord('Operation history') : operations.length ? operations.map(operationRecord).join('') : '<p class="empty">No completed protected operations are available.</p>';
      }
      async function loadAudit(cursor) { var parameters = new URLSearchParams(); if (auditOutcome.value) parameters.set('outcome', auditOutcome.value); if (auditAction.value) parameters.set('action', auditAction.value); if (cursor) parameters.set('cursor', cursor); var suffix = parameters.toString(); return api('/api/audit' + (suffix ? '?' + suffix : '')); }
      async function loadOperations(cursor) { var parameters = new URLSearchParams(); var runtime = selectedRuntime(); var scopeKind = selectedScopeKind(); if (operationOutcome.value) parameters.set('outcome', operationOutcome.value); if (runtime) parameters.set('runtime', runtime); if (scopeKind) parameters.set('scopeKind', scopeKind); if (cursor) parameters.set('cursor', cursor); var suffix = parameters.toString(); return api('/api/mutation-operations' + (suffix ? '?' + suffix : '')); }
      async function loadModels() { return api('/api/models' + selectedRuntimeQuery()); }
      async function loadLimits() { return api('/api/limits' + selectedRuntimeQuery()); }
      async function loadChallenges(cursor) { var parameters = new URLSearchParams(selectedScopeQuery().slice(1)); if (cursor) parameters.set('cursor', cursor); var suffix = parameters.toString(); return api('/api/auth-challenges' + (suffix ? '?' + suffix : '')); }
      async function loadWorkspace() { var scopeResult = (await Promise.allSettled([api('/api/scopes')]))[0]; var values = {}; var unavailable = {}; if (scopeResult.status === 'fulfilled' && scopeResult.value && Array.isArray(scopeResult.value.scopes)) values.scopes = scopeResult.value; else unavailable.scopes = true; renderContextSelector(values.scopes, unavailable.scopes); var results = await Promise.allSettled([api('/api/capabilities'), loadChallenges(), loadModels(), loadLimits(), loadAudit(), loadOperations()]); var keys = ['capabilities', 'challenges', 'models', 'limits', 'audit', 'operations']; results.forEach(function (result, index) { var key = keys[index]; var field = key === 'capabilities' ? 'actions' : key === 'challenges' ? 'challenges' : key === 'models' ? 'models' : key === 'limits' ? 'accounts' : key === 'audit' ? 'records' : 'operations'; if (result.status === 'fulfilled' && result.value && Array.isArray(result.value[field])) values[key] = result.value; else unavailable[key] = true; }); renderWorkspace(values, unavailable); return Object.keys(unavailable).length > 0; }
      runtimeScope.addEventListener('change', async function () { if (runtimeScope.disabled) return; selectedContext = runtimeScope.value; setNotice('Context changed. Refreshing observed runtime data; scope-filtered reads remain UNPROVEN until supplied by the API.', 'loading'); var incomplete = await loadWorkspace(); setNotice(incomplete ? 'Context refreshed; some evidence is UNPROVEN. Retry unavailable sections.' : 'Observed runtime data refreshed. Scope-filtered reads remain UNPROVEN until supplied by the API.', incomplete ? 'error' : 'ready'); });
      auditFilter.addEventListener('submit', async function (event) { event.preventDefault(); if (!token.value) { token.focus(); setNotice('A launch token is required to filter audit history.', 'error'); return; } auditFilterSubmit.disabled = true; auditFilterSubmit.textContent = 'Filtering…'; setNotice('Loading filtered audit history…', 'loading'); try { var data = await loadAudit(); auditFreshness(data); var records = data && Array.isArray(data.records) ? data.records : []; auditCursor = data && typeof data.nextCursor === 'string' ? data.nextCursor : ''; auditLoadMore.hidden = !auditCursor; auditRecords.innerHTML = records.length ? records.map(auditRecord).join('') : '<p class="empty">No Account Center audit records match this outcome.</p>'; setNotice('Filtered audit history is current.', 'ready'); } catch (_) { auditCursor = ''; auditLoadMore.hidden = true; auditRecords.innerHTML = unavailableRecord('Audit history'); setNotice('Audit history could not be filtered. Retry to verify current evidence.', 'error'); } finally { auditFilterSubmit.disabled = false; auditFilterSubmit.textContent = 'Filter audit history'; } });
      operationFilter.addEventListener('submit', async function (event) { event.preventDefault(); if (!token.value) { token.focus(); setNotice('A launch token is required to filter operation history.', 'error'); return; } operationFilterSubmit.disabled = true; operationFilterSubmit.textContent = 'Filtering…'; setNotice('Loading filtered operation history…', 'loading'); try { var data = await loadOperations(); operationFreshness(data); var operations = data && Array.isArray(data.operations) ? data.operations : []; operationCursor = data && typeof data.nextCursor === 'string' ? data.nextCursor : ''; operationLoadMore.hidden = !operationCursor; operationRecords.innerHTML = operations.length ? operations.map(operationRecord).join('') : '<p class="empty">No protected operations match this outcome.</p>'; setNotice('Filtered operation history is current.', 'ready'); } catch (_) { operationCursor = ''; operationLoadMore.hidden = true; operationRecords.innerHTML = unavailableRecord('Operation history'); setNotice('Operation history could not be filtered. Retry to verify current evidence.', 'error'); } finally { operationFilterSubmit.disabled = false; operationFilterSubmit.textContent = 'Filter operation history'; } });
      auditLoadMore.addEventListener('click', async function () { if (!auditCursor || auditLoadMore.disabled) return; auditLoadMore.disabled = true; auditLoadMore.textContent = 'Loading older records…'; setNotice('Loading older audit history…', 'loading'); try { var data = await loadAudit(auditCursor); auditFreshness(data); var records = data && Array.isArray(data.records) ? data.records : []; auditCursor = data && typeof data.nextCursor === 'string' ? data.nextCursor : ''; auditLoadMore.hidden = !auditCursor; if (records.length) auditRecords.insertAdjacentHTML('beforeend', records.map(auditRecord).join('')); setNotice(records.length ? 'Older audit history is current.' : 'No older audit history is available.', 'ready'); } catch (_) { setNotice('Older audit history could not be verified. Previously loaded evidence is retained.', 'error'); } finally { auditLoadMore.disabled = false; auditLoadMore.textContent = 'Load older audit records'; } });
      operationLoadMore.addEventListener('click', async function () { if (!operationCursor || operationLoadMore.disabled) return; operationLoadMore.disabled = true; operationLoadMore.textContent = 'Loading older protected operations…'; setNotice('Loading older protected operations…', 'loading'); try { var data = await loadOperations(operationCursor); operationFreshness(data); var operations = data && Array.isArray(data.operations) ? data.operations : []; operationCursor = data && typeof data.nextCursor === 'string' ? data.nextCursor : ''; operationLoadMore.hidden = !operationCursor; if (operations.length) operationRecords.insertAdjacentHTML('beforeend', operations.map(operationRecord).join('')); setNotice(operations.length ? 'Older protected operations are current.' : 'No older protected operations are available.', 'ready'); } catch (_) { setNotice('Older protected operations could not be verified. Previously loaded evidence is retained.', 'error'); } finally { operationLoadMore.disabled = false; operationLoadMore.textContent = 'Load older protected operations'; } });
      guidedLoadMore.addEventListener('click', async function () { if (!challengeCursor || guidedLoadMore.disabled) return; guidedLoadMore.disabled = true; guidedLoadMore.textContent = 'Loading older challenges…'; setNotice('Loading older guided-auth challenges…', 'loading'); try { var data = await loadChallenges(challengeCursor); challengeFreshness(data); var challenges = data && Array.isArray(data.challenges) ? data.challenges : []; challengeCursor = data && typeof data.nextCursor === 'string' ? data.nextCursor : ''; guidedLoadMore.hidden = !challengeCursor; if (challenges.length) guidedRecords.insertAdjacentHTML('beforeend', challenges.map(challengeRecord).join('')); setNotice(challenges.length ? 'Older guided-auth challenges are current.' : 'No older guided-auth challenges are available.', 'ready'); } catch (_) { setNotice('Older guided-auth challenges could not be verified. Previously loaded evidence is retained.', 'error'); } finally { guidedLoadMore.disabled = false; guidedLoadMore.textContent = 'Load older guided-auth challenges'; } });
      document.addEventListener('click', async function (event) { var guided = event.target.closest('.view-guided'); if (guided) { selectView('guided'); return; } var detail = event.target.closest('.view-challenge'); if (detail) { var detailId = detail.dataset.challengeId; if (!detailId) return; detail.disabled = true; detail.textContent = 'Loading…'; guidedDetail.innerHTML = '<p class="empty" role="status">Loading guided-auth challenge detail…</p>'; try { var detailResponse = await loadChallengeDetail(detailId); renderChallengeDetail(detailResponse.challenge); setNotice('Guided-auth challenge detail is current.', 'ready'); } catch (_) { guidedDetail.innerHTML = '<article class="record" role="status"><strong>UNPROVEN — data unavailable</strong><p>Guided-auth challenge detail could not be verified. Refresh the challenge inventory and try again.</p></article>'; setNotice('Guided-auth challenge detail could not be verified.', 'error'); } finally { detail.disabled = false; detail.textContent = 'View challenge details'; } return; } var retry = event.target.closest('.retry-workspace'); if (retry) { retry.disabled = true; retry.textContent = 'Retrying…'; setNotice('Retrying unavailable workspace data…', 'loading'); var incomplete = await loadWorkspace(); setNotice(incomplete ? 'Workspace refreshed; some evidence is UNPROVEN. Retry unavailable sections.' : 'Local workspace refreshed. Read-only evidence is current.', incomplete ? 'error' : 'ready'); return; } var button = event.target.closest('.cancel-challenge'); if (!button || button.disabled) return; var id = button.dataset.challengeId; if (!id) return; openCancelChallengeDialog(id, button); });
      function render(status) {
        latestStatus = status;
        renderAttention(null, true);
        var profileList = Array.isArray(status.profiles) ? status.profiles : []; var routeList = Array.isArray(status.routes) ? status.routes : []; var warningList = Array.isArray(status.warnings) ? status.warnings : [];
        var readable = profileList.filter(function (p) { return p.usage && p.usage.readable; }).length; var unhealthy = profileList.filter(function (p) { return p.usage && p.usage.health === 'error'; }).length;
        source.textContent = text(status.source) + ' · ' + text(status.schemaVersion); freshness.textContent = status.generatedAt ? 'Observed ' + new Date(status.generatedAt).toLocaleString() : 'Timestamp unknown'; freshness.className = 'pill good';
        metrics.innerHTML = '<div class="metric"><strong>' + readable + '/' + profileList.length + '</strong><span>accounts readable</span></div><div class="metric"><strong>' + (routeList.length ? (unhealthy ? 'attention' : 'nominal') : 'none') + '</strong><span>routing health</span></div><div class="metric"><strong>' + warningList.length + '</strong><span>active warnings</span></div>';
        runtimes.innerHTML = (status.runtimes || []).length ? status.runtimes.map(function (r) { return '<div class="runtime-row"><div><div class="runtime-name">' + escapeHtml(r.displayName || r.key) + '</div><div class="runtime-meta">' + escapeHtml(capability(r)) + '</div></div><span class="pill ' + (r.capabilities && r.capabilities.readStatus ? 'good' : 'warn') + '">' + (r.capabilities && r.capabilities.readStatus ? 'Readable' : 'UNPROVEN') + '</span></div>'; }).join('') : '<p class="empty">No runtime reported by this status source.</p>';
        document.getElementById('route-count').textContent = routeList.length + (routeList.length === 1 ? ' route' : ' routes'); routes.innerHTML = routeList.length ? routeList.map(function (r) { return '<div class="route"><strong>' + escapeHtml(r.provider) + ' → ' + escapeHtml(r.runtime) + '</strong><p>Active: <b>' + escapeHtml(r.activeProfileId) + '</b> · ' + (r.order || []).length + ' account' + ((r.order || []).length === 1 ? '' : 's') + ' in order</p></div>'; }).join('') : '<p class="empty">No route configured by this runtime.</p>';
        document.getElementById('account-count').textContent = profileList.length + (profileList.length === 1 ? ' account' : ' accounts'); accounts.innerHTML = profileList.length ? profileList.map(function (p) { var u = p.usage || {}; var windows = u.windows || []; var primary = windows[0] || {}; var value = primary.remainingPct; var barClass = value == null ? 'bad' : value < 10 ? 'low' : ''; var proof = u.readable ? 'Observed readable status' : 'UNPROVEN — unreadable status'; var capacity = value == null ? 'unreadable' : value + '% ' + escapeHtml(primary.displayLabel || primary.name || 'remaining'); return '<article class="account-record" role="listitem"><div class="account-name">' + escapeHtml(p.label || p.id) + '</div><div class="subtle">' + escapeHtml(p.id) + '</div><dl class="account-details"><div><dt>Health / auth</dt><dd><span class="status-line"><span class="dot ' + healthClass(u.health) + '"></span>' + escapeHtml(u.health || 'unknown') + ' · ' + escapeHtml((u.auth || {}).state || 'unknown') + '</span></dd></div><div><dt>Capacity</dt><dd><span class="usage"><span class="bar" aria-hidden="true"><i class="' + barClass + '" style="width:' + percent(value) + '%"></i></span>' + capacity + '</span></dd></div><div><dt>Routing role</dt><dd>' + escapeHtml(p.disabled ? 'disabled' : p.role || 'unknown') + '</dd></div><div><dt>Runtime compatibility</dt><dd>' + escapeHtml((p.runtimeCompatibility || []).join(', ') || 'unproven') + '</dd></div><div><dt>Proof</dt><dd>' + escapeHtml(proof) + '</dd></div></dl></article>'; }).join('') : '<p class="empty">No accounts reported by this runtime.</p>';
        var modelSet = {}; profileList.forEach(function (p) { (p.models || []).forEach(function (m) { modelSet[m] = true; }); }); var modelNames = Object.keys(modelSet).sort(); var disabled = (status.policy && status.policy.disabledModels) || []; document.getElementById('model-count').textContent = modelNames.length + (modelNames.length === 1 ? ' model' : ' models'); models.innerHTML = modelNames.length ? modelNames.map(function (model) { var isDisabled = disabled.indexOf(model) !== -1; return '<span class="model' + (isDisabled ? ' disabled' : '') + '">' + escapeHtml(model) + (isDisabled ? ' · disabled' : '') + '</span>'; }).join('') : '<p class="empty">No model catalog was reported.</p>';
        document.getElementById('updated').textContent = 'Last successful request: ' + new Date().toLocaleString() + (status.noSecrets === true ? ' · no-secrets assertion present' : ' · no-secrets assertion unproven');
      }
      form.addEventListener('submit', async function (event) { event.preventDefault(); if (!token.value) { token.focus(); setNotice('A launch token is required to request status.', 'error'); return; } refresh.disabled = true; refresh.textContent = 'Refreshing…'; setNotice('Requesting local runtime status…', 'loading'); try { var status = await api('/api/status'); render(status); var incomplete = await loadWorkspace(); setNotice(incomplete ? 'Workspace refreshed; some evidence is UNPROVEN. Retry unavailable sections.' : 'Local workspace refreshed. Read-only evidence is current.', incomplete ? 'error' : 'ready'); } catch (error) { if (error && error.status === 401) token.focus(); setNotice(error instanceof Error ? error.message : 'Status request could not be completed.', 'error'); } finally { refresh.disabled = false; refresh.textContent = 'Refresh status'; } });
    }());
  </script>
</body>
</html>`;
}
