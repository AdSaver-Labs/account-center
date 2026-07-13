# Account Center agent instructions

## Codex `/auth` parity

This repo has an Account Center MCP server registered with the VPS Codex CLI as `account-center`.

When Alej asks Codex about `/auth`, Account Center status, connected Codex/OpenClaw accounts, routing, limits, auto-switch, or safe auth dry-runs, Codex should use the MCP tools instead of guessing from files:

- `account-center/account_center_status` — equivalent to `/auth`.
- `account-center/account_center_help` — command help.
- `account-center/account_center_auth` — run a specific `/auth ...` command.

Safety rules:

- Status/help/list/dry-run commands are allowed.
- Live Account Center mutations are allowed in Codex MCP because Alej explicitly approved Account Center as the local control plane for Codex account recovery.
- Destructive commands still require Account Center guardrails: exact connected target match, runtime-specific adapter, backup/receipt, and redacted output.
- Delete means credential deletion; remove means routing removal only.
- Do not print secrets, tokens, raw OAuth JSON, or SQLite credential rows.
- Redact emails in logs or shared summaries as `[REDACTED_EMAIL]` unless Alej explicitly needs the exact value.

The MCP server implementation lives at:

```text
scripts/account-center-mcp.mjs
```

Fallback if MCP is unavailable:

```bash
ACCOUNT_CENTER_SOURCE=openclaw node scripts/chatops.mjs '/auth'
```
