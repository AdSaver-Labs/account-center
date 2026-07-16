import test from "node:test";
import assert from "node:assert/strict";
import { cancelAuthChallenge, createAuthChallenge, expireAuthChallenge, getAuthChallenge } from "./auth-challenges.js";

test("guided auth challenge preserves add mode and de-duplicates active target", () => {
  const first = createAuthChallenge({ mode: "add", provider: "openai", runtime: "openclaw", target: "new@example.com", scope: "agent:main" });
  const second = createAuthChallenge({ mode: "add", provider: "openai", runtime: "openclaw", target: "NEW@example.com", scope: "agent:main" }, [first]);
  assert.equal(first.mode, "add");
  assert.equal(first.status, "pending");
  assert.equal(second.id, first.id);
});

test("guided add and reauth challenges for the same target never collapse into one operation", () => {
  const add = createAuthChallenge({ mode: "add", provider: "openai", runtime: "openclaw", target: "same@example.com", scope: "agent:main" });
  const reauth = createAuthChallenge({ mode: "reauth", provider: "openai", runtime: "openclaw", target: "same@example.com", scope: "agent:main" }, [add]);
  assert.notEqual(reauth.id, add.id);
  assert.notEqual(reauth.key, add.key);
  assert.equal(reauth.mode, "reauth");
});

test("guided auth challenge can be cancelled without exposing credentials", () => {
  const challenge = createAuthChallenge({ mode: "reauth", provider: "openai", runtime: "openclaw", target: "old@example.com", scope: "agent:main" });
  const cancelled = cancelAuthChallenge(challenge);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(JSON.stringify(getAuthChallenge([cancelled], cancelled.id)).includes("token"), false);
});

test("guided auth expires deterministically and an expired challenge no longer blocks replacement", () => {
  const input = { mode: "add" as const, provider: "openai", runtime: "openclaw", target: "new@example.com", scope: "agent:main", expiresAt: "2026-07-14T18:00:00.000Z" };
  const challenge = createAuthChallenge(input, [], new Date("2026-07-14T17:00:00.000Z"));
  assert.equal(expireAuthChallenge(challenge, new Date("2026-07-14T17:59:59.999Z")).status, "pending");
  const expired = expireAuthChallenge(challenge, new Date(input.expiresAt));
  assert.equal(expired.status, "expired");
  assert.equal(cancelAuthChallenge(challenge, new Date(input.expiresAt)).status, "expired");
  const replacement = createAuthChallenge(input, [challenge], new Date("2026-07-14T18:00:00.000Z"));
  assert.notEqual(replacement.id, challenge.id);
});

test("guided auth rejects malformed expiry instead of leaving a challenge pending forever", () => {
  assert.throws(() => createAuthChallenge({ mode: "add", provider: "openai", runtime: "openclaw", target: "new@example.com", scope: "agent:main", expiresAt: "not-a-date" }), /invalid challenge expiry/);
});

test("guided auth rejects unsafe public lifecycle metadata before it can become durable inventory", () => {
  assert.throws(() => createAuthChallenge({ mode: "add", provider: "private@example.test", runtime: "openclaw", target: "new@example.com", scope: "default" }), /invalid challenge provider/);
  assert.throws(() => createAuthChallenge({ mode: "add", provider: "openai", runtime: "open claw", target: "new@example.com", scope: "default" }), /invalid challenge runtime/);
  assert.throws(() => createAuthChallenge({ mode: "add", provider: "openai", runtime: "openclaw", target: "new@example.com", scope: "agent:private@example.test" }), /invalid challenge scope/);
});
