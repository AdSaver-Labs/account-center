# Account Center Control App Strategy

**Date:** 2026-07-13

## Decision

Account Center should be the primary local control plane for Codex/OpenClaw/Hermes account status, routing, and recovery. It should not depend on modifying the Codex app/TUI first.

Codex MCP and future Codex TUI patches are integration surfaces, not the product foundation.

## Why this is better

A separate Account Center app can:

- show which agent/runtime is currently using which account;
- show which accounts are in auto-switch order;
- show usage windows and reset times;
- let Alej manually recover when an agent stops due to limits/auth trouble;
- work even when Codex's literal slash-command surface is limited or changes after updates;
- integrate multiple runtimes at once: Codex, OpenClaw, Hermes, and future agents.

This avoids over-coupling Account Center to one enterprise app's private TUI behavior.

## Required manual commands

The Account Center command contract must be available from the app UI and from chat/MCP surfaces where supported:

| Command | Meaning | Default manual behavior |
|---|---|---|
| `/auth` | show status, active account, limits, commands | read-only |
| `/auth list` | list connected accounts/routes | read-only |
| `/auth auto` | apply safe auto-switch to best readable account | live route mutation by default; `--dry-run` previews |
| `/auth use <email-or-profile>` | switch active route to a connected account | live route mutation by default; `--dry-run` previews |
| `/auth remove <email-or-profile>` | remove from routing only | live route mutation by default; does **not** delete credentials; `--dry-run` previews |
| `/auth delete <email-or-profile>` | delete credentials | live only after exact connected target match, backup, receipt; `--dry-run` previews |
| `/auth add <email>` | start account/device-code add flow | app should launch guided flow |
| `/auth reauth <email>` | refresh expired/broken account | app should launch guided flow |

## Mutation policy

Alej explicitly allows live Account Center mutations from Codex/MCP/app paths. The risk control is **not** permanent refusal; the risk control is Account Center logic:

- exact connected target match for destructive delete;
- separate `remove` vs `delete` semantics;
- backup before runtime mutation;
- receipt/audit record;
- redacted output;
- no raw credential/token display;
- runtime-specific adapter instead of blind file edits.

## Codex integration tiers

1. **Works now:** Codex MCP server `account-center` can call Account Center tools.
2. **Allowed now:** MCP registration on the VPS includes `ACCOUNT_CENTER_MCP_ALLOW_MUTATIONS=1`.
3. **Convenience later:** local Codex TUI/app patch for `/auth` or equivalent command if stable enough.
4. **Better product path:** Account Center desktop/menu-bar/app UI with direct buttons for status, use, auto, remove, delete, add, and reauth.
5. **Future Codex app-server path:** Codex 0.144.3 exposes experimental `app-server` and `remote-control` surfaces; these should be investigated for product-level integration before maintaining fragile TUI patches.

## App UI implication

The app should have an agent/account control view:

- agent selector: Codex, OpenClaw agents, Hermes/Jack, future agents;
- active account badge;
- auto-switch order view;
- per-account usage windows;
- buttons:
  - Auto-switch now;
  - Use this account;
  - Remove from routing;
  - Delete credentials;
  - Add account;
  - Reauth account;
- confirmation affordances for delete only;
- receipts/history panel.

This lets Alej recover agents even if the target app's chat command surface is unavailable.
