# AC-10 R1 — canonical delete-command-path review

**Status:** passed (fixture-only)

## Scope reviewed

- Every public credential-delete entry point resolves to the same guarded path: CLI `/auth delete` maps to `accounts delete`, the protected executor mints the exact default-scope capability only after bound review and idempotency confirmation, and the OpenClaw adapter privately resolves one exact connected target.
- The adapter has one immutable helper identity: Alej’s locally owned `/home/Alej/.openclaw/workspace/3-Resources/codex-account-ops/scripts/codex-auth-delete.py`. It checks file type, ownership, restrictive mode, and pinned SHA-256 immediately before the only possible `python3 <helper> <canonical-profile> --apply` call. Missing, untrusted, unauthorized, ambiguous, malformed, timed-out, or alternate native results fail closed without public identity, path, backup, or diagnostic disclosure.
- The sole versioned public receipt is `account-center.owned-delete-receipt.v1`. Account Center, Dexter ChatOps/MCP, and Hermes admit exactly the verified opaque applied receipt `{ "action": "account.delete", "state": "DELETED", "receipt": "opaque-owned-delete" }` or the fixed target-free `UNPROVEN` result. Hermes continues to invoke the working Dexter ChatOps `/auth delete` transport.
- Full Sentinel `/auth` rendering and Hermes/Dexter weekly-only capacity policy are retained by fixture coverage; the canonical public views project only weekly windows for shared-agent availability.

## Executed verification

1. Static command-path review confirmed the CLI/auth bridge, MCP authorization, Dexter ChatOps, Hermes bridge, executor, and adapter have no alternate delete executor or target-bearing terminal path. The fixture suite covers missing/forged authorization, review and idempotency mismatch, malformed quoting, direct adapter apply, ambiguous/missing identity, untrusted helper, malformed/mismatched/unverified receipt, timeout/output-limit/nonzero, and malformed transport. Blocked cases assert that the helper runner is not invoked.
2. `npm run qa:security` passed: TypeScript build/typecheck; **271 Node fixture/mock tests**; **19 Hermes-plugin fixture tests**; **15 Playwright/axe fixture-browser tests**; secret scan of **183 tracked files**; and `npm audit --audit-level=high` with **0 vulnerabilities**.
3. Static helper verification passed: regular `Alej`-owned `0600` file; SHA-256 `4c09c926e94500f02f34a19ca80fbec280003227588d2b4f0d1d1085ee7fba37`, matching the adapter pin; `python3 -m py_compile` passed without executing it.
4. Final locked-state and repository review passed: AC-10 remained `PLANNED` under `.account-center-pipeline/locks/state.lock`; `git diff --check` passed; the working tree was clean before this evidence record. The local release branch contains the two prior AC-09 pipeline commits pending publication relative to `origin/main`; this is repository publication state, not an external dependency or an AC-06 blocker.

No native-helper invocation, live deletion, interactive login, provider request, credential/store write, routing/model mutation, Sentinel operation, service operation, or live browser action occurred.

## Decision

AC-10 satisfies specification, command-path integrity, quality, and security QA. Commit this release evidence and mark its local merge record verified. No subsequent release gate is defined, so the sole checkpoint remains AC-10 as completed release evidence. The owned transaction, one opaque receipt contract, working Dexter command, full Sentinel `/auth` format, and Hermes/Dexter weekly-only policy remain unchanged.
