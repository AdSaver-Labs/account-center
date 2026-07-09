# Account Center Product & Technical Plan

> Working name: **Account Center**
>
> Goal: build an open-source, agent-agnostic app for managing model/provider accounts, usage windows, routing order, reauthentication, and chat/manual controls.

## 1. Executive summary

Account Center turns the current private Sentinel/account-routing workflow into a reusable open-source product. It should let any AI agent or model gateway discover available accounts, understand quota/health, switch to the next eligible account, remove/disable models/accounts from routing, and start reauthentication from CLI, Telegram, or another chat interface.

The product should be **adapter-first**: Account Center owns policies, status, commands, audit logs, and UI; adapters own runtime-specific credential stores and provider-specific OAuth/token details.

## 2. Current private system lessons

The existing VPS system has proven useful patterns:

- A no-token Sentinel polls provider usage and writes a status export.
- Auth switching is separated from model invocation, so status checks do not burn model tokens.
- Manual commands such as `/auth list`, `/auth <email>`, `/auth add <email>`, `/auth remove <email>`, and `/auth auto` are understandable from Telegram.
- Last-resort accounts can be protected by policy.
- Runtime/provider naming drift is a real failure mode: older scripts expected `openai-codex:*`; the current runtime stores ChatGPT/Codex profiles as `openai:*`.
- Legacy JSON auth-state files and sqlite-backed auth stores can coexist during migrations; an app must support both via adapters.
- Agent sessions/prompts/memory/config must be treated separately from account routing. Account Center should never mutate agent work product unless an adapter explicitly asks and the user approves.

## 3. Product principles

1. **Agent-agnostic by default** — no core code assumes Hermes, OpenClaw, Codex CLI, Claude Code, LiteLLM, or any one runtime.
2. **Credential isolation** — core status exports use handles/labels; raw tokens remain in adapter-owned secure stores.
3. **Policy over scripts** — routing and last-resort behavior should be declarative.
4. **Chat-first operations** — every key action should be possible from Telegram/Slack/Discord/webhook text commands.
5. **Human approval for reauth** — OAuth/device-code/2FA steps should be explicit and safe.
6. **Auditable changes** — every switch/reauth/remove action creates an event receipt and backup/rollback pointer where applicable.
7. **Local-first** — first release runs on a VPS or workstation; hosted/cloud mode can come later.

## 4. User personas

| Persona | Need |
|---|---|
| Solo operator | Keep agents running when one model account hits a limit. |
| Agency operator | Protect primary business accounts while routing work through helper accounts. |
| Multi-agent system owner | Share status/routing policy across agents without sharing raw credentials. |
| Open-source agent developer | Add Account Center support through a small adapter. |
| Security-conscious user | Reauth and switch accounts without exposing tokens in chat/logs. |

## 5. Core features

### 5.1 Account registry

Stores non-secret metadata:

- provider key: `openai`, `anthropic`, `openrouter`, `github-copilot`, `custom:*`
- profile/account handle: e.g. `openai:user@example.com`
- display label
- agent/runtime compatibility
- routing role: primary, secondary, backup, monitor-only, disabled
- last health result
- quota windows
- cooldowns
- reauth status

### 5.2 Provider usage Sentinel

Provider-specific probes produce normalized status:

```json
{
  "provider": "openai",
  "profileId": "openai:user@example.com",
  "readable": true,
  "health": "ok",
  "usage": {
    "fiveHourRemainingPct": 97,
    "dailyRemainingPct": 80,
    "weeklyRemainingPct": 77
  },
  "tokenExpiresAt": "2026-07-10T00:00:00Z",
  "errors": []
}
```

Provider adapters may support only partial status. Unknown is allowed, but routing policy can require known usage before selecting an account.

### 5.3 Routing policy engine

Policy decides the next route:

- prefer eligible primary accounts;
- exclude exhausted/cooldown/error accounts;
- respect last-resort rules;
- support project/agent leases;
- account for model compatibility;
- optionally force a profile for a bounded recovery window.

### 5.4 Runtime adapters

Adapters implement runtime-specific operations:

```ts
interface RuntimeAdapter {
  id: string;
  listProfiles(): Promise<Profile[]>;
  getAuthOrder(provider: string): Promise<string[]>;
  setAuthOrder(provider: string, orderedProfileIds: string[]): Promise<ChangeReceipt>;
  startReauth(profileHint: string, options: ReauthOptions): Promise<ReauthChallenge>;
  removeFromRouting(profileId: string): Promise<ChangeReceipt>;
  verify(profileId?: string): Promise<VerifyResult>;
}
```

Initial adapters:

1. **OpenClaw adapter** — sqlite/json auth store, `openclaw models auth order`, Sentinel compatibility.
2. **Hermes adapter** — Hermes credential pool/auth store, no token copying from OpenClaw.
3. **Generic command adapter** — user supplies shell commands for list/switch/reauth/verify.
4. **LiteLLM-style gateway adapter** — virtual-key/budget/routing integration where available.

### 5.5 Interfaces

- CLI: `account-center status`, `account-center use`, `account-center reauth`, etc.
- HTTP API: `/v1/accounts`, `/v1/routes/next`, `/v1/commands`
- Telegram/chat command bridge
- Web dashboard: Accounts, Providers, Agents, Events, Policies, Reauth Queue
- JSON status export for agents that only need read access

## 6. Manual commands

See `docs/COMMANDS.md` for the operator-facing command set.

Minimum chat commands:

```text
/account status
/account list
/account use <profile|email|label>
/account auto
/account next
/account remove <profile|email|label>
/account disable <profile|email|label>
/account enable <profile|email|label>
/account reauth <profile|email|label>
/account models
/account model disable <provider/model>
/account model enable <provider/model>
/account policy
/account doctor
```

## 7. Security model

### 7.1 Secret boundaries

Core Account Center stores:

- account handles
- public labels
- usage/health summaries
- routing order
- audit receipts
- non-secret OAuth challenge metadata

Adapters store or access:

- OAuth access/refresh tokens
- API keys
- browser cookies/session state
- provider-specific secret stores

Core status exports must never contain raw credential material.

### 7.2 Redaction rules

- redact token-like strings in logs;
- do not print provider auth blobs;
- status exports use profile IDs only;
- chat responses include device URLs/codes only when intended for human reauth;
- all destructive operations support dry-run.

## 8. Repository shape

```text
account-center/
  README.md
  ACCOUNT_CENTER.md
  docs/
    ARCHITECTURE.md
    COMMANDS.md
    RESEARCH.md
    ROADMAP.md
    SECURITY.md
  packages/
    core/
    cli/
    server/
    dashboard/
    adapters/
      openclaw/
      hermes/
      generic-command/
      litellm/
  examples/
    openclaw-local.yaml
    hermes-local.yaml
    generic-agent.yaml
  .github/workflows/
    ci.yml
```

## 9. Suggested stack

- TypeScript/Node for CLI/server/dashboard/adapters, because current Sentinel scripts are already JS/MJS and chat/gateway integrations fit well.
- SQLite for local event/account/policy state.
- YAML/JSON config for declarative policies.
- React/Vite or simple server-rendered UI for dashboard.
- Optional Python helper adapters where runtimes already expose Python scripts.

## 10. Implementation milestones

1. Planning seed repo — docs, command contract, architecture, roadmap.
2. Core schema and policy engine — no runtime mutation yet.
3. OpenClaw adapter MVP — list/status/use/auto/remove from routing.
4. Hermes adapter MVP — list/status/use local Hermes credential pool; no cross-copying tokens.
5. Telegram bridge MVP — `/account` commands call CLI/API.
6. Reauth queue MVP — device-code/OAuth challenge lifecycle.
7. Web dashboard MVP.
8. Generic adapter SDK.
9. Team comparison with Dexter/Codex development plan.

## 11. Team workflow with Dexter/Codex dev lead

After this plan is published:

1. Jack asks Dexter and the Codex app/agent dev lead to independently research/plan Account Center.
2. Dexter writes its plan into the Jack↔Dexter bridge or the new repo as a proposal.
3. Jack and Dexter compare plans against:
   - agent-agnostic design;
   - security boundaries;
   - command completeness;
   - implementation feasibility;
   - compatibility with OpenClaw, Hermes, and generic agents.
4. The best merged approach becomes `docs/TEAM_DECISION.md` before implementation begins.

## 12. Open questions

- Should v0 be local-only, or include a hosted dashboard mode from the start?
- Should the canonical config be one file or per-provider/per-runtime fragments?
- Should model enable/disable be global, per account, per provider, or per agent?
- Should Account Center own reauth flows directly or delegate entirely to adapters?
- What exact level of support is needed for non-OAuth API-key providers?
