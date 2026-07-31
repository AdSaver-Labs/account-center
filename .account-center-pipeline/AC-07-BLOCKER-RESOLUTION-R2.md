# AC-07 R2 — pipeline-record format repair

## Preserved candidate

AC-07 R1's reviewed shared mutation executor remains the candidate, with the owned exact-account helper, opaque receipt contract, Dexter `/auth delete`, Sentinel format, and weekly-only policy unchanged.

## Internal issue

The R1 release-evidence writer appended a literal escape sequence after the JSON document. That invalidates the locked pipeline record despite passing code and fixture QA. This is an internal receipt/evidence-format defect, not an external dependency or a reason to skip the gate.

## Bounded R2 plan

1. Under exclusive lock, repair the state document to canonical valid JSON and retain the R1 candidate and evidence.
2. Parse the repaired JSON, inspect the exact diff, and re-check repository/remote integrity.
3. Re-record the already-passing fixture-only QA and static-compilation outcome without running the native helper or any live mutation.
4. Commit, push, and verify only the corrected pipeline evidence; otherwise retain `PLANNED`.

No deletion, native helper execution, login, provider request, runtime-store write, or route mutation is permitted.
