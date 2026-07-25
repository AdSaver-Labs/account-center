#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { HermesRuntimeCapacityAdapter } from "@account-center/core";

const help = `Usage: node scripts/export-hermes-automation-capacity.mjs [--scope profile:default] [--provider openai] [--hermes-bin hermes] [--previous-state path]\n\nRead-only. Calls \`hermes status --all\` only for Hermes runtime proof and reads the\ncanonical Account Center OpenClaw/Sentinel status for the mapped account's provider capacity.\nIt never derives quota from Hermes login/auth text and never persists state; the cron gate\nmust persist its state only after accepting this decision. Exit 0 means available; 2 blocked.\n`;

export async function runHermesCapacityExport(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  if (options.help) return { code: 0, stdout: help, stderr: "" };
  let previous;
  if (options.previousState) {
    try {
      previous = JSON.parse(await readFile(options.previousState, "utf8"));
    } catch {
      // A malformed/unreadable previous state is not allowed to reset a
      // notifier. Do not manufacture a transition from an unknown history.
      return blockedWithoutTransition(options.scope);
    }
  }
  const adapter = new HermesRuntimeCapacityAdapter({ hermesBin: options.hermesBin, provider: options.provider, scope: options.scope });
  const result = await adapter.export(previous);
  return { code: result.agents.every((agent) => agent.state === "available") ? 0 : 2, stdout: `${JSON.stringify(result)}\n`, stderr: "" };
}

function parseOptions(argv) {
  const options = { scope: "profile:default", provider: "openai", hermesBin: "hermes", previousState: undefined, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") { options.help = true; continue; }
    if (!["--scope", "--provider", "--hermes-bin", "--previous-state"].includes(arg)) throw new Error(`unsupported option: ${arg}`);
    const value = argv[++index];
    if (!value || value.startsWith("-")) throw new Error(`missing value for ${arg}`);
    if (arg === "--scope") options.scope = value;
    if (arg === "--provider") options.provider = value;
    if (arg === "--hermes-bin") options.hermesBin = value;
    if (arg === "--previous-state") options.previousState = value;
  }
  if (!/^[a-z][a-z0-9_-]{0,31}:[a-z0-9_-]{1,64}$/i.test(options.scope)) throw new Error("scope must be an exact kind:id value");
  if (!/^[a-z][a-z0-9_-]{0,63}$/i.test(options.provider)) throw new Error("provider must be a simple provider key");
  return options;
}

function blockedWithoutTransition(scope) {
  const result = {
    schemaVersion: "account-center.automation-capacity-export.v1",
    generatedAt: "unknown",
    state: { schemaVersion: "account-center.automation-capacity-state.v1", agents: [{ agentRef: "connection-1", runtime: "hermes", scope, state: "blocked" }] },
    agents: [{ agentRef: "connection-1", runtime: "hermes", scope, state: "blocked", workers: "paused", reason: "runtime-unproven", evidence: { runtime: "unproven", provider: "unproven" } }]
  };
  return { code: 2, stdout: `${JSON.stringify(result)}\n`, stderr: "" };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = await runHermesCapacityExport();
    process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exitCode = result.code;
  } catch (error) {
    process.stderr.write(`Hermes capacity export blocked: ${error instanceof Error ? error.message : "invalid input"}\n`);
    process.exitCode = 2;
  }
}
