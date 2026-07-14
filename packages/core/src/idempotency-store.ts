import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname } from "node:path";

export type IdempotencyClaim =
  | { kind: "new" | "replay" }
  | { kind: "blocked"; reason: "idempotency_key_reused_with_different_request" };

interface PersistedState {
  schemaVersion: "account-center.idempotency.v1";
  entries: Record<string, string>;
}

export class DurableIdempotencyStore {
  constructor(private readonly path: string, private readonly lockTimeoutMs = 1_000) {}

  async claim(key: string, requestDigest: string): Promise<IdempotencyClaim> {
    if (!key.trim() || !requestDigest.trim()) throw new Error("idempotency key and request digest are required");
    return this.withLock(async () => {
      const state = await this.read();
      const keyDigest = digest(key);
      const previous = state.entries[keyDigest];
      if (previous === requestDigest) return { kind: "replay" };
      if (previous) return { kind: "blocked", reason: "idempotency_key_reused_with_different_request" };
      state.entries[keyDigest] = requestDigest;
      await this.write(state);
      return { kind: "new" };
    });
  }

  private async read(): Promise<PersistedState> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!isState(parsed)) throw new Error("invalid idempotency state");
      return parsed;
    } catch (error: unknown) {
      if (isMissing(error)) return { schemaVersion: "account-center.idempotency.v1", entries: {} };
      throw error;
    }
  }

  private async write(state: PersistedState): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, this.path);
      await chmod(this.path, 0o600);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async withLock<T>(work: () => Promise<T>): Promise<T> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const lock = `${this.path}.lock`;
    const deadline = Date.now() + this.lockTimeoutMs;
    while (true) {
      try {
        await mkdir(lock, { mode: 0o700 });
        await chmod(lock, 0o700);
        break;
      } catch (error: unknown) {
        if (!isExists(error)) throw error;
        if (Date.now() >= deadline) throw new Error("idempotency_store_lock_timeout");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    try {
      return await work();
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }
}

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function isMissing(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT"; }
function isExists(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "EEXIST"; }
function isState(value: unknown): value is PersistedState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<PersistedState>;
  return candidate.schemaVersion === "account-center.idempotency.v1" && Boolean(candidate.entries) && typeof candidate.entries === "object" && !Array.isArray(candidate.entries) && Object.values(candidate.entries).every((entry) => typeof entry === "string");
}
