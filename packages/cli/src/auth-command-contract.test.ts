import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseAuthCommand } from "./auth-bridge.js";

const contract = readFileSync(new URL("../../../docs/AUTH_COMMAND_CONTRACT.md", import.meta.url), "utf8");

test("auth command contract documents remove preview/confirmation and safety distinctions", () => {
  assert.match(contract, /\/auth auto` \| route mutation \| live apply/);
  assert.match(contract, /\/auth add <email>` \| guided auth \| create local guided challenge/);
  assert.match(contract, /POST \/api\/auth-challenges/);
  assert.match(contract, /remove\*\* means remove from routing only/);
  assert.match(contract, /preview first; exact confirmed apply/);
  assert.match(contract, /delete\*\* means credential deletion/);
  assert.match(contract, /Direct JSON\/SQLite edits and private runtime internals are not supported/);
  assert.match(contract, /documented native OpenClaw\/Sentinel transaction/);
  assert.match(contract, /Hermes \/ Jack/);
  assert.match(contract, /Codex is chat\/session\/default oriented/);
});

test("contract-critical auth commands map to expected executor argv", () => {
  assert.deepEqual(parseAuthCommand("/auth"), ["status"]);
  assert.deepEqual(parseAuthCommand("/auth auto"), ["routes", "auto", "--apply"]);
  assert.deepEqual(parseAuthCommand("/auth use openai:helper-2"), ["routes", "use", "openai:helper-2", "--apply"]);
  assert.deepEqual(parseAuthCommand("/auth remove openai:helper-2"), ["routes", "remove", "openai:helper-2", "--dry-run"]);
  assert.deepEqual(parseAuthCommand("/auth delete openai:helper-2"), ["accounts", "delete", "openai:helper-2", "--apply"]);
  assert.deepEqual(parseAuthCommand("/auth add new@example.com"), ["reauth", "start", "new@example.com", "--mode", "add", "--apply"]);
  assert.deepEqual(parseAuthCommand("/auth reauth old@example.com"), ["reauth", "start", "old@example.com", "--mode", "reauth", "--apply"]);
});
