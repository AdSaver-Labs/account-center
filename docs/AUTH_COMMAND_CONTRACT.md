# Account Center `/auth` Command Contract

**Status:** canonical v0 contract  
**Last updated:** 2026-07-13

Account Center exposes the same account, model, routing, and guided-auth actions through CLI, ChatOps, MCP, local API, and the app UI. All surfaces must call the same command executor/policy layer; UI/API/MCP must not duplicate mutation logic.

## Manual command namespace

The manual/chat compatibility command is:

```text
/auth
```

`/oauth` is invalid and must be rejected with a message that the manual command is `/auth`.

## Command matrix

| Command | Class | Manual default | Preview | Required guards |
|---|---|---|---|---|
| `/auth` | read | read-only | n/a | no secrets |
| `/auth status` | read | read-only | n/a | no secrets |
| `/auth list` / `/auth accounts` | read | read-only | n/a | no secrets |
| `/auth next` | read | read-only | n/a | no secrets |
| `/auth auto` | route mutation | live apply | `--dry-run` | eligible target, runtime lock, receipt, proof |
| `/auth use <target>` | route mutation | live apply | `--dry-run` | exact connected target, runtime lock, receipt, proof |
| `/auth remove <target>` | route mutation | live apply | `--dry-run` | exact connected route target, routing-only, receipt, proof |
| `/auth delete <target>` | credential mutation | live apply | `--dry-run` | exact connected credential target, backup, receipt, proof |
| `/auth add <email>` | guided auth | create local guided challenge | n/a | explicit observed runtime/default scope, valid email, mode-specific idempotency, no raw tokens |
| `/auth reauth <email>` | guided auth | create local guided challenge | n/a | explicit observed runtime/default scope, valid email, mode-specific idempotency, no raw tokens |
| `/auth reauth status [id]` | read | read-only | n/a | no secrets |
| `/auth reauth cancel <id>` | guided auth mutation | cancel challenge | n/a | scoped challenge id, receipt |
| `/auth probe` | read/probe | read-only probe | n/a | no model-token spend unless explicit |
| `/auth audit` | read | read-only | n/a | redacted |
| `/auth doctor` | read | read-only | n/a | redacted diagnostics |
| `/auth model list` | read | read-only | n/a | no secrets |
| `/auth model status` | read | read-only | n/a | no secrets |
| `/auth model use <model>` | model mutation | dry-run until implemented per runtime | `--dry-run` | model catalog/probe support, runtime lock, proof |
| `/auth model auto` | model mutation | dry-run until implemented per runtime | `--dry-run` | supported model choice, runtime lock, proof |
| `/auth model fallback add/remove/clear ...` | model mutation | dry-run until implemented per runtime | `--dry-run` | scoped runtime, backup, proof |
| `/auth model disable/enable <provider/model>` | policy mutation | lower-level dry-run unless `--apply` | n/a | receipt |

## Terminology

- **remove** means remove from routing only. It does not delete credentials.
- **delete** means credential deletion. It requires exact connected-target match and backup first.
- **add** creates a durable local guided-auth challenge for a new account. It does not add credentials or route an account in this build.
- **reauth** creates a durable local guided-auth challenge for an existing/broken/expired account. It does not refresh credentials in this build.
- **model use** means change a runtime/scope model selection, not account credentials.

## Runtime/scope semantics

| Runtime | Scope examples | Notes |
|---|---|---|
| Hermes / Jack | `profile:default`, future `session:<id>` | App and terminal must support Hermes. Existing sessions may keep old model until new session/restart. |
| OpenClaw / Dexter | `agent:main`, `agent:qa-manager`, `agent:test-engineer`, `all` | Never mutate sessions/prompts/memory/bootstrap. Named-agent and `all` changes require clear scope display. |
| Codex | `default`, future `chat:<id>`, future `session:<id>` | Codex is chat/session/default oriented, not OpenClaw-agent oriented. Chat/session writes are read-only until capability-detected. |

## Guided auth lifecycle contract

`/auth add` and `/auth reauth` must preserve mode internally. They must not both collapse into an indistinguishable `reauth start` command.

Challenge uniqueness key:

```text
provider + runtime + normalizedEmail + scopeKind + scopeId
```

Account Center challenge state is authoritative for the app/API. Runtime worker/session/result files are adapter artifacts reconciled back into Account Center state.

The supported local initiation endpoint is bearer-protected, same-origin `POST /api/auth-challenges`. Its JSON body is exactly `mode`, `provider`, `runtime`, `scope`, and `target`; only an observed runtime with the authoritative `default` scope is currently accepted. `target` is a valid email used only to derive the durable mode-specific uniqueness key and is never returned or stored. Replaying the same active mode/provider/runtime/email/scope returns the existing redacted challenge with `idempotent: true`; `add` and `reauth` never share that key.

Terminal lifecycle actions use bearer-protected, same-origin, body-free `POST /api/auth-challenges/:id/complete` and `POST /api/auth-challenges/:id/fail`. They are available only when a server-owned local verifier adapter observes the matching terminal outcome. The response contains only the redacted challenge plus `{ outcome, verificationState: "verified" }`; replaying the same terminal action is idempotent, and cancelled or expired challenges reject terminal transitions. No endpoint accepts or returns OAuth payloads, credentials, identity data, or device codes.

## Post-operation proof

Mutations must report one of:

```text
verified
unproven
failed
```

Never print success when proof is missing. Use `UNPROVEN` if the runtime mutation returned but read-only verification could not confirm the result.

## App button equivalents

| App action | Command equivalent |
|---|---|
| Refresh status | `/auth` |
| Auto-switch account | `/auth auto` |
| Use account | `/auth use <target>` |
| Remove from routing | `/auth remove <target>` |
| Delete credentials | `/auth delete <target>` |
| Add account | `/auth add <email>` |
| Reauth account | `/auth reauth <email>` |
| Probe model | `/auth model probe <model>` or model validation API |
| Use model | `/auth model use <model> --runtime <runtime> --scope <scope>` |

## Redaction

Local app UI may display exact emails to Alej. Logs, receipts, MCP/shared summaries, and non-local error text should redact exact emails unless exact display is required for an operator action.
