# Architecture

Account Center is an agent-agnostic account control plane. The core never directly knows where a runtime stores OAuth tokens or API keys; it only talks to adapters.

## Layers

```text
Chat/CLI/Web/API
   ↓
Command Router + Approval Gates
   ↓
Policy Engine + Account Registry + Audit Log
   ↓
Provider Probes        Runtime Adapters
(OpenAI, Anthropic,    (OpenClaw, Hermes,
 OpenRouter, etc.)      generic command, LiteLLM)
   ↓                    ↓
Usage/health status    Runtime-specific auth order / reauth / model policy
```

## Core modules

| Module | Responsibility |
|---|---|
| Account Registry | Non-secret provider/profile metadata, labels, roles, routing state. |
| Provider Probe | Reads usage/health windows without invoking LLM generation when possible. |
| Policy Engine | Selects next route, enforces backup-only and cooldown rules. |
| Runtime Adapter SDK | Contract for list/use/remove/reauth/verify in any agent runtime. |
| Command Router | Normalizes CLI, HTTP, Telegram, Slack, Discord, and webhook commands. |
| Audit Log | Durable receipts for every mutation. |
| Dashboard API | Local-first UI and REST API. |

## Adapter contract

```ts
export interface RuntimeAdapter {
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

## Provider probe contract

```ts
export interface ProviderProbe {
  id: string;
  probe(profile: ProfileRef): Promise<UsageHealthResult>;
  supportsNoTokenUsageProbe: boolean;
}
```

A probe must state whether it spends LLM/model tokens. Account Center should prefer no-token usage endpoints and warn before using generation canaries.

## Local state

Recommended v0 local DB: SQLite.

Tables:

- `accounts`
- `providers`
- `runtime_adapters`
- `routing_policies`
- `model_policies`
- `usage_snapshots`
- `leases`
- `reauth_challenges`
- `audit_events`

## Status export

Agents that should only read status can consume a JSON export:

```json
{
  "generatedAt": "...",
  "accounts": [],
  "routes": [],
  "warnings": [],
  "noSecrets": true
}
```

## Safety boundaries

- Core stores handles, never raw OAuth tokens.
- Adapters may access secrets but must redact outputs.
- Mutations require explicit `--apply` or confirmed chat command.
- Backup-only account usage requires confirmation.
- Runtime sessions/prompts/memory/bootstrap/config are out of scope unless a runtime adapter has a narrow, approved account-routing operation.
