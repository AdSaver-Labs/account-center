import test from "node:test";
import assert from "node:assert/strict";
import { parseAuthCommand, renderAuthHelp } from "./auth-bridge.js";
import { runCli } from "./index.js";

test("/auth status maps to account-center status with JSON/no-write preserved", () => {
  assert.deepEqual(parseAuthCommand("/auth status --json --no-write-export"), ["status", "--json", "--no-write-export"]);
});

test("/auth accounts and /auth next map to existing CLI commands", () => {
  assert.deepEqual(parseAuthCommand("/auth accounts"), ["accounts", "list"]);
  assert.deepEqual(parseAuthCommand("/auth next --source openclaw"), ["routes", "next", "--source", "openclaw"]);
  assert.deepEqual(parseAuthCommand("/auth probe --provider all --json"), ["providers", "probe", "--provider", "all", "--json"]);
});

test("/auth auto/use/remove/disable/enable/model commands stay dry-run unless --apply is explicit", () => {
  assert.deepEqual(parseAuthCommand("/auth auto"), ["routes", "auto"]);
  assert.deepEqual(parseAuthCommand("/auth use openai:helper-2"), ["routes", "use", "openai:helper-2"]);
  assert.deepEqual(parseAuthCommand("/auth remove helper-1"), ["routes", "remove", "helper-1"]);
  assert.deepEqual(parseAuthCommand("/auth disable helper-1"), ["accounts", "disable", "helper-1"]);
  assert.deepEqual(parseAuthCommand("/auth enable helper-1 --apply"), ["accounts", "enable", "helper-1", "--apply"]);
  assert.deepEqual(parseAuthCommand("/auth model disable openai/gpt-5.3-codex"), ["models", "disable", "openai/gpt-5.3-codex"]);
});

test("/auth help promotes auth and never promotes oauth", () => {
  const help = renderAuthHelp();
  assert.match(help, /^\/auth commands/m);
  assert.doesNotMatch(help, /\/oauth/);
});

test("/oauth is rejected as a manual chat command", () => {
  assert.throws(() => parseAuthCommand("/oauth status"), /Manual command is \/auth/);
});

test("CLI auth bridge executes /auth guard against fixture status", async () => {
  const result = await runCli(["auth", "/auth", "guard", "--json"]);
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.next, "openai:helper-2");
});

test("CLI auth bridge executes /auth probe against fixture status", async () => {
  const result = await runCli(["auth", "/auth", "probe", "--json"]);
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed[0].provider, "openai");
  assert.equal(parsed[0].usableProfiles, 2);
});

test("CLI auth bridge rejects oauth manual command", async () => {
  const result = await runCli(["auth", "/oauth", "status"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr ?? "", /Manual command is \/auth/);
});
