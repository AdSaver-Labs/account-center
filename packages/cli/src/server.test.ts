import test from "node:test";
import assert from "node:assert/strict";
import { createAccountCenterServer } from "./server.js";

async function request(port: number, path: string, token?: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
}

test("local API requires bearer token and returns no-store status", async () => {
  const app = createAccountCenterServer({ token: "test-token" });
  const address = await app.listen();
  try {
    const denied = await request(address.port, "/api/status");
    assert.equal(denied.status, 401);
    const accepted = await request(address.port, "/api/status", "test-token");
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get("cache-control"), "no-store");
    const body = await accepted.json() as { schemaVersion: string };
  } finally {
    await app.close();
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
    const body = await accepted.json() as { schemaVersion: string; target: string; actions: Array<{ id: string; mode: string; state: string; requires: string[]; reason?: string }> };
    assert.equal(body.schemaVersion, "account-center.agent-capabilities.v1");
    assert.equal(body.target, "account-center");
    assert.deepEqual(body.actions.find((action) => action.id === "status"), { id: "status", mode: "read", state: "available", requires: ["bearer_token"] });
    assert.deepEqual(body.actions.find((action) => action.id === "account.delete"), {
      id: "account.delete",
      mode: "mutation",
      state: "blocked",
      reason: "no_stable_native_exact_profile_delete_api",
      requires: ["bearer_token", "canonical_target", "stable_native_exact_profile_delete_api", "atomic_transaction", "post_delete_authoritative_proof"]
    });
    assert.equal(JSON.stringify(body).match(/secret|password|accessToken|refreshToken/i), null);
  } finally {
    await app.close();
  }
});
