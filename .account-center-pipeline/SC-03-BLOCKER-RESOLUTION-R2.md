# SC-03 Blocker Resolution R2 — ignored pipeline evidence

State: PLANNED
Candidate: `main`
Owner: Account Center production coordinator

## Internal blocker

The SC-03 implementation and fixture-only QA evidence passed, but the repository intentionally ignores `.account-center-pipeline/`; a normal `git add` therefore refused the required release record. This is a repository evidence-tracking issue, not an external blocker and not an AC-06 limitation.

## Bounded resolution plan

1. Retain the completed SC-03 candidate and review evidence; do not alter source, contracts, the owned delete helper, or runtime stores.
2. Under the state-file exclusive lock, return this sole checkpoint to `PLANNED` and replace the merge-pending record with this precise VCS-evidence resolution plan.
3. Force-add only `.account-center-pipeline/state.json` and the SC-03 review/plan records, after checking the staged name set contains no ignored runtime data.
4. Commit and push only those evidence records, verify `HEAD` equals `origin/main`, then under the exclusive lock record the actual release commit and verification in a follow-up evidence commit.
5. Do not proceed to another checkpoint in this run. No native helper execution, live deletion, provider request, interactive login, credential/store write, route mutation, session/service operation, or runtime mutation is permitted.
