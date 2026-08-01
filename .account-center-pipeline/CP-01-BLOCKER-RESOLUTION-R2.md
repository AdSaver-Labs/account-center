# CP-01 R2 — locked state-consistency repair

State: PLANNED
Owner: Account Center production coordinator

## Preserved candidate

CP-01's loopback-only, per-launch owner-only token control-plane candidate remains on `main` unchanged. The AC-06 owned native exact-account transaction (`codex-auth-delete.py`), the single `opaque-owned-delete` receipt contract, the full Sentinel `/auth` format, the working Dexter `/auth delete` transport, and the Hermes/Dexter weekly-only policy remain locked and out of scope.

## Internal issue

The prior CP-01 evidence merge succeeded, but the sole active-checkpoint field still names the already-MERGED checkpoint. That leaves the coordinator state internally inconsistent and makes a later gate appear active without a bounded current record. This is a pipeline-record integrity issue; it is not an external dependency and does not justify changing any protected implementation or policy.

## Bounded R2 plan

1. Under the exclusive coordinator lock, preserve the existing CP-01 candidate and move the sole active record to `PLANNED` with this state-consistency plan.
2. Verify the checked-out and upstream revisions, the exact CP-01 evidence commits, and JSON schema/state invariants; limit edits to this plan and the pipeline state record.
3. Re-run the focused owned-delete contract fixtures plus deterministic build/test/security gates to independently prove the protected AC-06/Hermes/Dexter boundary remains intact while reconciling coordinator metadata. The native helper is never run and all subprocesses in delete tests remain fixtures/mocks.
4. Review the narrow diff and protected-contract invariants. If every check passes, record the verified reconciliation evidence, commit and push only the pipeline records, and verify `origin/main` equality. Otherwise retain the candidate as `PLANNED`.

## Completion condition

One consistent, locked CP-01 release record names the verified upstream commit and contains reproducible fixture-only evidence. No live deletion, interactive login, provider request, credential/store write, routing/model mutation, non-fixture server, or service/runtime operation occurs.
