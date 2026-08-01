# UI-01 R3 — factual release-record repair

State: PLANNED
Owner: Account Center production coordinator

## Preserved candidate

The published `main` tip `7f56d48` is retained intact. It contains the reviewed
UI-01 R2 publication-reconciliation evidence and preserves the AC-06 owned
exact-account transaction, target-free opaque receipt contract, full Sentinel
`/auth` format, working Dexter `/auth delete`, and Hermes/Dexter weekly-only
policy.

## Internal issue

The actual remote is now published and equal to local `main`, but the committed
state record still says `pending-publication` and `verified: false`. This is a
factual coordinator-record defect. It is internal; it is not an upstream CLI or
provider blocker, does not weaken AC-06, and does not justify a skip.

## Bounded resolution plan

1. Under the exclusive pipeline lock, retain `7f56d48` and set UI-01 `PLANNED`
   with this record rather than claiming a merge that the state has not proved.
2. Independently fetch and prove exact local/remote equality, clean topology,
   trusted helper owner/mode/pinned hash, and compile-only helper validity.
3. Re-run the deterministic fixture/mock security gate and inspect the receipt
   contract, Account Center adapter, Dexter/ChatOps bridge, Hermes bridge, and
   Sentinel/weekly-only preservation fixtures. The helper must never run.
4. If every fact is green, commit only this corrected state/evidence, push it,
   fetch, prove exact equality again, and record the factual merge. Otherwise
   preserve the candidate and remain `PLANNED` with failure evidence.

## Prohibitions

No native helper execution, live credential deletion, interactive login,
provider request, credential/store write, route/model mutation, live browser
action, or service operation. Tests use only fixtures, mocks, and fixture
servers.
