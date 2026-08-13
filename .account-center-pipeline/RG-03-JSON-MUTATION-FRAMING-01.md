# RG-03-JSON-MUTATION-FRAMING-01 — JSON mutation framing boundary

State: COMPLETE
Target gate: Release gate 3 — secure local control plane (protected mutation input validation).

## Ordinary-user outcome

A malformed or ambiguous body framing request cannot make a bearer-protected JSON mutation reach JSON parsing, runtime discovery, or durable local state. Valid canonical JSON mutations retain their existing behavior.

## Delivered

1. Added one raw-header framing boundary shared by guided-auth creation and account UI preference updates.
2. The boundary requires exactly one canonical positive `Content-Length` and no `Transfer-Encoding`; duplicate, conflicting, comma-joined, zero, signed, padded, or transfer-encoded framing fails before protected collaborators.
3. Added raw-socket coverage for both routes using throwing collaborators, plus preserved canonical request and body-size regression coverage. Syntax/framing forms rejected by Node before application delivery are documented as parser-level `400`; application-delivered invalid framing returns the fixed redacted no-store `413 invalid_request_framing` response.

## Evidence

- Focused build and server suite: 78 passing tests.
- Independent read-only review: PASS after one remediation; no findings.
- Full local quality proof: `npm test` passed 311 Node tests, 19 Hermes-plugin tests, and 7 owned-delete tests; `npm run qa` passed typecheck/build, clean install, and 90 browser/a11y tests; `npm run qa:security` passed tracked-source scan and dependency audit; `npm run verify:clean-install` and `npm run smoke:panel` passed.
- `git diff --check` passed.

## Boundaries retained

Fixture-only loopback proof only. No live runtime, credential, provider, routing, model, Codex, or permanent credential deletion operation occurred or is claimed.
