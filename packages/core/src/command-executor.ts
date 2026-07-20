import { AccountCenterStatus, AuditAction, AuditEvent, RuntimeKey } from "./schemas.js";
import { createReceipt, guardStatus, nextEligible } from "./policy.js";
import type { RuntimeAdapter } from "./runtime-adapters.js";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createMutationReview, MutationReview, MutationScope, verifyMutationApply } from "./mutation-contract.js";
import { MutationEvidence, MutationReceipt, MutationRepository, RouteScopeEvidence } from "./mutation-repository.js";
const routeCapabilitySecret = randomBytes(32);
const routeCapabilityBrand = Symbol("account-center.executor-route-capability");
type RouteCapabilityBinding = { action: AuditAction; target: string; provider: string; runtime: string; scope: MutationScope };
type ExecutorRouteCapability = { readonly [routeCapabilityBrand]: string };
// This minting closure is intentionally not exported: only a confirmed
// protected command lifecycle can issue a capability for an adapter apply.
function mintRouteCapability(binding: RouteCapabilityBinding): ExecutorRouteCapability { return { [routeCapabilityBrand]: createHmac("sha256", routeCapabilitySecret).update(canonicalCapability(binding)).digest("base64url") }; }
export function verifiesExecutorRouteCapability(value: unknown, binding: RouteCapabilityBinding): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const signature = (value as Partial<ExecutorRouteCapability>)[routeCapabilityBrand];
  const expected = createHmac("sha256", routeCapabilitySecret).update(canonicalCapability(binding)).digest("base64url");
  return typeof signature === "string" && Buffer.byteLength(signature) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
function canonicalCapability(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonicalCapability).join(",")}]`; if (value && typeof value === "object") { const record = value as Record<string, unknown>; return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalCapability(record[key])}`).join(",")}}`; } return JSON.stringify(value); }

export type AccountCenterCommand =
  | "status"
  | "guard"
  | "route.auto"
  | "route.use"
  | "route.remove"
  | "account.delete"
  | "account.enable"
  | "account.disable"
  | "model.enable"
  | "model.disable";

export interface CommandRequest {
  command: AccountCenterCommand;
  target?: string;
  provider?: string;
  runtime?: string;
  model?: string;
  apply?: boolean;
  receiptPath?: string;
  scope?: MutationScope;
  review?: MutationReview;
  reviewToken?: string;
  idempotencyKey?: string;
}

export interface CommandExecution {
  code: number;
  kind: "status" | "guard" | "mutation";
  status?: AccountCenterStatus;
  guard?: { ok: boolean; reason: string; next?: string };
  mutation?: { applied: boolean; dryRun: boolean; liveRuntimeMutation?: boolean; receipt: AuditEvent; [key: string]: unknown };
}

export async function executeAccountCenterCommand(request: CommandRequest, deps: { adapter: RuntimeAdapter; mutation?: { secret: string; repository: MutationRepository } }): Promise<CommandExecution> {
  const provider = request.provider ?? "openai";
  const runtime = request.runtime ?? "openclaw";
  const status = await deps.adapter.readStatus();
  if (request.command === "status") return { code: 0, kind: "status", status };
  if (request.command === "guard") return { code: guardStatus(status, provider, runtime, request.model).ok ? 0 : 2, kind: "guard", guard: guardStatus(status, provider, runtime, request.model) };

  const action: AuditAction = request.command as AuditAction;
  const target = resolveRouteTarget(status, action, request.target ?? (action === "route.auto" ? nextEligible(status, provider, runtime, request.model)?.profile.id : undefined), provider, runtime);
  if (["route.auto", "route.use", "route.remove"].includes(action) && !target) return { code: 2, kind: "mutation", mutation: blockedMutation(action, request.target, "canonical_route_target_required") };
  if (["route.auto", "route.use", "route.remove"].includes(action) && (provider !== "openai" || runtime !== "openclaw")) return { code: 2, kind: "mutation", mutation: blockedMutation(action, target, "openclaw_route_provider_runtime_required") };
  // The agent scope is an observed routing fact, not merely a well-formed
  // string. Validate it before creating a review or calling an adapter so a
  // stale public scope cannot acquire a capability through a preview.
  if (["route.auto", "route.use", "route.remove"].includes(action) && request.scope && !isObservedExactAgentScope(status, request.scope, provider, runtime)) return { code: 2, kind: "mutation", mutation: blockedMutation(action, target, "observed_agent_scope_required") };
  if (["route.auto", "route.use", "route.remove"].includes(action) && request.apply !== true && deps.mutation && request.scope && target) {
    const review = createMutationReview({ action, provider, runtime, scope: request.scope, target }, { secret: deps.mutation.secret });
    const preview = await deps.adapter.mutate({ action, target, apply: false, provider, runtime, receiptPath: request.receiptPath ?? ".account-center/receipts/executor.json", scope: request.scope });
    const payload = asMutation(preview.payload, action, target)!;
    return { code: preview.code, kind: "mutation", mutation: { ...payload, review, confirmationToken: encodeReview(review) } };
  }
  const authorization = await routeAuthorization(request, action, target, provider, runtime, deps.mutation);
  if (authorization.kind === "blocked") return { code: 2, kind: "mutation", mutation: blockedMutation(action, target, authorization.reason) };
  if (authorization.kind === "replay") return { code: authorization.receipt.outcome === "applied" ? 0 : 2, kind: "mutation", mutation: replayMutation(action, target, authorization.receipt) };
  const result = await deps.adapter.mutate({
    action,
    target,
    apply: request.apply === true,
    provider,
    runtime,
    receiptPath: request.receiptPath ?? ".account-center/receipts/executor.json",
    ...(authorization.kind === "confirmed" ? { routeCapability: mintRouteCapability({ action, target: target!, provider, runtime, scope: request.scope! }), scope: request.scope } : {})
  });
  const payload = asMutation(result.payload, action, target);
  if (authorization.kind === "confirmed") {
    const protectedPayload = payload!;
    const verified = isVerifiedApplied(protectedPayload);
    await deps.mutation!.repository.complete({ operationId: authorization.operationId, outcome: verified ? "applied" : "failed", warningCodes: verified ? ["fresh_read_after_write_verified"] : ["runtime_result_unproven"], evidence: redactedEvidence(protectedPayload) });
  }
  return { code: result.code, kind: "mutation", mutation: payload };
}

type RouteAuthorization = { kind: "none" } | { kind: "confirmed"; operationId: string } | { kind: "blocked"; reason: string } | { kind: "replay"; receipt: MutationReceipt };

async function routeAuthorization(request: CommandRequest, action: AuditAction, target: string | undefined, provider: string, runtime: string, lifecycle: { secret: string; repository: MutationRepository } | undefined): Promise<RouteAuthorization> {
  if (request.apply !== true || !["route.auto", "route.use", "route.remove"].includes(action)) return { kind: "none" };
  if (!lifecycle || !request.scope || !request.review || !request.reviewToken || !request.idempotencyKey || !target) return { kind: "blocked", reason: "route_apply_requires_confirmed_shared_mutation" };
  if (request.scope.kind !== "agent" || !/^[a-z][a-z0-9_-]{0,63}$/.test(request.scope.id) || request.scope.id === "all") return { kind: "blocked", reason: "explicit_agent_scope_required" };
  const verified = verifyMutationApply({ action, provider, runtime, scope: request.scope, target, review: request.review, reviewToken: request.reviewToken }, { secret: lifecycle.secret });
  if (verified.kind !== "confirmed") return { kind: "blocked", reason: verified.reason };
  const claim = await lifecycle.repository.claim({ idempotencyKey: request.idempotencyKey, requestDigest: verified.requestDigest, audit: { action, provider, runtime, scopeKind: request.scope.kind, scopeIdDigest: digest(request.scope.id), targetDigest: digest(target) } });
  return claim.kind === "execute" ? { kind: "confirmed", operationId: claim.operationId } : claim.kind === "replay" ? { kind: "replay", receipt: claim.receipt } : { kind: "blocked", reason: claim.reason };
}

function blockedMutation(action: AuditAction, target: string | undefined, reason: string): NonNullable<CommandExecution["mutation"]> {
  return { applied: false, dryRun: true, liveRuntimeMutation: false, receipt: createReceipt({ action, dryRun: true, target, summary: "Route apply was blocked before the runtime adapter because the protected mutation lifecycle was not confirmed.", warnings: [reason] }), reason };
}

function replayMutation(action: AuditAction, target: string | undefined, receipt: MutationReceipt): NonNullable<CommandExecution["mutation"]> {
  const historicalLiveRuntimeMutation = receipt.evidence?.liveRuntimeMutation === true;
  const historicalVerification = receipt.evidence?.verification ?? "unproven";
  return { applied: false, dryRun: true, liveRuntimeMutation: false, replayed: true, historicalOutcome: receipt.outcome, historicalLiveRuntimeMutation, historicalVerification, operationId: receipt.operationId, receipt: createReceipt({ action, dryRun: true, target, summary: "Replayed immutable protected mutation result; no current runtime mutation was attempted.", warnings: ["idempotency_replay", "historical_outcome"] }) };
}

function resolveRouteTarget(status: AccountCenterStatus, action: AuditAction, requested: string | undefined, provider: string, runtime: string): string | undefined {
  if (!requested || requested.startsWith("-") || /\s/.test(requested)) return undefined;
  // Route actions accept only an exactly observed canonical profile id, before
  // a review is minted, so the native argv builder never receives a user
  // operand that could alter its option shape.
  const matches = status.profiles.filter((profile) =>
    profile.provider === provider &&
    profile.runtimeCompatibility.includes(runtime as RuntimeKey) &&
    profile.id === requested
  );
  return matches.length === 1 ? matches[0]!.id : undefined;
}

function isExactAgentScope(scope: MutationScope): boolean { return scope.kind === "agent" && /^[a-z][a-z0-9_-]{0,63}$/.test(scope.id) && scope.id !== "all"; }
function isObservedExactAgentScope(status: AccountCenterStatus, scope: MutationScope, provider: string, runtime: string): boolean {
  return isExactAgentScope(scope) && status.routes.some((route) => route.provider === provider && route.runtime === runtime && route.scope === `agent:${scope.id}`);
}

function encodeReview(review: MutationReview): string { return `${Buffer.from(JSON.stringify(review)).toString("base64url")}.${review.token}`; }
export function decodeConfirmationToken(token: string): MutationReview | undefined {
  const [body, signature, ...rest] = token.split("."); if (!body || !signature || rest.length) return undefined;
  try { const review = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as MutationReview; return review.token === signature ? review : undefined; } catch { return undefined; }
}
function redactedEvidence(payload: NonNullable<CommandExecution["mutation"]>): MutationEvidence {
  const verification = isVerifiedApplied(payload) ? "verified" as const : "unproven" as const;
  const proof = persistedProof(payload.proof);
  return {
    receiptId: payload.receipt.id,
    verification,
    liveRuntimeMutation: payload.liveRuntimeMutation === true,
    ...(verification === "verified" && proof ? { proof } : {})
  };
}

function isVerifiedApplied(payload: NonNullable<CommandExecution["mutation"]>): boolean {
  return payload.applied === true && payload.liveRuntimeMutation === true && isRecord(payload.verification) && payload.verification.kind === "verified";
}

function persistedProof(value: unknown): MutationEvidence["proof"] | undefined {
  if (!isRecord(value) || !isRecord(value.nativeEvent) || !isRecord(value.verification) || !isRecord(value.verification.before) || !isRecord(value.verification.after)) return undefined;
  const native = value.nativeEvent;
  const verification = value.verification;
  const beforeValue = verification.before;
  const afterValue = verification.after;
  if (!isRecord(beforeValue) || !isRecord(afterValue)) return undefined;
  const before = boundedScopeEvidence(beforeValue);
  const after = boundedScopeEvidence(afterValue);
  if ((native.action !== "route.auto" && native.action !== "route.use" && native.action !== "route.remove") || typeof native.scopeId !== "string" || typeof native.targetId !== "string" || native.status !== "verified" || typeof verification.scopeId !== "string" || verification.scopeId !== native.scopeId || !before || !after) return undefined;
  return { nativeEvent: { action: native.action, scopeId: native.scopeId, targetId: native.targetId, status: "verified" }, verification: { scopeId: verification.scopeId, before, after } };
}
function boundedScopeEvidence(value: Record<string, unknown>): RouteScopeEvidence | undefined {
  const activeTargetId = typeof value.activeTargetId === "string" ? value.activeTargetId : undefined;
  if ((value.status !== "observed" && value.status !== "absent") || !Array.isArray(value.orderTargetIds) || value.orderTargetIds.length > 10 || !value.orderTargetIds.every((item) => typeof item === "string")) return undefined;
  return { status: value.status, ...(activeTargetId ? { activeTargetId } : {}), orderTargetIds: [...value.orderTargetIds] };
}

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function asMutation(value: unknown, action: AuditAction, target?: string): CommandExecution["mutation"] {
  if (isRecord(value) && isRecord(value.receipt)) return value as CommandExecution["mutation"];
  return {
    applied: false,
    dryRun: true,
    liveRuntimeMutation: false,
    receipt: createReceipt({ action, dryRun: true, target, summary: "Runtime returned an unstructured mutation result.", warnings: ["unstructured_runtime_result"] })
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
