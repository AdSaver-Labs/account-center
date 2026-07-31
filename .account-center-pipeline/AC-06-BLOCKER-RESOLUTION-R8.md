# AC-06 R8 — release-evidence reconciliation

## Preserved candidate

The reviewed AC-06 implementation remains the committed `5eaa2ed` Dexter boundary fix: Account Center reaches only the owned exact-account helper at `/home/Alej/.openclaw/workspace/3-Resources/codex-account-ops/scripts/codex-auth-delete.py`; Hermes delegates via Account Center; and Dexter, Hermes, and MCP expose only the versioned opaque receipt contract. The native helper is not invoked by this gate.

## Internal issue

The latest committed Dexter boundary hardening was not represented by the locked pipeline pointer, so the release evidence did not identify the actual `main` revision that completed the R7 fixture requirement. This is an internal coordinator-evidence defect, not an external dependency and not a reason to reclassify or skip AC-06.

## Bounded R8 plan

1. Preserve `5eaa2ed`, the owned-helper hash/ownership verification, full Sentinel `/auth` format, Hermes/Dexter weekly-only policy, and the R7 fixtures without source or native-store changes.
2. Under the exclusive coordinator lock, first record AC-06 as `PLANNED` with this distinct evidence-reconciliation plan and the explicit fixture-only/no-live-delete constraints.
3. Re-run the complete fixture/mock test suite and security QA; independently inspect the committed diff, repository cleanliness, remote equality, and local owned-helper trust pin.
4. If all evidence passes, record the verified AC-06 release commit and review evidence under the same lock, force-add only this pipeline evidence, push it, and verify `origin/main`. Otherwise retain the candidate and leave the checkpoint `PLANNED`.

## Completion condition

The AC-06 release evidence names the verified boundary commit and records passing fixture-only test/QA results. No live deletion, login, provider request, runtime-store write, or Sentinel route mutation is part of this gate.
