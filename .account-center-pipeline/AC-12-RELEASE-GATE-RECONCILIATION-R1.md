# AC-12 — owned-delete release-gate reconciliation R1

**State:** PLANNED
**Candidate:** preserve the checked-out Account Center candidate, including Dexter’s Alej-owned exact-account transaction at `/home/Alej/.openclaw/workspace/3-Resources/codex-account-ops/scripts/codex-auth-delete.py`, the one target-free `opaque-owned-delete` receipt, the working Dexter `/auth delete` transport, the full Sentinel `/auth` format, and Hermes/Dexter weekly-only policy.

## Internal issue

The authoritative pipeline record names AC-04 as the sole active checkpoint while simultaneously marking it `COMPLETED`. That is not a valid active release-gate state and could allow later work to advance without a current, independently verified ownership record. This is internal coordinator metadata debt, not an upstream OpenClaw CLI limitation and not a reason to weaken or bypass the owned native transaction.

## Bounded resolution plan

1. Under the exclusive pipeline state lock, move the sole active item to AC-12 and set it `PLANNED`; retain the existing candidate and all no-live-operation constraints.
2. Re-establish the concrete ownership chain: inspect the helper as a regular owner-only file with its pinned digest, compile it only, and run it only through its synthetic temporary-HOME fixture suite.
3. Re-run Account Center adapter/executor, Dexter ChatOps/MCP, and Hermes bridge contract fixtures that prove the helper invocation is fixed and public success is exactly `opaque-owned-delete`; then run deterministic security QA.
4. Review the resulting diff and public outputs for email/path/digest disclosure, target ambiguity fail-closed behavior, Sentinel format parity, Dexter command continuity, and weekly-only policy preservation. Only after all evidence passes, record AC-12 as completed and permit a later release gate.

## Invariants

- No live credential deletion, interactive login, provider request, route/model mutation, Sentinel operation, or service operation.
- Tests may execute the owned helper only with a synthetic temporary HOME and fixture state root; no live credential directory is available to them.
- The owned helper remains the only native credential-delete integration. Public verified success is exactly `opaque-owned-delete`; native receipt details, target digest, backup paths, and private diagnostics do not cross the adapter boundary.
- Preserve the locked full Sentinel `/auth` format, working Dexter `/auth delete` command, and Hermes/Dexter weekly-only policy.
