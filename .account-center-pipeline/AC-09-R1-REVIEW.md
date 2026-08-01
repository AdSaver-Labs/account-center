# AC-09 R1 — cross-consumer opaque-receipt drift review

**Status:** passed (fixture/mock only)

## Scope reviewed

- The sole native credential-delete implementation remains Alej’s owned exact-account transaction at `/home/Alej/.openclaw/workspace/3-Resources/codex-account-ops/scripts/codex-auth-delete.py`. No upstream OpenClaw CLI delete command is required.
- Account Center’s adapter recognizes only the verified native receipt `{ action: "account.delete", state: "DELETED", receipt: "opaque-owned-delete" }`; its public renderer, Dexter ChatOps, MCP, and Hermes accept only the shared applied text or the fixed target-free `UNPROVEN` text.
- Fixture coverage exercised malformed/tampered contracts, target/path-bearing would-be success output, malformed/mismatched/unverified native receipts, nonzero/failed/unavailable transport, and consumer forwarding. All fail closed without invoking the helper.
- Locked Sentinel `/auth` rendering, the working Dexter `/auth delete` command, and Hermes/Dexter weekly-only capacity behavior remain covered by the complete fixture suite.

## Executed verification

1. `npm run qa:security` passed: **268 Node fixture/mock tests**, **19 Hermes-plugin fixtures**, TypeScript build and typecheck, **15 Playwright/axe fixture-browser tests**, secret scan of **173 tracked files**, and `npm audit --audit-level=high` with **0 vulnerabilities**.
2. `python3 -m py_compile integrations/hermes-plugin/__init__.py /home/Alej/.openclaw/workspace/3-Resources/codex-account-ops/scripts/codex-auth-delete.py` passed.
3. Static trust inspection passed: helper is a regular file owned by uid `1001` (`Alej`), mode `0600`, SHA-256 `4c09c926e94500f02f34a19ca80fbec280003227588d2b4f0d1d1085ee7fba37`, matching the immutable adapter pin.
4. Contract schema inspection passed for `account-center.owned-delete-receipt.v1` and opaque receipt `opaque-owned-delete`; pipeline JSON parsed under its exclusive lock and `git diff --check` passed.

No native helper invocation, live credential deletion, interactive login, provider request, credential/store write, routing/model mutation, runtime service operation, or live browser operation occurred.

## Decision

AC-09 R1 passes specification, quality, and security QA. The release evidence may be committed and published; the owned transaction, opaque contract, full Sentinel `/auth` format, working Dexter command, and weekly-only policy are unchanged.
