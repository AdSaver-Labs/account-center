# Codex and Hermes `/auth` Test Results

**Date:** 2026-07-13  
**Scope:** Verify Account Center `/auth` behavior across VPS Codex and Hermes application/gateway surfaces before asking Codex to build the visual Account Center interface.

## Summary

| Surface | Result | Notes |
|---|---|---|
| Account Center ChatOps wrapper | ✅ Works | `ACCOUNT_CENTER_SOURCE=openclaw node scripts/chatops.mjs '/auth'` renders Dexter/OpenClaw-style account limits. |
| VPS Codex CLI model/auth | ✅ Works after config fix | Default model was invalid for ChatGPT-account Codex; pinned `~/.codex/config.toml` to `gpt-5.5`, then smoke returned expected response. |
| Codex agent shell tools | ✅ Works | Codex successfully ran the Account Center ChatOps wrapper and saw `Codex account limits`. |
| Codex TUI/app native `/auth` slash command | ❌ Not yet wired | Interactive Codex TUI returns `Unrecognized command '/auth'. Type "/" for a list of supported commands.` |
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

Interactive Codex TUI does not currently know `/auth`:

```text
Unrecognized command '/auth'. Type "/" for a list of supported commands.
```

This means Codex can access Account Center only by running the local wrapper/API through shell tools today. For parity with Hermes/OpenClaw chats, Account Center still needs a Codex-native integration.

Recommended options:

1. Codex plugin/skill command that maps `/auth ...` to Account Center.
2. Codex MCP server/tool exposing Account Center status/actions.
3. Codex app-side command bridge once the Codex app surface supports custom slash commands.
4. Short-term fallback: instruct Codex to run `ACCOUNT_CENTER_SOURCE=openclaw node scripts/chatops.mjs '/auth ...'` until native UI bridge exists.

## Next required work before UI build

- Add a native Codex `/auth` bridge or MCP/tool surface so Codex app/TUI can display the same Account Center output as Hermes/OpenClaw chats.
- Keep the shell wrapper as fallback.
- Re-test manual command flows from Codex after bridge installation:
  - `/auth`
  - `/auth list`
  - `/auth auto`
  - `/auth add <email>`
  - `/auth reauth <email>`
  - `/auth remove <email>`
  - `/auth delete <email> --dry-run`
- Only run destructive live remove/delete with explicit user target and approval.
