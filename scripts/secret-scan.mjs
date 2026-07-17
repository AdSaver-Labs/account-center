#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
const patterns = [
  [/\bsk-[A-Za-z0-9]{20,}\b/g, "OpenAI-style key"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "GitHub token"],
  [/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, "Slack token"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "AWS access key"],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, "private key"],
];
const findings = [];

for (const path of tracked) {
  if (path.endsWith(".png") || path.endsWith(".jpg") || path.endsWith(".zip")) continue;
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    continue;
  }
  for (const [pattern, label] of patterns) {
    for (const match of content.matchAll(pattern)) {
      const line = content.slice(0, match.index).split("\n").length;
      findings.push(`${path}:${line}: possible ${label}`);
    }
  }
}

if (findings.length) {
  console.error("Secret scan failed:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}
console.log(`Secret scan passed: ${tracked.length} tracked files scanned.`);
