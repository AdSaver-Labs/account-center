import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseAuthCommand } from "./auth-bridge.js";

const contract = readFileSync(new URL("../../../docs/AUTH_COMMAND_CONTRACT.md", import.meta.url), "utf8");
const strategy = readFileSync(new URL("../../../docs/ACCOUNT_CENTER_CONTROL_APP_STRATEGY.md", import.meta.url), "utf8");
const operations = readFileSync(new URL("../../../docs/AGENT_OPERATIONS.md", import.meta.url), "utf8");

test("auth command contract documents remove preview/confirmation and safety distinctions", () => {
  assert.match(contract, /\/auth auto` \| route mutation \| live apply/);
  assert.match(contract, /\/auth add <email>` \| guided auth \| create local guided challenge/);
  assert.match(contract, /POST \/api\/auth-challenges/);
  assert.match(contract, /remove\*\* means remove from routing only/);
  assert.match(contract, /preview first; exact confirmed apply/);
  assert.match(contract, /delete\*\* means credential deletion/);
  assert.match(contract, /Direct JSON\/SQLite edits and private runtime internals are not supported/);
  assert.match(contract, /owned runtime-local transaction/);
  assert.match(contract, /opaque receipt `opaque-owned-delete`/);
  assert.match(contract, /explicitly given `--apply`/);
  assert.match(contract, /Hermes \/ Jack/);
  assert.match(contract, /Codex is chat\/session\/default oriented/);
});

test("control-app strategy preserves the owned delete transaction and opaque receipt boundary", () => {
  assert.match(strategy, /codex-auth-delete\.py/);
  assert.match(strategy, /the same transaction used by Dexter `\/auth delete`/);
  assert.match(strategy, /exact-target adapter with explicit `--apply`/);
  assert.match(strategy, /opaque receipt `opaque-owned-delete`/);
  assert.match(strategy, /Missing, malformed, or unverified native evidence remains fail-closed as `UNPROVEN`/);
  assert.doesNotMatch(strategy, /until a documented native transactional delete adapter exists/);
});

test("operations guidance names the owned delete transaction instead of the superseded upstream-CLI blocker", () => {
  assert.match(operations, /Credential delete \| `account\.delete` \| Available only through the owned exact-account transaction/);
  assert.match(operations, /`codex-auth-delete\.py` transaction shared with Dexter `\/auth delete`/);
  assert.match(operations, /target-free opaque receipt `opaque-owned-delete`/);
  assert.match(operations, /malformed, or unverified native evidence is `UNPROVEN`/);
  assert.doesNotMatch(operations, /installed OpenClaw CLI has no stable exact-profile deletion API/);
});

test("contract-critical auth commands map to expected executor argv", () => {
  assert.deepEqual(parseAuthCommand("/auth"), ["status"]);
  assert.deepEqual(parseAuthCommand("/auth auto"), ["routes", "auto", "--apply"]);
  assert.deepEqual(parseAuthCommand("/auth use openai:helper-2"), ["routes", "use", "openai:helper-2", "--apply"]);
  assert.deepEqual(parseAuthCommand("/auth remove openai:helper-2"), ["routes", "remove", "openai:helper-2", "--dry-run"]);
  assert.deepEqual(parseAuthCommand("/auth delete openai:helper-2"), ["accounts", "delete", "openai:helper-2", "--dry-run"]);
  assert.deepEqual(parseAuthCommand("/auth add new@example.com"), ["reauth", "start", "new@example.com", "--mode", "add", "--apply"]);
  assert.deepEqual(parseAuthCommand("/auth reauth old@example.com"), ["reauth", "start", "old@example.com", "--mode", "reauth", "--apply"]);
});
