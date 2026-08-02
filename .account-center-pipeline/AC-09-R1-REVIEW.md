# AC-09 R1 — cross-consumer opaque-receipt drift review

**Status:** passed (fixture-only)

## Scope reviewed

- Account Center CLI, OpenClaw runtime adapter, Dexter ChatOps/MCP, and Hermes all enforce the sole versioned `account-center.owned-delete-receipt.v1` contract. The only verified public native result is `{ "action": "account.delete", "state": "DELETED", "receipt": "opaque-owned-delete" }`; every other delete result is the fixed, target-free `UNPROVEN` text.
- The adapter remains pinned to Alej’s owned exact-account transaction at `/home/Alej/.openclaw/workspace/3-Resources/codex-account-ops/scripts/codex-auth-delete.py`. It resolves one exact connected target and requires executor capability plus trusted helper evidence before it can call the helper. Its private receipt, target digest, backups, paths, stores, and diagnostics are suppressed.
- Dexter `/auth delete` remains the working shared ChatOps path used by Hermes. Fixture transport tests reject malformed, target-bearing, mismatched, unverified, nonzero, timeout, output-limit, and alternate-success outputs without invoking a native transaction.
- The locked full Sentinel `/auth` format and Hermes/Dexter weekly-only policy remain exercised in the complete fixture suites.

## Executed verification

1. Static contract and consumer inspection confirmed the fixed schema/version, two canonical public outcomes, opaque adapter normalizer, owned helper path/trust pin, and direct Hermes/Dexter shared transport.
2. `npm test` passed: **271 Node fixture/mock tests** and **19 Hermes-plugin fixture tests**, including cross-consumer receipt-drift and owned-helper non-invocation cases.
3. `npm run test:a11y` passed: **15 Playwright/axe fixture-browser tests**.
4. `npm run qa:security` passed: typecheck/build, complete fixture suites, secret scan of **182 tracked files**, and `npm audit --audit-level=high` with **0 vulnerabilities**.
5. Static helper verification passed: regular `Alej`-owned `0600` file; SHA-256 `4c09c926e94500f02f34a19ca80fbec280003227588d2b4f0d1d1085ee7fba37`; `python3 -m py_compile` passed without execution.
6. Final repository review passed: clean working tree before this evidence record, `git diff --check`, tracked-file secret scan, and JSON state/status/gate validation under `.account-center-pipeline/locks/state.lock` all passed.

No native-helper invocation, live deletion, interactive login, provider request, credential/store write, routing/model mutation, Sentinel operation, service operation, or live browser action occurred.

## Decision

AC-09 satisfies specification, quality, and security QA. Release evidence may be merged and the sole active checkpoint advances to AC-10, retaining the owned transaction, one opaque receipt contract, working Dexter command, full Sentinel `/auth` format, and Hermes/Dexter weekly-only policy.
