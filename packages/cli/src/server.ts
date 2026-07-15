import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
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
      const challenge = options.challengeStore ? await options.challengeStore.cancel(cancelId) : undefined;
      if (!challenge) return send(response, 404, { error: "not_found" });
      return send(response, 200, { schemaVersion: "account-center.auth-challenge-cancel.v1", challenge: authChallengeView(challenge) });
    }
    const allowedMethod = endpointMethod(request.url);
    if (allowedMethod && request.method !== allowedMethod) {
      response.setHeader("Allow", allowedMethod);
      return send(response, 405, { error: "method_not_allowed" });
    }
    if (request.method !== "GET") return send(response, 405, { error: "method_not_allowed" });
    if (request.url === "/api/capabilities") return send(response, 200, agentCapabilities());
    if (request.method === "GET" && new URL(request.url ?? "/", "http://account-center.local").pathname === "/api/audit") {
      const query = auditQuery(request.url ?? "/");
      if (!query) return send(response, 400, { error: "invalid_query" });
      return send(response, 200, await auditHistory(options.auditStore, query));
    }
    if (request.url === "/api/mutation-operations") return send(response, 200, await mutationOperationHistory(options.mutationRepository));
    if (request.url === "/api/models") {
      const adapter = createRuntimeAdapter(options.source ?? "fixture");
      const result = await executeAccountCenterCommand({ command: "status" }, { adapter });
      return send(response, result.code === 0 && result.status ? 200 : 500, result.status ? modelCatalog(result.status) : { error: "status_unavailable" });
    }
    if (request.url === "/api/scopes") {
      const adapter = createRuntimeAdapter(options.source ?? "fixture");
      const result = await executeAccountCenterCommand({ command: "status" }, { adapter });
      return send(response, result.code === 0 && result.status ? 200 : 500, result.status ? runtimeScopeCatalog(result.status) : { error: "status_unavailable" });
    }
    if (request.method === "GET" && request.url === "/api/auth-challenges") return send(response, 200, await authChallengeInventory(options.challengeStore));
    const challengeId = authChallengeId(request.url);
    if (challengeId) {
      const challenge = options.challengeStore ? await options.challengeStore.get(challengeId) : undefined;
      if (!challenge) return send(response, 404, { error: "not_found" });
      return send(response, 200, { schemaVersion: "account-center.auth-challenge.v1", challenge: authChallengeView(challenge) });
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
    async close(): Promise<void> { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  };
}

async function authChallengeInventory(store?: AuthChallengeStore): Promise<unknown> {
  const challenges = store ? await store.list() : [];
  return {
    schemaVersion: "account-center.auth-challenges.v1",
    challenges: challenges.map(authChallengeView)
  };
}

interface AuditQuery { limit: number; outcome?: AuditRecord["outcome"]; }

async function auditHistory(store: AuditStore | undefined, query: AuditQuery = { limit: 50 }): Promise<unknown> {
  const records = store ? (await store.list({ limit: 100 })).filter((record) => !query.outcome || record.outcome === query.outcome).slice(0, query.limit) : [];
  return {
    schemaVersion: "account-center.audit-history.v1",
    records: records.map(auditRecordView)
  };
}

function auditQuery(path: string): AuditQuery | undefined {
  const parameters = new URL(path, "http://account-center.local").searchParams;
  if ([...parameters.keys()].some((key) => key !== "limit" && key !== "outcome") || parameters.getAll("limit").length > 1 || parameters.getAll("outcome").length > 1) return undefined;
  const limitValue = parameters.get("limit");
  const limit = limitValue === null ? 50 : Number(limitValue);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return undefined;
  const outcome = parameters.get("outcome");
  if (outcome !== null && !["dry_run", "started", "applied", "blocked", "failed_no_change_verified", "unproven", "recovery_required"].includes(outcome)) return undefined;
  return { limit, ...(outcome === null ? {} : { outcome: outcome as AuditRecord["outcome"] }) };
}

async function mutationOperationHistory(repository?: MutationRepository): Promise<unknown> {
  return {
    schemaVersion: "account-center.mutation-operations.v1",
    operations: repository ? await repository.list() : []
  };
}

function modelCatalog(status: AccountCenterStatus): unknown {
  const known = new Set([...status.profiles.flatMap((profile) => profile.models), ...status.policy.disabledModels]);
  return {
    schemaVersion: "account-center.models.v1",
    generatedAt: status.generatedAt,
    models: Array.from(known).sort().map((id) => status.policy.disabledModels.includes(id)
      ? { id, selectable: false, reason: "disabled_by_policy" }
      : { id, selectable: true })
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
  const { reauth, ...safeStatus } = status;
  return redactJson({
    ...safeStatus,
    reauth: reauth.map(({ id, provider, profileHint, expiresAt, status: challengeStatus }) => ({ id, provider, profileHint, expiresAt, status: challengeStatus }))
  }) as AccountCenterStatus;
}

function auditRecordView({ id, createdAt, action, outcome, proofState, summary, warnings }: AuditRecord) {
  return { id, createdAt, action, outcome, proofState, summary, warnings };
}

function authChallengeView({ id, mode, provider, runtime, scope, status, expiresAt, createdAt, updatedAt }: Awaited<ReturnType<AuthChallengeStore["create"]>>) {
  return { id, mode, provider, runtime, scope, status, ...(expiresAt ? { expiresAt } : {}), createdAt, updatedAt };
}

function endpointMethod(path: string | undefined): "GET" | "POST" | undefined {
  const pathname = path ? new URL(path, "http://account-center.local").pathname : undefined;
  if (["/api/capabilities", "/api/audit", "/api/mutation-operations", "/api/models", "/api/scopes", "/api/auth-challenges", "/api/status"].includes(pathname ?? "")) return "GET";
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

function agentCapabilities(): unknown {
  return {
    schemaVersion: "account-center.agent-capabilities.v1",
    target: "account-center",
    transport: { loopbackOnly: true, authentication: "bearer_token", cacheControl: "no-store" },
    actions: [
      { id: "capabilities.list", mode: "read", state: "available", endpoint: { method: "GET", path: "/api/capabilities" }, requires: ["bearer_token"] },
      { id: "status", mode: "read", state: "available", endpoint: { method: "GET", path: "/api/status" }, requires: ["bearer_token"] },
      { id: "models.list", mode: "read", state: "available", endpoint: { method: "GET", path: "/api/models" }, requires: ["bearer_token"] },
      { id: "runtime_scopes.list", mode: "read", state: "available", endpoint: { method: "GET", path: "/api/scopes" }, requires: ["bearer_token"] },
      { id: "auth_challenges.list", mode: "read", state: "available", endpoint: { method: "GET", path: "/api/auth-challenges" }, requires: ["bearer_token"] },
      { id: "auth_challenges.detail", mode: "read", state: "available", endpoint: { method: "GET", path: "/api/auth-challenges/:id" }, requires: ["bearer_token", "opaque_challenge_id"] },
      { id: "auth_challenges.cancel", mode: "mutation", state: "available", endpoint: { method: "POST", path: "/api/auth-challenges/:id/cancel" }, requires: ["bearer_token", "same_origin", "opaque_challenge_id"] },
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
    :root{--bg:#0c1117;--panel:#141b23;--panel-2:#101720;--line:#2a3541;--muted:#9eabb9;--text:#edf3f8;--accent:#79d4b4;--warn:#f1bd67;--danger:#ee8290;--blue:#8ec5ff;--radius:10px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
    *{box-sizing:border-box}body{margin:0;min-width:320px;background:var(--bg);color:var(--text);font-size:14px;line-height:1.45}button,input,select{font:inherit}button{cursor:pointer}button:focus-visible,input:focus-visible,select:focus-visible,a:focus-visible{outline:3px solid var(--blue);outline-offset:2px}.skip{position:absolute;left:12px;top:-50px;padding:8px 12px;background:var(--text);color:#000;z-index:10}.skip:focus{top:12px}.shell{max-width:1440px;margin:auto;padding:20px 24px 36px}.topbar{display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:1px solid var(--line);padding-bottom:17px}.eyebrow,.caption{margin:0;color:var(--muted);font-size:11px;letter-spacing:.11em;text-transform:uppercase}.brand{display:flex;align-items:center;gap:12px}.mark{width:29px;height:29px;border:1px solid var(--accent);border-radius:7px;display:grid;place-items:center;color:var(--accent);font-weight:800}.brand h1{font-size:18px;margin:0;letter-spacing:-.03em}.local{border:1px solid #376858;border-radius:999px;padding:4px 9px;color:var(--accent);font-size:11px}.connection{display:grid;grid-template-columns:minmax(240px,1fr) auto;gap:16px;align-items:end;padding:18px 0}.connection h2,.section-title h2{font-size:14px;margin:0}.connection p{margin:4px 0 0;color:var(--muted);font-family:system-ui,sans-serif;font-size:13px}.token-form{display:flex;align-items:end;gap:8px}.field{min-width:0;flex:1}.field label{display:block;margin-bottom:5px;color:var(--muted);font-size:12px}.field input,.field select{width:100%;height:36px;border:1px solid var(--line);border-radius:6px;background:#090e13;color:var(--text);padding:0 9px}.primary,.quiet{height:36px;border-radius:6px;padding:0 12px;border:1px solid transparent;font-weight:700;font-size:12px;white-space:nowrap}.primary{background:var(--accent);color:#082119}.primary:hover{background:#a0e4cc}.primary[disabled]{opacity:.6;cursor:wait}.quiet{background:transparent;color:var(--muted);border-color:var(--line);cursor:not-allowed}.quiet:not(:disabled){cursor:pointer}.notice{display:flex;gap:9px;align-items:center;border:1px solid var(--line);border-radius:7px;background:var(--panel-2);padding:9px 11px;color:var(--muted);font-family:system-ui,sans-serif;font-size:13px}.notice[data-state="error"]{border-color:#8b4350;color:#ffd4da}.notice[data-state="ready"]{border-color:#356b5a;color:#d0f5e8}.notice-dot{width:7px;height:7px;border-radius:50%;background:currentColor;flex:none}.dashboard{display:grid;grid-template-columns:1.05fr .95fr;gap:14px;margin-top:14px}.panel{border:1px solid var(--line);border-radius:var(--radius);background:var(--panel);min-width:0}.panel-header{display:flex;align-items:start;justify-content:space-between;gap:10px;padding:14px 15px;border-bottom:1px solid var(--line)}.section-title{display:flex;align-items:baseline;gap:9px}.count{color:var(--muted);font-size:11px}.panel-body{padding:14px 15px}.health-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.metric{padding:10px;border:1px solid var(--line);border-radius:7px;background:var(--panel-2)}.metric strong{display:block;font-size:18px;line-height:1.1}.metric span{display:block;margin-top:4px;color:var(--muted);font-family:system-ui,sans-serif;font-size:11px}.status-line{display:flex;align-items:center;gap:7px;font-size:12px}.dot{width:7px;height:7px;border-radius:50%;background:var(--muted);flex:none}.ok{background:var(--accent)}.warn{background:var(--warn)}.error{background:var(--danger)}.unknown{background:var(--muted)}.runtime-list,.action-list{display:grid;gap:8px}.runtime-row,.action-row{display:flex;justify-content:space-between;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid var(--line)}.runtime-row:last-child,.action-row:last-child{border-bottom:0}.runtime-name{font-weight:700}.runtime-meta{color:var(--muted);font-family:system-ui,sans-serif;font-size:12px}.pill{display:inline-flex;align-items:center;border:1px solid var(--line);border-radius:999px;padding:2px 7px;color:var(--muted);font-size:10px;letter-spacing:.05em;text-transform:uppercase;white-space:nowrap}.pill.good{border-color:#376858;color:var(--accent)}.pill.warn{border-color:#735a2c;color:#ffd58c}.wide{grid-column:1/-1}.table-wrap{overflow:auto}.accounts{width:100%;border-collapse:collapse;font-size:12px}.accounts th{color:var(--muted);font-size:10px;letter-spacing:.08em;text-align:left;text-transform:uppercase}.accounts th,.accounts td{padding:10px 8px;border-bottom:1px solid var(--line);white-space:nowrap}.accounts th:first-child,.accounts td:first-child{padding-left:0}.accounts th:last-child,.accounts td:last-child{padding-right:0}.accounts tr:last-child td{border-bottom:0}.account-name{font-weight:700}.subtle{color:var(--muted);font-family:system-ui,sans-serif}.usage{display:flex;align-items:center;gap:6px}.bar{display:inline-block;width:46px;height:5px;background:#293440;border-radius:99px;overflow:hidden}.bar i{display:block;height:100%;background:var(--accent)}.bar i.low{background:var(--warn)}.bar i.bad{background:var(--danger)}.route-list{display:grid;gap:10px}.route{padding:10px;border-left:3px solid var(--blue);background:var(--panel-2)}.route strong{display:block;font-size:12px}.route p{margin:4px 0 0;color:var(--muted);font-family:system-ui,sans-serif;font-size:12px}.empty{color:var(--muted);font-family:system-ui,sans-serif;font-size:13px;padding:10px 0}.model-list{display:flex;flex-wrap:wrap;gap:6px}.model{border:1px solid var(--line);border-radius:5px;padding:4px 6px;font-size:11px}.model.disabled{border-color:#75434b;color:#f3aab2;text-decoration:line-through}.action-row p{margin:2px 0 0;color:var(--muted);font-family:system-ui,sans-serif;font-size:11px}.footer{display:flex;justify-content:space-between;gap:12px;padding-top:14px;color:var(--muted);font-family:system-ui,sans-serif;font-size:11px}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}@media(max-width:760px){.shell{padding:16px}.connection,.dashboard{grid-template-columns:1fr}.token-form{align-items:stretch}.health-grid{grid-template-columns:1fr}.topbar{align-items:start}.footer{flex-direction:column}.accounts th:nth-child(3),.accounts td:nth-child(3){display:none}}@media(max-width:430px){.token-form{flex-direction:column}.primary{width:100%}.local{display:none}}
  </style>
  <style>
    .tabs{display:flex;gap:8px;overflow:auto;padding:4px 0 14px}.tab{min-height:36px;border:1px solid var(--line);border-radius:6px;background:transparent;color:var(--muted);padding:0 11px;white-space:nowrap}.tab[aria-selected="true"]{border-color:#376858;color:var(--accent);background:var(--panel-2)}.view[hidden]{display:none}.view-heading{display:flex;justify-content:space-between;gap:12px;align-items:baseline;margin:4px 0 14px}.view-heading h2{font-size:16px;margin:0}.view-heading p{margin:0;color:var(--muted);font-family:system-ui,sans-serif;font-size:13px}.record-list{display:grid;gap:8px}.record{border:1px solid var(--line);border-radius:7px;background:var(--panel-2);padding:11px}.record strong{display:block}.record p{margin:5px 0 0;color:var(--muted);font-family:system-ui,sans-serif;font-size:12px}.catalog-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.secondary{margin-top:14px}@media(max-width:760px){.catalog-grid{grid-template-columns:1fr}.tabs{margin:0 -2px}}
  </style>
</head>
<body>
  <a class="skip" href="#workspace">Skip to workspace</a>
  <main class="shell" id="workspace" tabindex="-1">
    <header class="topbar"><div class="brand"><span class="mark" aria-hidden="true">AC</span><div><p class="eyebrow">Local control plane</p><h1>Account Center</h1></div></div><span class="local">Local-only · bearer protected</span></header>
    <section class="connection" aria-labelledby="connect-heading"><div><h2 id="connect-heading">Status connection</h2><p>Use the launch token for this local server. It is used only for this request and is never displayed.</p></div><form class="token-form" id="token-form"><div class="field"><label for="token">Launch token</label><input id="token" name="token" type="password" autocomplete="off" spellcheck="false" required aria-describedby="token-help"><span id="token-help" class="sr-only">Required to load current runtime status.</span></div><button class="primary" id="refresh" type="submit">Refresh status</button></form></section>
    <p class="notice" id="notice" data-state="idle" role="status" aria-live="polite"><span class="notice-dot" aria-hidden="true"></span><span>Awaiting a launch token. No runtime data is loaded.</span></p>
    <nav class="tabs" aria-label="Account Center views" role="tablist"><button class="tab" type="button" role="tab" tabindex="0" aria-selected="true" aria-controls="dashboard-view" id="dashboard-tab" data-tab="dashboard">Dashboard</button><button class="tab" type="button" role="tab" tabindex="-1" aria-selected="false" aria-controls="guided-view" id="guided-tab" data-tab="guided">Guided auth</button><button class="tab" type="button" role="tab" tabindex="-1" aria-selected="false" aria-controls="catalogs-view" id="catalogs-tab" data-tab="catalogs">Runtime catalogs</button><button class="tab" type="button" role="tab" tabindex="-1" aria-selected="false" aria-controls="audit-view" id="audit-tab" data-tab="audit">Receipts &amp; audit</button></nav>
    <section class="dashboard view" id="dashboard-view" data-view="dashboard" role="tabpanel" aria-labelledby="dashboard-tab" tabindex="-1">
      <article class="panel"><div class="panel-header"><div class="section-title"><h2>Runtime health</h2><span class="count" id="source">Not connected</span></div><span class="pill" id="freshness">Unverified</span></div><div class="panel-body"><div class="health-grid" id="metrics"><div class="metric"><strong>—</strong><span>accounts readable</span></div><div class="metric"><strong>—</strong><span>routing health</span></div><div class="metric"><strong>—</strong><span>active warnings</span></div></div><div class="runtime-list" id="runtimes"><p class="empty">Runtime capability will appear after status loads.</p></div></div></article>
      <article class="panel"><div class="panel-header"><div class="section-title"><h2>Routing</h2><span class="count" id="route-count">No routes</span></div><span class="pill warn">Read-only view</span></div><div class="panel-body"><div class="route-list" id="routes"><p class="empty">No routing state loaded.</p></div></div></article>
      <article class="panel"><div class="panel-header"><div class="section-title"><h2>Attention &amp; pending work</h2><span class="count" id="attention-count">No signals</span></div><span class="pill warn">Review</span></div><div class="panel-body"><div class="record-list" id="attention"><p class="empty">Load status to identify recovery work.</p></div></div></article>
      <article class="panel wide"><div class="panel-header"><div class="section-title"><h2>Connected accounts</h2><span class="count" id="account-count">No accounts</span></div><span class="pill">Status data</span></div><div class="panel-body table-wrap"><table class="accounts"><caption class="sr-only">Connected accounts and their current health</caption><thead><tr><th>Account</th><th>Health / auth</th><th>Capacity</th><th>Routing role</th><th>Runtime</th></tr></thead><tbody id="accounts"><tr><td colspan="5" class="empty">Load status to inspect connected accounts.</td></tr></tbody></table></div></article>
      <article class="panel"><div class="panel-header"><div class="section-title"><h2>Model policy</h2><span class="count" id="model-count">No catalog</span></div><span class="pill">Observed</span></div><div class="panel-body"><div class="model-list" id="models"><p class="empty">Models are derived from connected account status.</p></div></div></article>
      <article class="panel"><div class="panel-header"><div class="section-title"><h2>Operator actions</h2><span class="count">Capability discovery</span></div><span class="pill warn">Guarded</span></div><div class="panel-body"><div class="action-list" id="operator-actions"><p class="empty">Load status to discover protected action availability.</p></div></div></article>
    </section>
    <section class="view secondary" id="guided-view" data-view="guided" role="tabpanel" aria-labelledby="guided-tab" tabindex="-1" hidden><header class="view-heading"><div><h2>Guided auth</h2><p>Durable local challenge history. Starting or completing authentication is not available until runtime proof exists.</p></div><span class="pill warn">Read-only lifecycle</span></header><div class="record-list" id="guided-records"><p class="empty">Load status to inspect local challenges.</p></div><section class="record-list secondary" id="guided-detail" aria-live="polite" aria-label="Guided-auth challenge detail"></section></section>
    <section class="view secondary" id="catalogs-view" data-view="catalogs" role="tabpanel" aria-labelledby="catalogs-tab" tabindex="-1" hidden><header class="view-heading"><div><h2>Runtime catalogs</h2><p>Observed scopes and models. Catalog visibility does not grant mutation permission.</p></div><span class="pill">Observed</span></header><div class="catalog-grid"><article class="panel"><div class="panel-header"><div class="section-title"><h2>Scopes</h2></div><span class="pill">Read-only</span></div><div class="panel-body record-list" id="scope-records"><p class="empty">Load status to inspect available scopes.</p></div></article><article class="panel"><div class="panel-header"><div class="section-title"><h2>Models</h2></div><span class="pill">Read-only</span></div><div class="panel-body record-list" id="catalog-models"><p class="empty">Load status to inspect observed models.</p></div></article></div></section>
    <section class="view secondary" id="audit-view" data-view="audit" role="tabpanel" aria-labelledby="audit-tab" tabindex="-1" hidden><header class="view-heading"><div><h2>Receipts &amp; audit</h2><p>Redacted Account Center evidence only. This is not a raw runtime log.</p></div><span class="pill">Local evidence</span></header><form class="token-form" id="audit-filter"><div class="field"><label for="audit-outcome">Outcome</label><select id="audit-outcome" name="outcome"><option value="">All outcomes</option><option value="applied">Applied</option><option value="dry_run">Dry run</option><option value="blocked">Blocked</option><option value="failed_no_change_verified">Failed, no change verified</option><option value="unproven">UNPROVEN</option></select></div><button class="quiet" id="audit-filter-submit" type="submit">Filter audit history</button></form><div class="catalog-grid"><article class="panel"><div class="panel-header"><div class="section-title"><h2>Audit history</h2></div></div><div class="panel-body record-list" id="audit-records"><p class="empty">Load status to inspect recorded actions.</p></div></article><article class="panel"><div class="panel-header"><div class="section-title"><h2>Operation history</h2></div></div><div class="panel-body record-list" id="operation-records"><p class="empty">No protected operations loaded.</p></div></article></div></section>
    <footer class="footer"><span id="updated">No successful status request yet.</span><span>Status payloads are expected to contain no secrets.</span></footer>
  </main>
  <script>
    (function () {
      var form = document.getElementById('token-form'); var token = document.getElementById('token'); var refresh = document.getElementById('refresh'); var notice = document.getElementById('notice');
      var source = document.getElementById('source'); var freshness = document.getElementById('freshness'); var metrics = document.getElementById('metrics'); var runtimes = document.getElementById('runtimes'); var routes = document.getElementById('routes'); var accounts = document.getElementById('accounts'); var models = document.getElementById('models'); var attention = document.getElementById('attention'); var attentionCount = document.getElementById('attention-count'); var operatorActions = document.getElementById('operator-actions'); var latestStatus;
      var guidedRecords = document.getElementById('guided-records'); var guidedDetail = document.getElementById('guided-detail'); var scopeRecords = document.getElementById('scope-records'); var catalogModels = document.getElementById('catalog-models'); var auditRecords = document.getElementById('audit-records'); var operationRecords = document.getElementById('operation-records'); var auditFilter = document.getElementById('audit-filter'); var auditOutcome = document.getElementById('audit-outcome'); var auditFilterSubmit = document.getElementById('audit-filter-submit');
      var tabs = Array.prototype.slice.call(document.querySelectorAll('[data-tab]')); var views = Array.prototype.slice.call(document.querySelectorAll('[data-view]'));
      function selectView(name, focusPanel) { tabs.forEach(function (tab) { var selected = tab.dataset.tab === name; tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1; }); views.forEach(function (view) { view.hidden = view.dataset.view !== name; }); if (focusPanel !== false) document.getElementById(name + '-view').focus({ preventScroll: true }); }
      tabs.forEach(function (tab, index) { tab.addEventListener('click', function () { selectView(tab.dataset.tab); }); tab.addEventListener('keydown', function (event) { var targetIndex = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1; if (targetIndex < 0) return; event.preventDefault(); var target = tabs[targetIndex]; selectView(target.dataset.tab, false); target.focus(); }); });
      function text(value) { return String(value == null ? '—' : value); }

      function escapeHtml(value) { var box = document.createElement('span'); box.textContent = text(value); return box.innerHTML; }
      function setNotice(message, state) { notice.dataset.state = state; notice.lastElementChild.textContent = message; }
      function healthClass(value) { return value === 'ok' ? 'ok' : value === 'warn' ? 'warn' : value === 'error' ? 'error' : 'unknown'; }
      function percent(value) { return typeof value === 'number' ? Math.max(0, Math.min(100, value)) : 0; }
      function capability(runtime) { var c = runtime.capabilities || {}; var labels = []; if (c.readStatus) labels.push('status'); if (c.mutateRoutes) labels.push('routes'); if (c.startReauth) labels.push('reauth'); if (c.mutateModels) labels.push('models'); return labels.length ? labels.join(' · ') : 'no capabilities reported'; }
      async function api(path, init) { var response = await fetch(path, { method: init && init.method || 'GET', credentials: 'same-origin', headers: { authorization: 'Bearer ' + token.value } }); if (!response.ok) { var error = new Error(response.status === 401 ? 'Launch token rejected' : 'Local API request failed (' + response.status + ')'); error.status = response.status; throw error; } return response.json(); }
      function record(target, title, detail, badge) { return '<article class="record"><strong>' + escapeHtml(title) + '</strong><p>' + escapeHtml(detail) + '</p><span class="pill">' + escapeHtml(badge || 'observed') + '</span></article>'; }
      function scopeLabel(scope) { return scope && typeof scope === 'object' && typeof scope.kind === 'string' && typeof scope.id === 'string' ? scope.kind + ':' + scope.id : typeof scope === 'string' ? scope : 'scope not reported'; }
      function challengeRecord(item) { var cancel = item.status === 'pending' ? '<button class="quiet cancel-challenge" type="button" data-challenge-id="' + escapeHtml(item.id) + '" aria-label="Cancel pending challenge">Cancel pending challenge</button>' : ''; return '<article class="record"><strong>' + escapeHtml(item.mode + ' · ' + item.provider) + '</strong><p>' + escapeHtml(item.runtime + ' · ' + scopeLabel(item.scope)) + '</p><span class="pill">' + escapeHtml(item.status) + '</span><button class="quiet view-challenge" type="button" data-challenge-id="' + escapeHtml(item.id) + '" aria-label="View challenge details">View challenge details</button>' + cancel + '</article>'; }
      function renderChallengeDetail(challenge) { if (!challenge || typeof challenge !== 'object') { guidedDetail.innerHTML = '<article class="record" role="status"><strong>UNPROVEN — data unavailable</strong><p>Guided-auth challenge detail could not be verified.</p></article>'; return; } var expiry = challenge.expiresAt ? 'Expires: ' + challenge.expiresAt : 'Expiry not reported'; guidedDetail.innerHTML = '<article class="record"><strong>Challenge detail</strong><p>' + escapeHtml(challenge.mode) + ' · ' + escapeHtml(challenge.provider) + ' · ' + escapeHtml(challenge.runtime) + ' · ' + escapeHtml(scopeLabel(challenge.scope)) + '</p><p>' + escapeHtml(expiry) + ' · Created: ' + escapeHtml(challenge.createdAt || 'not reported') + ' · Updated: ' + escapeHtml(challenge.updatedAt || 'not reported') + '</p><span class="pill">' + escapeHtml(challenge.status || 'UNPROVEN') + '</span></article>'; }
      async function loadChallengeDetail(id) { return api('/api/auth-challenges/' + encodeURIComponent(id)); }
      function unavailableRecord(label) { return '<article class="record" role="status"><strong>UNPROVEN — data unavailable</strong><p>' + escapeHtml(label) + ' could not be verified. Previously loaded evidence is not shown as current.</p><button class="quiet retry-workspace" type="button">Retry workspace data</button></article>'; }
      function renderAttention(challengeData, challengesUnavailable) { if (!latestStatus) return; var signals = []; var profiles = Array.isArray(latestStatus.profiles) ? latestStatus.profiles : []; profiles.forEach(function (profile) { var usage = profile.usage || {}; var firstWindow = usage.windows && usage.windows[0] || {}; if (usage.health === 'error' || usage.auth && usage.auth.state === 'reauth-needed') signals.push({ title: 'Authentication needs attention', detail: profile.label || profile.id, badge: 'reauth-needed' }); else if (!usage.readable || firstWindow.remainingPct == null || firstWindow.remainingPct < 10) signals.push({ title: 'Capacity needs review', detail: profile.label || profile.id, badge: firstWindow.remainingPct == null ? 'unreadable' : firstWindow.remainingPct + '% remaining' }); }); (latestStatus.warnings || []).forEach(function (warning) { signals.push({ title: 'Runtime warning', detail: warning, badge: 'review' }); }); if (challengesUnavailable) signals.push({ title: 'Guided-auth evidence is UNPROVEN', detail: 'Refresh workspace data before treating challenge status as current.', badge: 'unproven' }); else { var pending = challengeData && challengeData.challenges || []; pending.filter(function (item) { return item.status === 'pending'; }).forEach(function (item) { signals.push({ title: 'Pending guided auth', detail: item.mode + ' · ' + item.provider + ' · ' + item.runtime + ' · ' + scopeLabel(item.scope), badge: 'pending', guided: true }); }); } attentionCount.textContent = signals.length ? signals.length + (signals.length === 1 ? ' signal' : ' signals') : 'No signals'; attention.innerHTML = signals.length ? signals.map(function (item) { return '<article class="record"><strong>' + escapeHtml(item.title) + '</strong><p>' + escapeHtml(item.detail) + '</p><span class="pill">' + escapeHtml(item.badge) + '</span>' + (item.guided ? '<button class="quiet view-guided" type="button">View guided auth</button>' : '') + '</article>'; }).join('') : '<p class="empty">No recovery work is currently reported by verified local evidence.</p>'; }
      function renderOperatorActions(capabilityData, unavailable) { var names = { routes: 'Switch route', guided_auth: 'Start guided auth', models: 'Change model policy', 'account.delete': 'Delete credentials', updates: 'Update Account Center' }; if (unavailable) { operatorActions.innerHTML = unavailableRecord('Action capability contract'); return; } var actions = capabilityData && capabilityData.actions || []; operatorActions.innerHTML = Object.keys(names).map(function (id) { var action = actions.filter(function (item) { return item.id === id; })[0]; var state = action && action.state || 'UNPROVEN'; var reason = action && action.reason ? action.reason.replaceAll('_', ' ') : 'No protected action contract was reported.'; return '<div class="action-row"><div><strong>' + escapeHtml(names[id]) + '</strong><p>' + escapeHtml(reason) + '</p></div><button class="quiet" type="button" disabled>' + escapeHtml(state) + '</button></div>'; }).join(''); }
      function renderWorkspace(data, unavailable) {
        renderAttention(data.challenges, unavailable.challenges);
        renderOperatorActions(data.capabilities, unavailable.capabilities);
        var challenges = data.challenges && data.challenges.challenges || []; guidedRecords.innerHTML = unavailable.challenges ? unavailableRecord('Guided-auth challenge inventory') : challenges.length ? challenges.map(challengeRecord).join('') : '<p class="empty">No durable guided-auth challenges are recorded.</p>';
        var scopes = data.scopes && data.scopes.scopes || []; scopeRecords.innerHTML = unavailable.scopes ? unavailableRecord('Runtime scope catalog') : scopes.length ? scopes.map(function (item) { return record(scopeRecords, item.runtime, item.scope.kind + ':' + item.scope.id, (item.capabilities && item.capabilities.readStatus) ? 'readable' : 'unproven'); }).join('') : '<p class="empty">No readable runtime scopes were reported.</p>';
        var catalog = data.models && data.models.models || []; catalogModels.innerHTML = unavailable.models ? unavailableRecord('Model catalog') : catalog.length ? catalog.map(function (item) { return record(catalogModels, item.id, item.selectable ? 'Cataloged for observation.' : 'Not selectable in this observed policy.', item.selectable ? 'observed' : item.reason || 'blocked'); }).join('') : '<p class="empty">No observed models were reported.</p>';
        var audit = data.audit && data.audit.records || []; auditRecords.innerHTML = unavailable.audit ? unavailableRecord('Audit history') : audit.length ? audit.map(function (item) { return record(auditRecords, item.action, item.summary || 'No summary supplied.', item.outcome); }).join('') : '<p class="empty">No Account Center audit records are available.</p>';
        var operations = data.operations && data.operations.operations || []; operationRecords.innerHTML = unavailable.operations ? unavailableRecord('Operation history') : operations.length ? operations.map(function (item) { return record(operationRecords, item.operationId || 'operation', item.outcome || 'No terminal outcome.', item.state || 'unproven'); }).join('') : '<p class="empty">No completed protected operations are available.</p>';
      }
      async function loadAudit() { var parameters = new URLSearchParams(); if (auditOutcome.value) parameters.set('outcome', auditOutcome.value); var suffix = parameters.toString(); return api('/api/audit' + (suffix ? '?' + suffix : '')); }
      async function loadWorkspace() { var results = await Promise.allSettled([api('/api/capabilities'), api('/api/auth-challenges'), api('/api/scopes'), api('/api/models'), loadAudit(), api('/api/mutation-operations')]); var keys = ['capabilities', 'challenges', 'scopes', 'models', 'audit', 'operations']; var values = {}; var unavailable = {}; results.forEach(function (result, index) { var key = keys[index]; var field = key === 'capabilities' ? 'actions' : key === 'challenges' ? 'challenges' : key === 'scopes' ? 'scopes' : key === 'models' ? 'models' : key === 'audit' ? 'records' : 'operations'; if (result.status === 'fulfilled' && result.value && Array.isArray(result.value[field])) values[key] = result.value; else unavailable[key] = true; }); renderWorkspace(values, unavailable); return Object.keys(unavailable).length > 0; }
      auditFilter.addEventListener('submit', async function (event) { event.preventDefault(); if (!token.value) { token.focus(); setNotice('A launch token is required to filter audit history.', 'error'); return; } auditFilterSubmit.disabled = true; auditFilterSubmit.textContent = 'Filtering…'; setNotice('Loading filtered audit history…', 'loading'); try { var data = await loadAudit(); var records = data && Array.isArray(data.records) ? data.records : []; auditRecords.innerHTML = records.length ? records.map(function (item) { return record(auditRecords, item.action, item.summary || 'No summary supplied.', item.outcome); }).join('') : '<p class="empty">No Account Center audit records match this outcome.</p>'; setNotice('Filtered audit history is current.', 'ready'); } catch (_) { auditRecords.innerHTML = unavailableRecord('Audit history'); setNotice('Audit history could not be filtered. Retry to verify current evidence.', 'error'); } finally { auditFilterSubmit.disabled = false; auditFilterSubmit.textContent = 'Filter audit history'; } });
      document.addEventListener('click', async function (event) { var guided = event.target.closest('.view-guided'); if (guided) { selectView('guided'); return; } var detail = event.target.closest('.view-challenge'); if (detail) { var detailId = detail.dataset.challengeId; if (!detailId) return; detail.disabled = true; detail.textContent = 'Loading…'; guidedDetail.innerHTML = '<p class="empty" role="status">Loading guided-auth challenge detail…</p>'; try { var detailResponse = await loadChallengeDetail(detailId); renderChallengeDetail(detailResponse.challenge); setNotice('Guided-auth challenge detail is current.', 'ready'); } catch (_) { guidedDetail.innerHTML = '<article class="record" role="status"><strong>UNPROVEN — data unavailable</strong><p>Guided-auth challenge detail could not be verified. Refresh the challenge inventory and try again.</p></article>'; setNotice('Guided-auth challenge detail could not be verified.', 'error'); } finally { detail.disabled = false; detail.textContent = 'View challenge details'; } return; } var retry = event.target.closest('.retry-workspace'); if (retry) { retry.disabled = true; retry.textContent = 'Retrying…'; setNotice('Retrying unavailable workspace data…', 'loading'); var incomplete = await loadWorkspace(); setNotice(incomplete ? 'Workspace refreshed; some evidence is UNPROVEN. Retry unavailable sections.' : 'Local workspace refreshed. Read-only evidence is current.', incomplete ? 'error' : 'ready'); return; } var button = event.target.closest('.cancel-challenge'); if (!button || button.disabled) return; var id = button.dataset.challengeId; if (!id) return; button.disabled = true; button.textContent = 'Cancelling…'; setNotice('Cancelling the pending guided-auth challenge…', 'loading'); try { await api('/api/auth-challenges/' + encodeURIComponent(id) + '/cancel', { method: 'POST' }); var incomplete = await loadWorkspace(); setNotice(incomplete ? 'Guided-auth challenge cancelled; some evidence is UNPROVEN.' : 'Guided-auth challenge cancelled. No credentials were changed.', incomplete ? 'error' : 'ready'); } catch (_) { button.disabled = false; button.textContent = 'Cancel pending challenge'; setNotice('The guided-auth challenge could not be cancelled. Refresh to verify its state.', 'error'); } });
      function render(status) {
        latestStatus = status;
        renderAttention(null, true);
        var profileList = Array.isArray(status.profiles) ? status.profiles : []; var routeList = Array.isArray(status.routes) ? status.routes : []; var warningList = Array.isArray(status.warnings) ? status.warnings : [];
        var readable = profileList.filter(function (p) { return p.usage && p.usage.readable; }).length; var unhealthy = profileList.filter(function (p) { return p.usage && p.usage.health === 'error'; }).length;
        source.textContent = text(status.source) + ' · ' + text(status.schemaVersion); freshness.textContent = status.generatedAt ? 'Observed ' + new Date(status.generatedAt).toLocaleString() : 'Timestamp unknown'; freshness.className = 'pill good';
        metrics.innerHTML = '<div class="metric"><strong>' + readable + '/' + profileList.length + '</strong><span>accounts readable</span></div><div class="metric"><strong>' + (routeList.length ? (unhealthy ? 'attention' : 'nominal') : 'none') + '</strong><span>routing health</span></div><div class="metric"><strong>' + warningList.length + '</strong><span>active warnings</span></div>';
        runtimes.innerHTML = (status.runtimes || []).length ? status.runtimes.map(function (r) { return '<div class="runtime-row"><div><div class="runtime-name">' + escapeHtml(r.displayName || r.key) + '</div><div class="runtime-meta">' + escapeHtml(capability(r)) + '</div></div><span class="pill ' + (r.capabilities && r.capabilities.readStatus ? 'good' : 'warn') + '">' + (r.capabilities && r.capabilities.readStatus ? 'Readable' : 'UNPROVEN') + '</span></div>'; }).join('') : '<p class="empty">No runtime reported by this status source.</p>';
        document.getElementById('route-count').textContent = routeList.length + (routeList.length === 1 ? ' route' : ' routes'); routes.innerHTML = routeList.length ? routeList.map(function (r) { return '<div class="route"><strong>' + escapeHtml(r.provider) + ' → ' + escapeHtml(r.runtime) + '</strong><p>Active: <b>' + escapeHtml(r.activeProfileId) + '</b> · ' + (r.order || []).length + ' account' + ((r.order || []).length === 1 ? '' : 's') + ' in order</p></div>'; }).join('') : '<p class="empty">No route configured by this runtime.</p>';
        document.getElementById('account-count').textContent = profileList.length + (profileList.length === 1 ? ' account' : ' accounts'); accounts.innerHTML = profileList.length ? profileList.map(function (p) { var u = p.usage || {}; var windows = u.windows || []; var primary = windows[0] || {}; var value = primary.remainingPct; var barClass = value == null ? 'bad' : value < 10 ? 'low' : ''; return '<tr><td><div class="account-name">' + escapeHtml(p.label || p.id) + '</div><div class="subtle">' + escapeHtml(p.id) + '</div></td><td><div class="status-line"><span class="dot ' + healthClass(u.health) + '"></span>' + escapeHtml(u.health || 'unknown') + ' · ' + escapeHtml((u.auth || {}).state || 'unknown') + '</div></td><td><div class="usage"><span class="bar"><i class="' + barClass + '" style="width:' + percent(value) + '%"></i></span>' + (value == null ? 'unreadable' : value + '% ' + escapeHtml(primary.displayLabel || primary.name || 'remaining')) + '</div></td><td>' + escapeHtml(p.disabled ? 'disabled' : p.role || 'unknown') + '</td><td>' + escapeHtml((p.runtimeCompatibility || []).join(', ') || 'unproven') + '</td></tr>'; }).join('') : '<tr><td colspan="5" class="empty">No accounts reported by this runtime.</td></tr>';
        var modelSet = {}; profileList.forEach(function (p) { (p.models || []).forEach(function (m) { modelSet[m] = true; }); }); var modelNames = Object.keys(modelSet).sort(); var disabled = (status.policy && status.policy.disabledModels) || []; document.getElementById('model-count').textContent = modelNames.length + (modelNames.length === 1 ? ' model' : ' models'); models.innerHTML = modelNames.length ? modelNames.map(function (model) { var isDisabled = disabled.indexOf(model) !== -1; return '<span class="model' + (isDisabled ? ' disabled' : '') + '">' + escapeHtml(model) + (isDisabled ? ' · disabled' : '') + '</span>'; }).join('') : '<p class="empty">No model catalog was reported.</p>';
        document.getElementById('updated').textContent = 'Last successful request: ' + new Date().toLocaleString() + (status.noSecrets === true ? ' · no-secrets assertion present' : ' · no-secrets assertion unproven');
      }
      form.addEventListener('submit', async function (event) { event.preventDefault(); if (!token.value) { token.focus(); setNotice('A launch token is required to request status.', 'error'); return; } refresh.disabled = true; refresh.textContent = 'Refreshing…'; setNotice('Requesting local runtime status…', 'loading'); try { var status = await api('/api/status'); render(status); var incomplete = await loadWorkspace(); setNotice(incomplete ? 'Workspace refreshed; some evidence is UNPROVEN. Retry unavailable sections.' : 'Local workspace refreshed. Read-only evidence is current.', incomplete ? 'error' : 'ready'); } catch (error) { if (error && error.status === 401) token.focus(); setNotice(error instanceof Error ? error.message : 'Status request could not be completed.', 'error'); } finally { refresh.disabled = false; refresh.textContent = 'Refresh status'; } });
    }());
  </script>
</body>
</html>`;
}
