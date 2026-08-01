# UI-01 R2 — release-publication reconciliation

State: PLANNED
Owner: Account Center production coordinator

## Preserved candidate

`cf09c6a` is the reviewed UI-01 release-evidence candidate. Its parent is the
current `origin/main` tip `fbe7c02`; the local checkout therefore contains one
unpublished, linear coordinator commit rather than a source conflict. The
already reviewed native Codex UI implementation and all prior AC-06 evidence
remain preserved.

## Internal issue

The pipeline state says UI-01 is merged while its release-evidence commit has
not yet been published to `origin/main`. This is an internal publication/evidence
reconciliation defect—not an external dependency—and does not invalidate the
owned native exact-account deletion transaction or authorize any live action.

## Bounded resolution plan

1. Under the exclusive state lock, record this publication discrepancy as
   `PLANNED` while retaining `cf09c6a` as the sole candidate.
2. Revalidate the unpublished linear commit against its `origin/main` parent;
   compile-check only the owned helper and run fixture/mock contract tests plus
   full deterministic security QA.
3. Review the resulting diff for the sole opaque receipt contract, full
   Sentinel `/auth`, working Dexter `/auth delete`, and Hermes/Dexter
   weekly-only behavior.
4. If all evidence passes and `origin/main` remains the direct parent, publish
   the linear candidate, fetch, and verify exact `HEAD == origin/main` equality;
   then record the factual release evidence. Otherwise leave this checkpoint
   `PLANNED` and retain the candidate.

## Non-negotiable boundaries

No native helper invocation, live deletion, login, provider request,
credential/store write, routing/model mutation, live browser action, or service
operation is permitted. Tests use fixtures, mocks, and fixture servers only.
