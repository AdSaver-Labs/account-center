# UI-01 — Native Codex visual-system ownership review

State: APPROVED
Owner: Account Center production coordinator
Reviewed at: 2026-08-01T08:10:15Z

## Scope and provenance

The isolated native Codex UI worktree at `/tmp/account-center-codex-ui` was restored from its tracked `HEAD` after an interrupted local checkout left only tracked-file deletions. It is clean. Its native visual-system tip `02b03ed94fc99b61967c914f963574cb26d9a8bb` is an ancestor of this protected main checkout, so the production UI surface is attributable to that worktree rather than an unreviewed local overlay.

The reviewed surface is `packages/cli/src/server.ts`, with focused contract coverage in `packages/cli/src/control-panel.test.ts` and fixture/browser coverage in `tests/browser/account-center.a11y.spec.mjs`. It implements the documented dark token layer; visible focus; semantic tabs, landmarks, dialog focus restoration, and keyboard navigation; 320/430/760/desktop reflow; and literal, non-success `UNPROVEN` protected/unavailable states.

## Independent coordinator review

- **Spec:** approved. The rendered token values, status language, responsive constraints, and accessible control semantics align with `docs/ACCOUNT_CENTER_UI_IMPLEMENTATION_SPEC.md`.
- **Quality:** approved. Native worktree ancestry is proven; the worktree is clean; `git diff --check` is clean; the release checkout has no uncommitted implementation change beyond the planned pipeline state/evidence.
- **QA/security:** passed through `npm run qa:security`: build/typecheck, 268 Node fixture/mock tests, 19 Hermes-plugin tests, 15 Playwright/axe fixture-browser tests, 163-file secret scan, and `npm audit --audit-level=high` (0 vulnerabilities). The browser suite explicitly passed truthful protected states, malformed-data-to-`UNPROVEN`, keyboard/dialog behavior, axe, and no horizontal overflow at all required viewports.

## Locked boundaries

The verification compile-checked `/home/Alej/.openclaw/workspace/3-Resources/codex-account-ops/scripts/codex-auth-delete.py` only; it did not invoke it. No live deletion, interactive login, provider request, credential/store write, route/model mutation, browser operation against a live runtime, or service operation occurred.

The owned exact-account transaction remains the only Account Center/OpenClaw delete implementation. The shared versioned receipt stays target-free and exact: `account-center.owned-delete-receipt.v1` / `opaque-owned-delete`. Full Sentinel `/auth`, working Dexter `/auth delete`, and Hermes/Dexter weekly-only behavior are unchanged.
