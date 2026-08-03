# AC-06 Native Transaction Filesystem Hardening R1 — Review

## Result

Approved after fixture-only implementation and QA.

## Implementation

- Retained the one owned native exact-account helper used by Dexter:
  `/home/Alej/.openclaw/workspace/3-Resources/codex-account-ops/scripts/codex-auth-delete.py`.
- Hardened the helper's private state/artifact tree to owner-only `0700`, rejecting symlinked or non-owner transaction directories.
- Made operation directories `0700` and backup/receipt/lock files `0600`; hardened production artifact parents to `0700` without opening or changing credentials.
- Added a nonblocking owner-only transaction lock before backup/mutation, so concurrent operations fail closed instead of interleaving a rollback with another write.
- Rejected unsafe credential source files (symlink/non-regular/non-owner/group-or-world-accessible) before copying or mutation.
- Preserved Account Center's pinned helper identity and updated its SHA-256 pin to the reviewed helper content.
- Preserved the target-free Account Center/Hermes/Dexter public receipt protocol: `account.delete` / `DELETED` / `opaque-owned-delete`.

## Fixture coverage

The owned-helper suite now verifies:

1. successful JSON/SQLite fixture deletion and owner-only artifacts;
2. preview and absent target leave fixture stores/artifacts untouched;
3. JSON and SQLite forced failures restore fixture bytes exactly;
4. symlinked private state fails closed without modifying credentials or a link target; and
5. an already-held transaction lock fails closed without credential mutation.

## Verification

All verification was fixture-only; no live account deletion, login, provider call, Sentinel action, route/model mutation, service operation, or notification occurred.

- `npm test` — passed: 271 Node tests, 19 Hermes plugin tests, and 7 owned-helper fixture tests.
- `npm run qa:security` — passed: typecheck, build, 15/15 accessibility tests, secret scan (195 tracked files), and `npm audit` (0 high vulnerabilities).
- Native helper syntax compilation and reviewed SHA validation completed successfully.

## Protected invariants

Hermes/Dexter Sentinel `/auth` rendering and weekly-only capacity policy were not changed. Dexter `/auth delete` continues to call the same owned helper; no upstream OpenClaw CLI delete command is required.
