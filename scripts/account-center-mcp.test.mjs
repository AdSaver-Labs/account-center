import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";


const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bridge = resolve(root, "scripts/account-center-mcp.mjs");

function call(command, env = {}) {
  const request = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "account_center_auth", arguments: { command } } };
  const result = spawnSync(process.execPath, [bridge], {
    cwd: root,
    input: `${JSON.stringify(request)}\n`,
    encoding: "utf8",
    env: { ...process.env, ...env, ACCOUNT_CENTER_MCP_ALLOW_MUTATIONS: "" },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

const MUTATION_BLOCKED_TEXT =
  "Blocked potentially mutating Account Center command in Codex MCP.\n\n" +
  "For safety, this MCP bridge allows status/help and dry-runs by default. " +
  "Ask Alej for an explicit target/approval and run through Telegram/Hermes/OpenClaw, or set ACCOUNT_CENTER_MCP_ALLOW_MUTATIONS=1 for a controlled test session.";

for (const { name, command, privateValues } of [
  {
    name: "positional route-use shortcut",
    command: "/auth openai:opaque-identity-01",
    privateValues: ["openai:opaque-identity-01"],
  },
  {
    name: "route target",
    command: "/auth use opaque-account-target-02",
    privateValues: ["opaque-account-target-02"],
  },
  {
    name: "routing removal target and receipt",
    command: "/auth remove opaque-account-target-03 --receipt opaque-receipt-03 --path /srv/private/account-center/receipt-03.json",
    privateValues: ["opaque-account-target-03", "opaque-receipt-03", "/srv/private/account-center/receipt-03.json"],
  },
  {
    name: "credential identity and path",
    command: "/auth delete openai:opaque-identity-04 --path /srv/private/account-center/receipt-04.json",
    privateValues: ["openai:opaque-identity-04", "/srv/private/account-center/receipt-04.json"],
  },
  {
    name: "guided-auth identity",
    command: "/auth reauth openai:opaque-identity-05",
    privateValues: ["openai:opaque-identity-05"],
  },
]) {
  test(`MCP blocks live ${name} unless mutation authorization is enabled without echoing operands`, () => {
    const response = call(command);
    assert.equal(response.result.isError, true);
    assert.equal(response.result.content[0].text, MUTATION_BLOCKED_TEXT);
    const publicOutput = JSON.stringify(response);
    for (const value of privateValues) assert.equal(publicOutput.includes(value), false, `${value} leaked from ${publicOutput}`);
  });
}

test("MCP permits an explicitly dry-run mutation without mutation authorization", () => {
  const response = call("/auth auto --dry-run");
  assert.notEqual(response.result.content[0].text.includes("Blocked potentially mutating"), true);
});

test("MCP keeps hostile generic-command provider-probe failures opaque", () => {
  const hostileValues = [
    "person@example.test",
    "/srv/private/account-center/worktree",
    "sk-hostile-token-value-123456789",
    "/usr/local/bin/private-adapter --dump-config",
    "HOSTILE_STDERR_DIAGNOSTIC",
  ];
  const diagnostic = `HOSTILE_STDERR_DIAGNOSTIC email=${hostileValues[0]} path=${hostileValues[1]} token=${hostileValues[2]} command=${hostileValues[3]}`;
  const response = call("/auth probe --source generic-command --provider all", {
    ACCOUNT_CENTER_SOURCE: "generic-command",
    ACCOUNT_CENTER_GENERIC_COMMAND: `${process.execPath} -e "process.stderr.write('${diagnostic}\\n'); process.exit(23)"`,
  });

  assert.equal(response.result.isError, true);
  const publicOutput = JSON.stringify(response);
  for (const value of hostileValues) assert.equal(publicOutput.includes(value), false, `${value} leaked from ${publicOutput}`);
  assert.equal(response.result.content[0].text, "Account Center request UNPROVEN.\n");
});

for (const [name, command] of [["status", "/auth"], ["help", "/auth help"], ["dry-run", "/auth delete person@example.test --dry-run"]]) {
  test(`MCP ${name} success path is a redacted public response`, () => {
    const response = call(command, { ACCOUNT_CENTER_SOURCE: "fixture" });
    assert.equal(response.result.isError, false);
    const publicOutput = JSON.stringify(response);
    assert.equal(publicOutput.includes("person@example.test"), false, publicOutput);
    assert.equal(publicOutput.includes("sk-"), false, publicOutput);
  });
}
