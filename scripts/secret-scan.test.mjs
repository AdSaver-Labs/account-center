import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const scanner = new URL("./secret-scan.mjs", import.meta.url);

function fixtureRepository(files) {
  const root = mkdtempSync(join(tmpdir(), "account-center-secret-scan-"));
  cpSync(scanner, join(root, "secret-scan.mjs"));
  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(root, path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  return root;
}

function runScanner(root) {
  return spawnSync(process.execPath, ["secret-scan.mjs"], { cwd: root, encoding: "utf8" });
}

test("tracked public fixtures reject generic bearer values without echoing them", () => {
  const token = `Bearer synthetic-${"x".repeat(24)}`;
  const root = fixtureRepository({ "tests/fixtures/public-status.json": JSON.stringify({ launchToken: token }) });
  try {
    const result = runScanner(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /tests\/fixtures\/public-status\.json:1: possible bearer token/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(token));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ordinary documentation and opaque public references remain accepted", () => {
  const root = fixtureRepository({
    "docs/SECURITY.md": "Use a bearer token without publishing its value.\n",
    "tests/fixtures/public-status.json": JSON.stringify({ accountRef: "acct_opaque_reference" }),
  });
  try {
    const result = runScanner(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Secret scan passed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});