#!/usr/bin/env node
import { runCli } from "../packages/cli/dist/index.js";
import { tokenizeAuthCommand } from "../packages/cli/dist/auth-bridge.js";

const message = process.argv.slice(2).join(" ").trim();
if (!message) {
  console.error("Usage: node scripts/chatops.mjs '/auth status --json'");
  process.exit(1);
}

if (!message.startsWith("/auth")) {
  console.error("Only /auth manual chat commands are accepted by this wrapper.");
  process.exit(1);
}

let tokens;
try {
  tokens = tokenizeAuthCommand(message);
} catch {
  console.error("Invalid Account Center command.");
  process.exit(1);
}

// Hermes and Dexter both enter through this wrapper. Do not let a thrown
// adapter/process diagnostic escape that canonical public contract.
try {
  const result = await runCli(["auth", ...tokens]);
  if (result.stdout) process.stdout.write(result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`);
  if (result.stderr) process.stderr.write(result.stderr.endsWith("\n") ? result.stderr : `${result.stderr}\n`);
  process.exitCode = result.code;
} catch {
  console.error("Account Center /auth request UNPROVEN.");
  process.exitCode = 2;
}
