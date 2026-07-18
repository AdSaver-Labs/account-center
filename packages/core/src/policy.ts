import { AccountCenterStatus, AuditAction, AuditEvent, Profile, RouteState, nowIso } from "./schemas.js";

export interface EligibilityResult {
  profile: Profile;
  eligible: boolean;
  reasons: string[];
  score: number;
}

export interface ReceiptInput {
  action: AuditAction;
  actor?: string;
  dryRun?: boolean;
  target?: string;
  summary: string;
  before?: unknown;
  after?: unknown;
  warnings?: string[];
}

export function evaluateProfile(status: AccountCenterStatus, profile: Profile, route?: RouteState, model?: string): EligibilityResult {
  return evaluateProfileInternal(status, profile, route, model, true);
}

function evaluateProfileInternal(status: AccountCenterStatus, profile: Profile, route: RouteState | undefined, model: string | undefined, enforceBackupRule: boolean): EligibilityResult {
  const reasons: string[] = [];
  if (profile.disabled || profile.role === "disabled") reasons.push("account_disabled");
  if (profile.role === "monitor-only") reasons.push("monitor_only");
  if (!profile.usage.readable) reasons.push("status_unreadable");
  if (profile.usage.health === "error") reasons.push("health_error");
  if (profile.usage.auth.state !== "ok") reasons.push("reauth_needed");
  if (profile.cooldownUntil && Date.parse(profile.cooldownUntil) > Date.now()) reasons.push("cooldown_active");
  if (route && !route.order.includes(profile.id)) reasons.push("not_in_route_order");
  if (model && (status.policy.disabledModels.includes(model) || !profile.models.includes(model))) reasons.push("model_not_allowed");
  if (isStale(profile.usage.generatedAt, status.policy.staleAfterSeconds)) reasons.push("status_stale");

  const fiveHour = remaining(profile, "five-hour");
  if (fiveHour !== null && fiveHour < status.policy.minFiveHourRemainingPct) reasons.push("five_hour_exhausted");
  const weekly = remaining(profile, "weekly");
  if (weekly !== null && weekly < status.policy.minWeeklyRemainingPct) reasons.push("weekly_exhausted");

  const normalAvailable = enforceBackupRule && status.profiles.some((candidate) => candidate.provider === profile.provider && candidate.role !== "backup" && evaluateProfileInternal(status, candidate, route, model, false).eligible);
  if (enforceBackupRule && profile.role === "backup" && normalAvailable && !status.policy.allowBackupWhenNormalAvailable) reasons.push("backup_protected");

  return {
    profile,
    eligible: reasons.length === 0,
    reasons,
    score: score(profile)
  };
}

export function nextEligible(status: AccountCenterStatus, provider = "openai", runtime = "openclaw", model?: string): EligibilityResult | undefined {
  const route = status.routes.find((item) => item.provider === provider && item.runtime === runtime);
  if (!route) return undefined;
  return route.order
    .map((id) => status.profiles.find((profile) => profile.id === id))
    .filter((profile): profile is Profile => Boolean(profile))
    .map((profile) => evaluateProfile(status, profile, route, model))
    .filter((result) => result.eligible)
    .sort((a, b) => b.score - a.score)[0];
}

export function guardStatus(status: AccountCenterStatus, provider = "openai", runtime = "openclaw", model?: string): { ok: boolean; reason: string; next?: string } {
  const next = nextEligible(status, provider, runtime, model);
  if (!next) return { ok: false, reason: "no_eligible_account" };
  return { ok: true, reason: "usable_account_found", next: next.profile.id };
}

export function createReceipt(input: ReceiptInput): AuditEvent {
  const createdAt = nowIso();
  return {
    id: `evt_${createdAt.replace(/[-:.TZ]/g, "").slice(0, 14)}_${Math.random().toString(36).slice(2, 8)}`,
    action: input.action,
    actor: input.actor ?? "cli",
    dryRun: input.dryRun ?? true,
    createdAt,
    target: input.target,
    summary: input.summary,
    before: input.before,
    after: input.after,
    warnings: input.warnings ?? []
  };
}

function remaining(profile: Profile, name: string): number | null {
  return profile.usage.windows.find((window) => window.name === name)?.remainingPct ?? null;
}

function isStale(generatedAt: string, staleAfterSeconds: number): boolean {
  return Date.now() - Date.parse(generatedAt) > staleAfterSeconds * 1000;
}

function score(profile: Profile): number {
  const roleScore = profile.role === "primary" ? 40 : profile.role === "secondary" ? 30 : profile.role === "backup" ? 5 : 0;
  const weekly = remaining(profile, "weekly") ?? 50;
  const five = remaining(profile, "five-hour") ?? 50;
  return roleScore + weekly + five;
}
