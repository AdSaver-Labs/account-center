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
    assert.equal(parsed.profiles[0].id, "openai:helper-1");
  } finally {
    if (previousWorkspace === undefined) delete process.env.ACCOUNT_CENTER_OPENCLAW_WORKSPACE;
    else process.env.ACCOUNT_CENTER_OPENCLAW_WORKSPACE = previousWorkspace;
    if (previousCli === undefined) delete process.env.ACCOUNT_CENTER_OPENCLAW_CLI;
    else process.env.ACCOUNT_CENTER_OPENCLAW_CLI = previousCli;
  }
});

test("/auth default output retains Codex account-limit detail while redacting account emails", async () => {
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
    assert.match(result.stdout, /^Codex account limits/);
    assert.match(result.stdout, /Snapshot: 10 Jul 2026, 12:25 EEST/);
    assert.match(result.stdout, /Current active account: \[REDACTED_EMAIL\] \(openai:\[REDACTED_EMAIL\]\)/);
    assert.equal(result.stdout.includes("travis@example.com"), false);
    assert.equal(result.stdout.includes("49pushy@example.com"), false);
    assert.equal(result.stdout.includes("info@adsaveragency.com"), false);
    assert.match(result.stdout, /Non-AdSaver weekly-usable accounts: 1/);
    assert.match(result.stdout, /⚠️ WARNING: only 1 non-AdSaver weekly-usable account remains/);
    assert.match(result.stdout, /No-token commands you can use here:/);
    assert.match(result.stdout, /• \/auth add <email> — start OpenAI Codex device-code login from Telegram/);
    assert.match(result.stdout, /\[REDACTED_EMAIL\] — PLUS/);
    assert.match(result.stdout, /OAuth expires: 18 Jul 2026, 23:28/);
    assert.match(result.stdout, /• 5h: 1% used \/ 99% left\n  refresh: 10 Jul 2026, 17:25/);
    assert.match(result.stdout, /\[REDACTED_EMAIL\] — FREE/);
    assert.match(result.stdout, /• 5h: unknown/);
    assert.match(result.stdout, /\[REDACTED_EMAIL\]/);
  } finally {
    if (previousWorkspace === undefined) delete process.env.ACCOUNT_CENTER_OPENCLAW_WORKSPACE;
    else process.env.ACCOUNT_CENTER_OPENCLAW_WORKSPACE = previousWorkspace;
    if (previousCli === undefined) delete process.env.ACCOUNT_CENTER_OPENCLAW_CLI;
    else process.env.ACCOUNT_CENTER_OPENCLAW_CLI = previousCli;
    if (previousSource === undefined) delete process.env.ACCOUNT_CENTER_SOURCE;
    else process.env.ACCOUNT_CENTER_SOURCE = previousSource;
  }
});
