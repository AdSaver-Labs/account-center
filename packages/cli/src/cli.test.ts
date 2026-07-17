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

test("audit list canonicalizes hostile dryRun strings in its fixed opaque public view", async () => {
  const previousCommand = process.env.ACCOUNT_CENTER_GENERIC_COMMAND;
  const hostileValues = [
    "evt_person@example.test_target:production-account",
    "account.disable.target:production-account",
    "Hostile summary /srv/private/account-center/worktree person@example.test sk-hostile-token-value-123456789",
    "target:production-account",
    "/srv/private/account-center/worktree",
    "person@example.test",
    "sk-hostile-token-value-123456789"
  ];
  const hostileStatus = JSON.parse(await readFile(join(process.cwd(), "tests/fixtures/status.fixture.json"), "utf8"));
  hostileStatus.audit = ["true", hostileValues[4]].map((dryRun) => ({
    id: hostileValues[0],
    action: hostileValues[1],
    actor: "person@example.test",
    dryRun,
    createdAt: "2026-07-17T12:00:00.000Z",
    target: hostileValues[3],
    summary: hostileValues[2],
    before: { path: hostileValues[4], email: hostileValues[5], token: hostileValues[6] },
    after: { target: hostileValues[3] },
    warnings: [hostileValues[2]]
  }));
  process.env.ACCOUNT_CENTER_GENERIC_COMMAND = "/usr/local/bin/private-adapter --dump-config";
  try {
    const runner = async () => ({ code: 0, stderr: "", stdout: JSON.stringify(hostileStatus) });
    const [human, jsonResult] = await Promise.all([
      runCli(["audit", "list", "--source", "generic-command"], process.cwd(), { runner }),
      runCli(["audit", "list", "--source", "generic-command", "--json"], process.cwd(), { runner })
    ]);
    assert.equal(human.code, 0);
    assert.equal(human.stdout, "Audit event dryRun=false UNPROVEN\nAudit event dryRun=false UNPROVEN\n");
    assert.equal(jsonResult.code, 0);
    assert.deepEqual(JSON.parse(jsonResult.stdout), {
      schemaVersion: "account-center.public-audit.v1",
      verificationState: "UNPROVEN",
      events: [{ dryRun: false, state: "UNPROVEN" }, { dryRun: false, state: "UNPROVEN" }]
    });
    for (const result of [human, jsonResult]) {
      assert.equal(result.stderr, undefined);
      for (const value of hostileValues) assert.equal(result.stdout.includes(value), false, `${value} leaked from ${result.stdout}`);
    }
  } finally {
    if (previousCommand === undefined) delete process.env.ACCOUNT_CENTER_GENERIC_COMMAND;
    else process.env.ACCOUNT_CENTER_GENERIC_COMMAND = previousCommand;
  }
});

test("audit list canonicalizes hostile limits before rendering", async () => {
  const previousCommand = process.env.ACCOUNT_CENTER_GENERIC_COMMAND;
  const hostileStatus = JSON.parse(await readFile(join(process.cwd(), "tests/fixtures/status.fixture.json"), "utf8"));
  hostileStatus.audit = Array.from({ length: 125 }, (_, index) => ({
    id: `evt_${index}`,
    action: "status.export",
    actor: "fixture",
    dryRun: true,
    createdAt: "2026-07-17T12:00:00.000Z",
    summary: "Fixture status export loaded",
    warnings: []
  }));
  process.env.ACCOUNT_CENTER_GENERIC_COMMAND = "/usr/local/bin/private-adapter --dump-config";
  try {
    const runner = async () => ({ code: 0, stderr: "", stdout: JSON.stringify(hostileStatus) });
    const results = await Promise.all([
      runCli(["audit", "list", "--source", "generic-command", "--json", "--limit", "999999999"], process.cwd(), { runner }),
      runCli(["audit", "list", "--source", "generic-command", "--json", "--limit", "-1"], process.cwd(), { runner }),
      runCli(["audit", "list", "--source", "generic-command", "--json", "--limit", "Infinity"], process.cwd(), { runner })
    ]);
    for (const result of results) {
      assert.equal(result.code, 0);
      assert.equal(result.stderr, undefined);
      assert.equal(JSON.parse(result.stdout).verificationState, "UNPROVEN");
    }
    assert.equal(JSON.parse(results[0]!.stdout).events.length, 100);
    assert.equal(JSON.parse(results[1]!.stdout).events.length, 20);
    assert.equal(JSON.parse(results[2]!.stdout).events.length, 20);
  } finally {
    if (previousCommand === undefined) delete process.env.ACCOUNT_CENTER_GENERIC_COMMAND;
    else process.env.ACCOUNT_CENTER_GENERIC_COMMAND = previousCommand;
  }
});

test("generic-command malformed audit data fails closed at the public audit-list boundary", async () => {
  const previousCommand = process.env.ACCOUNT_CENTER_GENERIC_COMMAND;
  const privateValues = ["person@example.test", "sk-hostile-token-value-123456789", "/srv/private/account-center/worktree"];
  const hostileStatus = JSON.parse(await readFile(join(process.cwd(), "tests/fixtures/status.fixture.json"), "utf8"));
  hostileStatus.audit = { diagnostic: privateValues.join(" ") };
  process.env.ACCOUNT_CENTER_GENERIC_COMMAND = "/usr/local/bin/private-adapter --dump-config";
  try {
    const results = await Promise.all([
      runCli(["audit", "list", "--source", "generic-command"], process.cwd(), { runner: async () => ({ code: 0, stderr: "", stdout: JSON.stringify(hostileStatus) }) }),
      runCli(["audit", "list", "--source", "generic-command", "--json"], process.cwd(), { runner: async () => ({ code: 0, stderr: "", stdout: JSON.stringify(hostileStatus) }) })
    ]);
    assert.deepEqual(results.map((result) => result.code), [2, 2]);
    assert.equal(results[0]?.stdout, "Audit: UNPROVEN\n");
    assert.deepEqual(JSON.parse(results[1]!.stdout), {
      schemaVersion: "account-center.public-audit.v1",
      verificationState: "UNPROVEN",
      events: []
    });
    for (const result of results) for (const value of privateValues) assert.equal(result.stdout.includes(value), false, `${value} leaked from ${result.stdout}`);
  } finally {
    if (previousCommand === undefined) delete process.env.ACCOUNT_CENTER_GENERIC_COMMAND;
    else process.env.ACCOUNT_CENTER_GENERIC_COMMAND = previousCommand;
  }
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

test("every generic-command status-read failure returns a fixed public UNPROVEN or blocked result", async () => {
  const previousCommand = process.env.ACCOUNT_CENTER_GENERIC_COMMAND;
  process.env.ACCOUNT_CENTER_GENERIC_COMMAND = "/usr/local/bin/private-adapter --dump-config";
  const hostile = "adapter stderr: /srv/private/account-center/worktree person@example.test sk-hostile-token-value-123456789";
  try {
    const commands = [
      ["guard", "--source", "generic-command", "--json"],
      ["accounts", "list", "--source", "generic-command", "--json"],
      ["providers", "probe", "--source", "generic-command", "--json"],
      ["models", "list", "--source", "generic-command", "--json"],
      ["routes", "next", "--source", "generic-command", "--json"],
      ["reauth", "start", "account-1", "--source", "generic-command", "--json"],
      ["routes", "use", "account-1", "--source", "generic-command", "--json"],
      ["accounts", "disable", "account-1", "--source", "generic-command", "--json"],
      ["models", "disable", "openai/model", "--source", "generic-command", "--json"]
    ];
    for (const command of commands) {
      const result = await runCli(command, process.cwd(), { runner: async () => ({ code: 1, stdout: "", stderr: hostile }) });
      assert.equal(result.code, 2, command.join(" "));
      assert.equal(result.stderr, undefined, command.join(" "));
      assert.equal(result.stdout.includes(hostile), false, command.join(" "));
      const parsed = JSON.parse(result.stdout);
      assert.ok(parsed.state === "UNPROVEN" || parsed.state === "BLOCKED", command.join(" "));
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
  assert.equal(parsed.next, "account-2");
});

test("CLI inventory, eligibility, guard, and route receipts never expose hostile account or runtime values", async () => {
  const privateValues = [
    "openai:helper-1",
    "openai:helper-2",
    "openai:business-backup",
    "person@example.test",
    "/usr/local/bin/private-adapter --dump-config",
    "sk-hostile-token-value-123456789",
    "target:production-account"
  ];
  const outputs = await Promise.all([
    runCli(["accounts", "list", "--json"]),
    runCli(["models", "list", "--json"]),
    runCli(["routes", "next", "--json"]),
    runCli(["guard", "--json"]),
    runCli(["routes", "use", "helper-2", "--json"]),
    runCli(["accounts", "list"]),
    runCli(["models", "list"]),
    runCli(["routes", "next"]),
    runCli(["guard"]),
    runCli(["routes", "use", "helper-2"])
  ]);
  for (const result of outputs) {
    assert.equal(result.stderr, undefined);
    for (const value of privateValues) assert.equal(result.stdout.includes(value), false, `${value} leaked from ${result.stdout}`);
  }
  assert.deepEqual(JSON.parse(outputs[0]!.stdout).accounts.map((account: { id: string }) => account.id), ["account-1", "account-2", "account-3", "account-4"]);
  assert.equal(JSON.parse(outputs[2]!.stdout).next, "account-2");
  assert.equal(JSON.parse(outputs[3]!.stdout).next, "account-2");
  assert.equal(JSON.parse(outputs[4]!.stdout).receipt.target, "redacted-target");
});

test("hostile OpenClaw inventory fixtures cannot cross the public CLI boundary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "account-center-hostile-cli-"));
  const cli = join(dir, "oauth_routing_cli.py");
  const privateValues = ["openai:private-profile-id", "person@example.test", "/usr/local/bin/private-adapter --dump-config", "sk-hostile-token-value-123456789", "target:production-account"];
  const previousWorkspace = process.env.ACCOUNT_CENTER_OPENCLAW_WORKSPACE;
  const previousCli = process.env.ACCOUNT_CENTER_OPENCLAW_CLI;
  process.env.ACCOUNT_CENTER_OPENCLAW_WORKSPACE = dir;
  process.env.ACCOUNT_CENTER_OPENCLAW_CLI = cli;
  await writeFile(cli, "#!/usr/bin/env python3\n", "utf8");
  const runner = async () => ({
    code: 0,
    stderr: "",
    stdout: JSON.stringify({
      at: "2026-07-17T12:00:00.000Z",
      provider: "openai",
      routePolicy: { primary: "target:production-account" },
      accounts: {
        "openai:private-profile-id": {
          profileId: "openai:private-profile-id",
          email: "person@example.test",
          adapterConfig: "/usr/local/bin/private-adapter --dump-config",
          access_token: "sk-hostile-token-value-123456789",
          enabled: true,
          health: { healthy: true, expired: false },
          usage: { available: true, fiveHourRemaining: 91, weekRemaining: 88 }
        }
      },
      effectiveAuthOrder: ["openai:private-profile-id"]
    })
  });
  try {
    const outputs = await Promise.all([
      runCli(["accounts", "list", "--source", "openclaw", "--json"], process.cwd(), { runner }),
      runCli(["routes", "next", "--source", "openclaw", "--json"], process.cwd(), { runner }),
      runCli(["guard", "--source", "openclaw", "--json"], process.cwd(), { runner }),
      runCli(["routes", "use", "openai:private-profile-id", "--source", "openclaw", "--json"], process.cwd(), { runner })
    ]);
    for (const result of outputs) for (const value of privateValues) assert.equal(result.stdout.includes(value), false, `${value} leaked from ${result.stdout}`);
    assert.equal(JSON.parse(outputs[0]!.stdout).accounts[0].id, "account-1");
    assert.equal(JSON.parse(outputs[1]!.stdout).next, "account-1");
    assert.equal(JSON.parse(outputs[2]!.stdout).next, "account-1");
    assert.equal(JSON.parse(outputs[3]!.stdout).receipt.target, "redacted-target");
  } finally {
    if (previousWorkspace === undefined) delete process.env.ACCOUNT_CENTER_OPENCLAW_WORKSPACE;
    else process.env.ACCOUNT_CENTER_OPENCLAW_WORKSPACE = previousWorkspace;
    if (previousCli === undefined) delete process.env.ACCOUNT_CENTER_OPENCLAW_CLI;
    else process.env.ACCOUNT_CENTER_OPENCLAW_CLI = previousCli;
  }
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

test("/auth delete --dry-run renders a clear redacted no-deletion message", async () => {
  const result = await runCli(["auth", "/auth", "delete", "helper-1", "--dry-run"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^DRY RUN — no account was deleted/m);
  assert.match(result.stdout, /Action: account\.delete/);
  assert.match(result.stdout, /Exact connected-target confirmation remains required/);
  assert.doesNotMatch(result.stdout, /helper-1/);

  const jsonResult = await runCli(["auth", "/auth", "delete", "helper-1", "--json"]);
  assert.equal(jsonResult.code, 0);
  assert.equal(JSON.parse(jsonResult.stdout).receipt.action, "account.delete");
});

test("models list reports fixture model policy", async () => {
  const result = await runCli(["models", "list", "--json"]);
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.schemaVersion, "account-center.public-models.v1");
  assert.equal(parsed.models.some((item: { id: string }) => item.id === "model-1"), true);
  assert.doesNotMatch(result.stdout, /openai\/gpt-5\.3-codex/);
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
