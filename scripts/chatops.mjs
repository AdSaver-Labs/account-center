#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runCli } from "../packages/cli/dist/index.js";
import { tokenizeAuthCommand } from "../packages/cli/dist/auth-bridge.js";

const message = process.argv.slice(2).join(" ").trim();
const OWNED_DELETE_UNPROVEN_TEXT = "DRY RUN — no account was deleted and no live Sentinel/OpenClaw store was changed.\nAction: account.delete\nTarget: redacted-target\nResult: BLOCKED\nVerification: UNPROVEN\n\nCredential deletion is UNPROVEN; the owned exact-account transaction did not produce verified evidence.\nExact connected-target confirmation remains required before credential deletion.\n";
const OWNED_DELETE_APPLIED_TEXT = "APPLIED — owned exact-account credential delete completed.\nAction: account.delete\nResult: APPLIED\nVerification: VERIFIED\nReceipt: opaque-owned-delete\n";
function loadDeleteContract() {
  const contract = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "contracts", "owned-delete-receipt.v1.json"), "utf8"));
  if (contract?.schemaVersion !== "account-center.owned-delete-receipt.v1" ||
      contract?.nativeReceipt?.action !== "account.delete" ||
      contract?.nativeReceipt?.state !== "DELETED" ||
      contract?.nativeReceipt?.receipt !== "opaque-owned-delete" ||
      contract?.public?.appliedText !== OWNED_DELETE_APPLIED_TEXT ||
      contract?.public?.unprovenText !== OWNED_DELETE_UNPROVEN_TEXT) throw new Error("owned_delete_receipt_contract_invalid");
  return contract;
}
let deleteContractValid = false;
try { loadDeleteContract(); deleteContractValid = true; } catch { /* fail closed */ }
if (!message) {
  console.error("Usage: node scripts/chatops.mjs '/auth status --json'");
  process.exit(1);
}

if (!message.startsWith("/auth")) {
  console.error("Only /auth manual chat commands are accepted by this wrapper.");
  process.exit(1);
}

if (!deleteContractValid && /^\/auth\s+delete(?:\s|$)/i.test(message)) {
  process.stdout.write(OWNED_DELETE_UNPROVEN_TEXT);
  process.exit(2);
}

let tokens;
try {
  tokens = tokenizeAuthCommand(message);
} catch {
  // Tokenization happens before the CLI can classify a malformed delete. Keep
  // the shared Hermes/Dexter credential-delete boundary at its two canonical,
  // target-free outcomes even for malformed quoted operands.
  if (/^\/auth\s+delete(?:\s|$)/i.test(message)) {
    process.stdout.write(OWNED_DELETE_UNPROVEN_TEXT);
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
