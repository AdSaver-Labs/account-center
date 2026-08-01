# AC-08 R1 — direct Hermes receipt-contract review

**Status:** passed (fixture/mock only)

## Scope reviewed

- Account Center retains the owned exact-account transaction at `/home/Alej/.openclaw/workspace/3-Resources/codex-account-ops/scripts/codex-auth-delete.py`; no upstream OpenClaw CLI delete command is required.
- The OpenClaw adapter is pinned to that regular Alej-owned `0600` helper and accepts only the verified native receipt `{ action: "account.delete", state: "DELETED", receipt: "opaque-owned-delete" }`.
- The direct Hermes-plugin fixture imports the real bridge using a temporary fixture root and replaces `subprocess.run` before `/auth delete`; it permits only the shared versioned applied and `UNPROVEN` texts and fails closed for injected output, nonzero result, or unavailable transport.
- Compiled Account Center adapter, CLI, Dexter ChatOps, MCP, Hermes, and documentation fixtures retain the same target-free opaque receipt boundary. Locked Sentinel `/auth` rendering, working Dexter `/auth delete`, and Hermes/Dexter weekly-only behavior remain covered.

## Executed verification

1. `npm run qa:security` passed: **268 Node fixture/mock tests**, **19 Hermes-plugin fixtures**, TypeScript build/typecheck, **15 Playwright/axe fixture-browser tests**, secret scan of **171 tracked files**, and `npm audit --audit-level=high` reporting **0 vulnerabilities**.
2. `python3 -m py_compile integrations/hermes-plugin/__init__.py /home/Alej/.openclaw/workspace/3-Resources/codex-account-ops/scripts/codex-auth-delete.py` passed.
3. Static helper trust inspection passed: regular file, owner `Alej` (uid 1001), mode `0600`, SHA-256 `4c09c926e94500f02f34a19ca80fbec280003227588d2b4f0d1d1085ee7fba37`, matching the immutable adapter pin.
4. Pipeline JSON was written under its exclusive lock and parsed by Python and Node. `git diff --check` passed before review recording.

No native helper invocation, live credential deletion, interactive login, provider request, credential/store write, routing/model mutation, runtime service operation, or live browser operation occurred.

## Decision

AC-08 R1 passes specification, quality, and security QA. The candidate may be committed and published as the release-gate record; protected implementation, policy, and format surfaces remain unchanged.
