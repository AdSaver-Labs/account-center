# Commands

Account Center should expose the same operations through CLI, HTTP, Telegram, and other chat bridges.

## Naming

Preferred public command namespace:

```text
/account ...
```

Aliases can include:

```text
/auth ...
/oauth ...
/model-account ...
```

## Chat commands

| Command | Purpose | Safe by default? |
|---|---|---|
| `/account` | Show short status and active route | yes |
| `/account status` | Full account/routing status | yes |
| `/account list` | List profiles with health/usage/role | yes |
| `/account next` | Show next eligible account without switching | yes |
| `/account auto` | Switch to policy-selected next eligible account | mutates routing |
| `/account use <label>` | Switch routing head to an existing eligible account | mutates routing |
| `/account force <label>` | Force route despite warnings | approval/high-friction |
| `/account remove <label>` | Remove from routing order; keep credential saved | mutates routing |
| `/account disable <label>` | Disable account in policy | mutates policy |
| `/account enable <label>` | Re-enable account in policy | mutates policy |
| `/account reauth <label>` | Start OAuth/device-code or adapter reauth | human auth required |
| `/account add <provider> <label>` | Start adding a new account | human auth required |
| `/account models` | List model availability and disabled models | yes |
| `/account model disable <provider/model>` | Remove model from allowed routing | mutates policy |
| `/account model enable <provider/model>` | Re-enable model | mutates policy |
| `/account leases` | Show project/agent account leases | yes |
| `/account lease <agent> <label> <ttl>` | Temporarily reserve account | mutates policy |
| `/account doctor` | Diagnose adapters/config/status | yes |
| `/account audit` | Show recent switch/reauth events | yes |
| `/account help` | Command help | yes |

## CLI equivalents

```bash
account-center status
account-center accounts list
account-center routes next
account-center routes auto --apply
account-center routes use <profile> --apply
account-center routes remove <profile> --apply
account-center accounts disable <profile> --apply
account-center accounts enable <profile> --apply
account-center accounts reauth <profile>
account-center accounts add --provider openai --label helper-1
account-center models list
account-center models disable openai/gpt-5.5 --apply
account-center doctor
account-center audit list --limit 20
```

## HTTP API sketch

```http
GET  /v1/status
GET  /v1/accounts
GET  /v1/routes/next?provider=openai&agent=main
POST /v1/routes/use
POST /v1/routes/auto
POST /v1/accounts/:id/disable
POST /v1/accounts/:id/enable
POST /v1/accounts/:id/remove-from-routing
POST /v1/accounts/:id/reauth
GET  /v1/models
POST /v1/models/:id/disable
POST /v1/models/:id/enable
GET  /v1/audit
GET  /v1/doctor
```

All mutating routes should support:

```json
{
  "dryRun": true,
  "reason": "operator requested from Telegram",
  "actor": "telegram:6286407055"
}
```

## Manual Telegram workflows

### Check status

```text
/account status
```

Expected response:

```text
Account Center: OK
Active: openai:helper-1
Next eligible: openai:helper-2
Warnings: jack-codex daily 1% left; adsaver backup protected
```

### Switch to next available account

```text
/account auto
```

Expected response:

```text
Switched openai route:
old: openai:helper-1
new: openai:helper-2
receipt: evt_...
```

### Switch to a specific account

```text
/account use 49pushy
```

If eligible:

```text
Switched to openai:49pushy-simmers+link@icloud.com.
5h left: 97%, weekly left: 77%.
```

If blocked:

```text
Blocked by policy: account is backup-only. Use /account force 49pushy --confirm if you really want this.
```

### Remove from routing without deleting credential

```text
/account remove travis
```

Expected:

```text
Removed openai:travis... from normal routing. Credential remains saved. Use /account enable travis to restore policy visibility.
```

### Reauthenticate

```text
/account reauth travis
```

Expected:

```text
Open this URL and enter code ABCD-EFGH:
https://...
Waiting up to 15 minutes. I will report success/failure here.
```

### Disable a broken model

```text
/account model disable openai/gpt-5.3-codex
```

Expected:

```text
Disabled model openai/gpt-5.3-codex for provider openai because it is incompatible with ChatGPT-backed Codex accounts.
Affected adapters: openclaw, hermes.
Receipt: evt_...
```

## OpenClaw/Dexter current manual command mapping

Existing private commands/scripts that informed this spec:

```bash
# Account list/status from Telegram plugin
/auth
/auth list
/auth <email>
/auth add <email>
/auth reauth <email>
/auth remove <email>
/auth auto

# Direct private scripts
node 3-Resources/codex-account-ops/scripts/codex-auth-switch.mjs --auto --apply --agent all
node 3-Resources/codex-account-ops/scripts/codex-auth-switch.mjs <email-or-profile> --apply --agent all
3-Resources/codex-account-ops/scripts/codex-account-sentinel.mjs --print
python3 ops/scripts/oauth_routing_cli.py status --workspace ~/.openclaw/workspace --json
python3 ops/scripts/oauth_routing_cli.py doctor --workspace ~/.openclaw/workspace
```

Account Center should absorb these semantics into a clean, provider/runtime-neutral command set.

## Safety requirements

- Mutating commands must print what will change before applying when interactive.
- Chat commands must require explicit confirmation for backup-only/last-resort accounts.
- Reauth commands must redact tokens and store only non-secret challenge metadata in chat-visible state.
- Remove/disable must distinguish **remove from routing** from **delete credential**; v0 should avoid credential deletion.
- Every successful mutation writes an audit receipt.
