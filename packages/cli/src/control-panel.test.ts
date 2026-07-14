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
    assert.match(html, /Operator actions/);
    assert.match(html, /Unsupported/);
    assert.match(html, /authorization: 'Bearer ' \+ token.value/);
  } finally {
    await app.close();
  }
});
