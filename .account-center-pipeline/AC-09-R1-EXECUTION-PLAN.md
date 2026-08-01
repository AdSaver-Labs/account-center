# AC-09 R1 — cross-consumer opaque-receipt drift release gate

**State:** PLANNED
**Candidate:** current protected `main` implementation; release evidence only unless the bounded fixture review exposes internal drift.

## Materially distinct bounded internal resolution plan

AC-08 directly revalidated the Hermes boundary. This gate tests the *cross-consumer protocol invariant*: Account Center CLI/adapter, Dexter ChatOps/MCP, Hermes, and documentation must all derive or enforce the one immutable versioned opaque owned-delete receipt contract without allowing a consumer-specific success variant.

1. Inspect the tracked TypeScript contract loader, Hermes bridge, ChatOps/MCP transport, and native-adapter receipt normalizer for the exact schema/version and two public outcomes. Confirm the native transaction remains the Alej-owned exact-account helper at `/home/Alej/.openclaw/workspace/3-Resources/codex-account-ops/scripts/codex-auth-delete.py`; compile and inspect it only.
2. Run fixture/mock contract-drift cases: malformed version/schema, valid-looking target/path-bearing success text, unverified/mismatched native receipts, unavailable/nonzero transport, and failure to load a contract. Every destructive outcome must be the fixed target-free `UNPROVEN` text except the one verified opaque applied text. The native helper must not be invoked.
3. Run the full security/QA gate and static trust checks; examine the diff, working tree, state JSON, Sentinel rendering fixtures, and Hermes/Dexter weekly-only fixtures. Record review only on green evidence.
4. If an internal check fails, retain this candidate, write a new bounded remediation plan distinct from this one, leave `AC-09` `PLANNED`, execute it, and re-review. Do not classify AC-06 as externally blocked or skip the owned transaction.

## Invariants

- No live deletion, login, provider request, credential/store write, routing/model mutation, runtime operation, or live browser operation; fixture/mock tests only.
- Preserve the locked full Sentinel `/auth` format and Hermes/Dexter weekly-only policy.
- Preserve the working Dexter `/auth delete` command and the owned exact-account transaction.
- The only successful native public receipt remains `{ "action": "account.delete", "state": "DELETED", "receipt": "opaque-owned-delete" }`; all public output stays target-free and opaque.
