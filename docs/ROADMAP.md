# Roadmap

## Phase 0 — Planning and team alignment

- Publish planning repo.
- Ask Codex engineering teammate for independent research/plan.
- Ask Dexter for operator/orchestration suggestions.
- Merge best ideas into `docs/TEAM_DECISION.md`.

## Phase 1 — Core schemas and dry-run CLI

- Define account/profile/provider/model policy schemas.
- Implement local SQLite store.
- Implement audit event receipts.
- Implement `account-center status`, `accounts list`, `routes next` in dry-run/read-only mode.

## Phase 2 — OpenClaw adapter MVP

- List current OpenClaw profiles from sqlite/json stores.
- Read auth order.
- Set auth order with backup/receipt.
- Remove profile from routing without deleting credentials.
- Reuse/port Sentinel status export behavior.

## Phase 3 — Hermes adapter MVP

- List Hermes credential pool entries.
- Reorder/use local Hermes credentials without copying OpenClaw tokens.
- Mark exhausted credentials with cooldown metadata.
- Verify with tiny smoke when explicitly allowed.

## Phase 4 — Chat command bridge

- Telegram command adapter for `/account ...`.
- Dry-run/confirmation flow for mutating operations.
- Reauth challenge lifecycle.
- Audit receipts delivered back to chat.

## Phase 5 — Dashboard MVP

- Accounts table.
- Route policy editor.
- Reauth queue.
- Event/audit log.
- Provider/model compatibility panel.

## Phase 6 — Generic adapter SDK

- Document adapter contract.
- Provide generic command adapter.
- Example integrations for shell-based agents.
- Test harness for adapters.

## Phase 7 — Production hardening

- Security review.
- Redaction tests.
- Backup/restore tests.
- CI release builds.
- Installation docs.
