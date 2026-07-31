# AC-04 blocker resolution — ignored release-record inclusion

State: PLANNED
Owner: Account Center production coordinator

## Internal blocker

The reviewed AC-04 release record and locked pipeline state are intentionally covered by the repository ignore rules, so ordinary `git add` refused to stage them. This is a repository integration issue, not an external dependency and does not affect the owned AC-06 transaction.

## Materially different bounded resolution plan

1. Keep the already reviewed reauth-evidence candidate unchanged; do not reopen runtime, provider, credential, route, or native-delete work.
2. Verify the two exact pipeline records are the only intended ignored inputs and stage only those paths with Git's explicit force-add mechanism.
3. Re-run cached diff validation, create the release-record commit, push it to `origin/main`, and compare the resulting local and remote hashes.
4. Under the exclusive state lock, write the verified commit hash and final merge evidence; force-add only that state record, commit, push, and verify again.

No native helper execution, live deletion, interactive login, provider request, credential/store write, route mutation, or session/service operation is permitted.
