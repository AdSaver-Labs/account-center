# Final Merged Plan: Account Center + Universal Sentinel

**Date:** 2026-07-09  
**Participants:** Jack/Hermes, Dexter/OpenClaw, Codex colleague  
**Status:** Ready for Alej approval before implementation.  
**Repo:** https://github.com/AdSaver-Labs/account-center

## Executive conclusion

Build **Account Center** as a **local-first, CLI/ChatOps-first, agent-agnostic account control plane**.

The MVP is **not** the dashboard. The MVP is one universal account command system that works from any connected surface:

- Telegram;
- terminal;
- Hermes/Jack;
- OpenClaw/Dexter;
- Codex CLI/app/colleague;
- future chat bridges;
- later a dashboard/app UI.

The current private Sentinel should become the **compatibility baseline**. Account Center should lift Sentinel’s proven behavior into a reusable public product with adapters for each runtime.

## What changed after Codex joined

Codex confirmed and strengthened three points:

1. **Command router first, app later.**  
   The dashboard should only call the same command router used by Telegram/CLI/agents. No dashboard-only mutation logic.

2. **Universal command vocabulary is the MVP.**  
   `/account ...` must work the same way anywhere an operator or main agent is connected.

3. **Codex has two roles.**
   - Development teammate: implement code/tests/build evidence.
   - Runtime consumer: use Account Center guard/status before heavy Codex work, but do not own credentials or copy OpenClaw/Hermes auth stores.

## Agreed product principles

1. **Agent-agnostic core**  
   No core logic assumes OpenClaw, Hermes, Codex, Telegram, or any single provider.

2. **Local-first v0**  
   Run on Alej’s VPS/local environment first. Hosted/cloud custody is out of scope for v0.

3. **Runtime-owned credentials**  
   Raw OAuth tokens, refresh tokens, API keys, cookies, auth DB rows, and browser/session credentials stay inside each runtime/provider store.

4. **No-token status first**  
   Prefer usage/health endpoints that do not spend model tokens. Generation canaries are explicit, visible, and optional.

5. **One command router for everything**  
   CLI, Telegram, HTTP API, dashboard, and agent calls all go through the same command router/policy engine.

6. **Dry-run before mutation**  
   Every mutating command must support planning/dry-run and produce a receipt when applied.

7. **Protect agent work product**  
   Account routing must not mutate sessions, prompts, memory, bootstrap files, skills, or unrelated runtime config.

8. **Backup/last-resort protection**  
   Business-critical accounts can be backup-only and require high-friction confirmation.

9. **Remove from routing is not credential deletion**  
   Credential deletion is out of v0 or must require a separate high-friction approval flow later.

10. **Test known failure modes before live mutation**  
    Provider namespace drift, sqlite-vs-JSON auth state, stale status, backup-only routing, no-secret exports, and concurrent command races must be fixture-tested.

## MVP definition

Account Center MVP is complete when Alej can use the same command vocabulary from terminal and Telegram to:

- see all accounts with Dexter-style metrics;
- see active route and next eligible route;
- inspect 5h/daily and weekly capacity where available;
- inspect auth/readability/health/staleness;
- auto-switch to the next eligible account;
- switch/change to a named eligible account;
- remove an account from routing without deleting credentials;
- disable/enable accounts;
- disable/enable models;
- start add/reauth flows from chat or CLI;
- receive receipts for all mutations;
- expose a token-free guard/status file usable by Jack, Dexter, Codex, and future agents.

The dashboard/app comes after this command/control plane is reliable.

## Universal command contract

Canonical chat namespace:

```text
/account ...
```

Compatibility aliases:

```text
/auth ...
/oauth ...
```

CLI mirrors chat:

```bash
account-center status
account-center accounts list
account-center routes next
account-center routes auto --apply
account-center routes use <label|profile|email> --apply
account-center routes remove <label|profile|email> --apply
account-center accounts add --provider <provider> --label <label>
account-center accounts reauth <label|profile|email>
account-center accounts disable <label|profile|email> --apply
account-center accounts enable <label|profile|email> --apply
account-center models disable <provider/model> --apply
account-center models enable <provider/model> --apply
account-center leases list
account-center leases create <agent|project> <profile> <ttl> --apply
account-center doctor
account-center audit list --limit 20
account-center help
```

MVP ChatOps commands:

```text
/account
/account status
/account list
/account next
/account auto
/account use <label|profile|email>
/account remove <label|profile|email>
/account disable <label|profile|email>
/account enable <label|profile|email>
/account add <provider> <label|email>
/account reauth <label|profile|email>
/account models
/account model disable <provider/model>
/account model enable <provider/model>
/account leases
/account lease <agent|project> <label|profile> <ttl>
/account doctor
/account audit
/account help
```

All mutating commands must include:

- actor;
- source surface;
- reason;
- target runtime/provider;
- dry-run/apply mode;
- before state;
- after state;
- warnings;
- rollback/backup pointer where possible;
- receipt ID.

## Operator status output

The status output should match the operator value of Dexter’s current `/auth` output while using a provider-neutral schema.

Short chat output example:

```text
Account Center: OK
Active: openai:helper-1
Next eligible: openai:helper-2
Warnings: backup protected; 1 account weekly low
Snapshot age: 42s
Receipt/audit: evt_...
```

Account list output should show:

```text
helper-1
  provider: openai
  runtime: openclaw
  role: primary
  routing: active
  readable: yes
  auth: ok
  5h/daily left: 97%
  weekly left: 77%
  leases: none

helper-2
  role: secondary
  routing: eligible
  5h/daily left: 86%
  weekly left: 55%

business-backup
  role: backup-only
  routing: protected
```

## Architecture

```text
CLI / Telegram / Other Chat / HTTP / Dashboard / Agent Guard
  ↓
Command Router
  - parse /account, /auth, /oauth
  - normalize actor/reason/dryRun/apply
  - enforce approval gates
  - redact all outputs
  ↓
Core
  - Account Registry
  - Policy Engine
  - Audit Store
  - Lease Store
  - Reauth Queue
  - Status Export Writer
  ↓
Provider Probes                 Runtime Adapters
  - usage/health windows          - OpenClaw
  - no-token preferred            - Hermes
  - live canary opt-in            - Codex CLI/app
                                  - LiteLLM
                                  - generic command runtime
```

Recommended repo modules:

```text
packages/core              schemas, registry, policy, audit, redaction
packages/cli               terminal UX and JSON output
packages/server            local HTTP command router
packages/chat-telegram     Telegram bridge
packages/probes            provider probe contracts and implementations
packages/adapters          openclaw, hermes, codex, generic-command, litellm
packages/status-export     guard file writer/reader
packages/dashboard         later UI over the same API
examples                   safe configs only
tests/fixtures             redacted sqlite/json/status/auth-shape fixtures
```

## Core model

Minimum entities:

- `Provider`
- `Runtime`
- `Profile`
- `UsageSnapshot`
- `RouteState`
- `Policy`
- `Lease`
- `ReauthChallenge`
- `AuditEvent`

Secrets are absent from the core model by design.

## Adapter contract

Runtime adapters should expose:

```ts
export interface RuntimeAdapter {
  id: string;
  displayName: string;
  capabilities(): Promise<RuntimeCapabilities>;

  listProfiles(opts?: ListProfilesOptions): Promise<ProfileSummary[]>;
  getRouteState(providerId: string): Promise<RouteState>;

  planSetRoute(input: SetRouteInput): Promise<ChangePlan>;
  applySetRoute(planId: string, opts: ApplyOptions): Promise<ChangeReceipt>;

  planRemoveFromRouting(input: RemoveRouteInput): Promise<ChangePlan>;
  applyRemoveFromRouting(planId: string, opts: ApplyOptions): Promise<ChangeReceipt>;

  planDisable(input: DisableInput): Promise<ChangePlan>;
  applyDisable(planId: string, opts: ApplyOptions): Promise<ChangeReceipt>;

  startReauth(input: ReauthInput): Promise<ReauthChallenge>;
  pollReauth(challengeId: string): Promise<ReauthStatus>;
  verify(profileId?: string): Promise<VerifyResult>;
}
```

Rules:

- `plan*` is side-effect free.
- `apply*` writes receipts and rollback pointers.
- adapters use runtime-native APIs where possible;
- direct file/db edits are high risk and must be tightly scoped;
- adapter outputs pass redaction before logs/chat/API.

## Status export / guard contract

All main agents should be able to read a no-secret status/guard file or local API response:

```json
{
  "schemaVersion": "account-center.status.v1",
  "generatedAt": "2026-07-09T00:00:00Z",
  "ageSeconds": 42,
  "ok": true,
  "noSecrets": true,
  "activeRoute": {
    "providerId": "openai",
    "runtimeId": "openclaw",
    "profileId": "openai:helper-1"
  },
  "nextEligible": {
    "providerId": "openai",
    "profileId": "openai:helper-2",
    "reason": "has_5h_and_weekly_capacity"
  },
  "accounts": [],
  "warnings": [],
  "policy": {
    "backupProtected": true,
    "requiresKnownUsageForAuto": true
  }
}
```

Before heavy work, Jack/Dexter/Codex should be able to run:

```bash
account-center guard --provider openai --runtime <jack|dexter|codex>
```

or read the status export. If guard fails, the agent reports the account blocker instead of spending the wrong account.

## Implementation phases

### Phase 1 — contracts, schemas, redaction

- TypeScript schemas for provider/runtime/profile/usage/route/policy/lease/reauth/audit.
- Redaction library and tests first.
- Command request/response schema shared by CLI, local API, chat bridge.
- SQLite store and migration harness.
- No-secret status export writer and guard reader.

Exit criteria:

- fixture-backed `account-center status --json` works;
- redaction tests catch secret-looking fields;
- no live runtime mutation exists.

### Phase 2 — policy engine and dry-run CLI

- Eligibility ranking by role, usage windows, auth/readability, cooldown, lease, model compatibility, stale status.
- Commands: `status`, `accounts list`, `routes next`, `doctor`, `audit list`.
- Dry-run plans for `use`, `auto`, `remove`, `disable`, `enable`.
- Receipt objects for plans.

Exit criteria:

- tests cover exhausted, unreadable, monitor-only, backup-only, stale, cooldown, leased accounts.

### Phase 3 — OpenClaw adapter read-only

- Read OpenClaw profiles and route state.
- Support sqlite-backed auth store and legacy JSON fixtures.
- Normalize `openai:*` and legacy `openai-codex:*`.
- Import current Sentinel status export as one status/probe source.
- Produce `/account list` output comparable to current `/auth`.

Exit criteria:

- OpenClaw status/list/next work without modifying OpenClaw;
- no secrets appear in output.

### Phase 4 — OpenClaw adapter mutations

- Route planning/apply through OpenClaw-native auth-order commands where available.
- Backup and rollback pointers for every route mutation.
- Remove-from-routing without credential deletion.
- Multi-agent target support.
- SQLite/per-runtime mutation locks.

Exit criteria:

- `routes use`, `routes auto`, `routes remove` pass dry-run and live tests against fixtures/dedicated test runtime before real runtime state is touched.

### Phase 5 — Telegram/ChatOps bridge

- Telegram bridge over local command API.
- Register `/account` commands.
- Keep `/auth` and `/oauth` compatibility aliases.
- Two-step confirmation for backup-only/force operations.
- Chat replies include metrics and receipt IDs.

Exit criteria:

- Alej can run status/list/next/auto/use/remove from Telegram with the same policy engine as CLI.

### Phase 6 — reauth queue

- Provider-neutral OAuth/device-code challenge lifecycle.
- Adapter owns actual credential persistence.
- Chat/CLI show URL/code/expiry and poll status.
- Manual/challenge/rate-limit states are visible.

Exit criteria:

- `/account add` and `/account reauth` can start, track, expire, and report without printing tokens.

### Phase 7 — Hermes, Codex, generic adapters

- Hermes adapter starts read-only and never imports OpenClaw credentials.
- Codex adapter starts read-only: local profile/auth health/status; mutation only after its auth/routing model is understood and tested.
- Generic command adapter supports JSON contracts for arbitrary future agents.
- LiteLLM adapter maps virtual keys/budgets/rate limits/model access into Account Center status/policy later.

Exit criteria:

- at least one non-OpenClaw runtime consumes status and exposes route state through the same commands.

### Phase 8 — dashboard/app MVP

- Build local dashboard after command/API paths are stable.
- Show accounts, active route, next route, leases, model disables, reauth queue, audit log, adapter health.
- Dashboard calls the same local API/command router. No separate dashboard-only mutation logic.

## Immediate implementation recommendation after approval

If Alej approves, start with **Phase 1 only**:

1. Scaffold TypeScript monorepo.
2. Add schemas.
3. Add redaction tests.
4. Add SQLite store/migrations.
5. Add fixture-backed status export and `account-center status --json`.
6. Add `account-center guard` for agents.
7. Do **not** mutate live Sentinel/OpenClaw/Hermes/Codex routing yet.

Then proceed to Phase 2 dry-run CLI before any live account switch/change/remove/add operation is implemented.

## Key risks

- Some providers may not expose no-token usage windows.
- Usage endpoint success does not guarantee live model inference success.
- Codex CLI/app auth model needs read-only discovery before route mutation.
- Telegram, terminal, API, and agents can race; per-runtime locks are mandatory.
- Direct file/db mutation is risky; prefer runtime-native commands.
- Dashboard pressure can distract from the MVP; build CLI/ChatOps first.

## Final approval question

Approve this implementation direction?

If approved, Jack should start **Phase 1: contracts, schemas, redaction, SQLite store, fixture-backed status export, and guard command**. Codex should act as development lead, with Jack reviewing and Dexter acting as operator/safety gate.
