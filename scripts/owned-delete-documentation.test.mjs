import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const documents = [
  "docs/ACCOUNT_CENTER_CONTROL_APP_STRATEGY.md",
  "docs/AUTH_COMMAND_CONTRACT.md",
  "docs/AGENT_OPERATIONS.md",
].map((relative) => ({ relative, text: readFileSync(resolve(root, relative), "utf8") }));

function combined() {
  return documents.map(({ text }) => text).join("\n");
}

test("public delete strategy documents the one owned exact-account transaction", () => {
  const text = combined();
  for (const required of [
    "codex-auth-delete.py",
    "Dexter `/auth delete`",
    "exact connected target",
    "preview by default",
    "explicit `--apply`",
    "backup",
    "atomic rollback",
    "authoritative verification",
    "opaque-owned-delete",
    "UNPROVEN",
  ]) {
    assert.match(text, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `missing public delete contract: ${required}`);
  }

  for (const staleClaim of [
    /no native (?:delete )?transaction exists/i,
    /delete is blocked because no native/i,
    /upstream OpenClaw CLI delete command is required/i,
  ]) {
    assert.doesNotMatch(text, staleClaim);
  }
});

test("each public delete contract keeps receipt evidence target-free and sole", () => {
  for (const { relative, text } of documents) {
    assert.match(text, /opaque-owned-delete/, `${relative} must name the opaque receipt`);
    assert.match(text, /target-free|no native path, target digest|target digest, paths/i, `${relative} must prohibit target disclosure`);
    assert.doesNotMatch(text, /receipt:\s*[^\s`]*[A-Za-z0-9][^\s`]*@/i, `${relative} must not document an identity-bearing receipt`);
  }
});
