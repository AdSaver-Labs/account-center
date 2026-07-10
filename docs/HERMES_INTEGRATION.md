# Hermes `/auth` Integration

Account Center ships a Hermes plugin that registers `/auth` as a real Hermes slash command. The command delegates to the same Account Center ChatOps wrapper used by CLI/local tests, so Telegram, CLI/plugin sessions, and future bridges share one command implementation.

## What it does

- Registers `/auth` through `hermes_cli.plugins.PluginContext.register_command`.
- Routes typed commands such as `/auth status --json` to `scripts/chatops.mjs`.
- Defaults Hermes-side Account Center reads to the OpenClaw/Sentinel adapter when configured with `account_center.default_source: openclaw`.
- Keeps mutation-shaped commands dry-run unless the user explicitly passes `--apply` and the adapter supports live mutation.
- Redacts token/API-key shaped strings from command output before returning it to chat.
- Does not store or copy provider credentials. Credentials remain in the owning runtime stores.

## Install into a Hermes profile

From the Account Center repo:

```bash
mkdir -p ~/.hermes/plugins/account-center
cp integrations/hermes-plugin/plugin.yaml ~/.hermes/plugins/account-center/plugin.yaml
cp integrations/hermes-plugin/__init__.py ~/.hermes/plugins/account-center/__init__.py
```

Enable the plugin and point it at this checkout in `~/.hermes/config.yaml`:

```yaml
plugins:
  enabled:
    - account-center

account_center:
  root: /home/Alej/account-center-draft
  default_source: openclaw
  openclaw_workspace: /home/Alej/.openclaw/workspace
  openclaw_cli: /home/Alej/.openclaw/workspace/ops/scripts/oauth_routing_cli.py
  command_timeout: 45

platforms:
  telegram:
    extra:
      command_menu:
        priority:
          - auth
        priority_mode: prepend
        max_commands: 80
```

Then restart the Hermes gateway from outside the running gateway process:

```bash
systemctl --user restart hermes-gateway.service
```

Telegram's command menu is populated by `set_my_commands` at gateway startup. After restart, `/auth` should appear near the top of the menu because the integration sets it as a command-menu priority.

## Verify locally

```bash
python3 integrations/hermes-plugin/test_account_center_plugin.py

python3 - <<'PY'
from hermes_cli.plugins import discover_plugins, get_plugin_command_handler
from hermes_cli.commands import telegram_bot_commands, telegram_menu_commands

discover_plugins(force=True)
handler = get_plugin_command_handler('auth')
assert handler
assert 'auth' in {name for name, _ in telegram_bot_commands()}
menu, _ = telegram_menu_commands()
assert 'auth' in {name for name, _ in menu}
print(handler('status --json --no-write-export')[:500])
PY
```

## Example commands

```text
/auth help
/auth status --json
/auth accounts
/auth next
/auth probe --provider all --json
/auth ensure --source openclaw
/auth auto
```

The manual command namespace is `/auth`. `/oauth` remains a rejected legacy/internal name and should not be exposed to users.
