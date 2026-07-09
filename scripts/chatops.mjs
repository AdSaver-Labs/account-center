#!/usr/bin/env node
import { runCli } from "../packages/cli/dist/index.js";

const message = process.argv.slice(2).join(" ").trim();
if (!message) {
  console.error("Usage: node scripts/chatops.mjs '/auth status --json'");
  process.exit(1);
}

if (!message.startsWith("/auth")) {
  console.error("Only /auth manual chat commands are accepted by this wrapper.");
  process.exit(1);
}

const result = await runCli(["auth", ...message.split(/\s+/)]);
if (result.stdout) process.stdout.write(result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`);
if (result.stderr) process.stderr.write(result.stderr.endsWith("\n") ? result.stderr : `${result.stderr}\n`);
process.exitCode = result.code;
