# AC-07 R3 — canonical pipeline-record recovery

## Preserved candidate

AC-07 R1’s verified executor boundary remains the candidate: one shared protected lifecycle, the Alej-owned exact-account helper, its sole opaque receipt contract, full Sentinel `/auth`, working Dexter `/auth delete`, and weekly-only policy.

## Internal issue

The release-evidence serialization appended a literal backslash-n token after the JSON object, making the state file invalid JSON. This is a local pipeline receipt-format defect—not an external dependency—and it must be repaired without advancing or skipping the checkpoint.

## Bounded R3 plan

1. Take the exclusive state lock and atomically rewrite canonical newline-terminated JSON, retaining the AC-07 candidate and all fixture-only prohibitions.
2. Parse the exact on-disk state with both Python and Node, inspect its diff, and ensure no ignored review artifact is required for the durable state record.
3. Reconfirm existing QA evidence and static trust checks; do not rerun or invoke any native transaction, login, provider, runtime store, route, model, or service action.
4. Commit and push only valid pipeline evidence after repository and remote checks pass; otherwise retain `PLANNED` with a further distinct recovery record.
