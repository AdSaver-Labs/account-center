import { AccountCenterStatus, AuditAction, AuditEvent } from "./schemas.js";
import { createReceipt, guardStatus, nextEligible } from "./policy.js";
import { RuntimeAdapter } from "./runtime-adapters.js";
import { createHash } from "node:crypto";
import { MutationReview, MutationScope, verifyMutationApply } from "./mutation-contract.js";
import { MutationRepository } from "./mutation-repository.js";

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
  const target = action === "route.auto" ? request.target ?? nextEligible(status, provider, runtime, request.model)?.profile.id : request.target;
  const authorization = await routeAuthorization(request, action, target, provider, runtime, deps.mutation);
  if (authorization.kind === "blocked") return { code: 2, kind: "mutation", mutation: blockedMutation(action, target, authorization.reason) };
  if (authorization.kind === "replay") return { code: authorization.receipt.outcome === "applied" ? 0 : 2, kind: "mutation", mutation: replayMutation(action, target, authorization.receipt.outcome) };
  const result = await deps.adapter.mutate({
    action,
    target,
    apply: request.apply === true,
    provider,
    runtime,
    receiptPath: request.receiptPath ?? ".account-center/receipts/executor.json",
    ...(authorization.kind === "confirmed" ? { authorized: true, scope: request.scope } : {})
  });
  const payload = asMutation(result.payload, action, target);
  if (authorization.kind === "confirmed") {
    const protectedPayload = payload!;
    await deps.mutation!.repository.complete({ operationId: authorization.operationId, outcome: protectedPayload.applied === true ? "applied" : "failed", warningCodes: protectedPayload.applied === true ? ["fresh_read_after_write_verified"] : ["runtime_result_unproven"] });
  }
  return { code: result.code, kind: "mutation", mutation: payload };
}

type RouteAuthorization = { kind: "none" } | { kind: "confirmed"; operationId: string } | { kind: "blocked"; reason: string } | { kind: "replay"; receipt: { outcome: "applied" | "not_applied" | "blocked" | "failed" } };

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

function replayMutation(action: AuditAction, target: string | undefined, outcome: "applied" | "not_applied" | "blocked" | "failed"): NonNullable<CommandExecution["mutation"]> {
  const applied = outcome === "applied";
  return { applied, dryRun: !applied, liveRuntimeMutation: applied, receipt: createReceipt({ action, dryRun: !applied, target, summary: "Replayed immutable protected mutation result.", warnings: ["idempotency_replay"] }) };
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
