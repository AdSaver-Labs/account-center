# AC-04 — verified reauth transaction release gate (R11)

**State:** PLANNED
**Candidate:** current clean `main` candidate retaining AC-11's already verified owned delete integration.

## Locked preservation boundary

Keep Dexter's sole owned exact-account credential-delete helper at `/home/Alej/.openclaw/workspace/3-Resources/codex-account-ops/scripts/codex-auth-delete.py`, its pinned identity and target-free `opaque-owned-delete` projection, the working Dexter `/auth delete` command, the full Sentinel `/auth` format, and the Hermes/Dexter weekly-only policy. No native helper implementation edit, live credential deletion, interactive login, provider request, route/model mutation, Sentinel operation, or service/browser action is permitted.

## Internal release-gate gap and bounded resolution

The remaining AC-04 concern is not an upstream CLI capability: it is whether the local reauth terminal boundary can be reviewed as a proof-only lifecycle that has no public HTTP completion surface and no authority to invoke a runtime adapter, credential writer, route decision, or owned delete helper.

1. Inventory the exported reauth proof/readiness/terminal seams and the HTTP capability/route table; prove the only public guided-auth mutations are start and cancel.
2. Exercise the terminal proof boundary solely with fixture stores: exact fresh challenge-bound evidence may produce target-free durable metadata and bounded audit data; malformed, stale, mismatched, inherited, credential-bearing, replayed, and unavailable-audit evidence must produce no terminal claim.
3. Confirm the terminal implementation imports no runtime adapter or delete transaction, and that the fixture path invokes no helper, provider, credential store, route action, or live runtime mutation.
4. Re-run the actual owned delete helper only in its temporary-HOME fixture suite, plus the Account Center/Hermes/Dexter opaque-contract, Sentinel-format, weekly-only, full QA/security, and browser/axe checks.
5. Perform source/diff and result review. Merge only when all checks pass; otherwise retain this candidate and write the next bounded internal remediation plan.

## Acceptance evidence

- No public endpoint or advertised capability accepts reauth proof completion; readiness remains proof-only and non-mutating.
- Terminal success and failure records expose no target, email, token, proof, native path, or digest; rejected evidence leaves the challenge terminal state and audit count unchanged.
- The owned delete contract remains the single fixed public opaque result and Dexter `/auth delete` remains on the shared command path.
- Full fixture-only QA/security and accessibility checks pass without a live deletion.
