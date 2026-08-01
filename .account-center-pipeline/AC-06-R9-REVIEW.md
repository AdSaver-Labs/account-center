# AC-06 R9 — owned-delete release-gate review

**Status:** passed (fixture/mock only)

## Scope reviewed

- Account Center OpenClaw adapter is pinned to Dexter’s owned `codex-auth-delete.py` transaction and calls it only after executor capability, default scope, and exact connected-target resolution.
- The adapter accepts only the narrow verified native result and emits the sole public native receipt `{ action: "account.delete", state: "DELETED", receipt: "opaque-owned-delete" }`.
- Hermes uses the canonical Account Center ChatOps `/auth delete` transport and accepts exactly the shared applied or fixed UNPROVEN text; Dexter ChatOps applies the identical boundary.
- Sentinel’s established `/auth` status rendering and Hermes/Dexter weekly-only capacity behavior were retained by the full fixture suite.

## Local owned-helper trust evidence

The helper was inspected and compiled only—not invoked. It is a regular file, owner `Alej` (uid 1001), mode `0600`, and SHA-256 `4c09c926e94500f02f34a19ca80fbec280003227588d2b4f0d1d1085ee7fba37`, matching the adapter’s immutable pin.

## Executed verification

1. Focused build and contract suite passed: **97 Node fixture/mock tests** and **19 Hermes plugin fixtures**. Coverage includes exact native argv through a mocked runner, direct-apply/capability rejection, untrusted helper rejection before runner invocation, normalized exact email/profile matching, ambiguous/missing target rejection, malformed/mismatched/unverified receipt rejection, output/timeout/nonzero fail-closed handling, Hermes injected/failed/unavailable transport handling, and Dexter document/ChatOps parity.
2. `npm run qa:security` passed: build/typecheck; **268 Node fixture/mock tests**; **19 Hermes plugin fixtures**; **15 Playwright/axe fixture-browser tests**; secret scan of **167 tracked files**; and `npm audit --audit-level=high` with **0 vulnerabilities**.
3. `git diff --check` passed. Before publication, local `main` equaled `origin/main` at `66bc8220d7077d694d787a3e40509b5047537f3f`.

No native-helper invocation, live deletion, login, provider request, credential/runtime-store write, route/model mutation, service operation, or live browser operation occurred.

## Decision

AC-06 R9 passes review and QA. Publish the pipeline release record only; runtime implementation and protected policy/format files remain unchanged.
