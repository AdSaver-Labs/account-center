import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";


const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bridge = resolve(root, "scripts/account-center-mcp.mjs");

function call(command, env = {}) {
  const request = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "account_center_auth", arguments: { command } } };
  return callRequest(request, env);
}

function callRequest(request, env = {}, input = `${JSON.stringify(request)}\n`) {
  const result = spawnSync(process.execPath, [bridge], {
    cwd: root,
    input,
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

test("MCP initializes and lists tools before ignored CLI build artifacts exist", () => {
  const fixtureRoot = mkdtempSync(resolve(tmpdir(), "account-center-mcp-clean-"));
  const fixtureScripts = resolve(fixtureRoot, "scripts");
  mkdirSync(fixtureScripts);
  copyFileSync(bridge, resolve(fixtureScripts, "account-center-mcp.mjs"));
  writeFileSync(resolve(fixtureScripts, "chatops.mjs"), "// presence-only clean-checkout fixture\n");
  try {
    const request = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
    const result = spawnSync(process.execPath, [resolve(fixtureScripts, "account-center-mcp.mjs")], {
      cwd: fixtureRoot,
      input: `${JSON.stringify(request)}\n`,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const response = JSON.parse(result.stdout.trim());
    assert.equal(response.result.serverInfo.name, "account-center");
    assert.equal(result.stderr.includes("auth-bridge"), false);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

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
  {
    name: "guarded route application",
    command: "/auth guard --ensure-route --apply --receipt opaque-receipt-06 --path /srv/private/account-center/receipt-06.json",
    privateValues: ["opaque-receipt-06", "/srv/private/account-center/receipt-06.json"],
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
  const response = call("/auth auto --dry-run", { ACCOUNT_CENTER_SOURCE: "fixture" });
  assert.equal(response.result.isError, false);
  assert.equal(response.result.content[0].text.includes("Blocked potentially mutating"), false);
});

test("MCP blocks dry-run text embedded in a quoted mutation operand", () => {
  const embeddedDryRunOperand = "opaque-target --dry-run";
  const response = call(`/auth delete "${embeddedDryRunOperand}" --apply`);

  assert.equal(response.result.isError, true);
  assert.equal(response.result.content[0].text, MUTATION_BLOCKED_TEXT);
  assert.equal(JSON.stringify(response).includes(embeddedDryRunOperand), false);
});

for (const { name, command } of [
  { name: "a quoted standalone flag", command: '/auth auto "--dry-run"' },
  { name: "an escaped standalone flag", command: "/auth auto \\--dry-run" },
  { name: "a dry-run flag paired with apply", command: "/auth auto --dry-run --apply" },
]) {
  test(`MCP fails closed for ${name}`, () => {
    const response = call(command);
    assert.equal(response.result.isError, true);
    assert.equal(response.result.content[0].text, MUTATION_BLOCKED_TEXT);
  });
}

test("MCP permits a positional route-use dry-run through the canonical parser", () => {
  const target = "openai:opaque-target-07";
  const response = call(`/auth ${target} --dry-run`, { ACCOUNT_CENTER_SOURCE: "fixture" });
  assert.equal(response.result.isError, false);
  assert.equal(JSON.stringify(response).includes(target), false);
});

test("MCP fails closed for an unterminated quoted mutation operand", () => {
  const response = call('/auth delete "opaque-target --dry-run --apply');

  assert.equal(response.result.isError, true);
  assert.equal(response.result.content[0].text, MUTATION_BLOCKED_TEXT);
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

test("MCP keeps hostile adapter source labels opaque", () => {
  const hostileSource = "/srv/private/account-center/adapter --source=production";
  const response = call("/auth", { ACCOUNT_CENTER_SOURCE: hostileSource });
  assert.equal(response.result.isError, true);
  assert.equal(response.result.content[0].text, "Account Center request UNPROVEN.\n");
  assert.equal(JSON.stringify(response).includes(hostileSource), false);
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

test("MCP schema and JSON-RPC errors use fixed public text without echoing request values", () => {
  const opaqueTool = "opaque-tool-target-08";
  const schema = callRequest({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  assert.equal(schema.result.tools[0].inputSchema.properties.command.description.includes("@"), false);
  assert.equal(schema.result.tools[0].inputSchema.properties.command.description.includes("[REDACTED_TARGET]"), false);

  for (const request of [
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: opaqueTool, arguments: {} } },
    { jsonrpc: "2.0", id: 1, method: "opaque-method-target-09", params: {} },
  ]) {
    const response = callRequest(request);
    assert.equal(response.error.message, "Invalid Account Center MCP request.");
    assert.equal(JSON.stringify(response).includes(opaqueTool), false);
    assert.equal(JSON.stringify(response).includes("opaque-method-target-09"), false);
  }

  const malformed = callRequest({}, {}, '{"jsonrpc":"2.0","method":"opaque-parse-target-10"\n');
  assert.equal(malformed.error.message, "Invalid Account Center MCP request.");
  assert.equal(JSON.stringify(malformed).includes("opaque-parse-target-10"), false);
});
