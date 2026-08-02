# AC-06 active-state reconciliation R1

State: PLANNED
Owner: Account Center production coordinator

## Internal issue

The exclusive coordinator state selects AC-06 as the active release gate even though the checked-in AC-06 release record says `MERGED`. This is a coordinator evidence/freshness inconsistency, not an upstream OpenClaw capability issue and not an external blocker. The owned exact-account transaction at `/home/Alej/.openclaw/workspace/3-Resources/codex-account-ops/scripts/codex-auth-delete.py` remains the required native implementation; no upstream CLI delete command is required.

## Materially distinct bounded resolution plan

1. Under the exclusive pipeline lock, reconcile the active checkpoint with the current `main` ancestry and verify that the owned helper is a regular, owner-owned `0600` file whose SHA-256 remains pinned by the Account Center adapter.
2. Re-run the complete fixture/mock cross-consumer acceptance surface: exact canonical argv and exact-target rejection in the OpenClaw adapter; the versioned target-free opaque receipt contract; CLI/ChatOps/MCP/Dexter/Hermes acceptance of only the two canonical output strings; fixed full Sentinel `/auth` status rendering; and Hermes/Dexter weekly-only capacity behavior.
3. Run deterministic build, Node/Hermes fixture tests, accessibility proof, and security QA. Native-helper execution is prohibited: all transaction results must come from mocked runners/fixtures, and no account, credential, routing, provider, Sentinel, or service state may be changed.
4. Record factual review evidence and retain AC-06 as the sole `PLANNED` checkpoint until its state record and this review are committed and the resulting merge is verified. No checkpoint may be skipped or relabeled as externally blocked.

## Executed evidence

- Locked state JSON parsed and the prior AC-05 release records `51489fc` and `49ffcf0` are ancestors of `main`.
- Helper trust inspection passed without invocation: regular file, owner `Alej`, mode `0600`, SHA-256 `4c09c926e94500f02f34a19ca80fbec280003227588d2b4f0d1d1085ee7fba37`, matching `OWNED_OPENCLAW_DELETE_SHA256`.
- `npm test` passed: 271 Node fixture/mock tests and 19 Hermes-plugin tests. This includes mocked exact native argv, receipt validation/fail-closed cases, shared Dexter ChatOps/MCP parity, the Hermes fixture bridge, normal `/auth` status rendering, and weekly-only inventory coverage.
- `npm run test:a11y` passed: 15 fixture-browser/axe tests.
- `npm run qa:security` passed: typecheck/build, the full fixture suites, 15 browser tests, secret scan of 179 tracked files, and `npm audit --audit-level=high` with 0 vulnerabilities.

No native helper was launched. No live deletion, interactive login, provider request, credential/store write, route/model mutation, Sentinel update, service operation, or live browser action occurred.
