/**
 * Stable, deliberately narrow identifiers permitted in the public model
 * catalog. Runtime evidence may only select from this policy; it cannot add
 * arbitrary identifiers to a protected response.
 */
export const PUBLIC_MODEL_ALLOWLIST = Object.freeze([
  "openai/gpt-4.1",
  "openai/gpt-5.3-codex",
  "openai/gpt-5.5"
] as const);

export function isPublicModelId(value: string): value is (typeof PUBLIC_MODEL_ALLOWLIST)[number] {
  return (PUBLIC_MODEL_ALLOWLIST as readonly string[]).includes(value);
}

/** Trusted OpenClaw normalization defaults, kept beside the public policy to avoid duplicate IDs drifting. */
export const DEFAULT_OPENCLAW_OBSERVED_MODEL_IDS = Object.freeze([
  "openai/gpt-5.5",
  "openai/gpt-5.3-codex"
] as const);
