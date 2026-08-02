# AC-08 R1 — direct Hermes owned-delete receipt review

**Status:** passed (fixture-only)

## Scope reviewed

- Account Center and Hermes share the versioned `account-center.owned-delete-receipt.v1` contract: the only verified public delete receipt is `{ "action": "account.delete", "state": "DELETED", "receipt": "opaque-owned-delete" }`; the only other delete output is the fixed target-free `UNPROVEN` contract.
- The OpenClaw adapter invokes only Alej’s owned native exact-account transaction at `/home/Alej/.openclaw/workspace/3-Resources/codex-account-ops/scripts/codex-auth-delete.py`, after exact connected-target resolution, verified shared executor capability, and helper trust checks. Its private receipt, target, paths, backups, and diagnostics do not cross the public boundary.
- Hermes invokes the working Dexter ChatOps `/auth delete` path and admits only exact canonical output. Fixture tests replace `subprocess.run` before the request, so neither ChatOps nor the native helper runs.
- The locked full Sentinel `/auth` format and Hermes/Dexter weekly-only policy remain covered by the complete fixture suites.

## Executed verification

1. `npm test` passed: **271 Node fixture/mock tests** and **19 Hermes-plugin fixture tests**.
2. `npm run test:a11y` passed: **15 Playwright/axe fixture-browser tests**.
3. `npm run qa:security` passed: typecheck/build, the complete fixture suites, secret scan of **182 tracked files**, and `npm audit --audit-level=high` with **0 vulnerabilities**.
4. Static helper verification passed: the helper is a regular `Alej`-owned `0600` file, SHA-256 `4c09c926e94500f02f34a19ca80fbec280003227588d2b4f0d1d1085ee7fba37`, matching the adapter pin; `python3 -m py_compile` passed without execution.
5. Locked-state/diff review passed: JSON parsed under `.account-center-pipeline/locks/state.lock`; AC-06 confirmation `db059ccd67ece007a5e0c0e4b2393aaa5842ab61` is an ancestor of `main`; `git diff --check` passed with a clean working tree before this evidence record.

No native-helper invocation, live deletion, interactive login, provider request, credential/store write, routing/model mutation, Sentinel operation, service operation, or live browser action occurred.

## Decision

AC-08 satisfies specification, quality, and security QA. Publish this evidence and advance the sole active checkpoint to AC-09, retaining all owned-transaction, opaque-receipt, Sentinel-format, Dexter-command, and weekly-only invariants.
