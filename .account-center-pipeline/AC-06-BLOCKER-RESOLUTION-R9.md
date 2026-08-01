# AC-06 R9 — owned-delete release-gate revalidation

## Preserved candidate

The committed Account Center integration uses Dexter’s owned exact-account transaction at `/home/Alej/.openclaw/workspace/3-Resources/codex-account-ops/scripts/codex-auth-delete.py`. The adapter pins its reviewed digest, validates the local owner/type/mode/hash boundary immediately before a mutation, and exports only `opaque-owned-delete`. Hermes remains a transport client of Account Center’s canonical ChatOps `/auth delete` command. Sentinel’s full `/auth` format and the Hermes/Dexter weekly-only policy are locked.

## Internal release-gate issue

The pipeline pointer advanced through the UI release records after AC-06’s prior merge. Before a subsequent release gate may be considered, the exact owned-delete boundary must be revalidated against the current main revision rather than inferred from earlier AC-06 evidence. This is an internal review/QA task; the native helper’s existence is established and is not an upstream-CLI dependency.

## Bounded R9 plan

1. Under the exclusive pipeline lock, preserve the current candidate and record AC-06 as `PLANNED` with fixture-only constraints.
2. Inspect the current Account Center adapter, shared receipt schema, Hermes bridge, Dexter ChatOps surface, and local helper trust attributes. Do not invoke the native helper or access runtime stores.
3. Run targeted owned-delete contract fixtures followed by the complete fixture/mock security QA suite. Confirm no test executes live deletion, interactive login, provider request, route/model mutation, or runtime-store write.
4. Independently review the resulting diff, repository cleanliness, branch/remote equality, and protected Sentinel/weekly-only surfaces. If every check passes, record and publish the AC-06 R9 release evidence; otherwise retain the candidate as `PLANNED` with a new bounded remediation record.

## Completion condition

A current-main, fixture-only review proves the one opaque receipt contract and the single owned transaction path across Account Center, Hermes, and Dexter. No live deletion is in scope.
