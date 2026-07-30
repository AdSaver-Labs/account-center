import { readFileSync } from "node:fs";

export interface OwnedDeleteReceiptContract {
  schemaVersion: "account-center.owned-delete-receipt.v1";
  nativeReceipt: { action: "account.delete"; state: "DELETED"; receipt: "opaque-owned-delete" };
  public: { appliedText: string; unprovenText: string };
}

// Public delete text is an immutable protocol value, not editable presentation
// copy. This prevents a damaged local contract from becoming an identity/path
// disclosure channel at an otherwise opaque receipt boundary.
export const OWNED_DELETE_APPLIED_TEXT = "APPLIED — owned exact-account credential delete completed.\nAction: account.delete\nResult: APPLIED\nVerification: VERIFIED\nReceipt: opaque-owned-delete\n";
export const OWNED_DELETE_UNPROVEN_TEXT = "DRY RUN — no account was deleted and no live Sentinel/OpenClaw store was changed.\nAction: account.delete\nTarget: redacted-target\nResult: BLOCKED\nVerification: UNPROVEN\n\nCredential deletion is UNPROVEN; the owned exact-account transaction did not produce verified evidence.\nExact connected-target confirmation remains required before credential deletion.\n";

/**
 * The versioned contract is shared by the CLI/Dexter bridge and Hermes. It is
 * deliberately target-free; failure to load or validate it fails the caller
 * closed rather than substituting a transport-local receipt.
 */
export function loadOwnedDeleteReceiptContract(): OwnedDeleteReceiptContract {
  const raw = JSON.parse(readFileSync(new URL("../../../contracts/owned-delete-receipt.v1.json", import.meta.url), "utf8")) as Partial<OwnedDeleteReceiptContract>;
  if (raw.schemaVersion !== "account-center.owned-delete-receipt.v1" ||
      raw.nativeReceipt?.action !== "account.delete" ||
      raw.nativeReceipt.state !== "DELETED" ||
      raw.nativeReceipt.receipt !== "opaque-owned-delete" ||
      raw.public?.appliedText !== OWNED_DELETE_APPLIED_TEXT ||
      raw.public?.unprovenText !== OWNED_DELETE_UNPROVEN_TEXT) {
    throw new Error("owned_delete_receipt_contract_invalid");
  }
  return raw as OwnedDeleteReceiptContract;
}
