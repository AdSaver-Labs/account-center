import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { MutationScopeKind } from "./mutation-contract.js";

export type MutationOutcome = "applied" | "not_applied" | "blocked" | "failed";
export interface MutationAudit {
  action: string;
  provider: string;
  runtime: string;
  scopeKind: MutationScopeKind;
  scopeIdDigest: string;
  targetDigest: string;
}
export interface MutationReceipt {
  schemaVersion: "account-center.mutation-receipt.v1";
  operationId: string;
  requestDigest: string;
  idempotencyKeyDigest: string;
  state: "completed";
  outcome: MutationOutcome;
  createdAt: string;
  completedAt: string;
  audit: MutationAudit & { warningCodes: string[] };
  evidence?: MutationEvidence;
}
export interface MutationEvidence {
  receiptId: string;
  verification: "verified" | "unproven";
  /** Whether the historical operation reached a native runtime invocation. */
  liveRuntimeMutation?: boolean;
  /** Credential-blind terminal categories for a reauthentication transaction. */
  reauth?: ReauthReceiptEvidence;
  proof?: {
    nativeEvent: { action: string; scopeId: string; targetId: string; status: "verified" };
    verification: {
      scopeId: string;
      before: RouteScopeEvidence;
      after: RouteScopeEvidence;
    };
  };
}
export interface ReauthReceiptEvidence {
  verification: "verified" | "failed" | "unproven";
  route: "not_requested" | "applied" | "not_applied" | "unproven";
}
export interface RouteScopeEvidence {
  status: "observed" | "absent";
  activeTargetId?: string;
  orderTargetIds: string[];
}
export interface MutationOperationView {
  operationId: string;
  state: "pending" | "completed";
  createdAt: string;
  completedAt?: string;
  outcome?: MutationOutcome;
  audit: Pick<MutationAudit, "action" | "provider" | "runtime" | "scopeKind"> & { warningCodes: string[] };
}
export type MutationClaim =
  | { kind: "execute"; operationId: string }
  | { kind: "replay"; operationId: string; outcome: MutationOutcome; receipt: MutationReceipt }
  | { kind: "blocked"; reason: "idempotency_key_reused_with_different_request" | "operation_outcome_unknown" };
export interface MutationRepositoryDependencies { now?: () => Date; operationId?: () => string; }
interface PendingOperation { operationId: string; idempotencyKeyDigest: string; requestDigest: string; state: "pending"; createdAt: string; audit: MutationAudit; }
interface CompletedOperation { receipt: MutationReceipt; }
type Operation = PendingOperation | CompletedOperation;
interface State { schemaVersion: "account-center.mutation-repository.v1"; operations: Operation[]; }

export class MutationRepository {
  private readonly statePath: string;
  private readonly lockPath: string;
  private readonly now: () => Date;
  private readonly operationId: () => string;
  constructor(private readonly root: string, dependencies: MutationRepositoryDependencies = {}) {
    this.statePath = join(root, "mutation-repository.v1.json");
    this.lockPath = join(root, "write.lock");
    this.now = dependencies.now ?? (() => new Date());
    this.operationId = dependencies.operationId ?? (() => `op_${randomUUID()}`);
  }

  async claim(input: { idempotencyKey: string; requestDigest: string; audit: MutationAudit }): Promise<MutationClaim> {
    assertKey(input.idempotencyKey);
    assertDigest(input.requestDigest); assertAudit(input.audit);
    return this.withLock(async () => {
      const state = await this.read();
      const keyDigest = digest(input.idempotencyKey);
      const existing = state.operations.find((operation) => operationKeyDigest(operation) === keyDigest);
      if (existing) {
        if (operationRequestDigest(existing) !== input.requestDigest) return { kind: "blocked", reason: "idempotency_key_reused_with_different_request" };
        if (isCompleted(existing)) return { kind: "replay", operationId: existing.receipt.operationId, outcome: existing.receipt.outcome, receipt: existing.receipt };
        return { kind: "blocked", reason: "operation_outcome_unknown" };
      }
      const operation: PendingOperation = { operationId: this.operationId(), idempotencyKeyDigest: keyDigest, requestDigest: input.requestDigest, state: "pending", createdAt: this.now().toISOString(), audit: input.audit };
      if (!/^op_[A-Za-z0-9_-]{1,100}$/.test(operation.operationId)) throw new Error("invalid operation id");
      state.operations.push(operation); await this.write(state);
      return { kind: "execute", operationId: operation.operationId };
    });
  }

  async complete(input: { operationId: string; outcome: MutationOutcome; warningCodes?: string[]; evidence?: MutationEvidence }): Promise<MutationReceipt> {
    assertIdentifier(input.operationId); assertOutcome(input.outcome); const warningCodes = validateWarnings(input.warningCodes ?? []);
    return this.withLock(async () => {
      const state = await this.read();
      const index = state.operations.findIndex((operation) => operationId(operation) === input.operationId);
      if (index < 0) throw new Error("operation_not_found");
      const existing = state.operations[index];
      if (isCompleted(existing)) {
        if (existing.receipt.outcome === input.outcome && equalWarnings(existing.receipt.audit.warningCodes, warningCodes)) return existing.receipt;
        throw new Error("immutable_receipt_conflict");
      }
      const evidence = validateEvidence(input.evidence, input.outcome, warningCodes);
      const receipt: MutationReceipt = { schemaVersion: "account-center.mutation-receipt.v1", operationId: existing.operationId, requestDigest: existing.requestDigest, idempotencyKeyDigest: existing.idempotencyKeyDigest, state: "completed", outcome: input.outcome, createdAt: existing.createdAt, completedAt: this.now().toISOString(), audit: { ...existing.audit, warningCodes }, ...(evidence ? { evidence } : {}) };
      state.operations[index] = { receipt }; await this.write(state); return receipt;
    });
  }

  async list(): Promise<MutationOperationView[]> {
    return this.withLock(async () => (await this.read()).operations.map(operationView));
  }

  private async withLock<T>(work: () => Promise<T>): Promise<T> {
    await mkdir(this.root, { recursive: true, mode: 0o700 }); await chmod(this.root, 0o700); await assertPrivateDirectory(this.root);
    try { await mkdir(this.lockPath, { mode: 0o700 }); } catch (error: unknown) { if (isExists(error)) throw new Error("repository_locked"); throw error; }
    try { return await work(); } finally { await rm(this.lockPath, { recursive: true, force: true }); }
  }
  private async read(): Promise<State> {
    try { await assertPrivateFile(this.statePath); const parsed: unknown = JSON.parse(await readFile(this.statePath, "utf8")); if (!isState(parsed)) throw new Error("repository_corrupt"); return parsed; }
    catch (error: unknown) { if (isMissing(error)) return { schemaVersion: "account-center.mutation-repository.v1", operations: [] }; if (error instanceof SyntaxError) throw new Error("repository_corrupt"); throw error; }
  }
  private async write(state: State): Promise<void> {
    const temporary = join(this.root, `.mutation-repository.${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try { handle = await open(temporary, "wx", 0o600); await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8"); await handle.sync(); await handle.close(); handle = undefined; await rename(temporary, this.statePath); await chmod(this.statePath, 0o600); }
    finally { await handle?.close(); await rm(temporary, { force: true }); }
  }
}

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function operationKeyDigest(operation: Operation): string { return isCompleted(operation) ? operation.receipt.idempotencyKeyDigest : operation.idempotencyKeyDigest; }
function operationRequestDigest(operation: Operation): string { return isCompleted(operation) ? operation.receipt.requestDigest : operation.requestDigest; }
function operationId(operation: Operation): string { return isCompleted(operation) ? operation.receipt.operationId : operation.operationId; }
function isCompleted(operation: Operation): operation is CompletedOperation { return "receipt" in operation; }
function operationView(operation: Operation): MutationOperationView {
  if (isCompleted(operation)) {
    const { operationId, state, outcome, createdAt, completedAt, audit } = operation.receipt;
    return { operationId, state, outcome, createdAt, completedAt, audit: { action: audit.action, provider: audit.provider, runtime: audit.runtime, scopeKind: audit.scopeKind, warningCodes: [...audit.warningCodes] } };
  }
  const { operationId, state, createdAt, audit } = operation;
  return { operationId, state, createdAt, audit: { action: audit.action, provider: audit.provider, runtime: audit.runtime, scopeKind: audit.scopeKind, warningCodes: [] } };
}
function assertKey(value: string): void { if (!/^[A-Za-z0-9_-]{22,128}$/.test(value)) throw new Error("invalid_idempotency_key"); }
function assertDigest(value: string): void { if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("invalid_digest"); }
function assertIdentifier(value: string): void { if (!/^op_[A-Za-z0-9_-]{1,100}$/.test(value)) throw new Error("invalid_operation_id"); }
function assertOutcome(value: string): asserts value is MutationOutcome { if (!["applied", "not_applied", "blocked", "failed"].includes(value)) throw new Error("invalid_outcome"); }
function assertAudit(value: MutationAudit): void { for (const item of [value.action, value.provider, value.runtime]) if (!/^[a-z][a-z0-9._-]{0,63}$/.test(item)) throw new Error("invalid_audit_identifier"); if (!["agent", "profile", "session", "default", "all"].includes(value.scopeKind)) throw new Error("invalid_scope_kind"); assertDigest(value.scopeIdDigest); assertDigest(value.targetDigest); }
function validateWarnings(values: string[]): string[] { if (values.length > 32 || values.some((value) => !/^[a-z][a-z0-9_]{0,79}$/.test(value))) throw new Error("invalid_warning_code"); return [...values]; }
function equalWarnings(left: string[], right: string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
function isMissing(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT"; }
function isExists(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "EEXIST"; }
async function assertPrivateDirectory(path: string): Promise<void> { const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error("unsafe_repository_directory"); }
async function assertPrivateFile(path: string): Promise<void> { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error("unsafe_repository_state"); }
function isState(value: unknown): value is State { if (!isClosedObject(value, ["schemaVersion", "operations"])) return false; const candidate = value as Partial<State>; return candidate.schemaVersion === "account-center.mutation-repository.v1" && Array.isArray(candidate.operations) && candidate.operations.every(isOperation); }
function isOperation(value: unknown): value is Operation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if ("receipt" in value) return isClosedObject(value, ["receipt"]) && isReceipt((value as { receipt: unknown }).receipt);
  if (!isClosedObject(value, ["operationId", "idempotencyKeyDigest", "requestDigest", "state", "createdAt", "audit"])) return false;
  const item = value as Partial<PendingOperation>;
  return item.state === "pending" && isOperationId(item.operationId) && isDigest(item.idempotencyKeyDigest) && isDigest(item.requestDigest) && isTimestamp(item.createdAt) && isAudit(item.audit);
}
function isReceipt(value: unknown): value is MutationReceipt {
  if (!isClosedObject(value, ["schemaVersion", "operationId", "requestDigest", "idempotencyKeyDigest", "state", "outcome", "createdAt", "completedAt", "audit", "evidence"])) return false;
  const receipt = value as Partial<MutationReceipt>;
  return receipt.schemaVersion === "account-center.mutation-receipt.v1" && receipt.state === "completed" && isOperationId(receipt.operationId) && isDigest(receipt.idempotencyKeyDigest) && isDigest(receipt.requestDigest) && isTimestamp(receipt.createdAt) && isTimestamp(receipt.completedAt) && isOutcome(receipt.outcome) && isReceiptAudit(receipt.audit) && isStageFailureOutcomeConsistent(receipt.outcome, receipt.audit.warningCodes) && (receipt.evidence === undefined || isMutationEvidence(receipt.evidence)) && (receipt.evidence?.reauth === undefined || isReauthOutcomeConsistent(receipt.outcome, receipt.evidence.reauth, receipt.audit.warningCodes));
}
function validateEvidence(value: MutationReceipt["evidence"], outcome: MutationOutcome, warningCodes: string[]): MutationReceipt["evidence"] {
  if (!isStageFailureOutcomeConsistent(outcome, warningCodes)) throw new Error("invalid_receipt_evidence");
  if (value === undefined) return undefined;
  if (!isMutationEvidence(value) || (value.reauth !== undefined && !isReauthOutcomeConsistent(outcome, value.reauth, warningCodes))) throw new Error("invalid_receipt_evidence");
  return value.proof ? {
    receiptId: value.receiptId,
    verification: value.verification,
    liveRuntimeMutation: value.liveRuntimeMutation,
    ...(value.reauth ? { reauth: { verification: value.reauth.verification, route: value.reauth.route } } : {}),
    proof: {
      nativeEvent: { ...value.proof.nativeEvent },
      verification: { scopeId: value.proof.verification.scopeId, before: cloneScopeEvidence(value.proof.verification.before), after: cloneScopeEvidence(value.proof.verification.after) }
    }
  } : { receiptId: value.receiptId, verification: value.verification, ...(value.liveRuntimeMutation === true ? { liveRuntimeMutation: true } : {}), ...(value.reauth ? { reauth: { verification: value.reauth.verification, route: value.reauth.route } } : {}) };
}
export function isMutationEvidence(value: unknown): value is MutationEvidence {
  if (!isClosedObject(value, ["receiptId", "verification", "liveRuntimeMutation", "reauth", "proof"])) return false;
  const item = value as Partial<MutationEvidence>;
  if (!/^evt_[A-Za-z0-9_-]{1,100}$/.test(item.receiptId ?? "") || (item.verification !== "verified" && item.verification !== "unproven") || (item.liveRuntimeMutation !== undefined && typeof item.liveRuntimeMutation !== "boolean") || (item.reauth !== undefined && !isReauthEvidence(item.reauth))) return false;
  if (item.proof === undefined) return true;
  const proof = item.proof;
  if (!isClosedObject(proof, ["nativeEvent", "verification"])) return false;
  const nativeEvent = proof.nativeEvent;
  const verification = proof.verification;
  return isClosedObject(nativeEvent, ["action", "scopeId", "targetId", "status"]) && isClosedObject(verification, ["scopeId", "before", "after"]) && isProofAction(nativeEvent.action) && isProofIdentifier(nativeEvent.scopeId) && isProofIdentifier(nativeEvent.targetId) && nativeEvent.status === "verified" && verification.scopeId === nativeEvent.scopeId && isRouteScopeEvidence(verification.before) && isRouteScopeEvidence(verification.after);
}
function isReauthEvidence(value: unknown): value is ReauthReceiptEvidence {
  if (!isClosedObject(value, ["verification", "route"])) return false;
  const evidence = value as Partial<ReauthReceiptEvidence>;
  if ((evidence.verification !== "verified" && evidence.verification !== "failed" && evidence.verification !== "unproven") || (evidence.route !== "not_requested" && evidence.route !== "applied" && evidence.route !== "not_applied" && evidence.route !== "unproven")) return false;
  return evidence.verification === "verified" || evidence.route === "not_requested";
}
export function isReauthOutcomeConsistent(outcome: MutationOutcome, evidence: ReauthReceiptEvidence, warningCodes: string[]): boolean {
  if (!isStageFailureOutcomeConsistent(outcome, warningCodes)) return false;
  if (evidence.route === "applied") return outcome === "applied";
  if (evidence.verification === "verified" && evidence.route === "not_requested") return outcome === "applied";
  if (outcome === "failed") return evidence.verification === "unproven" && evidence.route === "not_requested" && warningCodes.includes("reauth_stage_failed");
  return outcome === "not_applied";
}
function cloneScopeEvidence(value: RouteScopeEvidence): RouteScopeEvidence { return { status: value.status, ...(value.activeTargetId ? { activeTargetId: value.activeTargetId } : {}), orderTargetIds: [...value.orderTargetIds] }; }
function isRouteScopeEvidence(value: unknown): value is RouteScopeEvidence {
  if (!isClosedObject(value, ["status", "activeTargetId", "orderTargetIds"])) return false;
  const item = value as Partial<RouteScopeEvidence>;
  return (item.status === "observed" || item.status === "absent") && (typeof item.activeTargetId === "undefined" || isProofIdentifier(item.activeTargetId)) && Array.isArray(item.orderTargetIds) && item.orderTargetIds.length <= 10 && item.orderTargetIds.every(isProofIdentifier);
}
function isClosedObject(value: unknown, allowedKeys: readonly string[]): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => allowedKeys.includes(key)); }
function isStageFailureOutcomeConsistent(outcome: MutationOutcome, warningCodes: string[]): boolean { return !warningCodes.includes("reauth_stage_failed") || outcome === "failed"; }
function isProofIdentifier(value: unknown): value is string { return typeof value === "string" && /^id_[a-f0-9]{24}$/.test(value); }
function isProofAction(value: unknown): value is string { return value === "route.auto" || value === "route.use" || value === "route.remove"; }
function isAudit(value: unknown): value is MutationAudit {
  if (!isClosedObject(value, ["action", "provider", "runtime", "scopeKind", "scopeIdDigest", "targetDigest"])) return false;
  const audit = value as Partial<MutationAudit>;
  return isAuditIdentifier(audit.action) && isAuditIdentifier(audit.provider) && isAuditIdentifier(audit.runtime) && isScopeKind(audit.scopeKind) && isDigest(audit.scopeIdDigest) && isDigest(audit.targetDigest);
}
function isReceiptAudit(value: unknown): value is MutationReceipt["audit"] {
  if (!isClosedObject(value, ["action", "provider", "runtime", "scopeKind", "scopeIdDigest", "targetDigest", "warningCodes"])) return false;
  const audit = value as Partial<MutationReceipt["audit"]>;
  return isAuditIdentifier(audit.action) && isAuditIdentifier(audit.provider) && isAuditIdentifier(audit.runtime) && isScopeKind(audit.scopeKind) && isDigest(audit.scopeIdDigest) && isDigest(audit.targetDigest) && Array.isArray(audit.warningCodes) && audit.warningCodes.length <= 32 && audit.warningCodes.every((warning) => typeof warning === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(warning));
}
function isOperationId(value: unknown): value is string { return typeof value === "string" && /^op_[A-Za-z0-9_-]{1,100}$/.test(value); }
function isDigest(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function isTimestamp(value: unknown): value is string { return typeof value === "string" && !Number.isNaN(Date.parse(value)); }
function isOutcome(value: unknown): value is MutationOutcome { return value === "applied" || value === "not_applied" || value === "blocked" || value === "failed"; }
function isScopeKind(value: unknown): value is MutationScopeKind { return value === "agent" || value === "profile" || value === "session" || value === "default" || value === "all"; }
function isAuditIdentifier(value: unknown): value is string { return typeof value === "string" && /^[a-z][a-z0-9._-]{0,63}$/.test(value); }
