#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const sandbox = await mkdtemp(join(tmpdir(), "account-center-clean-install-"));
const workspace = sandbox;
const stateRoot = join(sandbox, ".panel-state");
const tokenFile = join(sandbox, "launch-token");
const token = "clean-install-fixture-token";
let panel;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: workspace, encoding: "utf8", ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`clean_install_command_failed:${command}`);
  }
}

async function startPanel() {
  panel = spawn(process.execPath, ["packages/cli/dist/index.js", "serve", "--port", "0", "--source", "fixture", "--token-file", tokenFile], {
    cwd: workspace,
    env: { ...process.env, ACCOUNT_CENTER_DATA_DIR: stateRoot },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  let failure = "";
  panel.stdout.setEncoding("utf8");
  panel.stderr.setEncoding("utf8");
  panel.stdout.on("data", (chunk) => { output += chunk; });
  panel.stderr.on("data", (chunk) => { failure += chunk; });
  const url = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("clean_install_panel_start_timeout")), 10_000);
    const check = () => {
      const match = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(output);
      if (match) {
        clearTimeout(timeout);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    };
    panel.stdout.on("data", check);
    panel.once("error", () => { clearTimeout(timeout); reject(new Error("clean_install_panel_start_failed")); });
    panel.once("exit", () => { clearTimeout(timeout); reject(new Error(failure ? "clean_install_panel_start_failed" : "clean_install_panel_exited")); });
  });
  return url;
}

async function stopPanel() {
  if (!panel || panel.exitCode !== null) return;
  const exited = new Promise((resolve) => panel.once("exit", resolve));
  panel.kill("SIGINT");
  const timeout = setTimeout(() => panel.kill("SIGKILL"), 5_000);
  await exited;
  clearTimeout(timeout);
}

try {
  // The release candidate is the staged tree: unlike HEAD, it includes every
  // staged documentation, command, and harness change under review.
  const tree = spawnSync("git", ["write-tree"], { cwd: root, encoding: "utf8" });
  assert.equal(tree.status, 0, "clean install must materialize the staged release candidate");
  const archive = spawnSync("git", ["archive", "--format=tar", tree.stdout.trim()], { cwd: root, encoding: null, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(archive.status, 0, "clean install must archive the staged release candidate");
  run("tar", ["-x", "-C", sandbox], { input: archive.stdout });
  run("npm", ["ci"]);
  run("npm", ["run", "build"]);
  await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
  await chmod(tokenFile, 0o600);
  const base = await startPanel();
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/, "panel must announce a loopback URL");
  const missing = await fetch(`${base}/api/status`);
  assert.equal(missing.status, 401, "panel must reject a missing bearer token");
  const incorrect = await fetch(`${base}/api/status`, { headers: { authorization: "Bearer incorrect-token" } });
  assert.equal(incorrect.status, 401, "panel must reject an incorrect bearer token");
  const authenticated = await fetch(`${base}/api/status`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(authenticated.status, 200, "panel must return authenticated fixture status");
  const status = await authenticated.json();
  const serializedStatus = JSON.stringify(status);
  assert.equal(status.schemaVersion, "account-center.public-status.v1", "authenticated status must be public and redacted");
  assert.equal("token" in status, false, "status must not expose a top-level launch token");
  assert.equal(serializedStatus.includes(token), false, "status must not expose the launch token at any depth");
  const preferencesResponse = await fetch(`${base}/api/account-ui-preferences?runtime=hermes&scope=default`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(preferencesResponse.status, 200, "panel must return authenticated scoped fixture account visibility preferences");
  const preferences = await preferencesResponse.json();
  assert.deepEqual(preferences, { schemaVersion: "account-center.account-ui-preferences.v1", hiddenAccountRefs: [] }, "preferences must be a versioned, redacted empty fixture projection");
  assert.equal(JSON.stringify(preferences).includes(token), false, "preferences must not expose the launch token at any depth");
  process.stdout.write("Account Center clean Node install verification: passed\n");
} finally {
  await stopPanel();
  await rm(sandbox, { recursive: true, force: true });
}
