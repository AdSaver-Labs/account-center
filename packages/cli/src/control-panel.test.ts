import test from "node:test";
import assert from "node:assert/strict";
import { createAccountCenterServer } from "./server.js";

test("local control panel serves an accessible application shell", async () => {
  const app = createAccountCenterServer({ token: "test-token" });
  const address = await app.listen();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /<main/);
    assert.match(html, /Account Center/);
    assert.match(html, /aria-live/);
    assert.match(html, /Connected accounts/);
    assert.match(html, /Attention &amp; pending work/);
    assert.match(html, /View guided auth/);
    assert.match(html, /Guided auth/);
    assert.match(html, /Receipts &amp; audit/);
    assert.match(html, /data-view="dashboard"/);
    assert.match(html, /\/api\/auth-challenges/);
    assert.match(html, /\/api\/audit/);
    assert.match(html, /\/api\/models/);
    assert.match(html, /\/api\/scopes/);
    assert.match(html, /Unsupported/);
    assert.match(html, /authorization: 'Bearer ' \+ token.value/);
    assert.match(html, /Cancel pending challenge/);
    assert.match(html, /function scopeLabel\(scope\)/);
    assert.match(html, /scope not reported/);
    assert.match(html, /\/api\/auth-challenges\/.*encodeURIComponent\(id\).*\/cancel/);
    assert.match(html, /credentials: 'same-origin'/);
    assert.match(html, /UNPROVEN — data unavailable/);
    assert.match(html, /Retry workspace data/);
    assert.match(html, /some evidence is UNPROVEN/);
    assert.doesNotMatch(html, /localStorage|sessionStorage/);
  } finally {
    await app.close();
  }
});
