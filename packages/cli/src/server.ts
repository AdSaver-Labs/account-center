import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { AccountCenterStatus, AuditRecord, AuditStore, AuthChallengeStore, createRuntimeAdapter, executeAccountCenterCommand, MutationRepository, RuntimeSource } from "@account-center/core";

export interface AccountCenterServerOptions {
  token: string;
  source?: RuntimeSource;
  auditStore?: AuditStore;
  challengeStore?: AuthChallengeStore;
  mutationRepository?: MutationRepository;
}

export function createAccountCenterServer(options: AccountCenterServerOptions) {
  const server = createServer(async (request, response) => {
    setSafetyHeaders(response);
    if (request.method === "GET" && request.url === "/") return sendHtml(response, controlPanelHtml());
    if (!authorized(request, options.token)) return send(response, 401, { error: "unauthorized" });
    const cancelId = request.method === "POST" ? authChallengeCancelId(request.url) : undefined;
    if (cancelId) {
      if (!sameOrigin(request)) return send(response, 403, { error: "origin_forbidden" });
      const challenge = options.challengeStore ? await options.challengeStore.cancel(cancelId) : undefined;
      if (!challenge) return send(response, 404, { error: "not_found" });
      return send(response, 200, { schemaVersion: "account-center.auth-challenge-cancel.v1", challenge: authChallengeView(challenge) });
    }
    if (request.method !== "GET") return send(response, 405, { error: "method_not_allowed" });
    if (request.url === "/api/capabilities") return send(response, 200, agentCapabilities());
    if (request.url === "/api/audit") return send(response, 200, await auditHistory(options.auditStore));
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
      return send(response, result.code === 0 ? 200 : 500, result.status);
    }
    return send(response, 404, { error: "not_found" });
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

async function auditHistory(store?: AuditStore): Promise<unknown> {
  const records = store ? await store.list() : [];
  return {
    schemaVersion: "account-center.audit-history.v1",
    records: records.map(auditRecordView)
  };
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

function auditRecordView({ id, createdAt, action, outcome, proofState, summary, warnings }: AuditRecord) {
  return { id, createdAt, action, outcome, proofState, summary, warnings };
}

function authChallengeView({ id, mode, provider, runtime, scope, status, expiresAt, createdAt, updatedAt }: Awaited<ReturnType<AuthChallengeStore["create"]>>) {
  return { id, mode, provider, runtime, scope, status, ...(expiresAt ? { expiresAt } : {}), createdAt, updatedAt };
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
      { id: "status", mode: "read", state: "available", endpoint: { method: "GET", path: "/api/status" }, requires: ["bearer_token"] },
      { id: "models.list", mode: "read", state: "available", endpoint: { method: "GET", path: "/api/models" }, requires: ["bearer_token"] },
      { id: "runtime_scopes.list", mode: "read", state: "available", endpoint: { method: "GET", path: "/api/scopes" }, requires: ["bearer_token"] },
      { id: "auth_challenges.list", mode: "read", state: "available", endpoint: { method: "GET", path: "/api/auth-challenges" }, requires: ["bearer_token"] },
      { id: "auth_challenges.detail", mode: "read", state: "available", endpoint: { method: "GET", path: "/api/auth-challenges/:id" }, requires: ["bearer_token", "opaque_challenge_id"] },
      { id: "auth_challenges.cancel", mode: "mutation", state: "available", endpoint: { method: "POST", path: "/api/auth-challenges/:id/cancel" }, requires: ["bearer_token", "same_origin", "opaque_challenge_id"] },
      { id: "audit.history", mode: "read", state: "available", endpoint: { method: "GET", path: "/api/audit" }, requires: ["bearer_token"] },
      { id: "mutation_operations.history", mode: "read", state: "available", endpoint: { method: "GET", path: "/api/mutation-operations" }, requires: ["bearer_token"] },
      { id: "account.delete", mode: "mutation", state: "blocked", reason: "no_stable_native_exact_profile_delete_api", requires: ["bearer_token", "canonical_target", "stable_native_exact_profile_delete_api", "atomic_transaction", "post_delete_authoritative_proof"] },
      { id: "routes", mode: "mutation", state: "unproven", reason: "protected_route_contract_missing_scoped_review_idempotency_runtime_proof", requires: ["bearer_token", "dry_run", "explicit_confirmation", "idempotency_key"] },
      { id: "guided_auth", mode: "mutation", state: "unproven", reason: "protected_start_contract_missing_review_idempotency_runtime_proof", requires: ["bearer_token", "explicit_confirmation", "idempotency_key"] },
      { id: "models", mode: "mutation", state: "unproven", reason: "protected_model_contract_missing_scoped_review_idempotency_runtime_proof", requires: ["bearer_token", "dry_run", "explicit_confirmation", "idempotency_key"] },
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
    *{box-sizing:border-box}body{margin:0;min-width:320px;background:var(--bg);color:var(--text);font-size:14px;line-height:1.45}button,input{font:inherit}button{cursor:pointer}button:focus-visible,input:focus-visible,a:focus-visible{outline:3px solid var(--blue);outline-offset:2px}.skip{position:absolute;left:12px;top:-50px;padding:8px 12px;background:var(--text);color:#000;z-index:10}.skip:focus{top:12px}.shell{max-width:1440px;margin:auto;padding:20px 24px 36px}.topbar{display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:1px solid var(--line);padding-bottom:17px}.eyebrow,.caption{margin:0;color:var(--muted);font-size:11px;letter-spacing:.11em;text-transform:uppercase}.brand{display:flex;align-items:center;gap:12px}.mark{width:29px;height:29px;border:1px solid var(--accent);border-radius:7px;display:grid;place-items:center;color:var(--accent);font-weight:800}.brand h1{font-size:18px;margin:0;letter-spacing:-.03em}.local{border:1px solid #376858;border-radius:999px;padding:4px 9px;color:var(--accent);font-size:11px}.connection{display:grid;grid-template-columns:minmax(240px,1fr) auto;gap:16px;align-items:end;padding:18px 0}.connection h2,.section-title h2{font-size:14px;margin:0}.connection p{margin:4px 0 0;color:var(--muted);font-family:system-ui,sans-serif;font-size:13px}.token-form{display:flex;align-items:end;gap:8px}.field{min-width:0;flex:1}.field label{display:block;margin-bottom:5px;color:var(--muted);font-size:12px}.field input{width:100%;height:36px;border:1px solid var(--line);border-radius:6px;background:#090e13;color:var(--text);padding:0 9px}.primary,.quiet{height:36px;border-radius:6px;padding:0 12px;border:1px solid transparent;font-weight:700;font-size:12px;white-space:nowrap}.primary{background:var(--accent);color:#082119}.primary:hover{background:#a0e4cc}.primary[disabled]{opacity:.6;cursor:wait}.quiet{background:transparent;color:var(--muted);border-color:var(--line);cursor:not-allowed}.notice{display:flex;gap:9px;align-items:center;border:1px solid var(--line);border-radius:7px;background:var(--panel-2);padding:9px 11px;color:var(--muted);font-family:system-ui,sans-serif;font-size:13px}.notice[data-state="error"]{border-color:#8b4350;color:#ffd4da}.notice[data-state="ready"]{border-color:#356b5a;color:#d0f5e8}.notice-dot{width:7px;height:7px;border-radius:50%;background:currentColor;flex:none}.dashboard{display:grid;grid-template-columns:1.05fr .95fr;gap:14px;margin-top:14px}.panel{border:1px solid var(--line);border-radius:var(--radius);background:var(--panel);min-width:0}.panel-header{display:flex;align-items:start;justify-content:space-between;gap:10px;padding:14px 15px;border-bottom:1px solid var(--line)}.section-title{display:flex;align-items:baseline;gap:9px}.count{color:var(--muted);font-size:11px}.panel-body{padding:14px 15px}.health-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.metric{padding:10px;border:1px solid var(--line);border-radius:7px;background:var(--panel-2)}.metric strong{display:block;font-size:18px;line-height:1.1}.metric span{display:block;margin-top:4px;color:var(--muted);font-family:system-ui,sans-serif;font-size:11px}.status-line{display:flex;align-items:center;gap:7px;font-size:12px}.dot{width:7px;height:7px;border-radius:50%;background:var(--muted);flex:none}.ok{background:var(--accent)}.warn{background:var(--warn)}.error{background:var(--danger)}.unknown{background:var(--muted)}.runtime-list,.action-list{display:grid;gap:8px}.runtime-row,.action-row{display:flex;justify-content:space-between;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid var(--line)}.runtime-row:last-child,.action-row:last-child{border-bottom:0}.runtime-name{font-weight:700}.runtime-meta{color:var(--muted);font-family:system-ui,sans-serif;font-size:12px}.pill{display:inline-flex;align-items:center;border:1px solid var(--line);border-radius:999px;padding:2px 7px;color:var(--muted);font-size:10px;letter-spacing:.05em;text-transform:uppercase;white-space:nowrap}.pill.good{border-color:#376858;color:var(--accent)}.pill.warn{border-color:#735a2c;color:#ffd58c}.wide{grid-column:1/-1}.table-wrap{overflow:auto}.accounts{width:100%;border-collapse:collapse;font-size:12px}.accounts th{color:var(--muted);font-size:10px;letter-spacing:.08em;text-align:left;text-transform:uppercase}.accounts th,.accounts td{padding:10px 8px;border-bottom:1px solid var(--line);white-space:nowrap}.accounts th:first-child,.accounts td:first-child{padding-left:0}.accounts th:last-child,.accounts td:last-child{padding-right:0}.accounts tr:last-child td{border-bottom:0}.account-name{font-weight:700}.subtle{color:var(--muted);font-family:system-ui,sans-serif}.usage{display:flex;align-items:center;gap:6px}.bar{display:inline-block;width:46px;height:5px;background:#293440;border-radius:99px;overflow:hidden}.bar i{display:block;height:100%;background:var(--accent)}.bar i.low{background:var(--warn)}.bar i.bad{background:var(--danger)}.route-list{display:grid;gap:10px}.route{padding:10px;border-left:3px solid var(--blue);background:var(--panel-2)}.route strong{display:block;font-size:12px}.route p{margin:4px 0 0;color:var(--muted);font-family:system-ui,sans-serif;font-size:12px}.empty{color:var(--muted);font-family:system-ui,sans-serif;font-size:13px;padding:10px 0}.model-list{display:flex;flex-wrap:wrap;gap:6px}.model{border:1px solid var(--line);border-radius:5px;padding:4px 6px;font-size:11px}.model.disabled{border-color:#75434b;color:#f3aab2;text-decoration:line-through}.action-row p{margin:2px 0 0;color:var(--muted);font-family:system-ui,sans-serif;font-size:11px}.footer{display:flex;justify-content:space-between;gap:12px;padding-top:14px;color:var(--muted);font-family:system-ui,sans-serif;font-size:11px}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}@media(max-width:760px){.shell{padding:16px}.connection,.dashboard{grid-template-columns:1fr}.token-form{align-items:stretch}.health-grid{grid-template-columns:1fr}.topbar{align-items:start}.footer{flex-direction:column}.accounts th:nth-child(3),.accounts td:nth-child(3){display:none}}@media(max-width:430px){.token-form{flex-direction:column}.primary{width:100%}.local{display:none}}
  </style>
</head>
<body>
  <a class="skip" href="#workspace">Skip to workspace</a>
  <main class="shell" id="workspace" tabindex="-1">
    <header class="topbar"><div class="brand"><span class="mark" aria-hidden="true">AC</span><div><p class="eyebrow">Local control plane</p><h1>Account Center</h1></div></div><span class="local">Local-only · bearer protected</span></header>
    <section class="connection" aria-labelledby="connect-heading"><div><h2 id="connect-heading">Status connection</h2><p>Use the launch token for this local server. It is used only for this request and is never displayed.</p></div><form class="token-form" id="token-form"><div class="field"><label for="token">Launch token</label><input id="token" name="token" type="password" autocomplete="off" spellcheck="false" required aria-describedby="token-help"><span id="token-help" class="sr-only">Required to load current runtime status.</span></div><button class="primary" id="refresh" type="submit">Refresh status</button></form></section>
    <p class="notice" id="notice" data-state="idle" role="status" aria-live="polite"><span class="notice-dot" aria-hidden="true"></span><span>Awaiting a launch token. No runtime data is loaded.</span></p>
    <section class="dashboard" aria-label="Account Center workspace">
      <article class="panel"><div class="panel-header"><div class="section-title"><h2>Runtime health</h2><span class="count" id="source">Not connected</span></div><span class="pill" id="freshness">Unverified</span></div><div class="panel-body"><div class="health-grid" id="metrics"><div class="metric"><strong>—</strong><span>accounts readable</span></div><div class="metric"><strong>—</strong><span>routing health</span></div><div class="metric"><strong>—</strong><span>active warnings</span></div></div><div class="runtime-list" id="runtimes"><p class="empty">Runtime capability will appear after status loads.</p></div></div></article>
      <article class="panel"><div class="panel-header"><div class="section-title"><h2>Routing</h2><span class="count" id="route-count">No routes</span></div><span class="pill warn">Read-only view</span></div><div class="panel-body"><div class="route-list" id="routes"><p class="empty">No routing state loaded.</p></div></div></article>
      <article class="panel wide"><div class="panel-header"><div class="section-title"><h2>Connected accounts</h2><span class="count" id="account-count">No accounts</span></div><span class="pill">Status data</span></div><div class="panel-body table-wrap"><table class="accounts"><caption class="sr-only">Connected accounts and their current health</caption><thead><tr><th>Account</th><th>Health / auth</th><th>Capacity</th><th>Routing role</th><th>Runtime</th></tr></thead><tbody id="accounts"><tr><td colspan="5" class="empty">Load status to inspect connected accounts.</td></tr></tbody></table></div></article>
      <article class="panel"><div class="panel-header"><div class="section-title"><h2>Model policy</h2><span class="count" id="model-count">No catalog</span></div><span class="pill">Observed</span></div><div class="panel-body"><div class="model-list" id="models"><p class="empty">Models are derived from connected account status.</p></div></div></article>
      <article class="panel"><div class="panel-header"><div class="section-title"><h2>Operator actions</h2><span class="count">Guarded</span></div><span class="pill warn">Unproven</span></div><div class="panel-body"><div class="action-list"><div class="action-row"><div><strong>Switch route</strong><p>Mutation endpoint is not available in this local panel.</p></div><button class="quiet" type="button" disabled aria-describedby="route-action-note">Unsupported</button></div><div class="action-row"><div><strong>Reauthenticate account</strong><p>Challenge initiation has not been proven for this runtime.</p></div><button class="quiet" type="button" disabled>Unproven</button></div><div class="action-row"><div><strong>Change model policy</strong><p>Model mutations are not exposed by the status API.</p></div><button class="quiet" type="button" disabled>Unsupported</button></div></div><p id="route-action-note" class="sr-only">Route changes are unavailable because this panel has only a status API.</p></div></article>
    </section>
    <footer class="footer"><span id="updated">No successful status request yet.</span><span>Status payloads are expected to contain no secrets.</span></footer>
  </main>
  <script>
    (function () {
      var form = document.getElementById('token-form'); var token = document.getElementById('token'); var refresh = document.getElementById('refresh'); var notice = document.getElementById('notice');
      var source = document.getElementById('source'); var freshness = document.getElementById('freshness'); var metrics = document.getElementById('metrics'); var runtimes = document.getElementById('runtimes'); var routes = document.getElementById('routes'); var accounts = document.getElementById('accounts'); var models = document.getElementById('models');
      function text(value) { return String(value == null ? '—' : value); }
      function escapeHtml(value) { var box = document.createElement('span'); box.textContent = text(value); return box.innerHTML; }
      function setNotice(message, state) { notice.dataset.state = state; notice.lastElementChild.textContent = message; }
      function healthClass(value) { return value === 'ok' ? 'ok' : value === 'warn' ? 'warn' : value === 'error' ? 'error' : 'unknown'; }
      function percent(value) { return typeof value === 'number' ? Math.max(0, Math.min(100, value)) : 0; }
      function capability(runtime) { var c = runtime.capabilities || {}; var labels = []; if (c.readStatus) labels.push('status'); if (c.mutateRoutes) labels.push('routes'); if (c.startReauth) labels.push('reauth'); if (c.mutateModels) labels.push('models'); return labels.length ? labels.join(' · ') : 'no capabilities reported'; }
      function render(status) {
        var profileList = Array.isArray(status.profiles) ? status.profiles : []; var routeList = Array.isArray(status.routes) ? status.routes : []; var warningList = Array.isArray(status.warnings) ? status.warnings : [];
        var readable = profileList.filter(function (p) { return p.usage && p.usage.readable; }).length; var unhealthy = profileList.filter(function (p) { return p.usage && p.usage.health === 'error'; }).length;
        source.textContent = text(status.source) + ' · ' + text(status.schemaVersion); freshness.textContent = status.generatedAt ? 'Observed ' + new Date(status.generatedAt).toLocaleString() : 'Timestamp unknown'; freshness.className = 'pill good';
        metrics.innerHTML = '<div class="metric"><strong>' + readable + '/' + profileList.length + '</strong><span>accounts readable</span></div><div class="metric"><strong>' + (routeList.length ? (unhealthy ? 'attention' : 'nominal') : 'none') + '</strong><span>routing health</span></div><div class="metric"><strong>' + warningList.length + '</strong><span>active warnings</span></div>';
        runtimes.innerHTML = (status.runtimes || []).length ? status.runtimes.map(function (r) { return '<div class="runtime-row"><div><div class="runtime-name">' + escapeHtml(r.displayName || r.key) + '</div><div class="runtime-meta">' + escapeHtml(capability(r)) + '</div></div><span class="pill ' + (r.capabilities && r.capabilities.readStatus ? 'good' : 'warn') + '">' + (r.capabilities && r.capabilities.readStatus ? 'online' : 'unproven') + '</span></div>'; }).join('') : '<p class="empty">No runtime reported by this status source.</p>';
        document.getElementById('route-count').textContent = routeList.length + (routeList.length === 1 ? ' route' : ' routes'); routes.innerHTML = routeList.length ? routeList.map(function (r) { return '<div class="route"><strong>' + escapeHtml(r.provider) + ' → ' + escapeHtml(r.runtime) + '</strong><p>Active: <b>' + escapeHtml(r.activeProfileId) + '</b> · ' + (r.order || []).length + ' account' + ((r.order || []).length === 1 ? '' : 's') + ' in order</p></div>'; }).join('') : '<p class="empty">No route configured by this runtime.</p>';
        document.getElementById('account-count').textContent = profileList.length + (profileList.length === 1 ? ' account' : ' accounts'); accounts.innerHTML = profileList.length ? profileList.map(function (p) { var u = p.usage || {}; var windows = u.windows || []; var primary = windows[0] || {}; var value = primary.remainingPct; var barClass = value == null ? 'bad' : value < 10 ? 'low' : ''; return '<tr><td><div class="account-name">' + escapeHtml(p.label || p.id) + '</div><div class="subtle">' + escapeHtml(p.id) + '</div></td><td><div class="status-line"><span class="dot ' + healthClass(u.health) + '"></span>' + escapeHtml(u.health || 'unknown') + ' · ' + escapeHtml((u.auth || {}).state || 'unknown') + '</div></td><td><div class="usage"><span class="bar"><i class="' + barClass + '" style="width:' + percent(value) + '%"></i></span>' + (value == null ? 'unreadable' : value + '% ' + escapeHtml(primary.displayLabel || primary.name || 'remaining')) + '</div></td><td>' + escapeHtml(p.disabled ? 'disabled' : p.role || 'unknown') + '</td><td>' + escapeHtml((p.runtimeCompatibility || []).join(', ') || 'unproven') + '</td></tr>'; }).join('') : '<tr><td colspan="5" class="empty">No accounts reported by this runtime.</td></tr>';
        var modelSet = {}; profileList.forEach(function (p) { (p.models || []).forEach(function (m) { modelSet[m] = true; }); }); var modelNames = Object.keys(modelSet).sort(); var disabled = (status.policy && status.policy.disabledModels) || []; document.getElementById('model-count').textContent = modelNames.length + (modelNames.length === 1 ? ' model' : ' models'); models.innerHTML = modelNames.length ? modelNames.map(function (model) { var isDisabled = disabled.indexOf(model) !== -1; return '<span class="model' + (isDisabled ? ' disabled' : '') + '">' + escapeHtml(model) + (isDisabled ? ' · disabled' : '') + '</span>'; }).join('') : '<p class="empty">No model catalog was reported.</p>';
        document.getElementById('updated').textContent = 'Last successful request: ' + new Date().toLocaleString() + (status.noSecrets === true ? ' · no-secrets assertion present' : ' · no-secrets assertion unproven');
      }
      form.addEventListener('submit', async function (event) { event.preventDefault(); if (!token.value) { token.focus(); setNotice('A launch token is required to request status.', 'error'); return; } refresh.disabled = true; refresh.textContent = 'Refreshing…'; setNotice('Requesting local runtime status…', 'loading'); try { var response = await fetch('/api/status', { headers: { authorization: 'Bearer ' + token.value } }); if (!response.ok) throw new Error(response.status === 401 ? 'Token rejected. Check the local launch token.' : 'Status request failed (' + response.status + ').'); var status = await response.json(); render(status); setNotice('Runtime status loaded. Action controls remain unavailable until their APIs are proven.', 'ready'); } catch (error) { setNotice(error instanceof Error ? error.message : 'Status request could not be completed.', 'error'); } finally { refresh.disabled = false; refresh.textContent = 'Refresh status'; } });
    }());
  </script>
</body>
</html>`;
}
