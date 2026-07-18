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

for (const command of ["/auth auto", "/auth use openai:example", "/auth remove openai:example", "/auth delete example@example.invalid", "/auth delete person@example.test --receipt_target opaque-receipt-target --path /srv/private/account-center/receipt.json --token sk-hostile-token-value-123456789"]) {
  test(`MCP blocks live ${command} unless mutation authorization is enabled`, () => {
    const response = call(command);
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /Blocked potentially mutating Account Center command/);
    const publicOutput = JSON.stringify(response);
    for (const value of ["person@example.test", "opaque-receipt-target", "/srv/private/account-center/receipt.json", "sk-hostile-token-value-123456789"]) assert.equal(publicOutput.includes(value), false, `${value} leaked from ${publicOutput}`);
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
