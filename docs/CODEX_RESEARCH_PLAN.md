# Codex Research Plan: Account Center MVP

**Date:** 2026-07-09  
**Author:** Codex engineering teammate  
**Scope:** planning only; no implementation decisions in this document require modifying private OpenClaw/Sentinel files.

## Executive Recommendation

Build Account Center v0 as a local-first command and policy control plane, not as a dashboard-first app. The MVP should make account operations available from any terminal, chat bridge, agent, or local API while preserving the existing Sentinel safety model:

1. `account-center` CLI and local API are the canonical command surfaces.
2. `/account ...` ChatOps commands are thin wrappers over the same command router.
3. Runtime adapters own credential access and mutation.
4. Provider probes produce normalized, token-free health and usage snapshots.
5. Account Center core owns policy, audit receipts, leases, stale-status rules, model/account disables, and redacted exports.

The app/dashboard should come after the command router, adapter SDK, OpenClaw compatibility adapter, status export, and Telegram bridge are proven. The MVP Alej asked for is operational control from anywhere: status, switch/change, remove from routing, add, reauth, auto-route, and metrics comparable to Dexter's current `/auth` output.

## Research Inputs

Local/private references were inspected read-only and used only for behavior and interface analysis:

- Current Sentinel polls provider usage without model generation, writes a token-free status export, detects usage thresholds, detects unreadable auth, protects backup-only accounts, and can trigger auto-switch.
- Current auth-switch behavior supports list/status, manual switch, auto-switch, add/remove routing, dry-run/apply, multi-agent route updates, sqlite-backed auth state, JSON fallback, namespace aliases, backup-only protection, cooldowns, and redacted receipts.
- Current router work adds leases, health/usage truth reconciliation, config/state validation with last-known-good snapshots, locks for mutations, cooldown penalties, command bridge wrappers, and plugin/native chat command concerns.
- The Jack/Hermes contract demonstrates a useful pattern: agents can read a safe status/guard file and ask the owning runtime to route; they must not import or copy raw credentials.

External references used:

- LiteLLM Proxy provides a useful adjacent pattern for virtual keys, budgets, rate limits, and model access controls, but Account Center should remain orthogonal in v0 and integrate with LiteLLM as an adapter rather than becoming a model proxy.  
  https://docs.litellm.ai/docs/proxy/virtual_keys  
  https://docs.litellm.ai/docs/proxy/users
- OAuth 2.0 Device Authorization Grant defines the correct shape for device-code reauth: `device_code`, `user_code`, `verification_uri`, `expires_in`, and polling `interval`. Account Center should model reauth challenges in this provider-neutral shape.  
  https://datatracker.ietf.org/doc/html/rfc8628
- Telegram Bot API supports registered bot commands and message sending; Account Center should keep Telegram as one chat bridge behind a generic ChatOps adapter, not as core business logic.  
  https://core.telegram.org/bots/api
- OpenTelemetry defines a vendor-neutral vocabulary for traces, metrics, and logs. Account Center should use this model for internal observability while keeping account status exports separate and secret-free.  
  https://opentelemetry.io/docs/
- OpenAI's platform usage/cost reporting shows a useful precedent for usage/cost exports, but Account Center should distinguish API usage/cost APIs from ChatGPT/Codex account windows and never assume every provider offers equivalent account-level data.  
  https://developers.openai.com/cookbook/examples/completions_usage_api  
  https://help.openai.com/en/articles/20001072-how-do-i-export-monthly-usage-details-from-the-api-usage-dashboard

## What Current Sentinel Does

The current Sentinel is not just a polling script. It is a small account safety system with these concepts worth preserving:

- **No-token probes:** status checks call provider/account endpoints directly and avoid LLM generation.
- **Normalized account windows:** each account is reduced to readable status, 5h/window remaining, weekly remaining, auth expiry, and warnings.
- **Route policy:** normal routing excludes backup-only accounts while any non-backup account is usable.
- **Monitor-only profiles:** connected credentials can be monitored without being eligible for routing.
- **Namespace compatibility:** both canonical and legacy profile IDs must resolve, for example `openai:*` and older `openai-codex:*`.
- **Store compatibility:** sqlite-backed auth stores and legacy JSON auth-state files can coexist.
- **Dry-run/apply split:** mutation is explicit, visible, and receipt-backed.
- **Safe remove:** removing an account from routing is not credential deletion.
- **Failover triggers:** rate limits, usage exhaustion, quota/capacity errors, unreadable OAuth, and warning thresholds should all drive a route decision.
- **Cooldowns and leases:** recent failures and active project/agent reservations affect eligibility.
- **Token-free export:** other agents can inspect status and guard decisions without reading credentials.
- **Receipt trail:** route changes and failovers write event records with before/after context and redaction.
- **Work-product boundary:** account operations must not mutate prompts, sessions, memory, bootstrap, or unrelated runtime config.

These concepts should become core product contracts, not OpenClaw-specific implementation details.

## MVP Product Shape

### Primary User Story

From any chat/interface/terminal/agent, Alej can ask:

- What accounts exist?
- Which account is active?
- Which accounts have 5h/weekly capacity?
- Which account is next?
- Switch to next automatically.
- Switch/change to a named account.
- Remove an account from routing without deleting credentials.
- Disable or enable an account/model.
- Add or reauth an account through a human approval flow.
- See receipts, warnings, stale status, and adapter health.

### MVP Interfaces

All interfaces should call the same command router:

```text
CLI              account-center ...
Local API        http://127.0.0.1:<port>/v1/commands
Telegram         /account ...
Other chat       /account ... via bridge adapter
Agents           JSON status export, local API, or account-center guard
Generic runtime  adapter command protocol
```

The dashboard is intentionally not required for MVP completion.

## Architecture Recommendation

```text
CLI / ChatOps / Local API / Agent Guard
  |
  v
Command Router
  - parses /account, /auth, /oauth aliases
  - normalizes actor, reason, dryRun/apply
  - applies approval gates
  - redacts all responses
  |
  v
Core
  - Account Registry
  - Policy Engine
  - Audit Store
  - Lease Store
  - Reauth Queue
  - Status Export Writer
  |
  +--> Provider Probes
  |     - usage/health windows
  |     - no-token preferred
  |     - generation canary only if explicitly allowed
  |
  +--> Runtime Adapters
        - OpenClaw
        - Hermes
        - Codex CLI/app
        - LiteLLM gateway
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
tests/fixtures             redacted sqlite/json/status/auth-shape fixtures
examples                   safe configs only
```

Use TypeScript for core, CLI, server, and adapters because the current Sentinel/auth-switch surface is already JavaScript-oriented and TS gives useful schema/type boundaries. Use small Python helper adapters only where an existing runtime is Python-native.

Use SQLite for local durable state because v0 needs transactional audit events, leases, reauth challenges, snapshots, and command receipts without requiring hosted infrastructure.

## Core Data Model

Minimum entities:

```text
Provider
  id, displayName, capabilities

Runtime
  id, displayName, adapterKind, health, configRef

Profile
  id, providerId, label, aliases, role, runtimeRefs, createdAt, metadata

UsageSnapshot
  profileId, generatedAt, source, freshness, windows, auth, health, warnings

RouteState
  runtimeId, providerId, order, activeProfileId, lastGoodProfileId, observedAt

Policy
  profile roles, backup-only rules, thresholds, stale limits, model compatibility

Lease
  profileId, holder, project, expiresAt, reason, active

ReauthChallenge
  id, providerId, runtimeId, profileHint, verificationUri, userCode, expiresAt, status

AuditEvent
  id, actor, command, dryRun, status, before, after, warnings, receiptPath, createdAt
```

Secrets are intentionally absent from the core model. If future hosted mode ever needs custody, it should be designed as a separate encrypted secret subsystem and kept out of v0.

## Adapter Interface

Adapters must be able to serve arbitrary agents/runtimes while keeping core generic:

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

Key requirements:

- `plan*` methods must be side-effect free.
- `apply*` methods must include backup/rollback pointers where the runtime supports them.
- Adapter outputs must pass core redaction before logging or chat/API response.
- Adapters must declare whether they can mutate route order, start reauth, read usage, verify live inference, disable models, or only report status.
- Adapters should use runtime-native APIs where possible, for example an OpenClaw adapter should call runtime commands for auth order instead of editing unrelated files.

## Provider Probe Interface

```ts
export interface ProviderProbe {
  id: string;
  displayName: string;
  capabilities(): ProbeCapabilities;
  probe(profile: ProbeProfileRef, opts: ProbeOptions): Promise<UsageHealthResult>;
}
```

Probe output must separate:

- `usageReadable`: provider endpoint/status could be read.
- `authUsable`: credential appears accepted by provider/status endpoint.
- `generationVerified`: a live model call was explicitly allowed and passed.
- `windows`: named remaining-usage windows with source and freshness.
- `reauthNeeded`: auth is expired, rejected, or requires human action.
- `unknown`: provider does not expose enough data.

Policy can require `usageReadable=true` for automatic routing while allowing manual force with confirmation.

## Universal Command Contract

Canonical namespace:

```text
/account ...
```

Compatibility aliases:

```text
/auth ...
/oauth ...
```

CLI should mirror ChatOps:

```bash
account-center status
account-center accounts list
account-center routes next
account-center routes auto --apply
account-center routes use <label|profile|email> --apply
account-center routes remove <label|profile|email> --apply
account-center accounts add --provider openai --label <label>
account-center accounts reauth <label|profile|email>
account-center accounts disable <label|profile|email> --apply
account-center accounts enable <label|profile|email> --apply
account-center models disable <provider/model> --apply
account-center doctor
account-center audit list --limit 20
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

All mutating commands must carry:

- actor;
- source surface;
- reason;
- dry-run/apply flag;
- target runtime/provider;
- before state;
- after state;
- warnings;
- receipt ID.

Chat defaults should be safe:

- normal `/account auto` can apply only if policy has no high-friction warnings;
- backup-only use requires `/account force <target> --confirm` or a two-step confirmation;
- credential deletion is not part of v0;
- reauth shows only the human device URL/code and challenge expiry, never tokens.

## Metrics and Status Output

The MVP should intentionally match the operator value of Dexter's current `/auth` output while making the schema provider-neutral.

Short status:

```text
Account Center: OK
Active: openai:helper-1
Next eligible: openai:helper-2
Warnings: 1 account at weekly 3%; backup protected
Snapshot age: 42s
Receipt/audit: evt_...
```

List output should include:

```text
* helper-1
  provider: openai
  profile: openai:helper-1
  role: primary
  routing: active
  readable: yes
  5h left: 97%
  weekly left: 77%
  auth: ok
  leases: none

  helper-2
  role: secondary
  routing: eligible
  5h left: 86%
  weekly left: 55%

  business-backup
  role: backup-only
  routing: protected
```

JSON status export:

```json
{
  "schemaVersion": "account-center.status.v1",
  "generatedAt": "2026-07-09T00:00:00Z",
  "ageSeconds": 0,
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

Agent guard output:

```json
{
  "ok": true,
  "reason": "usable_account_found",
  "profileId": "openai:helper-2",
  "providerId": "openai",
  "generatedAt": "2026-07-09T00:00:00Z",
  "ageSeconds": 42
}
```

This export is how Sentinel becomes available to all agents without sharing credentials.

## Security and Secret Boundaries

Hard boundaries:

- Core never stores raw OAuth access tokens, refresh tokens, API keys, browser cookies, auth database rows, or session blobs.
- Chat/API/log/status output must pass redaction.
- Adapters may access credential stores only to perform declared runtime operations.
- Account Center never copies OpenClaw credentials into Hermes, Codex CLI, or another runtime.
- Profile IDs are handles, not credentials.
- Remove-from-routing is not delete-credential.
- Credential deletion is out of v0.
- Status snapshots expire; stale status must block automatic mutation when policy requires known usage.
- Backup-only accounts require high-friction confirmation.
- Runtime work product is out of scope for account operations.

Required tests before live mutation:

- redaction of token-like fields in events, logs, chat replies, API responses, and status exports;
- fixture coverage for sqlite auth store and JSON auth-state shapes;
- namespace alias tests for canonical and legacy provider/profile IDs;
- stale status blocks auto-switch;
- backup-only policy blocks normal use;
- remove-from-routing leaves credential references intact;
- receipts include before/after and rollback pointer without secrets;
- concurrent mutation lock prevents two command surfaces from racing route order.

## Codex Teammate and Runtime Integration

Codex should integrate in two distinct roles:

1. **Development teammate:** Codex reads repo docs, implements Account Center code, writes tests, and produces evidence. It does not own external account decisions or credential custody.
2. **Runtime consumer:** Codex CLI/app can consume Account Center guard/status output before heavy work and can expose a runtime adapter if route order or reauth can be controlled safely.

Codex development workflow:

- Before meaningful development tasks, run `account-center guard --provider openai --runtime codex` or read the status export.
- If guard fails due to stale status, no eligible account, backup-only protection, or reauth needed, Codex should report the account blocker instead of burning the wrong account.
- Codex should not read or copy OpenClaw/Hermes auth stores.
- Codex adapter work should start read-only: list local Codex profiles, verify current auth health, and report status. Route mutation comes only after the runtime-specific credential/routing model is understood and tested.

This keeps Codex useful as the engineering arm without turning it into a secret-handling operator.

## Recommended MVP Build Sequence

### Phase 1: Contracts, Schemas, Redaction

- Create TypeScript schemas for provider, runtime, profile, usage snapshot, route state, lease, reauth challenge, and audit event.
- Implement redaction library and tests first.
- Implement command request/response schema shared by CLI, local API, and chat bridge.
- Implement SQLite store and migration harness.
- Implement no-secret status export writer and guard reader.

Exit criteria:

- `account-center status --json` can emit a fixture-backed no-secret export.
- Redaction tests pass against secret-looking fixture fields.

### Phase 2: Policy Engine and Dry-Run CLI

- Implement eligibility ranking: role, readable status, usage windows, cooldown, lease, model compatibility, stale status.
- Implement `status`, `accounts list`, `routes next`, `doctor`, and `audit list`.
- Implement dry-run planning for `use`, `auto`, `remove`, `disable`, and `enable`.
- Implement receipts for dry-run plans.

Exit criteria:

- No live runtime mutation exists yet.
- Fixture tests cover exhausted, unreadable, monitor-only, backup-only, stale, cooldown, and leased accounts.

### Phase 3: OpenClaw Adapter Read-Only

- Read OpenClaw profiles and route state through runtime-supported commands or narrowly scoped store readers.
- Support sqlite-backed auth store and JSON fallback fixtures.
- Normalize `openai:*` and legacy `openai-codex:*`.
- Import current Sentinel status export as one provider probe/status source.
- Produce `/account list` output matching current `/auth` operator value.

Exit criteria:

- OpenClaw status/list/next work without modifying `/home/Alej/.openclaw`.
- No secrets appear in JSON/status/log output.

### Phase 4: OpenClaw Adapter Mutations

- Implement route planning and apply through OpenClaw-native route-order commands where available.
- Add backups/rollback pointers for every route mutation.
- Implement remove-from-routing without credential deletion.
- Implement multi-agent target support.
- Add mutation lock and receipt persistence.

Exit criteria:

- `routes use`, `routes auto`, and `routes remove` pass dry-run and live tests against redacted fixtures or a dedicated test runtime before touching real runtime state.

### Phase 5: Telegram/ChatOps Bridge

- Build Telegram bridge as a command adapter over the local command API.
- Register `/account` commands.
- Support `/auth` and `/oauth` compatibility aliases.
- Implement two-step confirmation for backup-only/force operations.
- Ensure chat replies use concise status metrics and receipt IDs.

Exit criteria:

- Alej can run status/list/next/auto/use/remove from Telegram with the same policy engine as CLI.

### Phase 6: Reauth Queue

- Implement provider-neutral reauth challenge lifecycle using OAuth device-flow fields where applicable.
- Adapter owns actual credential persistence.
- Chat and CLI show URL/code/expiry and poll status.
- Rate-limit/cloud challenge/manual failure states are first-class and operator-visible.

Exit criteria:

- `/account add` and `/account reauth` can start, track, expire, and report challenges without printing tokens.

### Phase 7: Hermes and Generic Runtime Adapters

- Hermes starts read-only and must not import OpenClaw credentials.
- Generic command adapter supports user-provided list/status/route/reauth commands with JSON contracts.
- LiteLLM adapter maps virtual keys, budgets, rate limits, and model access into Account Center status/policy where useful.

Exit criteria:

- At least one non-OpenClaw runtime can consume status and expose route state through the same commands.

### Phase 8: Dashboard MVP

- Build local dashboard only after command/API paths are stable.
- Show accounts, active route, next route, leases, model disables, reauth queue, audit log, adapter health.
- Use local API and same command router; no separate dashboard-only mutation logic.

## Risks and Open Questions

- **Provider terms and limits:** Account Center must manage legitimate operator-owned accounts and must not bypass provider limits or fraud controls.
- **No-token status availability:** Some providers may not expose precise usage windows. Policy must support unknown status and require confirmation for unsafe routing.
- **Usage endpoint vs live generation:** A readable usage endpoint does not guarantee model inference works. Model canaries should be opt-in and visibly token-spending.
- **OAuth/device-code reliability:** VPS-origin device flows can hit provider/Cloudflare/rate-limit challenges. Reauth must expose partial/manual states.
- **Runtime mutation safety:** Some runtimes may not have a stable account-order API. Adapters must prefer runtime commands and treat direct file/db edits as high risk.
- **Concurrent command surfaces:** Telegram, CLI, local API, and agents can race. Use SQLite transactions and per-runtime mutation locks.
- **Namespace drift:** Provider/profile aliases must be explicit and tested to avoid routing the wrong account.
- **Secret detection false confidence:** Redaction should be a defense-in-depth layer, not permission to handle raw secrets in core.
- **Codex CLI/app auth model:** Needs separate read-only discovery before promising route mutation.
- **Dashboard pressure:** A UI too early will slow the MVP. Build operational command paths first, then surface them in a dashboard.

## Final MVP Definition

Account Center MVP is done when Alej can use one command vocabulary from terminal and Telegram to:

- see active and eligible accounts with 5h/weekly/auth/role metrics;
- expose a token-free guard/status file usable by all agents;
- auto-switch or switch to a named eligible account with receipts;
- remove an account from routing without deleting credentials;
- disable/enable accounts and models;
- start add/reauth flows from chat or CLI;
- enforce backup-only and stale-status protections;
- integrate OpenClaw safely through an adapter;
- allow other agents, including Codex and Hermes, to consume status without sharing credentials.

Anything beyond that, especially the dashboard and hosted/cloud custody, should wait until the command/control-plane MVP is boring and well tested.
