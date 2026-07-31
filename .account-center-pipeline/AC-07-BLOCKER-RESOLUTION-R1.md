# AC-07 R1 — current-revision executor evidence reconciliation

## Preserved candidate

The committed Account Center shared mutation executor and AC-06 owned exact-account delete boundary remain the candidate. The owned native helper at `/home/Alej/.openclaw/workspace/3-Resources/codex-account-ops/scripts/codex-auth-delete.py`, the single opaque receipt contract, Dexter `/auth delete`, full Sentinel `/auth` format, and Hermes/Dexter weekly-only policy are fixed invariants.

## Internal issue

The locked pipeline pointer still names the completed AC-06 gate even though AC-07 is the next release gate and its prior evidence needs a current-revision, fixture-only verification. This is an internal coordinator state/evidence issue; it is not an external dependency and does not authorize a skip.

## Bounded R1 plan

1. Under the exclusive coordinator lock, preserve the candidate and set AC-07 to `PLANNED` with this reconciliation record.
2. Run the full fixture/mock QA-security gate plus static Python compilation; do not execute the native helper or any live mutation.
3. Inspect the working tree, remote equality, owned-helper ownership/mode/hash, contract consumer fixtures, and locked Sentinel/weekly-only preservation evidence.
4. If every check is green, record the verified AC-07 release evidence and push only the resulting pipeline evidence; otherwise retain the candidate and leave AC-07 `PLANNED` with the failure evidence.

## Prohibitions

No native helper execution, credential deletion, interactive login, provider request, runtime-store write, route mutation, or service operation is permitted.
