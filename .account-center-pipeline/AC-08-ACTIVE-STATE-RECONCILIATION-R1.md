# AC-08 active-state reconciliation R1

State: PLANNED
Owner: Account Center production coordinator

## Internal issue

The exclusive pipeline pointer remained on the already verified AC-07 executor release gate after current-revision fixture-only review completed. This is a coordinator-state freshness issue, not an upstream OpenClaw limitation or an external blocker. The owned exact-account transaction at `/home/Alej/.openclaw/workspace/3-Resources/codex-account-ops/scripts/codex-auth-delete.py` remains the required native implementation; the absence of an upstream delete subcommand is irrelevant.

## Materially distinct bounded resolution plan

1. Under the exclusive state lock, record AC-07's current-revision fixture-only review as the prior verified merge and advance the sole active pointer to AC-08, the direct Hermes owned-receipt gate.
2. Preserve the candidate unchanged: the fixed owned helper path and trust pin, exact connected-target guard, versioned target-free opaque receipt contract, working Dexter `/auth delete`, locked full Sentinel `/auth` output, and Hermes/Dexter weekly-only policy.
3. Execute AC-08 only with hermetic fixture boundaries: directly stub the Hermes plugin subprocess before each delete request and validate its exact contract output alongside the compiled adapter, CLI/Dexter ChatOps, MCP, and documentation consumers. The native helper, Node ChatOps transport, live runtime, providers, credentials, stores, routes, models, Sentinel, and browser must not be operated.
4. Re-review the persisted state JSON, contract fixtures, helper metadata/hash, and resulting diff; publish only this bounded state reconciliation after all fixture-only QA remains green. On any internal failure, retain AC-08 as PLANNED and add a new bounded remediation plan rather than skipping or relabeling AC-06 as external.

## Executed evidence

- Under the exclusive lock, AC-06 confirmation `db059ccd67ece007a5e0c0e4b2393aaa5842ab61` was verified as an ancestor of both local `main` and `origin/main`; local and remote were identical at `bbaf2b7a418345c47c3f0643189a3b6d758c1070` before this record.
- Static helper inspection only: regular owner-owned `0600` file, uid `1001`, SHA-256 `4c09c926e94500f02f34a19ca80fbec280003227588d2b4f0d1d1085ee7fba37`, matching the adapter pin; `python3 -m py_compile` passed without execution.
- Fresh fixture-only review passed: `npm test` (271 Node fixture/mock tests and 19 Hermes-plugin tests), `npm run test:a11y` (15 fixture-browser/axe tests), and `npm run qa:security` (typecheck/build, full fixture suites, 181 tracked-file secret scan, and 0 high audit vulnerabilities). The suite includes exact owned-delete adapter receipt validation, Dexter ChatOps/MCP parity, and Hermes shared-contract fixture coverage.

No native helper was launched. No live deletion, interactive login, provider request, credential/store write, route/model mutation, Sentinel update, service operation, or live browser action occurred.
