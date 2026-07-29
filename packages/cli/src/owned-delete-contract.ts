import { readFileSync } from "node:fs";

export interface OwnedDeleteReceiptContract {
  schemaVersion: "account-center.owned-delete-receipt.v1";
  nativeReceipt: { action: "account.delete"; state: "DELETED"; receipt: "opaque-owned-delete" };
  public: { appliedText: string; unprovenText: string };
}

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
      typeof raw.public?.appliedText !== "string" ||
      typeof raw.public?.unprovenText !== "string") {
    throw new Error("owned_delete_receipt_contract_invalid");
  }
  return raw as OwnedDeleteReceiptContract;
}
