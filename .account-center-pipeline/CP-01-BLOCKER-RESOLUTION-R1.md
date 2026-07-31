# CP-01 R1 — release-evidence reconciliation

## Preserved candidate

The reviewed CP-01 loopback/token implementation already exists on `main`. It binds only loopback, requires one owner-only launch-token file, keeps launch diagnostics token- and path-free, and is exercised only through fixture servers. The owned AC-06 exact-account delete adapter, its single opaque receipt contract, the full Sentinel `/auth` format, the working Dexter `/auth delete` command, and Hermes/Dexter weekly-only policy remain out of scope.

## Internal issue

CP-01's completed implementation and review results were left as `PLANNED` without a locked pipeline-state release record naming the actual verified `main` revision. This is an internal release-evidence reconciliation issue, not an external dependency or a reason to weaken the loopback/token, AC-06, or policy boundaries.

## Bounded R1 plan

1. Under the exclusive coordinator lock, preserve the existing candidate and record CP-01 as `PLANNED` with this fixture-only reconciliation plan.
2. Re-run the complete deterministic test suite, security QA, fixture browser/a11y checks, static Python compilation, and repository/diff invariants; do not start a non-fixture server or execute any native delete helper.
3. Independently inspect the launch-token and loopback fixtures plus AC-06/Hermes/Dexter opaque-delete contract tests to confirm that no source path broadens host binding, exposes a token/path, introduces a second delete implementation, or changes the locked policy/format.
4. If every check passes, record the actual reviewed main revision and proof in CP-01 and the state JSON under the same lock, commit and push the narrow evidence record, and verify remote equality. Otherwise retain the candidate and leave CP-01 `PLANNED`.

## Completion condition

The locked pipeline identifies the verified CP-01 revision with real fixture-only proof. No live server, deletion, login, provider request, credential/store write, route/model mutation, runtime operation, or service operation is performed.
