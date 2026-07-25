import type { ProviderKey } from "./schemas.js";

/**
 * Provider-family aliases are compatibility input only. Account Center emits
 * the canonical family everywhere, so a legacy Hermes `openai-codex:*`
 * reference can never create a second identity beside OpenClaw `openai:*`.
 */
const CANONICAL_PROVIDER_FAMILIES: Readonly<Record<string, ProviderKey>> = {
  openai: "openai",
  "openai-codex": "openai"
};

export function canonicalProviderFamily(value: string): ProviderKey {
  const normalized = value.trim().toLowerCase();
  return CANONICAL_PROVIDER_FAMILIES[normalized] ?? (normalized as ProviderKey);
}

/** Maps a declared provider-family prefix only; the account suffix is never inferred. */
export function canonicalProfileId(value: string, fallbackProvider?: ProviderKey): string {
  const trimmed = value.trim();
  const separator = trimmed.indexOf(":");
  if (separator <= 0 || separator === trimmed.length - 1) return trimmed;
  const family = canonicalProviderFamily(trimmed.slice(0, separator));
  if (family !== "openai" && fallbackProvider && family !== fallbackProvider) return trimmed;
  return `${family}:${trimmed.slice(separator + 1)}`;
}

export function sameCanonicalProviderFamily(left: string, right: string): boolean {
  return canonicalProviderFamily(left) === canonicalProviderFamily(right);
}
