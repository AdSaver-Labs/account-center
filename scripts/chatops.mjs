#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runCli } from "../packages/cli/dist/index.js";
import { tokenizeAuthCommand } from "../packages/cli/dist/auth-bridge.js";

const message = process.argv.slice(2).join(" ").trim();
const DELETE_UNPROVEN_TEXT = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "contracts", "owned-delete-receipt.v1.json"), "utf8")).public.unprovenText;
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
  // Tokenization happens before the CLI can classify a malformed delete. Keep
  // the shared Hermes/Dexter credential-delete boundary at its two canonical,
  // target-free outcomes even for malformed quoted operands.
  if (/^\/auth\s+delete(?:\s|$)/i.test(message)) {
    process.stdout.write(DELETE_UNPROVEN_TEXT);
    process.exit(2);
  }
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
