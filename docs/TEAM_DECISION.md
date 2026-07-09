# Team Decision: Account Center + Sentinel Generalization

**Date:** 2026-07-09  
**Participants so far:** Jack/Hermes, Dexter/OpenClaw. Standalone Codex CLI was attempted but blocked by expired/reused OAuth refresh token; Codex should rejoin through the healthier OpenClaw/Codex teammate path after reauth/verification.

## 1. Decision summary

Build **Account Center** as a local-first, open-source, agent-agnostic account control plane. It will generalize the current Sentinel/account-routing system into a reusable app that can work with OpenClaw, Hermes, Codex, LiteLLM-style gateways, CLI agents, and arbitrary future runtimes through adapters.

The current Sentinel should be treated as the **compatibility baseline**, not as throwaway code. Account Center v0 should preserve Sentinel’s proven safety behavior while separating core policy from runtime-specific credential stores.

## 2. Merged principles

1. **Agent-agnostic core** — no core logic assumes OpenClaw, Hermes, Codex, or a specific provider.
2. **Runtime-owned credentials** — raw OAuth/API/browser/session secrets stay in runtime/provider stores; Account Center stores handles, policies, status snapshots, receipts, and redacted metadata.
3. **No-token status first** — prefer provider usage/health endpoints that do not burn LLM/model tokens.
4. **Dry-run before mutation** — all mutating operations support dry-run and explicit apply/confirmation.
5. **Protect work product** — account routing must not mutate sessions, prompts, memory, bootstrap, skills, or unrelated runtime configs.
6. **Backup/last-resort policy** — business-critical accounts can be backup-only and require high-friction confirmation.
7. **Audit everything** — route changes, reauth starts/completions, disables, leases, and model-policy changes produce receipts.
8. **ChatOps-native** — Telegram/chat commands are first-class, not an afterthought.
9. **Local-first v0** — no hosted/cloud token custody until a separate encrypted custody/security model exists.
10. **Test proven failure modes** — namespace drift, stale status, sqlite/json auth stores, backup account policy, and no-secret exports must be fixtures/tests before live mutation.

## 3. Preserve from current Sentinel

Account Center must preserve these current Sentinel capabilities:

- no-token usage/status polling;
- token-free JSON status export;
- guard command for heavy model work;
- profile namespace compatibility (`openai:*` and legacy `openai-codex:*` aliases);
- sqlite-backed auth store support plus legacy JSON fallback;
- dry-run/apply split;
- backup/last-resort account protection;
- remove-from-routing without credential deletion;
- Telegram/manual commands for list, switch, auto, add/reauth, remove;
- event receipts and backups for routing changes;
- prohibition on modifying agent sessions/prompts/memory/bootstrap for account-only operations.

## 4. Product architecture

```text
CLI / Telegram / Slack / Discord / HTTP / Web Dashboard
  ↓
Command Router + Approval Gates + Redaction Boundary
  ↓
Core: Account Registry + Policy Engine + Audit Store + Reauth Queue
  ↓                          ↓
Provider Probes              Runtime Adapters
(OpenAI, Anthropic,          (OpenClaw, Hermes, Codex CLI/app,
 OpenRouter, Copilot, etc.)   LiteLLM, generic command agents)
  ↓                          ↓
Usage/health snapshots       Auth order / routing / reauth / verify
```

Recommended monorepo:

```text
packages/core          schemas, account registry, policy engine, audit receipts
packages/probes        provider usage/health probes
packages/adapters      openclaw, hermes, codex, generic-command, litellm
packages/cli           account-center CLI
packages/server        local API and command router
packages/dashboard     local web UI
examples/              redacted configs and fixtures
tests/fixtures         no-secret status/auth-shape fixtures
```

## 5. Core interfaces

### Runtime adapter

```ts
interface RuntimeAdapter {
  id: string;
  displayName: string;
  listProfiles(): Promise<Profile[]>;
  getAuthOrder(provider: string): Promise<string[]>;
  setAuthOrder(provider: string, orderedProfileIds: string[], opts: ApplyOptions): Promise<ChangeReceipt>;
  removeFromRouting(profileId: string, opts: ApplyOptions): Promise<ChangeReceipt>;
  startReauth(profileHint: string, opts: ReauthOptions): Promise<ReauthChallenge>;
  verify(profileId?: string): Promise<VerifyResult>;
}
```

### Provider probe

```ts
interface ProviderProbe {
  id: string;
  supportsNoTokenUsageProbe: boolean;
  probe(profile: ProfileRef): Promise<UsageHealthResult>;
}
```

### Policy engine responsibilities

- rank eligible accounts;
- enforce primary/secondary/backup/monitor-only/disabled roles;
- enforce cooldowns and leases;
- reject stale or unknown status when policy requires known usage;
- check model compatibility;
- choose next route;
- produce explainable decisions.

## 6. Command contract

Public command namespace:

```text
/account ...
```

Compatibility aliases:

```text
/auth ...
/oauth ...
```

Read-only commands:

```text
/account status
/account list
/account next
/account models
/account leases
/account doctor
/account audit
```

Mutating commands:

```text
/account auto
/account use <label|profile|email>
/account remove <label|profile|email>
/account disable <label|profile|email>
/account enable <label|profile|email>
/account model disable <provider/model>
/account model enable <provider/model>
/account lease <agent|project> <profile> <ttl>
```

Human-auth commands:

```text
/account add <provider> <label|email>
/account reauth <label|profile|email>
```

High-friction command:

```text
/account force <label|profile|email> --confirm
```

Every mutating command must include:

- actor;
- reason;
- dry-run/apply mode;
- before route;
- after route;
- backup/rollback pointer where applicable;
- event receipt ID.

## 7. Security gates

Before any live adapter mutation is implemented:

- redaction tests for logs, receipts, status exports, chat replies, and API responses;
- status export schema that forbids secret-looking fields;
- credential custody doc;
- backup/restore fixture tests;
- namespace alias tests;
- backup-only policy tests;
- stale-status tests;
- remove-from-routing vs credential-delete tests.

Credential deletion should be out of v0 or require a separate high-friction approval flow.

## 8. MVP scope

### In scope

- local CLI;
- local JSON/YAML config;
- SQLite state/audit store;
- no-token status exports;
- OpenClaw adapter read-only + dry-run first;
- OpenClaw route mutation after tests;
- Hermes adapter read-only + route selection after OpenClaw MVP;
- Telegram command bridge;
- reauth queue lifecycle;
- dashboard MVP.

### Out of scope for v0

- hosted/cloud credential custody;
- credential deletion;
- bypassing provider limits or terms;
- automatic mutation of agent sessions/prompts/memory/bootstrap;
- full LiteLLM replacement;
- public release containing private VPS scripts/secrets.

## 9. Implementation phases

### Phase 0 — repo/planning/team alignment

- Publish planning repo.
- Add this `TEAM_DECISION.md`.
- Reauth/verify Codex teammate path.
- Get Alej green light.

### Phase 1 — core schemas and dry-run CLI

- Account/profile/provider/model schemas.
- Policy engine with fixtures.
- Audit receipt store.
- CLI read-only commands.

### Phase 2 — OpenClaw adapter MVP

- list profiles from sqlite/json stores;
- read auth order;
- compute next route;
- dry-run route changes;
- apply route changes only after fixture tests;
- receipt/backup for each mutation.

### Phase 3 — Hermes adapter MVP

- list Hermes credential pool;
- mark exhausted/cooldown credentials;
- reorder/use local Hermes credentials;
- no OpenClaw token copying.

### Phase 4 — ChatOps bridge

- Telegram `/account` commands;
- confirmation flow;
- reauth challenge messages;
- receipt delivery.

### Phase 5 — dashboard

- account table;
- route policy editor;
- model policy editor;
- reauth queue;
- audit log.

### Phase 6 — generic adapters and public hardening

- generic shell-command adapter;
- LiteLLM-style gateway adapter;
- adapter SDK docs;
- CI/security tests;
- release docs.

## 10. Codex / colleague-agent participation

Codex should be software development lead after Alej approves execution.

Recommended role split:

- **Alej:** product owner, account purchasing/reauth approvals, green-light gates.
- **Dexter/OpenClaw:** operator/orchestrator, memory/team coordination, safety gate.
- **Jack/Hermes:** parallel runtime adapter consumer, plan/review/security counterweight, bridge coordination.
- **Codex:** code owner, implementation, tests, PR-ready diffs, build evidence.

Current blocker:

- Standalone Codex CLI failed with `refresh_token_reused` / `token_expired`.
- Before execution, verify Codex through the OpenClaw/Codex teammate path or reauth standalone Codex.

## 11. Open questions for Alej before build

1. Confirm repo name: `account-center` under `AdSaver-Labs`?
2. Confirm local-first only for v0.
3. Confirm OpenClaw adapter should be first mutating adapter.
4. Confirm Hermes adapter should be second.
5. Confirm Telegram command namespace should be `/account`, with `/auth` compatibility alias.
6. Confirm credential deletion is out of v0.
7. Confirm Codex should implement once its auth/route is verified.

## 12. Green-light checklist

Before implementation starts:

- [ ] Alej buys/adds enough accounts.
- [ ] Sentinel/account status shows enough available usage.
- [ ] Codex teammate route is verified or reauthed.
- [ ] GitHub repo is public and has planning docs.
- [ ] Alej approves Phase 1 only, not broad live routing mutation.
- [ ] First code PR/commit includes tests before live adapter mutation.
