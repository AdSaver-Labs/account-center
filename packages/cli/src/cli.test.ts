import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { runCli } from "./index.js";

test("serve supports an ephemeral loopback port with a per-launch token", async () => {
  const child = spawn(process.execPath, [new URL("./index.js", import.meta.url).pathname, "serve", "--port", "0", "--source", "fixture"], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let errors = "";
  let exited = false;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { output += chunk; });
  child.stderr.on("data", (chunk: string) => { errors += chunk; });
  child.once("exit", () => { exited = true; });
  try {
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`server launch timed out: ${errors}`)), 5_000);
      child.stdout.on("data", () => {
        if (/Account Center local panel: http:\/\/127\.0\.0\.1:\d+\//.test(output) && /Launch token: [A-Za-z0-9_-]+/.test(output)) {
          clearTimeout(deadline);
          resolve();
        }
      });
      child.once("error", reject);
      child.once("exit", (code) => { clearTimeout(deadline); reject(new Error(`server exited before launch: ${code}: ${errors}`)); });
    });
    const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)\/\nLaunch token: ([A-Za-z0-9_-]+)/);
    assert.ok(match);
    const [, port, token] = match;
    assert.notEqual(port, "0");
    assert.match(token, /^[A-Za-z0-9_-]{32}$/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/status`)).status, 401);
    const status = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(status.status, 200);
    assert.equal(status.headers.get("cache-control"), "no-store");
    const panel = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(panel.status, 200);
    assert.match(await panel.text(), /Account Center/);
  } finally {
    if (!exited) {
      child.kill("SIGINT");
      await once(child, "exit");
    }
  }
});

test("status --json emits fixture-backed no-secret export", async () => {
  const result = await runCli(["status", "--json", "--no-write-export"]);
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.schemaVersion, "account-center.public-status.v1");
  assert.equal(parsed.source, "fixture");
  assert.equal(JSON.stringify(parsed).includes("token"), false);
});

const hostileStatusFailure = "adapter stderr: /srv/private/account-center/worktree\nError: command /usr/local/bin/private-adapter --dump-config failed for person@example.test sk-hostile-token-value-123456789";

test("status failure renders a fixed public UNPROVEN response for humans", async () => {
  const previousCommand = process.env.ACCOUNT_CENTER_GENERIC_COMMAND;
  process.env.ACCOUNT_CENTER_GENERIC_COMMAND = "/usr/local/bin/private-adapter --dump-config";
  try {
    const result = await runCli(["status", "--source", "generic-command", "--no-write-export"], process.cwd(), {
      runner: async () => ({ code: 1, stdout: "", stderr: hostileStatusFailure })
    });
    assert.equal(result.code, 2);
    assert.equal(result.stderr, undefined);
    assert.equal(result.stdout, "Account Center: status UNPROVEN\nSource: generic-command\n");
    for (const value of ["/srv/private/account-center/worktree", "/usr/local/bin/private-adapter --dump-config", "person@example.test", "sk-hostile-token-value-123456789", "Error:"]) {
      assert.equal(result.stdout.includes(value), false, value);
    }
  } finally {
    if (previousCommand === undefined) delete process.env.ACCOUNT_CENTER_GENERIC_COMMAND;
    else process.env.ACCOUNT_CENTER_GENERIC_COMMAND = previousCommand;
  }
});

test("status failure renders a fixed public UNPROVEN JSON response", async () => {
  const previousCommand = process.env.ACCOUNT_CENTER_GENERIC_COMMAND;
  process.env.ACCOUNT_CENTER_GENERIC_COMMAND = "/usr/local/bin/private-adapter --dump-config";
  try {
    const result = await runCli(["status", "--source", "generic-command", "--json", "--no-write-export"], process.cwd(), {
      runner: async () => ({ code: 1, stdout: "", stderr: hostileStatusFailure })
    });
    assert.equal(result.code, 2);
    assert.equal(result.stderr, undefined);
    assert.deepEqual(JSON.parse(result.stdout), {
      schemaVersion: "account-center.public-status-error.v1",
      source: "generic-command",
      state: "UNPROVEN"
    });
    for (const value of ["/srv/private/account-center/worktree", "/usr/local/bin/private-adapter --dump-config", "person@example.test", "sk-hostile-token-value-123456789", "Error:"]) {
      assert.equal(result.stdout.includes(value), false, value);
    }
  } finally {
    if (previousCommand === undefined) delete process.env.ACCOUNT_CENTER_GENERIC_COMMAND;
    else process.env.ACCOUNT_CENTER_GENERIC_COMMAND = previousCommand;
  }
});

test("doctor --json uses a fixed public DTO instead of adapter diagnostics", async () => {
  const previousCommand = process.env.ACCOUNT_CENTER_GENERIC_COMMAND;
  process.env.ACCOUNT_CENTER_GENERIC_COMMAND = "/usr/local/bin/private-adapter --dump-config";
  try {
    const result = await runCli(["doctor", "--source", "generic-command", "--json"], process.cwd(), {
      runner: async () => ({ code: 1, stdout: "", stderr: "adapter stderr: person@example.test sk-hostile-token-value-123456789" })
    });
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      schemaVersion: "account-center.public-doctor.v1",
      source: "generic-command",
      state: "UNPROVEN"
    });
  } finally {
    if (previousCommand === undefined) delete process.env.ACCOUNT_CENTER_GENERIC_COMMAND;
    else process.env.ACCOUNT_CENTER_GENERIC_COMMAND = previousCommand;
  }
});

test("doctor renders the public OK state for humans", async () => {
  const result = await runCli(["doctor", "--source", "fixture"]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "Doctor: OK\nSource: fixture\n");
});

test("doctor renders the public UNPROVEN state for humans", async () => {
  const previousCommand = process.env.ACCOUNT_CENTER_GENERIC_COMMAND;
  process.env.ACCOUNT_CENTER_GENERIC_COMMAND = "/usr/local/bin/private-adapter --dump-config";
  try {
    const result = await runCli(["doctor", "--source", "generic-command"], process.cwd(), {
      runner: async () => ({ code: 1, stdout: "", stderr: "adapter stderr: person@example.test sk-hostile-token-value-123456789" })
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "Doctor: UNPROVEN\nSource: generic-command\n");
  } finally {
    if (previousCommand === undefined) delete process.env.ACCOUNT_CENTER_GENERIC_COMMAND;
    else process.env.ACCOUNT_CENTER_GENERIC_COMMAND = previousCommand;
  }
});

test("status writes a local status export when enabled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "account-center-"));
  const result = await runCli(["status", "--json", "--status-path", join(dir, "status.json")]);
  assert.equal(result.code, 0);
  const written = JSON.parse(await readFile(join(dir, "status.json"), "utf8"));
  assert.equal(written.schemaVersion, "account-center.public-status.v1");
});

test("guard returns next usable account", async () => {
  const result = await runCli(["guard", "--json"]);
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.next, "openai:helper-2");
});

test("guard --ensure-route plans automatic route switch without apply", async () => {
  const result = await runCli(["guard", "--ensure-route", "--json"]);
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ensured.applied, false);
  assert.equal(parsed.ensured.liveRuntimeMutation, false);
  assert.equal(parsed.ensured.receipt.action, "route.auto");
});

test("dry-run route and account commands produce non-mutating receipts", async () => {
  for (const argv of [
    ["routes", "auto"],
    ["routes", "use", "helper-2"],
    ["routes", "remove", "helper-1"],
    ["accounts", "disable", "helper-1"],
    ["accounts", "enable", "helper-1"],
    ["accounts", "delete", "helper-1"],
    ["models", "disable", "openai/gpt-5.3-codex"],
    ["models", "enable", "openai/gpt-5.3-codex"]
  ]) {
    const result = await runCli([...argv, "--json"]);
    assert.equal(result.code, 0, argv.join(" "));
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.applied, false);
    assert.equal(parsed.liveRuntimeMutation, false);
    assert.match(parsed.receipt.id, /^evt_/);
  }
});

test("/auth delete --dry-run renders a clear human no-deletion message", async () => {
  const result = await runCli(["auth", "/auth", "delete", "helper-1", "--dry-run"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^DRY RUN — no account was deleted/m);
  assert.match(result.stdout, /Action: account\.delete/);
  assert.match(result.stdout, /To actually delete it yourself, run:/);
  assert.match(result.stdout, /\/auth delete helper-1/);

  const jsonResult = await runCli(["auth", "/auth", "delete", "helper-1", "--json"]);
  assert.equal(jsonResult.code, 0);
  assert.equal(JSON.parse(jsonResult.stdout).receipt.action, "account.delete");
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
    assert.equal(parsed.profiles[0].id, "account-1");
  } finally {
    if (previousWorkspace === undefined) delete process.env.ACCOUNT_CENTER_OPENCLAW_WORKSPACE;
    else process.env.ACCOUNT_CENTER_OPENCLAW_WORKSPACE = previousWorkspace;
    if (previousCli === undefined) delete process.env.ACCOUNT_CENTER_OPENCLAW_CLI;
    else process.env.ACCOUNT_CENTER_OPENCLAW_CLI = previousCli;
  }
});

test("/auth default output stays within the public status boundary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "account-center-openclaw-limits-"));
  const cli = join(dir, "oauth_routing_cli.py");
  await writeFile(cli, "#!/usr/bin/env python3\n", "utf8");
  const previousWorkspace = process.env.ACCOUNT_CENTER_OPENCLAW_WORKSPACE;
  const previousCli = process.env.ACCOUNT_CENTER_OPENCLAW_CLI;
  const previousSource = process.env.ACCOUNT_CENTER_SOURCE;
  process.env.ACCOUNT_CENTER_OPENCLAW_WORKSPACE = dir;
  process.env.ACCOUNT_CENTER_OPENCLAW_CLI = cli;
  process.env.ACCOUNT_CENTER_SOURCE = "openclaw";
  try {
    const result = await runCli(["auth", "/auth"], process.cwd(), {
      runner: async () => ({
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          generatedAt: "2026-07-10T09:25:00.000Z",
          generatedAtEEST: "10 Jul 2026, 12:25",
          provider: "openai",
          routePolicy: {
            primary: "openai:travis@example.com",
            nonAdsaverWeeklyUsableCount: 1
          },
          accounts: [
            {
              email: "travis@example.com",
              profileId: "openai:travis@example.com",
              plan: "free",
              ok: true,
              routingEnabled: true,
              routingRecommendation: "normal-routing",
              tokenExpiresAtEEST: "17 Jul 2026, 16:33",
              windows: []
            },
            {
              email: "49pushy@example.com",
              profileId: "openai:49pushy@example.com",
              plan: "plus",
              ok: true,
              routingEnabled: true,
              routingRecommendation: "normal-routing",
              tokenExpiresAtEEST: "18 Jul 2026, 23:28",
              windows: [
                { label: "5h", usedPercent: 1, leftPercent: 99, resetAtEEST: "10 Jul 2026, 17:25" },
                { label: "Week", usedPercent: 0, leftPercent: 100, resetAtEEST: "17 Jul 2026, 12:25" }
              ]
            },
            {
              email: "info@adsaveragency.com",
              profileId: "openai:info@adsaveragency.com",
              plan: "plus",
              ok: true,
              routingEnabled: true,
              routingRecommendation: "normal-routing",
              tokenExpiresAtEEST: "16 Jul 2026, 19:32",
              windows: [
                { label: "5h", usedPercent: 1, leftPercent: 99, resetAtEEST: "10 Jul 2026, 17:25" },
                { label: "Week", usedPercent: 0, leftPercent: 100, resetAtEEST: "17 Jul 2026, 12:25" }
              ]
            }
          ]
        })
      })
    });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Account Center: status observed/);
    assert.match(result.stdout, /Source: openclaw/);
    assert.match(result.stdout, /Verification: UNPROVEN/);
    assert.doesNotMatch(result.stdout, /travis@example\.com|49pushy@example\.com|info@adsaveragency\.com|codex-device-auth-telegram|Fallback CLI/);
  } finally {
    if (previousWorkspace === undefined) delete process.env.ACCOUNT_CENTER_OPENCLAW_WORKSPACE;
    else process.env.ACCOUNT_CENTER_OPENCLAW_WORKSPACE = previousWorkspace;
    if (previousCli === undefined) delete process.env.ACCOUNT_CENTER_OPENCLAW_CLI;
    else process.env.ACCOUNT_CENTER_OPENCLAW_CLI = previousCli;
    if (previousSource === undefined) delete process.env.ACCOUNT_CENTER_SOURCE;
    else process.env.ACCOUNT_CENTER_SOURCE = previousSource;
  }
});
