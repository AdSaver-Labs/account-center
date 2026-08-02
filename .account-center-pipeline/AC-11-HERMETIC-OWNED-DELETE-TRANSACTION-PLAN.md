# AC-11 — hermetic owned-delete transaction hardening

**State:** COMPLETED — reconciled by `AC-11-COMPLETION-RECONCILIATION-R1.md` and its approved review.
**Candidate:** preserve the merged AC-10 candidate: Dexter's owned exact-account transaction at `/home/Alej/.openclaw/workspace/3-Resources/codex-account-ops/scripts/codex-auth-delete.py`, Account Center's single versioned opaque receipt contract, working Dexter `/auth delete`, full Sentinel `/auth` format, and Hermes/Dexter weekly-only policy.

## Internal issue

The native helper fixture suite uses a temporary `HOME` for synthetic credential stores, but the helper currently derives backup and private-receipt locations from the real Dexter workspace. Thus fixture `--apply` may leave artifacts outside the fixture root. The helper also uses a second-granularity operation name, allowing same-second backup/receipt collisions. These are internal filesystem-safety and test-isolation defects, not an upstream OpenClaw CLI blocker.

## Bounded resolution plan

1. Keep the exact production helper path and public arguments. Add a fail-closed, explicitly test-only state-root override that is accepted only when the override resolves beneath the temporary fixture `HOME`; otherwise production continues to use its normal private state root.
2. Generate a collision-resistant operation identifier for the native private backup and receipt locations, without changing the helper's private receipt fields or Account Center's opaque projection.
3. Expand the owned-helper fixture suite to prove all files written by success and forced rollback cases stay under the temporary root; prove preview and exact-target-not-found cases are non-mutating; and preserve byte-for-byte JSON/SQLite rollback.
4. Re-pin the Account Center helper hash and run the real owned helper only against temporary fixture stores, then run Account Center, Hermes/Dexter receipt, Sentinel-format, weekly-policy, QA/security, and diff checks. Review the resulting candidate before any next release gate.

## Invariants

- No live credential deletion, live runtime-store write, interactive login, provider request, route/model mutation, or Sentinel operation.
- The native receipt, backup paths, operation identifiers, and target digest remain private; public verified success remains exactly `opaque-owned-delete`.
- Dexter `/auth delete` stays on the same Account Center command path.
