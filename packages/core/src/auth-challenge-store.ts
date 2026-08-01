import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { AuthChallenge, AuthChallengeInput, cancelAuthChallenge, createAuthChallenge, expireAuthChallenge, getAuthChallenge, isSafePublicChallengeMetadata } from "./auth-challenges.js";
import { verifyReauthProof } from "./reauth-proof.js";

export class AuthChallengeStore {
  private readonly lockPath: string;

  constructor(private readonly path: string) { this.lockPath = `${path}.lock`; }

  async create(input: AuthChallengeInput): Promise<AuthChallenge> {
    return (await this.createWithResult(input)).challenge;
  }

  /** Reports whether an active challenge was created or durably reused. */
  async createWithResult(input: AuthChallengeInput): Promise<{ challenge: AuthChallenge; created: boolean }> {
    return this.withLock(async () => {
      const challenges = await this.listUnsafe();
      const challenge = createAuthChallenge(input, challenges);
      const created = !challenges.some((item) => item.id === challenge.id);
      if (created) await this.writeUnsafe([...challenges, challenge]);
      return { challenge, created };
    });
  }

  async list(): Promise<AuthChallenge[]> { return this.withLock(() => this.listUnsafe()); }

  /**
   * Public history/detail endpoints must not turn a GET into durable lifecycle
   * maintenance. This validates and redacts the same bounded record shape as
   * list(), but projects elapsed challenges in memory only. Explicit lifecycle
   * operations remain responsible for any durable expiry transition.
   */
  async listReadOnly(): Promise<AuthChallenge[]> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path, "utf8"));
      assertDurableChallenges(value, "challenge_store_corrupt", true);
      return value.map(redactChallenge).map((challenge) => expireAuthChallenge(challenge));
    } catch (error: unknown) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  private async listUnsafe(): Promise<AuthChallenge[]> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path, "utf8"));
      // This is a durable trust boundary, not merely a decoder. Historical
      // terminal/proof-bearing files are rejected in place rather than being
      // overwritten as a harmless-looking lifecycle history.
      assertDurableChallenges(value, "challenge_store_corrupt", true);
      const redacted = value.map(redactChallenge);
      const challenges = redacted.map((challenge) => expireAuthChallenge(challenge));
      // We already own lockPath. Re-entering write() would deadlock, so only
      // locked lifecycle code may use this lexical unsafe writer.
      if (value.some(hasRawTarget) || challenges.some((challenge, index) => challenge.status !== redacted[index]?.status)) await this.writeUnsafe(challenges);
      return challenges;
    } catch (error: unknown) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  async get(id: string): Promise<AuthChallenge | undefined> { return getAuthChallenge(await this.list(), id); }

  /** See listReadOnly(): never acquire a lifecycle lock or write from a GET. */
  async getReadOnly(id: string): Promise<AuthChallenge | undefined> { return getAuthChallenge(await this.listReadOnly(), id); }

  async cancel(id: string): Promise<AuthChallenge | undefined> {
    return (await this.cancelWithResult(id))?.challenge;
  }

  /** Atomically reports whether cancellation changed a pending challenge. */
  async cancelWithResult(id: string): Promise<{ challenge: AuthChallenge; changed: boolean } | undefined> {
    return this.withLock(async () => {
      const challenges = await this.listUnsafe();
      const index = challenges.findIndex((item) => item.id === id);
      if (index < 0) return undefined;
      const before = challenges[index];
      const cancelled = cancelAuthChallenge(challenges[index]);
      challenges[index] = cancelled;
      const changed = before.status !== cancelled.status;
      if (changed) await this.writeUnsafe(challenges);
      return { challenge: cancelled, changed };
    });
  }

  /** The only terminal transition: validate and discard proof under the lifecycle lock. */
  async completeReauthWithProof(id: string, proof: unknown, now = new Date()): Promise<{ kind: "completed" | "failed" | "unchanged" | "not_found"; challenge?: AuthChallenge }> {
    return this.withLock(async () => {
      const challenges = await this.listUnsafe();
      const index = challenges.findIndex((item) => item.id === id);
      if (index < 0) return { kind: "not_found" };
      const challenge = expireAuthChallenge(challenges[index]!, now);
      if (challenge.status !== "pending") {
        if (challenge.status !== challenges[index]!.status) { challenges[index] = challenge; await this.writeUnsafe(challenges); }
        return { kind: "unchanged", challenge };
      }
      if (verifyReauthProof(challenge, proof, { now }).kind !== "verified") return { kind: "unchanged", challenge };
      const kind = (proof as { result: "completed" | "failed" }).result;
      const terminal: AuthChallenge = { ...challenge, status: kind, updatedAt: now.toISOString() };
      challenges[index] = terminal;
      await this.writeUnsafe(challenges);
      return { kind, challenge: terminal };
    });
  }

  /**
   * TypeScript privacy and package export maps do not protect compiled JS.
   * Validate before any mkdir/temporary-file mutation, then acquire the same
   * canonical lock used by lifecycle operations and validate again under it.
   */
  private async write(challenges: AuthChallenge[]): Promise<void> {
    assertDurableChallenges(challenges, "challenge_store_unsafe_lifecycle", false);
    return this.withLock(async () => {
      // The caller can mutate its array while waiting for the lock.
      assertDurableChallenges(challenges, "challenge_store_unsafe_lifecycle", false);
      await this.writeUnsafe(challenges);
    });
  }

  /** Caller must own lockPath and have validated the bounded durable shape. */
  private async writeUnsafe(challenges: AuthChallenge[]): Promise<void> {
    const durable = challenges.map(redactChallenge);
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(durable, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.path);
    } finally {
      await handle?.close();
      await rm(temporary, { force: true });
    }
  }

  private async withLock<T>(work: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await mkdir(this.lockPath, { mode: 0o700 });
        try { return await work(); } finally { await rm(this.lockPath, { recursive: true, force: true }); }
      } catch (error: unknown) {
        if (!isExists(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    throw new Error("challenge_store_locked");
  }
}

function isMissing(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT"; }
function isExists(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "EEXIST"; }
const durableChallengeKeys = new Set(["id", "key", "mode", "status", "provider", "runtime", "scope", "expiresAt", "createdAt", "updatedAt"]);
const legacyChallengeKeys = new Set([...durableChallengeKeys, "target"]);

function assertDurableChallenges(value: unknown, error: string, allowLegacyTarget: boolean): asserts value is AuthChallenge[] {
  if (!Array.isArray(value) || !value.every((challenge) => isDurableChallenge(challenge, allowLegacyTarget))) throw new Error(error);
}

function isDurableChallenge(value: unknown, allowLegacyTarget: boolean): value is AuthChallenge {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<AuthChallenge>;
  const allowedKeys = allowLegacyTarget ? legacyChallengeKeys : durableChallengeKeys;
  return Object.keys(candidate).every((key) => allowedKeys.has(key)) &&
    hasOwn(candidate, "id") && typeof candidate.id === "string" &&
    hasOwn(candidate, "key") && typeof candidate.key === "string" &&
    hasOwn(candidate, "mode") && (candidate.mode === "add" || candidate.mode === "reauth") &&
    hasOwn(candidate, "status") && (candidate.status === "pending" || candidate.status === "completed" || candidate.status === "failed" || candidate.status === "cancelled" || candidate.status === "expired") &&
    hasOwn(candidate, "provider") && typeof candidate.provider === "string" &&
    hasOwn(candidate, "runtime") && typeof candidate.runtime === "string" &&
    hasOwn(candidate, "scope") && typeof candidate.scope === "string" &&
    isSafePublicChallengeMetadata(candidate as Pick<AuthChallenge, "provider" | "runtime" | "scope">) &&
    hasOwn(candidate, "createdAt") && isTimestamp(candidate.createdAt) &&
    hasOwn(candidate, "updatedAt") && isTimestamp(candidate.updatedAt) &&
    (candidate.expiresAt === undefined || isTimestamp(candidate.expiresAt));
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function hasRawTarget(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "target" in value;
}

function hasOwn(value: object, key: string): boolean { return Object.prototype.hasOwnProperty.call(value, key); }

function redactChallenge({ id, key, mode, status, provider, runtime, scope, expiresAt, createdAt, updatedAt }: AuthChallenge): AuthChallenge {
  return { id, key, mode, status, provider, runtime, scope, ...(expiresAt ? { expiresAt } : {}), createdAt, updatedAt };
}
