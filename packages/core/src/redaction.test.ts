import test from "node:test";
import assert from "node:assert/strict";
import { redactJson, redactText } from "./redaction.js";

test("redactText removes token-shaped values", () => {
  const input = "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456 and sk-abcdefghijklmnop";
  const output = redactText(input);
  assert.equal(output.includes("abcdefghijklmnopqrstuvwxyz123456"), false);
  assert.equal(output.includes("sk-abcdefghijklmnop"), false);
  assert.match(output, /\[REDACTED\]/);
});

test("redactText removes account emails", () => {
  const output = redactText("Route update for private@example.test was blocked.");
  assert.equal(output.includes("private@example.test"), false);
  assert.match(output, /\[REDACTED_EMAIL\]/);
});

test("redactJson redacts sensitive keys recursively", () => {
  const output = redactJson({
    profile: "openai:helper-1",
    noSecrets: true,
    auth: {
      refreshToken: "secret-refresh-token-value",
      nested: [{ api_key: "secret-api-key-value" }]
    }
  });
  assert.equal(output.auth.refreshToken, "[REDACTED]");
  assert.equal(output.auth.nested[0].api_key, "[REDACTED]");
  assert.equal(output.profile, "openai:helper-1");
  assert.equal(output.noSecrets, true);
});
