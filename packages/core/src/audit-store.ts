import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { redactText } from "./redaction.js";

export type AuditOutcome = "dry_run" | "started" | "applied" | "blocked" | "failed_no_change_verified" | "unproven" | "recovery_required";
export type AuditProofState = "verified" | "unproven" | "not_applicable";

export interface AuditRecord {
  id: string;
  createdAt: string;
  action: string;
  outcome: AuditOutcome;
  proofState: AuditProofState;
  requestDigest: string;
  summary: string;
  warnings: string[];
}

export interface AuditRecordInput {
  action: string;
  outcome: AuditOutcome;
  proofState: AuditProofState;
  requestDigest: string;
  summary: string;
  warnings: string[];
  unsafeContext?: unknown;
}

interface PersistedAudit {
  schemaVersion: "account-center.audit.v1";
  records: AuditRecord[];
}

export class AuditStore {
  constructor(private readonly path: string, private readonly lockTimeoutMs = 1_000, private readonly maxRecords = 1_000) {}

  async append(input: AuditRecordInput): Promise<AuditRecord> {
    if (!input.action.trim() || !input.requestDigest.trim()) throw new Error("audit action and request digest are required");
    return this.withLock(async () => {
      const state = await this.read();
      const record: AuditRecord = {
        id: `audit_${randomUUID()}`,
        createdAt: new Date().toISOString(),
        action: input.action,
        outcome: input.outcome,
        proofState: input.proofState,
        requestDigest: input.requestDigest,
        summary: redactText(input.summary).slice(0, 1_000),
        warnings: input.warnings.map((warning) => redactText(warning).slice(0, 160)).slice(0, 32)
      };
      state.records.push(record);
      if (state.records.length > this.maxRecords) state.records.splice(0, state.records.length - this.maxRecords);
      await this.write(state);
      return record;
    });
  }

  async list(options: { limit?: number } = {}): Promise<AuditRecord[]> {
    const limit = Math.max(1, Math.min(options.limit ?? 50, 100));
    const state = await this.read();
    return state.records.slice(-limit).reverse();
  }

  private async read(): Promise<PersistedAudit> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!isAudit(parsed)) throw new Error("invalid audit state");
      return parsed;
    } catch (error: unknown) {
      if (isMissing(error)) return { schemaVersion: "account-center.audit.v1", records: [] };
      throw error;
    }
  }

  private async write(state: PersistedAudit): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, this.path);
      await chmod(this.path, 0o600);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async withLock<T>(work: () => Promise<T>): Promise<T> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const lock = `${this.path}.lock`;
    const deadline = Date.now() + this.lockTimeoutMs;
    while (true) {
      try {
        await mkdir(lock, { mode: 0o700 });
        await chmod(lock, 0o700);
        break;
      } catch (error: unknown) {
        if (!isExists(error)) throw error;
        if (Date.now() >= deadline) throw new Error("audit_store_lock_timeout");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    try {
      return await work();
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }
}

function isMissing(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT"; }
function isExists(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "EEXIST"; }
function isAudit(value: unknown): value is PersistedAudit {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<PersistedAudit>;
  return candidate.schemaVersion === "account-center.audit.v1" && Array.isArray(candidate.records) && candidate.records.every(isRecord);
}
function isRecord(value: unknown): value is AuditRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<AuditRecord>;
  return typeof record.id === "string" && typeof record.createdAt === "string" && typeof record.action === "string" && typeof record.outcome === "string" && typeof record.proofState === "string" && typeof record.requestDigest === "string" && typeof record.summary === "string" && Array.isArray(record.warnings) && record.warnings.every((warning) => typeof warning === "string");
}
