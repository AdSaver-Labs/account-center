# AC-03 R2 — durable guided-auth terminal-evidence review

**Status:** passed (fixture-only)

## Scope reviewed

- A reauth challenge can reach `completed` or `failed` only through the store's locked `completeReauthWithProof` transition.
- The proof contract is exact, fresh (five minutes), challenge-bound, and sealed: `completed` requires matched identity/healthy verified replacement; `failed` requires matched identity/verified non-replacement failure.
- Proof bytes are validated under the lifecycle lock then discarded. The durable challenge record keeps only its existing nine-key redacted projection and terminal status.
- The narrow executor preflights audit readability, records bounded target-free audit metadata only after a terminal transition, and has no runtime adapter, login, credential, route, or native-helper authority.
- No API/CLI endpoint exposes this fixture-safe completion boundary because there is not yet a protected native proof source; it remains unavailable rather than accepting client-asserted evidence.
- The owned Dexter transaction, the one `opaque-owned-delete` receipt contract, Hermes/Dexter full Sentinel `/auth` rendering, Dexter `/auth delete`, and weekly-only policy are unchanged.

## Fixture evidence

- New terminal fixtures prove successful terminal completion, verified terminal failure, malformed/stale proof rejection, replay rejection, audit-unavailable fail-closed behavior, and absence of account targets, tokens, raw proof, replacement evidence, and verification payloads from durable challenge state.
- `npm run test` passed: **271 Node fixture/mock tests** and **19 Hermes-plugin fixtures**.
- `npm run qa:security` passed: typecheck/build, the same **271 Node** and **19 Hermes** fixtures, **15 Playwright/axe fixture-browser tests**, secret scan of **175 tracked files**, and `npm audit --audit-level=high` with **0 vulnerabilities**.
- `git diff --check` passed. The owned Python helper was not invoked; no live deletion, login, provider request, live runtime-store write, route/model mutation, or browser operation occurred.

## Decision

AC-03 R2 satisfies its internal lifecycle completion gate. The proof transition is deliberately not a public authentication claim and does not advance or alter the owned delete transaction boundary.
