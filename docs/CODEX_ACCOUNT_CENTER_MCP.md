# Codex Account Center MCP Bridge

**Date:** 2026-07-13

## Purpose

Codex TUI/app currently does not support the native `/auth` slash command used in Hermes/OpenClaw chats. In an interactive Codex TUI smoke test, `/auth` returned:

```text
Unrecognized command '/auth'. Type "/" for a list of supported commands.
```

Until Codex exposes a custom slash-command surface, Account Center parity is provided through a Codex MCP server.

## Server

Implementation:

```text
scripts/account-center-mcp.mjs
```

Registered globally in Codex as:

```text
account-center
```

Registration command used on the VPS:

```bash
codex mcp add account-center \
  --env ACCOUNT_CENTER_SOURCE=openclaw \
  -- node /home/Alej/account-center-draft/scripts/account-center-mcp.mjs
```

Current `codex mcp get account-center --json` shows a stdio server using:

```text
node /home/Alej/account-center-draft/scripts/account-center-mcp.mjs
```

## Exposed tools

| Tool | Purpose |
|---|---|
| `account_center_status` | Equivalent to `/auth`; shows Account Center Codex/OpenClaw account status and limits. |
| `account_center_help` | Shows `/auth` command help. |
| `account_center_auth` | Runs a specific `/auth ...` command. |

## Safety

The bridge is safe-by-default:

- status/help/list/dry-run commands are allowed;
- live mutating commands are blocked by default;
- email addresses and token-shaped values are redacted from tool output;
- live mutations require a deliberate controlled session with `ACCOUNT_CENTER_MCP_ALLOW_MUTATIONS=1`.

Blocked examples by default:

```text
/auth delete <email>
/auth remove <email>
/auth use <email>
/auth add <email>
/auth reauth <email>
```

Allowed examples:

```text
/auth
/auth list
/auth help
/auth auto
/auth delete nobody@example.invalid --dry-run
```

## Verification

Direct MCP JSON-RPC smoke passed:

- `initialize` returned server info;
- `tools/list` returned Account Center tools;
- `account_center_status` returned `Codex account limits`;
- live delete without dry-run was blocked.

Codex agent smoke passed:

```text
mcp: account-center/account_center_status started
mcp: account-center/account_center_status (completed)
MCP_AUTH_OK
Codex account limits
```

## Remaining gap

This MCP bridge gives Codex real Account Center access, but it does not make literal `/auth` in the Codex TUI become a slash command. Native `/auth` in Codex still needs one of:

1. Codex custom slash-command support if/when available;
2. a Codex plugin command surface if local plugin commands become available;
3. an app-server/TUI patch, if we decide to maintain a local patch;
4. the future Account Center app UI, making `/auth` less important inside the Codex TUI.
