import { createHash } from "node:crypto";

/** Public, instruction-only OpenClaw native sign-in handoff. It has no login or credential authority. */
export interface NativeAuthHandoffPreflightInput {
  runtime: "openclaw";
  provider: "openai";
  scope: "default";
  idempotencyKey: string;
}

export interface NativeAuthHandoffPreflightView {
  schemaVersion: "account-center.native-auth-handoff-preflight.v1";
  handoffId: string;
  state: "handoff_required";
  verificationState: "UNPROVEN";
  instruction: "Complete the provider's native OpenClaw sign-in outside Account Center, then recheck.";
}

export function isNativeAuthHandoffPreflightInput(value: unknown): value is NativeAuthHandoffPreflightInput {
  if (!isRecord(value) || Object.keys(value).sort().join("\0") !== ["idempotencyKey", "provider", "runtime", "scope"].join("\0")) return false;
  return value.runtime === "openclaw" && value.provider === "openai" && value.scope === "default" &&
    typeof value.idempotencyKey === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value.idempotencyKey);
}

/** Opaque deterministic reference; the idempotency key itself never leaves this boundary. */
export function nativeAuthHandoffId(input: NativeAuthHandoffPreflightInput): string {
  return `handoff_${createHash("sha256").update(`openclaw\0openai\0default\0${input.idempotencyKey}`).digest("hex").slice(0, 32)}`;
}

export function nativeAuthHandoffPreflightView(input: NativeAuthHandoffPreflightInput): NativeAuthHandoffPreflightView {
  return { schemaVersion: "account-center.native-auth-handoff-preflight.v1", handoffId: nativeAuthHandoffId(input), state: "handoff_required", verificationState: "UNPROVEN", instruction: "Complete the provider's native OpenClaw sign-in outside Account Center, then recheck." };
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
