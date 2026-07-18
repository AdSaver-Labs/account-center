import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { AuditAction } from "./schemas.js";
import type { MutationScope } from "./mutation-contract.js";

/**
 * An in-process, executor-issued capability. Its verifier key is deliberately
 * module-private: adapters accept neither a secret nor a verifier through
 * constructor options, environment, or mutation input.
 */
const verifierSecret = randomBytes(32);
const capabilityBrand = Symbol("account-center.executor-route-capability");

export interface ExecutorRouteCapability {
  readonly [capabilityBrand]: string;
}

interface CapabilityBinding {
  action: AuditAction;
  target: string;
  provider: string;
  runtime: string;
  scope: MutationScope;
}

export function mintExecutorRouteCapability(binding: CapabilityBinding): ExecutorRouteCapability {
  const body = canonical(binding);
  return { [capabilityBrand]: createHmac("sha256", verifierSecret).update(body).digest("base64url") };
}

export function verifiesExecutorRouteCapability(value: unknown, binding: CapabilityBinding): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const signature = (value as Partial<ExecutorRouteCapability>)[capabilityBrand];
  if (typeof signature !== "string") return false;
  const expected = createHmac("sha256", verifierSecret).update(canonical(binding)).digest("base64url");
  return Buffer.byteLength(signature) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
