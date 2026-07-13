import test from "node:test";
import assert from "node:assert/strict";
import { createAuthChallenge, cancelAuthChallenge, getAuthChallenge } from "./auth-challenges.js";

test("guided auth challenge preserves add mode and de-duplicates active target", () => {
  const first = createAuthChallenge({ mode: "add", provider: "openai", runtime: "openclaw", target: "new@example.com", scope: "agent:main" });
  const second = createAuthChallenge({ mode: "add", provider: "openai", runtime: "openclaw", target: "NEW@example.com", scope: "agent:main" }, [first]);
  assert.equal(first.mode, "add");
  assert.equal(first.status, "pending");
  assert.equal(second.id, first.id);
});

test("guided auth challenge can be cancelled without exposing credentials", () => {
  const challenge = createAuthChallenge({ mode: "reauth", provider: "openai", runtime: "openclaw", target: "old@example.com", scope: "agent:main" });
  const cancelled = cancelAuthChallenge(challenge);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(JSON.stringify(getAuthChallenge([cancelled], cancelled.id)).includes("token"), false);
});
