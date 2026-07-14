import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { AuthChallenge, AuthChallengeInput, cancelAuthChallenge, createAuthChallenge, getAuthChallenge } from "./auth-challenges.js";

export class AuthChallengeStore {
  constructor(private readonly path: string) {}

  async create(input: AuthChallengeInput): Promise<AuthChallenge> {
    const challenges = await this.list();
    const challenge = createAuthChallenge(input, challenges);
    if (!challenges.some((item) => item.id === challenge.id)) await this.write([...challenges, challenge]);
    return challenge;
  }

  async list(): Promise<AuthChallenge[]> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!Array.isArray(value)) return [];
      const challenges = value.filter(isChallenge).map(redactChallenge);
      if (value.some(hasRawTarget)) await this.write(challenges);
      return challenges;
    } catch (error: unknown) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  async get(id: string): Promise<AuthChallenge | undefined> { return getAuthChallenge(await this.list(), id); }

  async cancel(id: string): Promise<AuthChallenge | undefined> {
    const challenges = await this.list();
    const index = challenges.findIndex((item) => item.id === id);
    if (index < 0) return undefined;
    const cancelled = cancelAuthChallenge(challenges[index]);
    challenges[index] = cancelled;
    await this.write(challenges);
    return cancelled;
  }

  private async write(challenges: AuthChallenge[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(challenges, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }
}

function isMissing(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT"; }
function isChallenge(value: unknown): value is AuthChallenge {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<AuthChallenge>;
  return typeof candidate.id === "string" && typeof candidate.key === "string" && typeof candidate.mode === "string" && typeof candidate.status === "string" && typeof candidate.provider === "string" && typeof candidate.runtime === "string" && typeof candidate.scope === "string" && typeof candidate.createdAt === "string" && typeof candidate.updatedAt === "string";
}

function hasRawTarget(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "target" in value;
}

function redactChallenge({ id, key, mode, status, provider, runtime, scope, expiresAt, createdAt, updatedAt }: AuthChallenge): AuthChallenge {
  return { id, key, mode, status, provider, runtime, scope, ...(expiresAt ? { expiresAt } : {}), createdAt, updatedAt };
}
