# AC-06 Blocker Resolution — bounded implementation plan

## Scope
- Keep exact-account OpenClaw credential deletion fail-closed; no native account, credential, route, service, or Sentinel mutation is introduced.
- Replace caller-selected receipt-file writes with a safe request validator plus durable, process-owned private receipt storage.
- Make the public `account.delete` blocked outcome canonical across CLI, Hermes, and Dexter MCP.
- Add fixture-only filesystem and bridge-parity regression coverage.

## Steps
1. Validate a requested receipt path without creating or overwriting it; reject symlinked parents, symlink/final entries, directories, existing files, and link-like existing entries.
2. Persist only allow-listed receipt data in a private `0700`, non-symlink receipt directory under Account Center data ownership. Create an opaque random filename exclusively with no-follow flags, file mode `0600`, write/sync/close safeguards, and directory sync.
3. Centralize blocked mutation construction/rendering in the CLI and make bridges pass the CLI’s canonical public delete result rather than applying mutation-output redaction or generic replacement.
4. Cover unsafe paths, durable private receipts, permissions/opaque data, and exact CLI/Hermes/MCP delete parity using temporary fixtures only.
5. Run build and focused tests; commit only these bounded changes.

## Non-goals / invariants
- No real credentials, accounts, routes, services, Sentinel state, `/auth` status format, detailed Sentinel status, or weekly-only policy changes.
- No claim of an authoritative native deletion transaction; delete remains `BLOCKED`/`UNPROVEN`.
- No approval is issued by this implementation task.
