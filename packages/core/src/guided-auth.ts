import type { AuthChallengeInput } from "./auth-challenges.js";
import type { AccountCenterStatus } from "./schemas.js";

export type GuidedAuthStartInput = Pick<AuthChallengeInput, "mode" | "provider" | "runtime" | "scope" | "target">;

/** Local intent creation only; it does not mutate an adapter or credentials. */
export function isValidGuidedAuthStart(status: AccountCenterStatus, input: unknown): input is GuidedAuthStartInput {
  if (!isRecord(input)) return false;
  if (Object.keys(input).sort().join("\0") !== ["mode", "provider", "runtime", "scope", "target"].join("\0")) return false;
  if ((input.mode !== "add" && input.mode !== "reauth") || typeof input.provider !== "string" || typeof input.runtime !== "string" || typeof input.scope !== "string" || typeof input.target !== "string") return false;
  const provider = input.provider.trim().toLowerCase();
  const runtime = input.runtime.trim().toLowerCase();
  return input.provider === provider && input.runtime === runtime && input.scope === "default" &&
    isEmailTarget(input.target) &&
    status.providers.some((candidate) => candidate.key === provider) &&
    status.runtimes.some((candidate) => candidate.key === runtime);
}

export function isEmailTarget(value: string): boolean {
  return value === value.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
