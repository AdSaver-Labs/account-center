# AC-11 — hermetic owned-delete transaction review

**Result:** APPROVED — fixture-only remediation complete; no live credential delete occurred.

## Implementation reviewed

- The sole native delete implementation remains Dexter's protected absolute helper path. Its production command interface is unchanged.
- A native private-state override exists only for explicitly marked fixture execution, only where the temporary HOME is directly under the system temp directory with the owned fixture prefix, and only when the override resolves beneath that HOME. Invalid use fails before the helper scans agents or mutates stores.
- Private backup and receipt names use a UTC prefix plus a cryptographically random suffix and an exclusive backup-directory create, preventing same-second co-mingling or receipt overwrite.
- Account Center is re-pinned to helper SHA-256 `76877f63f2bdf82bc8c156ae47f4e7aafa09e9b91389d6b15a2e89eb8d82eb70`. The owner/type/mode checks remain `Alej`, regular file, `0600`.
- Public Account Center, Hermes, Dexter ChatOps, and MCP behavior remains the one target-free opaque contract; native receipt details remain internal.

## Fixture evidence

The actual helper executed only with newly created temporary `HOME` fixture stores and a temporary private state root:

- successful exact deletion with JSON/SQLite backup and a private native receipt contained under the fixture root;
- preview and not-connected exact target have byte-for-byte unchanged JSON/SQLite stores and no private artifacts;
- forced post-JSON and post-SQLite failures restore both stores byte-for-byte, with native artifacts contained under the fixture root.

## QA and regression evidence

`npm run qa:security` passed:

- TypeScript build and typecheck;
- 271 Node fixture/mock tests, including owned-transaction adapter, Dexter ChatOps, MCP, opaque-receipt, full Sentinel `/auth` rendering, and weekly-only policy coverage;
- 19 Hermes plugin fixtures;
- 5 real native-helper fixture tests;
- 15 Playwright/axe checks;
- secret scan of 185 tracked files; and
- `npm audit --audit-level=high` with 0 vulnerabilities.

`git diff --check` passed for the Account Center candidate. The broader Dexter workspace already contains unrelated concurrent changes, so it was not treated as a clean commit boundary; no unrelated file was staged or modified by this checkpoint.
