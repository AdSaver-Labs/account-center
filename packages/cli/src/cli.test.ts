import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./index.js";

test("status --json emits fixture-backed no-secret export", async () => {
  const result = await runCli(["status", "--json", "--no-write-export"]);
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.schemaVersion, "account-center.status.v1");
  assert.equal(parsed.noSecrets, true);
  assert.equal(parsed.source, "fixture");
  assert.equal(JSON.stringify(parsed).includes("token"), false);
});

test("status writes a local status export when enabled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "account-center-"));
  const result = await runCli(["status", "--json", "--status-path", join(dir, "status.json")]);
  assert.equal(result.code, 0);
  const written = JSON.parse(await readFile(join(dir, "status.json"), "utf8"));
  assert.equal(written.schemaVersion, "account-center.status.v1");
});

test("guard returns next usable account", async () => {
  const result = await runCli(["guard", "--json"]);
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.next, "openai:helper-2");
});

test("dry-run route and account commands produce non-mutating receipts", async () => {
  for (const argv of [
    ["routes", "auto"],
    ["routes", "use", "helper-2"],
    ["routes", "remove", "helper-1"],
    ["accounts", "disable", "helper-1"],
    ["accounts", "enable", "helper-1"],
    ["models", "disable", "openai/gpt-5.3-codex"],
    ["models", "enable", "openai/gpt-5.3-codex"]
  ]) {
    const result = await runCli(argv);
    assert.equal(result.code, 0, argv.join(" "));
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.applied, false);
    assert.equal(parsed.liveRuntimeMutation, false);
    assert.match(parsed.receipt.id, /^evt_/);
  }
});

test("models list reports fixture model policy", async () => {
  const result = await runCli(["models", "list", "--json"]);
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.some((item: { model: string }) => item.model === "openai/gpt-5.3-codex"), true);
});

test("help promotes /auth compatibility as the manual chat command", async () => {
  const result = await runCli(["help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Manual chat compatibility command is \/auth/);
  assert.doesNotMatch(result.stdout, /\/oauth/);
});

test("OpenClaw source can be selected with a mocked read-only runner", async () => {
  const dir = await mkdtemp(join(tmpdir(), "account-center-openclaw-cli-"));
  const cli = join(dir, "oauth_routing_cli.py");
  await writeFile(cli, "#!/usr/bin/env python3\n", "utf8");
  const previousWorkspace = process.env.ACCOUNT_CENTER_OPENCLAW_WORKSPACE;
  const previousCli = process.env.ACCOUNT_CENTER_OPENCLAW_CLI;
  process.env.ACCOUNT_CENTER_OPENCLAW_WORKSPACE = dir;
  process.env.ACCOUNT_CENTER_OPENCLAW_CLI = cli;
  try {
    const result = await runCli(["status", "--source", "openclaw", "--json", "--no-write-export"], process.cwd(), {
      runner: async () => ({
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          at: "2026-07-09T10:55:50.721Z",
          provider: "openai",
          accounts: {
            "openai:helper-1": {
              profileId: "openai:helper-1",
              enabled: true,
              health: { healthy: true, expired: false },
              usage: { available: true, fiveHourRemaining: 84, weekRemaining: 17 }
            }
          },
          effectiveAuthOrder: ["openai:helper-1"]
        })
      })
    });
    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.source, "openclaw");
    assert.equal(parsed.profiles[0].id, "openai:helper-1");
  } finally {
    if (previousWorkspace === undefined) delete process.env.ACCOUNT_CENTER_OPENCLAW_WORKSPACE;
    else process.env.ACCOUNT_CENTER_OPENCLAW_WORKSPACE = previousWorkspace;
    if (previousCli === undefined) delete process.env.ACCOUNT_CENTER_OPENCLAW_CLI;
    else process.env.ACCOUNT_CENTER_OPENCLAW_CLI = previousCli;
  }
});
