import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { AuthChallenge, AuthChallengeInput, cancelAuthChallenge, createAuthChallenge, expireAuthChallenge, getAuthChallenge } from "./auth-challenges.js";

export class AuthChallengeStore {
  private readonly lockPath: string;

  constructor(private readonly path: string) { this.lockPath = `${path}.lock`; }

  async create(input: AuthChallengeInput): Promise<AuthChallenge> {
    return this.withLock(async () => {
      const challenges = await this.listUnsafe();
      const challenge = createAuthChallenge(input, challenges);
      if (!challenges.some((item) => item.id === challenge.id)) await this.write([...challenges, challenge]);
      return challenge;
    });
  }

  async list(): Promise<AuthChallenge[]> { return this.withLock(() => this.listUnsafe()); }

  private async listUnsafe(): Promise<AuthChallenge[]> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path, "utf8"));
      // Durable lifecycle evidence must never be silently treated as an empty
      // history when it is corrupt. In particular, an unknown terminal state
      // could otherwise be rendered as an innocuous empty list or an
      // unrecognized UI success-like state.
      if (!Array.isArray(value) || !value.every(isChallenge)) throw new Error("challenge_store_corrupt");
      const redacted = value.filter(isChallenge).map(redactChallenge);
      const challenges = redacted.map((challenge) => expireAuthChallenge(challenge));
      if (value.some(hasRawTarget) || challenges.some((challenge, index) => challenge.status !== redacted[index]?.status)) await this.write(challenges);
      return challenges;
    } catch (error: unknown) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  async get(id: string): Promise<AuthChallenge | undefined> { return getAuthChallenge(await this.list(), id); }

  async cancel(id: string): Promise<AuthChallenge | undefined> {
    return (await this.cancelWithResult(id))?.challenge;
  }

  /**
   * Atomically reports whether cancellation changed a pending challenge. The
   * protected API uses this to make retries safe without duplicating audit
   * evidence for an already-terminal lifecycle record.
   */
  async cancelWithResult(id: string): Promise<{ challenge: AuthChallenge; changed: boolean } | undefined> {
    return this.withLock(async () => {
      const challenges = await this.listUnsafe();
      const index = challenges.findIndex((item) => item.id === id);
      if (index < 0) return undefined;
      const before = challenges[index];
      const cancelled = cancelAuthChallenge(challenges[index]);
      challenges[index] = cancelled;
      const changed = before.status !== cancelled.status;
      if (changed) await this.write(challenges);
      return { challenge: cancelled, changed };
    });
  }

  private async write(challenges: AuthChallenge[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(challenges, null, 2)}\n`, "utf8");
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
function isChallenge(value: unknown): value is AuthChallenge {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<AuthChallenge>;
  return typeof candidate.id === "string" &&
    typeof candidate.key === "string" &&
    (candidate.mode === "add" || candidate.mode === "reauth") &&
    (candidate.status === "pending" || candidate.status === "completed" || candidate.status === "failed" || candidate.status === "cancelled" || candidate.status === "expired") &&
    typeof candidate.provider === "string" &&
    typeof candidate.runtime === "string" &&
    typeof candidate.scope === "string" &&
    isTimestamp(candidate.createdAt) &&
    isTimestamp(candidate.updatedAt) &&
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

function redactChallenge({ id, key, mode, status, provider, runtime, scope, expiresAt, createdAt, updatedAt }: AuthChallenge): AuthChallenge {
  return { id, key, mode, status, provider, runtime, scope, ...(expiresAt ? { expiresAt } : {}), createdAt, updatedAt };
}
