# AC-06 Native Transaction Filesystem Hardening R1

## Candidate preserved

`SC-01 R1 completed: public runtime/scope selectors are closed to authoritative labels while AC-06 and protected policy invariants remain intact.`

## Internal blocker

The owned native exact-account transaction is present and already shared by Account Center and Dexter, but its backup/receipt parent directories are group-writable and the helper does not transaction-lock all discovered credential stores. This is an internal filesystem-safety hardening issue, not an external OpenClaw capability blocker.

## Bounded resolution plan

1. Harden only the owned helper's transaction artifact tree: reject symlink/non-owner paths, repair/create private directories, and ensure backup/receipt files and operation directories are owner-only.
2. Add a fail-closed operation-wide advisory lock around discovery through receipt write, preventing concurrent rollback from overwriting a simultaneous mutation; preserve the helper argv and Dexter `/auth delete` path.
3. Extend hermetic fixture tests for private artifact modes, hostile private-state symlink rejection, and contention without touching live credentials.
4. Update Account Center's reviewed helper integrity pin, then run build, owned-helper fixtures, full tests, security QA, and a redaction/contract review. No live delete, login, provider, route/model, Sentinel, or notification operation is permitted.

## Invariants

- The only delete implementation remains `/home/Alej/.openclaw/workspace/3-Resources/codex-account-ops/scripts/codex-auth-delete.py`.
- The public native result remains target-free and exactly `account.delete` / `DELETED` / `opaque-owned-delete`.
- Hermes/Dexter full Sentinel `/auth` format and weekly-only policy remain unchanged.
- Fixture servers and temporary homes only; no live deletion tests.
