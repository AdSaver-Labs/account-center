# Agent Operations Contract

Account Center is designed for people **and** their self-hosted or remote agents. Agents interact with the protected CLI/API contract; they must not scrape the browser dashboard, edit runtime credential stores, or infer a mutation succeeded from prose.

## Trust boundary

- The local browser dashboard and agent API client use the same loopback-only server.
- Each launch has a bearer token. Treat it as a short-lived local secret: keep it in process memory or a platform secret store, never in source, logs, URLs, receipts, chat, or issue text.
- All API responses use `Cache-Control: no-store` and contain redacted operational metadata only.
- Account Center manages **Account Center only**. It does not provide a back door to update Hermes, OpenClaw, Codex, a provider account, or arbitrary host processes.

## Mandatory agent workflow

1. **Discover before action.** Fetch `GET /api/capabilities` with the bearer token before attempting any operation.
2. **Respect the returned state.** `available` is the only currently executable state. `blocked`, `unsupported`, `failed`, and `UNPROVEN` are all non-success. Do not retry a mutation blindly.
3. **Read status.** Fetch `GET /api/status`; validate `schemaVersion` and the `noSecrets` assertion before using its contents.
4. **Use preview first.** When a mutation endpoint becomes available, call its explicit dry-run/preview path before asking the operator to confirm.
5. **Confirm exact scope.** Never widen an action from a named runtime/profile/agent/session to `all`. Require an explicit `all` scope and confirmation where supported.
6. **Use idempotency.** Every future mutation request requires an agent-generated idempotency key. Reuse the same key only to recover the same interrupted request; create a new key for a newly reviewed request.
7. **Require proof.** Treat a request as applied only when its result union says `applied` **and** verification proof is present. A missing/stale proof is `UNPROVEN`, not success.
8. **Record redacted evidence.** Save request/audit IDs and receipt references, not raw response dumps, secrets, device codes, emails, or filesystem paths.

## Capability discovery

```bash
curl --fail --silent --show-error \
  -H "Authorization: Bearer $ACCOUNT_CENTER_LAUNCH_TOKEN" \
  http://127.0.0.1:4317/api/capabilities
```

Current capability schema:

```json
{
  "schemaVersion": "account-center.agent-capabilities.v1",
  "target": "account-center",
  "actions": [
    { "id": "status", "mode": "read", "state": "available" },
    { "id": "account.delete", "mode": "mutation", "state": "blocked" }
  ]
}
```

The action catalog is authoritative for the running server. Agents must not assume that a planned UI/API feature exists merely because it appears in a roadmap.

## Current safe operations

| Surface | Operation | State | Agent rule |
|---|---|---|---|
| API | `GET /api/capabilities` | Available | Discover behavior before every workflow. |
| API | `GET /api/status` | Available | Read-only; validate schema and redaction assertion. |
| API | `POST /api/auth-challenges/:id/cancel` | Available for an existing local challenge only | Browser-origin request plus bearer token required; response is `account-center.auth-challenge-cancel.v1` and contains only redacted lifecycle metadata. This cancels Account Center's local challenge record; it does not alter runtime credentials. |
| CLI | `status`, `guard`, provider probes | Available | Prefer `--json` for machine handling. |
| CLI/chat | `/auth ... --dry-run` | Available where adapter supports it | Preview only; no mutation. |
| Credential delete | `account.delete` | Blocked | Do not work around this. The installed OpenClaw CLI has no stable exact-profile deletion API; Account Center will not call private bundled internals or edit SQLite. A native exact-profile API, atomic transaction/recovery, and authoritative post-delete proof are required. |
| Routing/model/guided-auth start or runtime mutation | Planned / `UNPROVEN` | Not available through the API yet | Do not invoke private scripts as a substitute. Durable challenge lifecycle metadata and cancellation are redacted local control-plane operations; neither proves a runtime mutation is available. |
| Update Center apply | Blocked | Not available | Release provenance, packaging, backup, supervisor, and health proof are prerequisites. |

## Result-state handling

| Result | Meaning | Required agent behavior |
|---|---|---|
| `dry_run` / `planned` | Nothing changed. | Present impact to the operator; request explicit confirmation before a new live request. |
| `applied` + verified proof | Change completed and was verified. | Record the redacted receipt/audit reference. |
| `blocked` | Safety policy stopped the request. | Explain the structured reason; do not bypass it. |
| `unsupported` | This runtime cannot safely perform the operation. | Use only an API-supplied manual fallback, if any. |
| `failed_no_change_verified` | An attempted operation did not persist a change. | Report failure; no retry without a new review. |
| `UNPROVEN` / `recovery_required` | Outcome cannot be established safely. | Stop automation; preserve receipt/transaction ID and escalate to the operator. |

## Prohibited agent behaviors

- Passing a raw OAuth/device code, API key, refresh token, cookie, account email, or password to Account Center logs, chat, receipt text, or URL.
- Editing `auth-profiles.json`, `auth-state.json`, SQLite rows, Sentinel snapshots, sessions, prompts, memory, bootstrap, or workspace files directly to imitate an Account Center action.
- Driving mutations by scraping or clicking an undocumented browser UI control when no protected API capability is advertised.
- Treating a command exit code, open port, or status snapshot alone as proof of a destructive mutation.
- Calling `git pull`, `npm install`, a branch/ref, a custom URL, or a shell command through the Update Center.
- Updating Hermes, OpenClaw, or Codex through Account Center.

## Integration guidance

Self-hosted agents should call the loopback API directly. Remote agents should use a user-controlled secure bridge that terminates on the same host; never expose the Account Center server publicly or forward its bearer token through an untrusted relay.

The browser UI is for operator review and confirmation. The API is the integration surface. Future mutation endpoints will use structured request/response schemas, confirmation tokens bound to a reviewed operation, CSRF/origin protections where applicable, request-size limits, and redacted receipts.
