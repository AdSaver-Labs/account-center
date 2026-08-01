# AC-08 R1 — direct Hermes receipt-contract revalidation

**State:** PLANNED
**Candidate:** retain current `main` exactly; no alternate delete implementation.

## Bounded internal resolution plan

AC-07 is merged and its executor/lifecycle review has passed. The next release gate is a clean, fixture-only revalidation of the direct Hermes boundary so that Account Center and Hermes demonstrably consume the same versioned opaque receipt contract while Dexter remains unchanged.

1. Run the real Hermes-plugin fixture with `subprocess.run` replaced before every `/auth delete` request. Its temporary root will expose only the contract and a presence-only ChatOps file; it must not execute Node, ChatOps, the native helper, OpenClaw, or a provider.
2. Run the compiled Account Center adapter, CLI/Dexter ChatOps, MCP, and documentation contract fixtures. Confirm the immutable owned-helper trust pin and the only public native success receipt `{ action: "account.delete", state: "DELETED", receipt: "opaque-owned-delete" }`; malformed, injected, failed, or unavailable paths must resolve only to the fixed `UNPROVEN` text.
3. Run the repository security QA gate, compile the Hermes bridge and owned helper without invoking either, inspect the helper metadata/hash, and review the resulting diff and pipeline JSON.
4. Record a review only if every check passes. Otherwise retain this candidate, write a materially different bounded remediation plan, keep the checkpoint `PLANNED`, and execute that plan; do not relabel AC-06 as an external blocker.

## Non-negotiable invariants

- The sole native credential-delete transaction is `/home/Alej/.openclaw/workspace/3-Resources/codex-account-ops/scripts/codex-auth-delete.py`, already used by Dexter `/auth delete`; absence of an upstream OpenClaw CLI command is irrelevant.
- No test may invoke the helper or perform live deletion, login, provider request, credential/store write, routing/model mutation, runtime service operation, or live browser operation.
- Preserve the locked full Sentinel `/auth` format, the working Dexter `/auth delete` command, and Hermes/Dexter weekly-only policy.
- The receipt contract remains one target-free versioned opaque contract shared by Account Center, Hermes, Dexter/ChatOps, and MCP.
