import { randomBytes } from "node:crypto";

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

export interface NativeAuthHandoffRegistryOptions {
  now?: () => number;
  ttlMs?: number;
  maxEntries?: number;
  randomId?: () => string;
}

/** Listener-local, bounded, single-use opaque handoff references. */
export class NativeAuthHandoffRegistry {
  private readonly handoffs = new Map<string, number>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly randomId: () => string;

  constructor(options: NativeAuthHandoffRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
    this.maxEntries = options.maxEntries ?? 128;
    this.randomId = options.randomId ?? (() => `handoff_${randomBytes(24).toString("base64url")}`);
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1 || !Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1) throw new Error("invalid native handoff registry bounds");
  }

  issue(): string {
    this.prune();
    while (this.handoffs.size >= this.maxEntries) this.handoffs.delete(this.handoffs.keys().next().value as string);
    let id = this.randomId();
    while (this.handoffs.has(id)) id = this.randomId();
    this.handoffs.set(id, this.now() + this.ttlMs);
    return id;
  }

  consume(id: string): boolean {
    this.prune();
    if (!this.handoffs.has(id)) return false;
    this.handoffs.delete(id);
    return true;
  }

  private prune(): void {
    const now = this.now();
    for (const [id, expiresAt] of this.handoffs) if (expiresAt <= now) this.handoffs.delete(id);
  }
}

export function isNativeAuthHandoffPreflightInput(value: unknown): value is NativeAuthHandoffPreflightInput {
  if (!isRecord(value) || Object.keys(value).sort().join("\0") !== ["idempotencyKey", "provider", "runtime", "scope"].join("\0")) return false;
  return value.runtime === "openclaw" && value.provider === "openai" && value.scope === "default" &&
    typeof value.idempotencyKey === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value.idempotencyKey);
}

export function nativeAuthHandoffPreflightView(handoffId: string): NativeAuthHandoffPreflightView {
  return { schemaVersion: "account-center.native-auth-handoff-preflight.v1", handoffId, state: "handoff_required", verificationState: "UNPROVEN", instruction: "Complete the provider's native OpenClaw sign-in outside Account Center, then recheck." };
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
