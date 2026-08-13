# RG-03-CONNECTION-LIFECYCLE-BOUNDARY-01 — bounded keep-alive phases

**State:** COMPLETE

**Release gate:** Release gate 3 — secure local control plane (bounded availability / request lifecycle).

**Ordinary-user outcome:** A loopback Account Center listener closes an idle, partial-header, or dripped-header keep-alive follow-up phase within one server-owned second after a valid protected request, instead of retaining the connection for a Node default duration.

## Delivered boundary

- `packages/cli/src/server.ts` applies explicit one-second parser/request/socket/keep-alive values.
- A listener-owned absolute deadline is armed on initial connection and re-armed after every completed response; beginning a parsed subsequent request clears it. Byte drips cannot extend either phase.
- `packages/cli/src/server.test.ts` uses raw loopback sockets to prove a successful protected read followed by idle, partial-header, and dripped-header phases closes promptly without challenge-store access. Existing sequential protected keep-alive reads continue to pass.

## Verification

- Focused build and server suite: `npm run build && node --test packages/cli/dist/server.test.js` — 83 passing tests.
- Independent read-only review: no findings.
- Full local suite: `npm test` — 316 Node tests, 19 Hermes-plugin tests, and 7 owned-delete tests passed.
- Deterministic QA/security/browser: `npm run qa`, `npm run qa:security`, and `npm run test:a11y` passed; browser/a11y: 90 passing tests; tracked secret scan and dependency audit passed.
- Release checks: `npm run verify:clean-install` and `npm run smoke:panel` passed; `git diff --check` passed.
- Published commit: `320eb572b69cb0a67420061a23cdab03c820e196` (`fix(server): bound keep-alive connection phases`).
- Exact-head GitHub Actions: Account Center quality gates run `31722922898` completed successfully for that SHA.

## Scope and remaining limits

This pack hardens listener lifecycle only. It makes no credential, provider, routing, model, account, or runtime mutation, and does not close Gate 3 as a whole. CLI capability enforcement, lifecycle atomicity/recovery, and route scope authority blockers remain unchanged.
