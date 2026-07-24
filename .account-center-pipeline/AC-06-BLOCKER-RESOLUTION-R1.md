# AC-06 Blocker Resolution R1

## Scope

Bounded repair of the rejected receipt/MCP/status candidate. No OpenClaw credential, account, route, Sentinel, service, or undocumented-store mutation is enabled.

## Changes

- Restored normal human `/auth status` output exactly; the credential-delete policy remains in delete/help contracts while Sentinel normalization continues to retain five-hour and weekly status windows and policy fields.
- Dexter MCP now recognizes a normally parsed `/auth delete <target>` as the parser-implied dry-run and returns the fixed canonical CLI/Hermes `BLOCKED`/`UNPROVEN` text before generic MCP mutation authorization.
- Removed `receiptPath` from runtime-adapter and executor mutation contracts. Adapters now return receipt payloads only and do not write caller-selected paths.
- Added a CLI-boundary Python helper for only canonical blocked-delete status failures. It descriptor-walks from `/` with `dir_fd` and `O_NOFOLLOW`, requires/creates a uid-owned `0700` data root, exclusively creates random opaque `0600` receipt names, and fsyncs file and containing directory. It persists a fixed allow-listed redacted record only. Any explicit caller `--receipt-path` suppresses persistence and is never traversed or written.

## Verification

- `npm test` — passed: 183 tests.
- `python3 -m unittest integrations/hermes-plugin/test_account_center_plugin.py integrations/hermes-plugin/test_blocked_delete_receipt.py` — passed: 7 tests.
- Fixture-only helper tests cover private modes, opaque content, random filename shape, shared-root refusal, and symlink-root refusal. Core tests cover returned-payload adapter behavior and no caller-path creation.

## Review notes / concerns

- The helper intentionally fails closed on non-POSIX/no-`O_NOFOLLOW` environments (the supported Linux CLI runtime provides the required descriptor APIs).
- This change does not approve itself; independent review is still required.
