import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { blockedCredentialDeleteView, publicMutationView, renderMutation, runCli } from "./index.js";

async function privateTokenFile(token: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "account-center-launch-token-"));
  const path = join(root, "token");
  await writeFile(path, `${token}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

async function rejectedServe(args: string[]): Promise<{ output: string; errors: string; code: number | null }> {
  const child = spawn(process.execPath, [new URL("./index.js", import.meta.url).pathname, "serve", "--source", "fixture", ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let errors = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { output += chunk; });
  child.stderr.on("data", (chunk: string) => { errors += chunk; });
  const code = await once(child, "exit").then(([exitCode]) => exitCode as number | null);
  return { output, errors, code };
}

test("serve accepts the documented fixture token-file invocation without rendering its bearer token", async () => {
  const token = "fixture-adversarial-bearer-token-123456789";
  const tokenFile = await privateTokenFile(token);
  const child = spawn(process.execPath, [new URL("./index.js", import.meta.url).pathname, "serve", "--port", "0", "--source", "fixture", "--token-file", tokenFile], { stdio: ["ignore", "pipe", "pipe"] });
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
        if (/Account Center local panel: http:\/\/127\.0\.0\.1:\d+\//.test(output)) {
          clearTimeout(deadline);
          resolve();
        }
      });
      child.once("error", reject);
      child.once("exit", (code) => { clearTimeout(deadline); reject(new Error(`server exited before launch: ${code}: ${errors}`)); });
    });
    const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
    assert.ok(match);
    const [, port] = match;
    assert.notEqual(port, "0");
    assert.equal(output.includes(token), false, output);
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

test("serve rejects every explicit empty, missing, or option-like source value without launching", async () => {
  const invalidArgs = [
    ["--source"],
    ["--source", ""],
    ["--source", "--port", "0"],
    ["--source="],
    ["--source=--port", "0"],
    ["--source", "fixture", "--source"],
    ["--source", "fixture", "--source", "--port", "0"],
    ["--source=fixture", "--source="],
    ["--source", "fixture", "--source=--port", "0"],
    ["--source=fixture", "--source=opaque"]
  ];

  for (const args of invalidArgs) {
    const child = spawn(process.execPath, [new URL("./index.js", import.meta.url).pathname, "serve", ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let errors = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    child.stderr.on("data", (chunk: string) => { errors += chunk; });
    const code = await new Promise<number | null>((resolve, reject) => {
      const deadline = setTimeout(() => {
        child.kill("SIGINT");
        reject(new Error(`serve launched for invalid source arguments: ${args.join(" ")}`));
      }, 2_000);
      child.once("error", (error) => { clearTimeout(deadline); reject(error); });
      child.once("exit", (exitCode) => { clearTimeout(deadline); resolve(exitCode); });
    });
    assert.equal(code, 1);
    assert.equal(output, "");
    assert.match(errors, /Unsupported Account Center source\./);
    assert.doesNotMatch(errors, /fixture|127\.0\.0\.1|Launch token/);
  }
});

test("serve rejects missing, repeated, equals, legacy, and option-shaped token-file inputs without launch", async () => {
  const tokenFile = await privateTokenFile("fixture-adversarial-bearer-token-123456789");
  const invalidArgs = [
    [],
    ["--token-file"],
    ["--token-file", "--port", "0"],
    [`--token-file=${tokenFile}`],
    ["--token-file", tokenFile, "--token-file", tokenFile],
    ["--token", "fixture-adversarial-bearer-token-123456789"],
    ["--token=fixture-adversarial-bearer-token-123456789"]
  ];
  for (const args of invalidArgs) {
    const result = await rejectedServe(args);
    assert.equal(result.code, 1);
    assert.equal(result.output, "");
    assert.equal(result.errors, "Launch token file unavailable.\n");
    assert.equal(`${result.output}${result.errors}`.includes(tokenFile), false);
    assert.equal(`${result.output}${result.errors}`.includes("fixture-adversarial-bearer-token-123456789"), false);
  }
});

test("serve rejects symlinked, insecure, and empty fixture token files without rendering private values", async () => {
  const token = "fixture-adversarial-bearer-token-123456789";
  const secure = await privateTokenFile(token);
  const root = await mkdtemp(join(tmpdir(), "account-center-unsafe-launch-token-"));
  const link = join(root, "token-link");
  const insecure = join(root, "token-insecure");
  const empty = join(root, "token-empty");
  await symlink(secure, link);
  await writeFile(insecure, `${token}\n`, { mode: 0o644 });
  await chmod(insecure, 0o644);
  await writeFile(empty, "", { mode: 0o600 });
  for (const path of [link, insecure, empty]) {
    const result = await rejectedServe(["--token-file", path]);
    assert.equal(result.code, 1);
    assert.equal(result.output, "");
    assert.equal(result.errors, "Launch token file unavailable.\n");
    assert.equal(`${result.output}${result.errors}`.includes(path), false);
    assert.equal(`${result.output}${result.errors}`.includes(token), false);
  }
});

test("serve rejects repeated valid source options without launching", async () => {
  const invalidArgs = [
    ["--source", "fixture", "--source=openclaw"],
    ["--source=fixture", "--source", "openclaw"],
    ["--source", "fixture", "--source=fixture"],
    ["--source=fixture", "--source", "fixture"]
  ];

  for (const args of invalidArgs) {
    const child = spawn(process.execPath, [new URL("./index.js", import.meta.url).pathname, "serve", ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let errors = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    child.stderr.on("data", (chunk: string) => { errors += chunk; });
    const code = await new Promise<number | null>((resolve, reject) => {
      const deadline = setTimeout(() => {
        child.kill("SIGINT");
        reject(new Error(`serve launched for repeated source arguments: ${args.join(" ")}`));
      }, 2_000);
      child.once("error", (error) => { clearTimeout(deadline); reject(error); });
      child.once("exit", (exitCode) => { clearTimeout(deadline); resolve(exitCode); });
    });
    assert.equal(code, 1);
    assert.equal(output, "");
    assert.equal(errors, "Unsupported Account Center source.\n");
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

test("read-only status does not initialize mutation lifecycle when ACCOUNT_CENTER_DATA_DIR is a file", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-read-only-data-dir-"));
  const invalidDataDir = join(root, "not-a-directory");
  await writeFile(invalidDataDir, "not a directory", "utf8");
  const prior = process.env.ACCOUNT_CENTER_DATA_DIR;
  process.env.ACCOUNT_CENTER_DATA_DIR = invalidDataDir;
  try {
    const result = await runCli(["status", "--json", "--no-write-export"]);
    assert.equal(result.code, 0);
    assert.equal(JSON.parse(result.stdout).schemaVersion, "account-center.public-status.v1");
  } finally {
    if (prior === undefined) delete process.env.ACCOUNT_CENTER_DATA_DIR;
    else process.env.ACCOUNT_CENTER_DATA_DIR = prior;
  }
});

test("CLI rejects hostile adapter source labels without echoing them", async () => {
  const hostileSource = "/srv/private/account-center/adapter --source=production";
  for (const args of [["--source", hostileSource], ["--source=fixture", `--source=${hostileSource}`]]) {
    const result = await runCli(["status", ...args, "--no-write-export"]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "Unsupported Account Center source.\n");
    assert.equal(`${result.stdout}${result.stderr}`.includes(hostileSource), false);
  }
});

test("CLI gives valid equals-form sources the same fixture behavior as split-form sources", async () => {
  const [equalsForm, splitForm] = await Promise.all([
    runCli(["status", "--source=fixture", "--json", "--no-write-export"]),
    runCli(["status", "--source", "fixture", "--json", "--no-write-export"])
  ]);
  assert.equal(equalsForm.code, 0);
  assert.deepEqual(JSON.parse(equalsForm.stdout), JSON.parse(splitForm.stdout));
});

test("status rejects repeated valid source options with opaque errors", async () => {
  const argumentSets = [
    ["--source", "fixture", "--source=openclaw"],
    ["--source=openclaw", "--source", "fixture"],
    ["--source", "fixture", "--source=fixture"],
    ["--source=fixture", "--source", "fixture"]
  ];

  for (const sourceArgs of argumentSets) {
    const result = await runCli(["status", ...sourceArgs, "--no-write-export"]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "Unsupported Account Center source.\n");
  }
});

test("CLI rejects explicit empty or missing adapter sources without falling back to fixture", async () => {
  const previousSource = process.env.ACCOUNT_CENTER_SOURCE;
  process.env.ACCOUNT_CENTER_SOURCE = "";
  try {
    for (const args of [["status", "--source", "", "--no-write-export"], ["status", "--source", "--no-write-export"], ["status", "--no-write-export"]]) {
      const result = await runCli(args);
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "Unsupported Account Center source.\n");
    }
  } finally {
    if (previousSource === undefined) delete process.env.ACCOUNT_CENTER_SOURCE;
    else process.env.ACCOUNT_CENTER_SOURCE = previousSource;
  }
});

test("provider probe keeps hostile generic-command provider identifiers out of public output", async () => {
  const previousCommand = process.env.ACCOUNT_CENTER_GENERIC_COMMAND;
  const hostileProvider = "/srv/private/account-center/person@example.test sk-hostile-token-value-123456789";
  const hostileStatus = JSON.parse(await readFile(join(process.cwd(), "tests/fixtures/status.fixture.json"), "utf8"));
  hostileStatus.profiles[0].provider = hostileProvider;
  process.env.ACCOUNT_CENTER_GENERIC_COMMAND = "/usr/local/bin/private-adapter --dump-config";
  try {
    const runner = async () => ({ code: 0, stderr: "", stdout: JSON.stringify(hostileStatus) });
    const [human, jsonResult] = await Promise.all([
      runCli(["providers", "probe", "--source", "generic-command", "--provider", "all"], process.cwd(), { runner }),
      runCli(["providers", "probe", "--source", "generic-command", "--provider", "all", "--json"], process.cwd(), { runner })
    ]);
    assert.equal(human.code, 0);
    for (const result of [human, jsonResult]) {
      for (const value of [hostileProvider, "/srv/private", "person@example.test", "sk-hostile-token-value-123456789", "generic-command", "status"]) assert.equal(result.stdout.includes(value), false, `${value} leaked from ${result.stdout}`);
    }
    const parsed = JSON.parse(jsonResult.stdout);
    assert.equal(parsed.schemaVersion, "account-center.public-provider-probes.v1");
    assert.equal(parsed.verificationState, "UNPROVEN");
    assert.ok(parsed.probes.every((probe: { state: string; profiles: number; usableProfiles: number; limitsObserved: boolean }) => ["OK", "BLOCKED"].includes(probe.state) && Number.isInteger(probe.profiles) && Number.isInteger(probe.usableProfiles) && typeof probe.limitsObserved === "boolean"));
  } finally {
    if (previousCommand === undefined) delete process.env.ACCOUNT_CENTER_GENERIC_COMMAND;
    else process.env.ACCOUNT_CENTER_GENERIC_COMMAND = previousCommand;
  }
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

test("routes next accepts one exact provider/runtime selector in split and equals forms", async () => {
  const status = JSON.parse(await readFile("tests/fixtures/status.fixture.json", "utf8"));
  status.providers = [{ key: "anthropic", displayName: "Anthropic" }];
  status.runtimes = [{ key: "hermes", displayName: "Hermes", capabilities: { readStatus: true, mutateRoutes: false, startReauth: false, mutateModels: false } }];
  status.profiles = status.profiles.map((profile: Record<string, unknown>) => ({ ...profile, provider: "anthropic", runtimeCompatibility: ["hermes"], usage: { ...(profile.usage as Record<string, unknown>), provider: "anthropic" } }));
  status.routes = status.routes.map((route: Record<string, unknown>) => ({ ...route, provider: "anthropic", runtime: "hermes" }));
  const previousCommand = process.env.ACCOUNT_CENTER_GENERIC_COMMAND;
  process.env.ACCOUNT_CENTER_GENERIC_COMMAND = "account-center-test-status";
  try {
    for (const args of [
      ["--provider", "anthropic", "--runtime", "hermes"],
      ["--provider=anthropic", "--runtime=hermes"]
    ]) {
      const result = await runCli(["routes", "next", "--source", "generic-command", "--json", ...args], process.cwd(), {
        runner: async () => ({ code: 0, stdout: JSON.stringify(status), stderr: "" })
      });
      assert.equal(result.code, 0, args.join(" "));
      assert.deepEqual(JSON.parse(result.stdout), {
        schemaVersion: "account-center.public-route-next.v1",
        verificationState: "UNPROVEN",
        eligible: true,
        next: "account-2"
      });
    }
  } finally {
    if (previousCommand === undefined) delete process.env.ACCOUNT_CENTER_GENERIC_COMMAND;
    else process.env.ACCOUNT_CENTER_GENERIC_COMMAND = previousCommand;
  }
});

test("routes next selector validation does not change unrelated provider option parsing", async () => {
  const status = JSON.parse(await readFile("tests/fixtures/status.fixture.json", "utf8"));
  status.providers = [{ key: "anthropic", displayName: "Anthropic" }];
  status.profiles = status.profiles.map((profile: Record<string, unknown>) => ({ ...profile, provider: "anthropic", usage: { ...(profile.usage as Record<string, unknown>), provider: "anthropic" } }));
  const previousCommand = process.env.ACCOUNT_CENTER_GENERIC_COMMAND;
  process.env.ACCOUNT_CENTER_GENERIC_COMMAND = "account-center-test-status";
  try {
    const result = await runCli(["providers", "probe", "--source", "generic-command", "--provider=all", "--json"], process.cwd(), {
      runner: async () => ({ code: 0, stdout: JSON.stringify(status), stderr: "" })
    });
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      schemaVersion: "account-center.public-provider-probes.v1",
      verificationState: "UNPROVEN",
      probes: [{ state: "BLOCKED", profiles: 0, usableProfiles: 0, limitsObserved: false }]
    });
  } finally {
    if (previousCommand === undefined) delete process.env.ACCOUNT_CENTER_GENERIC_COMMAND;
    else process.env.ACCOUNT_CENTER_GENERIC_COMMAND = previousCommand;
  }
});

test("routes next rejects invalid route selectors with fixed opaque UNPROVEN output", async () => {
  const status = JSON.parse(await readFile("tests/fixtures/status.fixture.json", "utf8"));
  const duplicateRoute = { ...status.routes[0], activeProfileId: "route-selector-private-account", order: ["route-selector-private-account"] };
  const previousCommand = process.env.ACCOUNT_CENTER_GENERIC_COMMAND;
  process.env.ACCOUNT_CENTER_GENERIC_COMMAND = "account-center-test-status";
  const failure = {
    schemaVersion: "account-center.public-route-next-error.v1",
    state: "UNPROVEN"
  };
  const cases: Array<{ args: string[]; payload: unknown }> = [
    { args: ["--provider"], payload: status },
    { args: ["--provider="], payload: status },
    { args: ["--runtime", "--json"], payload: status },
    { args: ["--provider", "openai", "--provider", "openai"], payload: status },
    { args: ["--runtime=openclaw", "--runtime=openclaw"], payload: status },
    { args: ["--provider=private-provider", "--runtime=private-runtime"], payload: status },
    { args: ["--provider=openai", "--runtime=openclaw"], payload: { ...status, routes: [...status.routes, duplicateRoute] } }
  ];
  try {
    for (const { args, payload } of cases) {
      for (const format of ["text", "json"] as const) {
        const result = await runCli(["routes", "next", "--source", "generic-command", ...(format === "json" ? ["--json"] : []), ...args], process.cwd(), {
          runner: async () => ({ code: 0, stdout: JSON.stringify(payload), stderr: "" })
        });
        assert.equal(result.code, 2, `${format}: ${args.join(" ")}`);
        assert.equal(result.stderr, undefined, `${format}: ${args.join(" ")}`);
        if (format === "json" || args.includes("--json")) assert.deepEqual(JSON.parse(result.stdout), failure);
        else assert.equal(result.stdout, "Route selection UNPROVEN.\n");
        for (const privateValue of ["private-provider", "private-runtime", "route-selector-private-account"]) {
          assert.equal(result.stdout.includes(privateValue), false, `${format}: ${privateValue}`);
        }
      }
    }
  } finally {
    if (previousCommand === undefined) delete process.env.ACCOUNT_CENTER_GENERIC_COMMAND;
    else process.env.ACCOUNT_CENTER_GENERIC_COMMAND = previousCommand;
  }
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
    ["routes", "auto", "--scope", "agent:main"],
    ["routes", "use", "openai:helper-2", "--scope", "agent:main"],
    ["routes", "remove", "openai:helper-1", "--scope", "agent:main"],
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

test("public route preview requires an exact agent scope and returns an exact confirmation token", async () => {
  const blocked = await runCli(["routes", "use", "openai:helper-2", "--json"]);
  assert.equal(blocked.code, 2);
  const preview = await runCli(["routes", "use", "openai:helper-2", "--scope", "agent:main", "--json"]);
  assert.equal(preview.code, 0);
  const payload = JSON.parse(preview.stdout);
  assert.equal(typeof payload.confirmationToken, "string");
  assert.notEqual(payload.confirmationToken, "[REDACTED]");
  assert.equal(payload.liveRuntimeMutation, false);
  const confirmed = await runCli(["routes", "use", "openai:helper-2", "--scope", "agent:main", "--apply", "--confirm", payload.confirmationToken, "--idempotency-key", "route-preview-confirm-regression-001", "--json"]);
  assert.notEqual(JSON.parse(confirmed.stdout).state, "BLOCKED", "the exact public preview token must be accepted by --confirm");
});

test("public fixture /auth remove rejects an unobserved agent scope before minting a preview token", async () => {
  const result = await runCli(["auth", "/auth", "remove", "openai:helper-2", "--scope", "agent:not_observed", "--json"]);
  assert.equal(result.code, 2);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.state, "BLOCKED");
  assert.equal(payload.confirmationToken, undefined);
});

test("public JSON and human mutation renderers distinguish attempted-but-unproven results and historical replays", () => {
  const attempted = publicMutationView({ applied: false, dryRun: false, liveRuntimeMutation: true, verification: { kind: "unproven" }, receipt: { id: "evt_attempted", action: "route.remove", dryRun: false, target: "private@example.test" } });
  assert.equal(attempted.state, "ATTEMPTED_UNPROVEN");
  assert.equal(attempted.receipt.target, "redacted-target");
  assert.equal(JSON.stringify(attempted).includes("private@example.test"), false);
  assert.match(renderMutation(attempted), /^ATTEMPTED BUT UNPROVEN/m);
  assert.doesNotMatch(renderMutation(attempted), /DRY RUN|no live Sentinel\/OpenClaw store was changed/);

  const replay = publicMutationView({ applied: false, dryRun: true, liveRuntimeMutation: false, replayed: true, historicalOutcome: "failed", historicalLiveRuntimeMutation: true, historicalVerification: "unproven", receipt: { id: "evt_replay", action: "route.remove", dryRun: true } });
  assert.equal(replay.state, "REPLAYED_ATTEMPTED_UNPROVEN");
  assert.equal(replay.liveRuntimeMutation, false);
  assert.equal(replay.historicalLiveRuntimeMutation, true);
  assert.match(renderMutation(replay), /^REPLAYED HISTORICAL ATTEMPT BUT UNPROVEN/m);
  assert.match(renderMutation(replay), /no current runtime action was attempted/);
});

test("public /auth remove is preview-first and exact confirmation cannot authorize a different target", async () => {
  const previousDataDir = process.env.ACCOUNT_CENTER_DATA_DIR;
  process.env.ACCOUNT_CENTER_DATA_DIR = await mkdtemp(join(tmpdir(), "account-center-auth-remove-"));
  try {
    const preview = await runCli(["auth", "/auth", "remove", "openai:helper-2", "--scope", "agent:main", "--json"]);
    assert.equal(preview.code, 0);
    const planned = JSON.parse(preview.stdout);
    assert.equal(planned.applied, false);
    assert.equal(planned.receipt.action, "route.remove");
    assert.equal(typeof planned.confirmationToken, "string");

    const confirmed = await runCli(["auth", "/auth", "remove", "openai:helper-2", "--scope", "agent:main", "--apply", "--confirm", planned.confirmationToken, "--idempotency-key", "auth-remove-preview-confirm-001", "--json"]);
    assert.equal(JSON.parse(confirmed.stdout).liveRuntimeMutation, false, "fixture confirmation never performs a live apply");
    const replay = await runCli(["auth", "/auth", "remove", "openai:helper-2", "--scope", "agent:main", "--apply", "--confirm", planned.confirmationToken, "--idempotency-key", "auth-remove-preview-confirm-001", "--json"]);
    assert.equal(JSON.parse(replay.stdout).state, "REPLAYED", "an exact public confirmation is idempotent");

    const changedTarget = await runCli(["auth", "/auth", "remove", "openai:helper-1", "--scope", "agent:main", "--apply", "--confirm", planned.confirmationToken, "--idempotency-key", "auth-remove-preview-confirm-002", "--json"]);
    assert.equal(JSON.parse(changedTarget.stdout).state, "BLOCKED", "a confirmation token cannot authorize a different route target");
  } finally {
    if (previousDataDir === undefined) delete process.env.ACCOUNT_CENTER_DATA_DIR;
    else process.env.ACCOUNT_CENTER_DATA_DIR = previousDataDir;
  }
});

test("/auth delete --dry-run renders a clear redacted no-deletion message", async () => {
  const result = await runCli(["auth", "/auth", "delete", "helper-1", "--dry-run"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^DRY RUN — no account was deleted/m);
  assert.match(result.stdout, /Action: account\.delete/);
  assert.match(result.stdout, /Verification: UNPROVEN/);
  assert.match(result.stdout, /Exact connected-target confirmation remains required/);
  assert.doesNotMatch(result.stdout, /helper-1/);

  const jsonResult = await runCli(["auth", "/auth", "delete", "helper-1", "--json"]);
  assert.equal(jsonResult.code, 0);
  assert.equal(JSON.parse(jsonResult.stdout).receipt.action, "account.delete");
});

test("/auth delete status-adapter failures fail closed with an opaque unproven receipt boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-auth-delete-status-failure-"));
  const workspace = join(root, "workspace");
  const cli = join(workspace, "oauth_routing_cli.py");
  const receiptPath = join(root, "delete-receipt.json");
  const previousWorkspace = process.env.ACCOUNT_CENTER_OPENCLAW_WORKSPACE;
  const previousCli = process.env.ACCOUNT_CENTER_OPENCLAW_CLI;
  const previousDataDir = process.env.ACCOUNT_CENTER_DATA_DIR;
  process.env.ACCOUNT_CENTER_OPENCLAW_WORKSPACE = workspace;
  process.env.ACCOUNT_CENTER_OPENCLAW_CLI = cli;
  process.env.ACCOUNT_CENTER_DATA_DIR = join(root, "data");
  await mkdir(workspace, { recursive: true });
  await writeFile(cli, "#!/usr/bin/env python3\n", "utf8");
  const hostile = "Error: adapter stack at /srv/private/account-center/adapter.ts:42 for person@example.test token=sk-hostile-token-value-123456789";
  try {
    for (const json of [false, true]) {
      const result = await runCli(["auth", "/auth", "delete", "person@example.test", "--source", "openclaw", "--receipt-path", receiptPath, ...(json ? ["--json"] : [])], process.cwd(), {
        runner: async () => ({ code: 1, stdout: "", stderr: hostile })
      });
      assert.equal(result.code, 2);
      assert.equal(result.stderr, undefined);
      if (json) {
        assert.deepEqual(JSON.parse(result.stdout), {
          schemaVersion: "account-center.public-mutation.v1",
          verificationState: "UNPROVEN",
          applied: false,
          dryRun: true,
          liveRuntimeMutation: false,
          state: "BLOCKED",
          receipt: { id: "receipt-redacted", action: "account.delete", dryRun: true, target: "redacted-target" }
        });
      } else {
        assert.match(result.stdout, /^DRY RUN — no account was deleted/m);
        assert.match(result.stdout, /BLOCKED\/UNPROVEN/);
      }
      for (const privateValue of [hostile, cli, "/srv/private/account-center/adapter.ts:42", "person@example.test", "sk-hostile-token-value-123456789", "Error:"]) {
        assert.equal(result.stdout.includes(privateValue), false, privateValue);
      }
    }
    assert.equal(await lstat(receiptPath).then(() => true, () => false), false, "the caller-selected path is never written");
    assert.equal(await lstat(join(root, "data", "blocked-delete-receipts")).then(() => true, () => false), false, "a requested path suppresses boundary persistence");
  } finally {
    if (previousWorkspace === undefined) delete process.env.ACCOUNT_CENTER_OPENCLAW_WORKSPACE;
    else process.env.ACCOUNT_CENTER_OPENCLAW_WORKSPACE = previousWorkspace;
    if (previousCli === undefined) delete process.env.ACCOUNT_CENTER_OPENCLAW_CLI;
    else process.env.ACCOUNT_CENTER_OPENCLAW_CLI = previousCli;
    if (previousDataDir === undefined) delete process.env.ACCOUNT_CENTER_DATA_DIR;
    else process.env.ACCOUNT_CENTER_DATA_DIR = previousDataDir;
  }
});

test("/auth delete status failure keeps directory and symlink receipt paths opaque", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-auth-delete-unsafe-receipt-"));
  const workspace = join(root, "workspace");
  const cli = join(workspace, "oauth_routing_cli.py");
  const target = join(root, "private-receipt-target.json");
  const link = join(root, "receipt-link.json");
  await mkdir(workspace, { recursive: true });
  await writeFile(cli, "#!/usr/bin/env python3\n", "utf8");
  await writeFile(target, "unchanged-private-fixture", "utf8");
  await symlink(target, link);
  const priorWorkspace = process.env.ACCOUNT_CENTER_OPENCLAW_WORKSPACE;
  const priorCli = process.env.ACCOUNT_CENTER_OPENCLAW_CLI;
  process.env.ACCOUNT_CENTER_OPENCLAW_WORKSPACE = workspace;
  process.env.ACCOUNT_CENTER_OPENCLAW_CLI = cli;
  try {
    for (const receiptPath of [join(root, "receipt-directory"), link]) {
      if (receiptPath.endsWith("directory")) await mkdir(receiptPath);
      const result = await runCli(["auth", "/auth", "delete", "private@example.test", "--source", "openclaw", "--receipt-path", receiptPath, "--json"], process.cwd(), {
        runner: async () => ({ code: 1, stdout: "", stderr: "private adapter diagnostic" })
      });
      assert.equal(result.code, 2);
      const publicResult = JSON.parse(result.stdout);
      assert.equal(publicResult.state, "BLOCKED");
      assert.deepEqual(publicResult.receipt, { id: "receipt-redacted", action: "account.delete", dryRun: true, target: "redacted-target" });
      for (const privateValue of [receiptPath, "private@example.test", "private adapter diagnostic", "Error:"]) assert.equal(result.stdout.includes(privateValue), false, privateValue);
    }
    assert.equal(await readFile(target, "utf8"), "unchanged-private-fixture");
  } finally {
    if (priorWorkspace === undefined) delete process.env.ACCOUNT_CENTER_OPENCLAW_WORKSPACE;
    else process.env.ACCOUNT_CENTER_OPENCLAW_WORKSPACE = priorWorkspace;
    if (priorCli === undefined) delete process.env.ACCOUNT_CENTER_OPENCLAW_CLI;
    else process.env.ACCOUNT_CENTER_OPENCLAW_CLI = priorCli;
  }
});

test("/auth delete unsafe requested receipt entries are opaque and create no private receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-center-auth-delete-parent-symlink-"));
  const data = join(root, "data");
  const safeParent = join(root, "safe-parent");
  const linkedParent = join(root, "linked-parent");
  const existing = join(root, "existing.json");
  await mkdir(safeParent);
  await symlink(safeParent, linkedParent);
  await writeFile(existing, "preserve-me", "utf8");
  const previousDataDir = process.env.ACCOUNT_CENTER_DATA_DIR;
  const previousWorkspace = process.env.ACCOUNT_CENTER_OPENCLAW_WORKSPACE;
  const previousCli = process.env.ACCOUNT_CENTER_OPENCLAW_CLI;
  process.env.ACCOUNT_CENTER_DATA_DIR = data;
  process.env.ACCOUNT_CENTER_OPENCLAW_WORKSPACE = join(root, "missing-workspace");
  process.env.ACCOUNT_CENTER_OPENCLAW_CLI = join(root, "missing-cli.py");
  try {
    for (const receiptPath of [join(linkedParent, "receipt.json"), existing]) {
      const result = await runCli(["auth", "/auth", "delete", "private@example.test", "--source", "openclaw", "--receipt-path", receiptPath, "--json"], process.cwd(), {
        runner: async () => ({ code: 1, stdout: "", stderr: "private adapter diagnostic" })
      });
      assert.equal(result.code, 2);
      assert.deepEqual(JSON.parse(result.stdout), blockedCredentialDeleteView());
      assert.equal(result.stdout.includes(receiptPath), false);
    }
    assert.equal(await readFile(existing, "utf8"), "preserve-me");
    assert.equal(await lstat(join(linkedParent, "receipt.json")).then(() => true, () => false), false);
    assert.equal(await lstat(join(data, "receipts")).then(() => true, () => false), false);
  } finally {
    if (previousDataDir === undefined) delete process.env.ACCOUNT_CENTER_DATA_DIR;
    else process.env.ACCOUNT_CENTER_DATA_DIR = previousDataDir;
    if (previousWorkspace === undefined) delete process.env.ACCOUNT_CENTER_OPENCLAW_WORKSPACE;
    else process.env.ACCOUNT_CENTER_OPENCLAW_WORKSPACE = previousWorkspace;
    if (previousCli === undefined) delete process.env.ACCOUNT_CENTER_OPENCLAW_CLI;
    else process.env.ACCOUNT_CENTER_OPENCLAW_CLI = previousCli;
  }
});

test("credential delete apply and renderer both fail closed without a native transaction contract", async () => {
  const result = await runCli(["auth", "/auth", "delete", "helper-1", "--apply"]);
  assert.equal(result.code, 2);
  assert.match(result.stdout, /^DRY RUN — no account was deleted/m);
  assert.match(result.stdout, /Result: BLOCKED/);
  assert.match(result.stdout, /BLOCKED\/UNPROVEN/);
  assert.doesNotMatch(result.stdout, /DELETED|credentials were removed|--apply/);

  const impossibleSuccess = publicMutationView({
    applied: true,
    dryRun: false,
    liveRuntimeMutation: true,
    verification: { kind: "verified" },
    receipt: { id: "evt_delete", action: "account.delete", dryRun: false, target: "private@example.test" }
  });
  assert.equal(impossibleSuccess.state, "BLOCKED");
  assert.equal(impossibleSuccess.applied, false);
  assert.equal(impossibleSuccess.liveRuntimeMutation, false);
  assert.match(renderMutation(impossibleSuccess), /BLOCKED\/UNPROVEN/);
  assert.doesNotMatch(renderMutation(impossibleSuccess), /DELETED|credentials were removed/);
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
  assert.match(result.stdout, /accounts delete <email-or-profile> \[--dry-run\] -- BLOCKED\/UNPROVEN/);
  assert.doesNotMatch(result.stdout, /accounts delete <email-or-profile> \[--apply\]/);
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
