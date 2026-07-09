import { readFile } from "node:fs/promises";
import { AccountCenterStatus, assertAccountCenterStatus } from "./schemas.js";

export async function loadFixtureStatus(path = "tests/fixtures/status.fixture.json"): Promise<AccountCenterStatus> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  assertAccountCenterStatus(parsed);
  return parsed;
}
