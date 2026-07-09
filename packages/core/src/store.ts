import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { AccountCenterStatus, assertAccountCenterStatus } from "./schemas.js";
import { redactJson } from "./redaction.js";

export interface StatusStore {
  readStatus(): Promise<AccountCenterStatus>;
  writeStatus(status: AccountCenterStatus): Promise<void>;
}

export class FileStatusStore implements StatusStore {
  constructor(private readonly path: string) {}

  async readStatus(): Promise<AccountCenterStatus> {
    const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
    assertAccountCenterStatus(parsed);
    return parsed;
  }

  async writeStatus(status: AccountCenterStatus): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(redactJson(status), null, 2)}\n`, "utf8");
  }
}
