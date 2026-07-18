import test from "node:test";
import assert from "node:assert/strict";
import { inspectAuthCommand, parseAuthCommand, renderAuthHelp, tokenizeAuthCommand } from "./auth-bridge.js";
import { runCli } from "./index.js";

test("/auth status maps to account-center status with JSON/no-write preserved", () => {
  assert.deepEqual(parseAuthCommand("/auth status --json --no-write-export"), ["status", "--json", "--no-write-export"]);
});

test("/auth accounts and /auth next map to existing CLI commands", () => {
  assert.deepEqual(parseAuthCommand("/auth accounts"), ["accounts", "list"]);
  assert.deepEqual(parseAuthCommand("/auth next --source openclaw"), ["routes", "next", "--source", "openclaw"]);
  assert.deepEqual(parseAuthCommand("/auth probe --provider all --json"), ["providers", "probe", "--provider", "all", "--json"]);
});

test("manual /auth route/delete commands apply by default and support explicit dry-run", () => {
  assert.deepEqual(parseAuthCommand("/auth auto"), ["routes", "auto", "--apply"]);
  assert.deepEqual(parseAuthCommand("/auth auto --dry-run"), ["routes", "auto", "--dry-run"]);
  assert.deepEqual(parseAuthCommand("/auth use openai:helper-2"), ["routes", "use", "openai:helper-2", "--apply"]);
  assert.deepEqual(parseAuthCommand("/auth use openai:helper-2 --dry-run"), ["routes", "use", "openai:helper-2", "--dry-run"]);
  assert.deepEqual(parseAuthCommand("/auth remove helper-1"), ["routes", "remove", "helper-1", "--apply"]);
  assert.deepEqual(parseAuthCommand("/auth delete helper-1"), ["accounts", "delete", "helper-1", "--apply"]);
  assert.deepEqual(parseAuthCommand("/auth delete helper-1 --dry-run"), ["accounts", "delete", "helper-1", "--dry-run"]);
  assert.deepEqual(parseAuthCommand("/auth delete old@example.com --apply"), ["accounts", "delete", "old@example.com", "--apply"]);
  assert.deepEqual(parseAuthCommand("/auth disable helper-1"), ["accounts", "disable", "helper-1"]);
  assert.deepEqual(parseAuthCommand("/auth enable helper-1 --apply"), ["accounts", "enable", "helper-1", "--apply"]);
  assert.deepEqual(parseAuthCommand("/auth model disable openai/gpt-5.3-codex"), ["models", "disable", "openai/gpt-5.3-codex"]);
});

test("/auth add and reauth preserve guided-auth mode", () => {
  assert.deepEqual(parseAuthCommand("/auth add new@example.com"), ["reauth", "start", "new@example.com", "--mode", "add", "--apply"]);
  assert.deepEqual(parseAuthCommand("/auth reauth old@example.com"), ["reauth", "start", "old@example.com", "--mode", "reauth", "--apply"]);
  const addDryRun = parseAuthCommand("/auth add new@example.com --dry-run");
  assert.equal(addDryRun[0], "reauth");
  assert.equal(addDryRun[1], "start");
  assert.equal(addDryRun[2], "new@example.com");
  assert.equal(addDryRun.includes("--mode"), true);
  assert.equal(addDryRun[addDryRun.indexOf("--mode") + 1], "add");
  assert.equal(addDryRun.includes("--dry-run"), true);
  const reauthDryRun = parseAuthCommand("/auth reauth old@example.com --dry-run");
  assert.equal(reauthDryRun[0], "reauth");
  assert.equal(reauthDryRun[1], "start");
  assert.equal(reauthDryRun[2], "old@example.com");
  assert.equal(reauthDryRun.includes("--mode"), true);
  assert.equal(reauthDryRun[reauthDryRun.indexOf("--mode") + 1], "reauth");
  assert.equal(reauthDryRun.includes("--dry-run"), true);
});

test("/auth help promotes auth and never promotes oauth", () => {
  const help = renderAuthHelp();
  assert.match(help, /^\/auth commands/m);
  assert.doesNotMatch(help, /\/oauth/);
});

test("/oauth is rejected as a manual chat command", () => {
  assert.throws(() => parseAuthCommand("/oauth status"), /Manual command is \/auth/);
});

test("manual parser preserves quoted operands and marks quoted or escaped dry-run flags ineligible for MCP authorization", () => {
  assert.deepEqual(tokenizeAuthCommand('/auth use "opaque target" --dry-run'), ["/auth", "use", "opaque target", "--dry-run"]);
  assert.deepEqual(inspectAuthCommand('/auth use "opaque target" --dry-run'), {
    invocation: ["routes", "use", "opaque target", "--dry-run"],
    mutationCapable: true,
    explicitlyDryRun: true
  });
  assert.equal(inspectAuthCommand('/auth use target "--dry-run"').explicitlyDryRun, false);
  assert.equal(inspectAuthCommand("/auth use target \\--dry-run").explicitlyDryRun, false);
  assert.equal(inspectAuthCommand("/auth use target --dry-run --apply").explicitlyDryRun, false);
});

test("manual parser classifies guarded route apply and positional route use as mutation-capable", () => {
  assert.deepEqual(inspectAuthCommand("/auth guard --ensure-route --apply"), {
    invocation: ["guard", "--ensure-route", "--apply"],
    mutationCapable: true,
    explicitlyDryRun: false
  });
  assert.deepEqual(inspectAuthCommand("/auth openai:opaque-target --dry-run"), {
    invocation: ["routes", "use", "openai:opaque-target", "--dry-run"],
    mutationCapable: true,
    explicitlyDryRun: true
  });
});

test("CLI auth bridge executes /auth guard against fixture status", async () => {
  const result = await runCli(["auth", "/auth", "guard", "--json"]);
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.next, "account-2");
});

test("CLI auth bridge executes /auth probe against fixture status with an opaque public view", async () => {
  const result = await runCli(["auth", "/auth", "probe", "--json"]);
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.schemaVersion, "account-center.public-provider-probes.v1");
  assert.equal(parsed.verificationState, "UNPROVEN");
  assert.equal(parsed.probes[0].state, "OK");
  assert.equal(parsed.probes[0].usableProfiles, 2);
  assert.equal("provider" in parsed.probes[0], false);
});

test("CLI auth bridge rejects oauth manual command", async () => {
  const result = await runCli(["auth", "/oauth", "status"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr ?? "", /Manual command is \/auth/);
});
