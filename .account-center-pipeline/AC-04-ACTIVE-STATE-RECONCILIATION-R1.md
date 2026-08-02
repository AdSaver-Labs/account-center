# AC-04 active-state reconciliation R1

State: PLANNED
Candidate preserved: AC-04 fixture-only reauth-completion release evidence, including the already merged AC-04 implementation and its owned-delete carry-forward invariant.

## Internal issue

The exclusive pipeline state still selected AC-04 as `PLANNED`, although the AC-04 implementation/evidence release commit `79a832d` is an ancestor of current `main`. This is a coordinator metadata inconsistency, not an external delete dependency and not a reason to re-run or alter the native delete transaction.

## Materially distinct bounded resolution plan

1. Verify only Git ancestry and tracked pipeline records for the AC-04, AC-06, and AC-09 releases; retain all existing implementation and carry-forward evidence.
2. Re-run the existing fixture-only contract/QA evidence before changing selection: Account Center adapter, Dexter ChatOps/MCP, Hermes bridge, Sentinel `/auth`, and weekly-only capacity behavior must remain covered; inspect/compile but never invoke the owned helper.
3. Validate the state JSON under the coordinator lock and use an atomic locked replacement to select the next unmerged release record, AC-05, as the sole `PLANNED` checkpoint. The selection changes no runtime code, receipt contract, credentials, routes, models, or stores.
4. Review the resulting metadata-only diff and commit the reconciliation only after all evidence is green.

## Executed evidence

- `79a832d` (AC-04), `9573fef` (AC-06), and `22ec6c8` (AC-09) are ancestors of current `main`.
- Fixture-only verification passed: `npm test` (271 Node fixture/mock tests and 19 Hermes-plugin tests), `npm run test:a11y` (15 fixture-browser/axe tests), and `npm run qa:security` (typecheck/build, the same tests, 177 tracked-file secret scan, and `npm audit` with 0 vulnerabilities).
- Static trust check passed: the owned helper is a regular owner-owned `0600` file, SHA-256 `4c09c926e94500f02f34a19ca80fbec280003227588d2b4f0d1d1085ee7fba37`; `py_compile` passed for it and the Hermes bridge.
- `git diff --check` and locked JSON parsing passed.

No native helper invocation, live deletion, interactive login, provider request, credential/store write, routing/model mutation, runtime service operation, or live browser action occurred.
