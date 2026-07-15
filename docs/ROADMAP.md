# Roadmap

Account Center is intended to become a finished local-first account/subscription control plane for *any* AI agent runtime. The command/API layer comes before the dashboard; every UI or chat bridge should call the same policy engine.

## Completed foundation

### Phase 0 — Planning and team alignment

- Published planning repo.
- Asked Codex engineering teammate for independent research/plan.
- Asked Dexter for operator/orchestration suggestions.
- Merged best ideas into `docs/TEAM_DECISION.md` and `docs/FINAL_MERGED_PLAN.md`.

### Phase 1 — Core schemas, redaction, guard, checkpoint gate

- TypeScript monorepo.
- Provider/runtime/profile/usage/route/policy/lease/reauth/audit schemas.
- No-secret redaction library.
- Fixture-backed status export.
- `account-center status`, `guard`, dry-run route/account/model commands.
- `.account-center/status.json` and `.account-center/gate.json` checkpoint writer.

### Phase 2 — `/auth` manual bridge

- Actual `/auth` parser over the CLI.
- `/auth status`, `/auth accounts`, `/auth next`, `/auth auto`, `/auth use`, `/auth remove`, `/auth disable/enable`, `/auth model disable/enable`, `/auth doctor`, `/auth audit`.
- Old manual command name is rejected, not promoted.

### Phase 3 — generic adapter + automatic guard foundation

- `generic-command` runtime source.
- External agent status command contract via `ACCOUNT_CENTER_GENERIC_COMMAND`.
- Live apply is blocked until a protected native adapter supplies server-owned scope, review confirmation, idempotency, durable redacted receipt/audit, and authoritative post-operation proof.
- `guard --ensure-route` / `/auth ensure` to let agents automatically request the right account route from current usage policy.
- Example generic adapter script under `examples/generic-agent-status.mjs`.

## Remaining product path

### Phase 4 — OpenClaw live mutation hardening

Goal: make Account Center safely change Dexter/OpenClaw routing when explicitly requested or when an agent guard uses `--ensure-route --apply`.

Work:

- Formalize OpenClaw apply receipts and rollback pointers.
- Add per-runtime locks so Telegram/Jack/Dexter/Codex cannot race account switches.
- Back up auth-order/routing state before every live mutation.
- Write rollback pointers into every live apply receipt.
- Add dedicated test-runtime fixtures before touching real runtime state.
- Support `routes auto/use/remove --source openclaw --apply` as the first real apply surface.

Exit criteria:

- live OpenClaw route apply is verified against fixture/test runtime;
- real runtime apply is explicit, receipt-backed, rollback-aware, and does not touch sessions/prompts/memory/bootstrap.

### Phase 5 — provider/subscription probes

Goal: understand usage across different subscription/account types without spending tokens where possible.

Work:

- Probe contract for providers: OpenAI/Codex, Anthropic, OpenRouter, GitHub Copilot, LiteLLM-compatible gateways, custom subscriptions.
- CLI/manual probe surface: `providers probe` and `/auth probe`.
- Normalize usage windows: 5h, daily, weekly, monthly, credits, RPM/TPM, budget remaining, unknown.
- Support no-token probes first; optional canary probes must be explicit and visible.
- Add staleness, cooldown, and confidence scoring.

Exit criteria:

- accounts from multiple provider/subscription styles normalize into one `UsageSnapshot` model;
- policy can rank accounts even when some usage windows are unknown.

### Phase 6 — real `/auth` Telegram/ChatOps service

Goal: Alej can operate Account Center directly from Telegram through the same CLI/API core.

Work:

- Telegram/Hermes command bridge that shells to or imports `account-center auth`.
- Local raw-message wrapper `scripts/chatops.mjs` as the first integration seam.
- Rich short replies with account metrics and receipt IDs.
- Confirmation flow for `--apply`, backup-only accounts, and force operations.
- Audit log delivery and rollback hints.

Exit criteria:

- `/auth status`, `/auth accounts`, `/auth next`, `/auth auto`, `/auth use`, `/auth remove`, `/auth doctor` work from Telegram.

### Phase 7 — reauth/add queue

Goal: add and repair accounts from chat/CLI without leaking credentials.

Work:

- Provider-neutral reauth challenge lifecycle.
- Device-code URL/code/expiry display.
- Runtime adapter owns actual credential persistence.
- Polling and expiry states.
- Add/remove from routing stays separate from credential deletion.

Exit criteria:

- `/auth add` and `/auth reauth` can start, track, expire, and report without printing tokens.

### Phase 8 — Hermes, Codex, and more native runtime adapters

Goal: every main agent can consume the same account policy and route safely.

Work:

- Hermes adapter: credential-pool status, active account, safe route apply where supported.
- Codex adapter: standalone CLI/app auth health, selected profile, route/usage status.
- Codex `/auth` parity/control bridge: Codex MCP can call Account Center today and live mutations are intentionally enabled through Account Center guardrails. Literal `/auth` in the Codex TUI/app is convenience, not the product foundation; add a Codex plugin/app-server/TUI patch only when stable. Primary product direction is the Account Center app/control panel described in `docs/ACCOUNT_CENTER_CONTROL_APP_STRATEGY.md`.
- PI agent adapter: native status/apply once the real PI runtime status and switch commands are identified.
- Odysseus / PewDiePie harness adapter: native status/apply once the harness account/subscription APIs are identified.
- Generic command adapter remains the SDK for future agents.
- LiteLLM adapter maps virtual keys, budgets, model access, and rate limits.

Exit criteria:

- Jack/Hermes, Dexter/OpenClaw, Codex colleague, and at least one generic adapter all expose status through the same commands.

### Phase 9 — automatic policy daemon

Goal: agents can automatically switch based on usage/capacity without manually asking Alej every time.

Work:

- Local daemon or scheduled guard runner.
- Watches status snapshots and provider probes.
- Applies route changes only within policy: eligible account, not backup-protected, known usage, lock acquired, receipt written.
- Emits bridge events for Jack/Dexter/Codex shared awareness.

Exit criteria:

- when active account falls below threshold and another account is eligible, Account Center can switch routes automatically under policy and write a receipt.

### Phase 10 — local API/server

Goal: all apps and bridges use one stable local API instead of shelling directly.

Work:

- Local HTTP API for status, guard, routes, accounts, leases, audit, reauth.
- Authn/authz for local clients.
- Streaming/events for dashboard and agents.
- Same command router and policy engine as CLI.

Exit criteria:

- CLI, Telegram bridge, and future dashboard can all use the same local API.

### Phase 11 — dashboard/app MVP

Goal: visual Account Center.

Work:

- Accounts table.
- Active route and next eligible route.
- Usage windows by provider/subscription.
- Policy editor.
- Reauth queue.
- Audit log and receipts.
- Adapter health panel.
- Always-on account limit overlay: optional FPS-counter-style floating widget pinned above other apps/tabs to monitor active account, 5-hour/week windows, reset times, and warnings. It should also support a macOS top-right menu-bar/status node: hover reveals a compact active-account limits panel, and an **Always on** button pops it out into the movable overlay. See `docs/INTERFACE_NOTES.md`.

Exit criteria:

- dashboard performs no standalone mutation logic; it only calls the API/command router;
- interface planning explicitly revisits the always-on account limit overlay before scope is finalized.

### Phase 12 — production hardening and open-source release

Goal: make Account Center safe for other people and agent runtimes.

Work:

- Security review.
- CI release builds.
- Installation docs.
- Adapter SDK docs.
- Fixture corpus for common auth/status shapes.
- Backup/restore docs.
- Example integrations.

Exit criteria:

- a new user can install Account Center, connect an adapter, run `/auth status`, and safely route agents without exposing credentials.
