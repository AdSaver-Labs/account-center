import test from "node:test";
import assert from "node:assert/strict";
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
