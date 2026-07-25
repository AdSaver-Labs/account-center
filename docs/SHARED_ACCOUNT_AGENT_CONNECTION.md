# Shared Account Inventory and Agent Connection

## Product outcome

A user connects accounts to Account Center once. After connecting an agent, the agent can see the **same redacted account inventory**, weekly availability, eligibility, routing state, and recovery guidance.

Account Center is the authority for account identity and allocation decisions. It never exports OAuth tokens, API keys, refresh tokens, cookies, or credential files.

## Connection model

```text
Account Center account record
  -> agent connection (runtime + exact scope)
  -> scoped account lease/reference
  -> runtime adapter resolves its protected local credential
  -> verified availability/routing result returns to Account Center
```

Each agent must be explicitly connected once. An account can be visible to several connected agents, but each agent has an independent scoped lease and runtime verification. A visible account is not falsely presented as usable until that agent's adapter proves it can resolve the corresponding local credential.

## Canonical redacted contract

`GET /api/agent-connections` returns `account-center.agent-connections.v1`. It contains only opaque `connection-*` and `account-*` references, exact runtime/scope, connection state, weekly capacity, route state, and local onboarding guidance. It contains no email, profile label, provider credential, OAuth artifact, or five-hour availability window.

When an adapter resolves a local credential for one exact account, Account Center returns a `account-center.scoped-account-lease.v1` record. A lease is valid only for its listed runtime and scope. It is not transferable to another agent or runtime. `needs-auth` is the required state for an unresolved local credential, even when the same redacted account is usable in a different runtime.

The endpoint is bearer-protected and read-only. It offers a displayed `account-center connect-agent --runtime <hermes|openclaw> --scope <scope>` command as local onboarding guidance; this release does not execute it and does not alter credentials, routing, or services.

## User onboarding in the app

The app must provide **Connect an agent** instructions for Hermes and OpenClaw:

1. Select the runtime and exact agent scope.
2. Run the displayed local connection command or approve the local adapter request.
3. Account Center verifies the redacted inventory and shows connected / needs-auth / unavailable state.
4. If the agent has no matching local credential, show an exact supported reauthentication action; never advise copying a token between agent stores.
5. Show the same weekly-only account status and route selection model for every connected agent.

## Automation capacity policy

Scheduled Account Center work has a per-agent stateful gate. The source of
truth is `account-center.automation-capacity-export.v1`; its persistable
`state` member is `account-center.automation-capacity-state.v1`.

The no-agent cron gate calls the local core export and retains its `state`
member between runs:

```ts
const current = automationCapacityExport(status, previousState);
persist(current.state); // only after the cron gate accepts this decision
```

The output exposes only `connection-*` references, runtime, scope, capacity
state, worker action, proof classes, and a transition-only notification. The
persisted file contains only opaque agent references and last states; it does
not retain a notification, account/profile identifier, email, credential,
token, or five-hour window.

An agent is **available** only when all of these are true for the same exact
runtime/scope: its local connection is verified, a usable mapped account is
readable/authenticated, runtime evidence is freshly `verified`, and provider
evidence is freshly `available`. An active credential marker alone is never
runtime or provider evidence. Absent/invalid evidence blocks and pauses work.

For each agent independently:

- provider capacity first becomes unavailable -> one notification, workers pause;
- unchanged unavailable -> silent monitoring;
- recovery after verified runtime **and** provider evidence -> workers resume and one recovery notification;
- scheduler exceptions are local-only and must never bypass the stateful notifier.

The state file must be updated only after the cron gate has accepted the local
decision. If the existing file is malformed or unreadable, the CLI returns a
blocked result and emits no notification decision; it does not reset the state
and risk a duplicate alert.

## Verification requirements

- fixture: one Account Center account visible through connected Hermes and OpenClaw adapters;
- fixture: Hermes unresolved credential is `needs-auth`, never silently borrowed from OpenClaw;
- fixture: successful Hermes adapter verification creates a scoped lease without secret output;
- fixture: availability/routing display is weekly-only across app, Hermes, and OpenClaw;
- fixture: blocked -> unchanged blocked -> recovery yields exactly one alert, silence, one recovery.
