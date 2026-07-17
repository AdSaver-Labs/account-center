#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const security = process.argv.includes("--security");
const commands = [
  ["npm", ["test"]],
  ["npm", ["run", "typecheck"]],
  ["npm", ["run", "build"]],
  ["npm", ["run", "test:a11y"]],
];

if (security) {
  commands.push(
    ["node", ["scripts/secret-scan.mjs"]],
    ["npm", ["audit", "--audit-level=high"]],
  );
}

for (const [command, args] of commands) {
  console.log(`\n$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) {
    console.error(`Could not start ${command}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`\nAccount Center ${security ? "security " : ""}QA gate: passed`);
