# Codex and Hermes `/auth` Test Results

**Date:** 2026-07-13  
**Scope:** Verify Account Center `/auth` behavior across VPS Codex and Hermes application/gateway surfaces before asking Codex to build the visual Account Center interface.

## Summary

| Surface | Result | Notes |
|---|---|---|
| Account Center ChatOps wrapper | ✅ Works | `ACCOUNT_CENTER_SOURCE=openclaw node scripts/chatops.mjs '/auth'` renders Dexter/OpenClaw-style account limits. |
| VPS Codex CLI model/auth | ✅ Works after config fix | Default model was invalid for ChatGPT-account Codex; pinned `~/.codex/config.toml` to `gpt-5.5`, then smoke returned expected response. |
| Codex agent shell tools | ✅ Works | Codex successfully ran the Account Center ChatOps wrapper and saw `Codex account limits`. |
| Codex TUI/app native `/auth` slash command | ⚠️ MCP bridge installed | Literal `/auth` in the TUI still returns `Unrecognized command`, but Codex now has an `account-center` MCP server exposing `account_center_status`, `account_center_help`, and `account_center_auth`. |
| Hermes Account Center plugin | ✅ Works | Direct plugin call returns `Codex account limits`; `/off` alias works. |
| Hermes gateway service | ✅ Running | `hermes-gateway.service` active. |
| Hermes desktop backend | ✅ Running | `hermes-desktop-backend.service` active. |

## Details

### Account Center ChatOps wrapper

Verified safe commands:

- `/auth`
- `/auth list`
- `/auth auto` dry-run
- `/auth delete nobody@example.invalid --dry-run`
- `/oauth` rejection

Observed `/auth` output includes:

- `Codex account limits`
- current active account
- non-AdSaver weekly-usable count
- three readable/routing-enabled Plus accounts
- weekly windows
- note that OpenAI may report weekly/168h without a separate 5h window

### Codex CLI model fix

Initial Codex smoke failed because the default model was unsupported for ChatGPT-account Codex:

```text
The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account.
```

Tested explicit models:

- `gpt-5.5` ✅
- `gpt-5.4-mini` ✅
- `codex-auto-review` ✅

Pinned local Codex config:

```toml
model = "gpt-5.5"
```

Then default Codex smoke succeeded.

### Codex TUI/app gap

Interactive Codex TUI does not currently know literal `/auth`:

```text
Unrecognized command '/auth'. Type "/" for a list of supported commands.
```

A Codex MCP bridge has been installed as `account-center`, exposing:

- `account_center_status`
- `account_center_help`
- `account_center_auth`

Codex agent smoke verified the MCP bridge:

```text
MCP_AUTH_OK
Codex account limits
```

So Codex can access Account Center natively through MCP tools today; literal `/auth` slash-command parity remains a future TUI/plugin/app command task.

## Next required work before UI build

- Keep the MCP bridge and shell wrapper as fallbacks.
- If true literal `/auth` inside Codex TUI becomes necessary, add a TUI/plugin/app command bridge later.
- Re-test manual command flows from Codex through MCP before allowing live actions:
  - `/auth`
  - `/auth list`
  - `/auth auto`
  - `/auth add <email>`
  - `/auth reauth <email>`
  - `/auth remove <email>`
  - `/auth delete <email> --dry-run`
- Only run destructive live remove/delete with explicit user target and approval.
