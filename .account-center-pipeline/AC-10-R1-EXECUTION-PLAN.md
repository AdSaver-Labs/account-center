# AC-10 R1 — canonical delete-command-path release gate

**State:** PLANNED
**Candidate:** protected `main` after AC-09 receipt-drift review; release evidence only unless bounded fixture review finds an internal inconsistency.

## Materially distinct bounded internal resolution plan

AC-09 reviewed cross-consumer receipt equivalence. This gate reviews *canonical command-path integrity*: every public delete entry point must preserve the confirmed Account Center executor lifecycle and reach the same owned native transaction only through the guarded adapter; no shortcut may introduce a second delete implementation, a target-bearing output, or a policy drift.

1. Statically trace CLI `/auth delete`, Dexter ChatOps, MCP authorization, Hermes bridge, command executor, and OpenClaw adapter to confirm one guarded path, fixed helper identity, exact-target resolution, and opaque terminal boundary.
2. Run fixture/mock command-path negatives only: absent/forged authorization, wrong review/idempotency binding, malformed command quoting, direct adapter apply, malformed transport, and alternate receipts. Assert no helper runner invocation for every blocked case.
3. Re-run the deterministic QA/security/browser gates and review state, diff, full Sentinel `/auth` rendering fixtures, Dexter command fixtures, and weekly-only capacity fixtures before release evidence.
4. If an internal check fails, retain this candidate, write a new bounded remediation plan different from this command-path review, keep `AC-10` `PLANNED`, execute it, and re-review. Do not claim AC-06 is externally blocked or bypass Alej’s owned transaction.

## Invariants

- No live deletion, login, provider request, credential/store write, routing/model mutation, runtime operation, or live browser operation; fixture/mock tests only.
- Preserve the locked full Sentinel `/auth` format and Hermes/Dexter weekly-only policy.
- Preserve the working Dexter `/auth delete` command, Alej-owned exact-account transaction, and sole versioned opaque receipt contract.
