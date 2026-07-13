import { AccountCenterStatus, AuditAction, AuditEvent } from "./schemas.js";
import { createReceipt, guardStatus, nextEligible } from "./policy.js";
import { RuntimeAdapter } from "./runtime-adapters.js";

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
}

export interface CommandExecution {
  code: number;
  kind: "status" | "guard" | "mutation";
  status?: AccountCenterStatus;
  guard?: { ok: boolean; reason: string; next?: string };
  mutation?: { applied: boolean; dryRun: boolean; liveRuntimeMutation?: boolean; receipt: AuditEvent; [key: string]: unknown };
}

export async function executeAccountCenterCommand(request: CommandRequest, deps: { adapter: RuntimeAdapter }): Promise<CommandExecution> {
  const provider = request.provider ?? "openai";
  const runtime = request.runtime ?? "openclaw";
  const status = await deps.adapter.readStatus();
  if (request.command === "status") return { code: 0, kind: "status", status };
  if (request.command === "guard") return { code: guardStatus(status, provider, runtime, request.model).ok ? 0 : 2, kind: "guard", guard: guardStatus(status, provider, runtime, request.model) };

  const action: AuditAction = request.command as AuditAction;
  const target = action === "route.auto" ? request.target ?? nextEligible(status, provider, runtime, request.model)?.profile.id : request.target;
  const result = await deps.adapter.mutate({
    action,
    target,
    apply: request.apply === true,
    provider,
    runtime,
    receiptPath: request.receiptPath ?? ".account-center/receipts/executor.json"
  });
  const payload = asMutation(result.payload, action, target);
  return { code: result.code, kind: "mutation", mutation: payload };
}

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
