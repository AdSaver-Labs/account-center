# SC-01 — explicit runtime/scope everywhere R1 review

**Result:** APPROVED — public runtime selectors are now a closed, fail-closed contract; no protected consumer can use an adapter-specific runtime key as a context selector.

## Specification and safety review

- `/api/limits`, `/api/models`, `/api/auth-challenges`, `/api/audit`, and `/api/mutation-operations` admit only the established public labels (`codex`, `generic-command`, `hermes`, `openclaw`). Any custom/private, mixed-case, repeated, malformed, or scope-only selector is rejected before a protected context can be chosen.
- The scope rules remain explicit: inventory/challenge named scopes require their concrete runtime, default-scope inventory requires authoritative observed evidence, and audit/operation scope-kind filters require runtime.
- New fixture coverage sends a syntactically safe `custom:` runtime through all five protected paths and proves each returns fixed `400 {"error":"invalid_query"}`.
- AC-06 remains unchanged: Account Center retains the Alej-owned `codex-auth-delete.py` transaction, the sole target-free `opaque-owned-delete` receipt, and fixture-only Hermes/Dexter parity. The Sentinel `/auth` status format and Hermes/Dexter weekly-only policy are untouched.

## QA evidence

- Independent read-only review: **PASS**.
- `npm test`: 271 Node tests, 19 Hermes-plugin tests, and 5 temporary-HOME owned-delete tests passed.
- `npm run qa:security`: passed typecheck/build, the same fixture suites, 15 Playwright/axe tests, secret scan (193 tracked files), and `npm audit --audit-level=high` (0 vulnerabilities).
- Helper identity check passed without execution: regular file, owner `Alej`, mode `0600`, pinned SHA-256 `76877f63f2bdf82bc8c156ae47f4e7aafa09e9b91389d6b15a2e89eb8d82eb70`; `python3 -m py_compile` passed.
- No live credential deletion, interactive login, provider request, route/model mutation, Sentinel operation, or service operation occurred.
