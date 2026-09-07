import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { OpenClawRoutingPool } from "@account-center/core";
import { createAccountCenterServer } from "./server.js";

test("local control panel serves a calm accessible shell without weakening safety boundaries", async () => {
  const app = createAccountCenterServer({ token: "test-token" });
  const address = await app.listen();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /<main/);
    assert.match(html, /Account Center/);
    assert.match(html, /aria-live/);
    assert.match(html, /data-tab="home">Home/);
    assert.match(html, /data-tab="accounts">Accounts/);
    assert.match(html, /data-tab="more">More/);
    assert.match(html, /id="home-view"/);
    assert.match(html, /Runtime health/);
    assert.match(html, /Attention &amp; pending work/);
    assert.match(html, /Visible accounts/);
    assert.doesNotMatch(html, /<h2>Model policy<\/h2>/);
    assert.match(html, /<h2>Settings<\/h2>/);
    assert.match(html, /aria-label="Everyday settings help"/);
    assert.match(html, /<h2>Local connection<\/h2>/);
    assert.match(html, /<h2>Need to sign in\?<\/h2>/);
    assert.match(html, /id="onboarding-dialog"/);
    assert.match(html, /Welcome to Account Center/);
    assert.match(html, /Skip for now/);
    assert.match(html, /id="replay-onboarding"[^>]*>Replay welcome/);
    assert.match(html, /Only supported actions are offered/);
    assert.match(html, /Routing, model changes, and runtime sign-in changes remain unavailable without proof/);
    assert.doesNotMatch(html, /localStorage|sessionStorage/);
    assert.match(html, /id="guided-freshness" aria-describedby="guided-freshness-detail">Status unavailable/);
    assert.match(html, /Guided-auth records have not been checked\. No sign-in result is shown\./);
    assert.match(html, /id="audit-freshness" aria-describedby="audit-freshness-detail">Status unavailable/);
    assert.match(html, /Audit records have not been checked\. Previously loaded evidence is not shown as current\./);
    assert.match(html, /id="operation-freshness" aria-describedby="operation-freshness-detail">Status unavailable/);
    assert.match(html, /Operation records have not been checked\. Previously loaded evidence is not shown as current\./);
    assert.match(html, /id="models-fallbacks-badge" aria-describedby="models-fallbacks-detail">Status unavailable/);
    assert.match(html, /Model-policy evidence has not been checked\. No model setting or fallback is shown as current\./);
    assert.match(html, />Advanced</);
    assert.match(html, /Hidden locally only\. It can be restored to everyday lists; the connected credential and runtime state are preserved\./);
    assert.match(html, /Hide account locally; credentials stay connected/);
    assert.match(html, /Restore account to everyday lists/);
    assert.match(html, /No credential deletion was requested/);
    assert.match(html, /\/api\/account-ui-preferences/);
    assert.doesNotMatch(html, /\/api\/auth-challenges\/(?:start|complete)/);
    assert.match(html, /credentials: 'same-origin'/);
    assert.match(html, /--prose:system-ui/);
    assert.match(html, /@media\(max-width:320px\)/);
  } finally {
    await app.close();
  }
});

test("Home labels runtime coverage UNPROVEN until protected status identifies its source", async () => {
  const app = createAccountCenterServer({ token: "test-token" });
  const address = await app.listen();
  try {
    const html = await (await fetch(`http://127.0.0.1:${address.port}/`)).text();
    const initialShell = html.slice(0, html.indexOf("<script>"));
    assert.match(initialShell, /<h2>Runtime coverage<\/h2>/);
    assert.match(initialShell, /id="sentinel-runtimes"(?![^>]*hidden)/);
    assert.match(initialShell, /id="runtime-coverage-explanation"[^>]*aria-live="polite"[^>]*aria-atomic="true"/);
    assert.doesNotMatch(initialShell, /id="runtime-coverage-explanation"[^>]*role="status"/);
    assert.match(initialShell, /Runtime coverage source is UNPROVEN\. Hermes, OpenClaw, and Codex are not shown as live discovery\./);
    assert.doesNotMatch(initialShell, /Example data from the fixture status/);
    assert.doesNotMatch(initialShell, /protected live OpenClaw evidence/);
  } finally {
    await app.close();
  }
});

test("routing-pool panel copy separates saved candidates from an explicit override", async () => {
  const app = createAccountCenterServer({ token: "test-token" });
  const address = await app.listen();
  try {
    const html = await (await fetch(`http://127.0.0.1:${address.port}/`)).text();
    assert.match(html, /Routing Pool/);
    assert.match(html, /Saved\/unverified candidates/);
    assert.match(html, /Explicit override order/);
    assert.match(html, /UNPROVEN\/read-only/);
  } finally {
    await app.close();
  }
});

test("protected routing pools accept provider-confirmed email-shaped IDs but expose only opaque redacted snapshots", async () => {
  const privatePool: OpenClawRoutingPool = { agentId: "private-agent", provider: "openai", profiles: ["openai:private@example.test"], order: ["openai:private@example.test"] };
  const status = JSON.parse(await readFile(new URL("../../../tests/fixtures/status.fixture.json", import.meta.url), "utf8"));
  status.routes = [{ ...status.routes[0], runtime: "openclaw", scope: "agent:private-agent" }];
  const app = createAccountCenterServer({ token: "test-token", source: "openclaw", statusReader: async () => status, routingPoolAgentReader: async () => ["private-agent"], routingPoolReader: async () => privatePool });
  const address = await app.listen();
  try {
    const origin = `http://127.0.0.1:${address.port}`;
    const unauthorized = await fetch(`${origin}/api/routing-pools`);
    assert.equal(unauthorized.status, 401);
    const methodRejected = await fetch(`${origin}/api/routing-pools`, { method: "POST", headers: { authorization: "Bearer test-token" } });
    assert.equal(methodRejected.status, 405);
    const accepted = await fetch(`${origin}/api/routing-pools?runtime=openclaw&scope=agent%3Aagent-20cee3d10892329d`, { headers: { authorization: "Bearer test-token" } });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get("cache-control"), "no-store");
    const text = await accepted.text();
    assert.doesNotMatch(text, /private-agent|private-profile|private@example\.test|openai:/);
    const payload = JSON.parse(text);
    assert.deepEqual(Object.keys(payload).sort(), ["pools", "schemaVersion", "state", "verificationState"]);
    assert.equal(payload.schemaVersion, "account-center.openclaw-routing-pools.v1");
    assert.equal(payload.verificationState, "UNPROVEN");
    assert.equal(payload.state, "read-only");
    assert.equal(payload.pools.length, 1);
    assert.match(payload.pools[0].agentRef, /^agent-[a-f0-9]{16}$/);
  } finally { await app.close(); }
});

test("routing-pool failures and missing selectors fail closed before a reader can run", async () => {
  for (const source of ["fixture", "openclaw"] as const) {
    let reads = 0;
    const app = createAccountCenterServer({ token: "test-token", source, routingPoolReader: async () => { reads++; throw new Error("private path and profile"); } });
    const address = await app.listen();
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/routing-pools`, { headers: { authorization: "Bearer test-token" } });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: "invalid_query" });
      assert.equal(reads, 0);
    } finally { await app.close(); }
  }
});

test("routing pools fail closed when the returned private agent does not bind to the selected opaque scope", async () => {
  const requestedScope = "agent:agent-20cee3d10892329d";
  const status = JSON.parse(await readFile(new URL("../../../tests/fixtures/status.fixture.json", import.meta.url), "utf8"));
  const app = createAccountCenterServer({
    token: "test-token",
    source: "openclaw",
    statusReader: async () => status,
    routingPoolAgentReader: async () => ["private-agent"],
    routingPoolReader: async () => ({ agentId: "other-private-agent", provider: "openai", profiles: ["openai:private-profile"], order: [] })
  });
  const address = await app.listen();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/routing-pools?runtime=openclaw&scope=${encodeURIComponent(requestedScope)}`, { headers: { authorization: "Bearer test-token" } });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { schemaVersion: "account-center.openclaw-routing-pools.v1", verificationState: "UNPROVEN", state: "read-only", error: "UNPROVEN", pools: [] });
  } finally { await app.close(); }
});

test("routing pools require the authoritative selected opaque OpenClaw agent scope before one scoped read", async () => {
  const privateAgent = "private-agent";
  const publicScope = "agent:agent-20cee3d10892329d";
  const status = JSON.parse(await readFile(new URL("../../../tests/fixtures/status.fixture.json", import.meta.url), "utf8"));
  status.routes = [{ ...status.routes[0], runtime: "openclaw", scope: `agent:${privateAgent}` }];
  let reads = 0;
  const app = createAccountCenterServer({ token: "test-token", source: "openclaw", statusReader: async () => status, routingPoolAgentReader: async () => [privateAgent], routingPoolReader: async (scope) => {
    reads++;
    assert.equal(scope, publicScope);
    return { agentId: privateAgent, provider: "openai", profiles: ["openai:private-profile"], order: [] };
  } });
  const address = await app.listen();
  try {
    const origin = `http://127.0.0.1:${address.port}`;
    for (const suffix of ["", "?runtime=hermes&scope=" + publicScope, "?runtime=openclaw&scope=agent:agent-not-the-selected-agent"]) {
      const response = await fetch(`${origin}/api/routing-pools${suffix}`, { headers: { authorization: "Bearer test-token" } });
      assert.equal(response.status, 400);
    }
    assert.equal(reads, 0);
    const selected = await fetch(`${origin}/api/routing-pools?runtime=openclaw&scope=${encodeURIComponent(publicScope)}`, { headers: { authorization: "Bearer test-token" } });
    assert.equal(selected.status, 200);
    assert.equal(reads, 1);
    assert.doesNotMatch(await selected.text(), /private-agent|private-profile/);
  } finally { await app.close(); }
});
