from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


def load_plugin_module():
    plugin_path = Path(__file__).with_name("__init__.py")
    spec = importlib.util.spec_from_file_location("account_center_hermes_plugin_under_test", plugin_path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class AccountCenterHermesPluginTest(unittest.TestCase):
    def test_build_auth_message_normalizes_to_auth_namespace(self):
        plugin = load_plugin_module()
        self.assertEqual(plugin._build_auth_message(""), "/auth")
        self.assertEqual(plugin._build_auth_message("status --json"), "/auth status --json")
        self.assertEqual(plugin._build_auth_message("/auth status"), "/auth status")
        self.assertEqual(plugin._build_auth_message("/oauth status"), "/auth help")

    def test_redact_output_masks_token_shapes(self):
        plugin = load_plugin_module()
        redacted = plugin._redact_output('refresh_token="sample-refresh-value" access_token=sample-access-value')
        self.assertNotIn("sample-refresh-value", redacted)
        self.assertNotIn("sample-access-value", redacted)
        self.assertIn("[REDACTED]", redacted)

    def test_failed_chatops_subprocess_returns_fixed_unproven_contract(self):
        plugin = load_plugin_module()
        hostile_output = "email=person@example.test path=/srv/private/ac token=sk-secret-value-123456789"
        with patch.object(plugin, "_account_center_root", return_value=Path("/fixture/account-center")), patch.object(
            plugin.subprocess,
            "run",
            return_value=SimpleNamespace(returncode=2, stdout="", stderr=hostile_output),
        ):
            result = plugin._run_auth("delete person@example.test")
        self.assertEqual(result, plugin._AUTH_UNPROVEN_TEXT)
        self.assertNotIn("person@example.test", result)
        self.assertNotIn("sk-secret", result)

    def test_successful_chatops_stdout_redacts_email_paths_and_tokens(self):
        plugin = load_plugin_module()
        hostile_stdout = (
            "Account Center outcome: BLOCKED\n"
            "contact=person@example.test path=/srv/private/account-center/state "
            "token=hostile-token-value-123456789"
        )
        with patch.object(plugin, "_account_center_root", return_value=Path("/fixture/account-center")), patch.object(
            plugin.subprocess,
            "run",
            return_value=SimpleNamespace(returncode=0, stdout=hostile_stdout, stderr=""),
        ):
            result = plugin._run_auth("status")
        self.assertIn("Account Center outcome: BLOCKED", result)
        for private_value in (
            "person@example.test",
            "/srv/private/account-center/state",
            "hostile-token-value-123456789",
        ):
            self.assertNotIn(private_value, result)
        self.assertIn("[REDACTED]", result)

    def test_registered_command_metadata(self):
        plugin = load_plugin_module()

        class Ctx:
            def __init__(self):
                self.commands = {}

            def register_command(self, name, handler, description="", args_hint=""):
                self.commands[name] = {
                    "handler": handler,
                    "description": description,
                    "args_hint": args_hint,
                }

        ctx = Ctx()
        plugin.register(ctx)
        self.assertIn("auth", ctx.commands)
        self.assertIn("off", ctx.commands)
        self.assertEqual(ctx.commands["auth"]["args_hint"], "")
        self.assertEqual(ctx.commands["off"]["args_hint"], "")
        self.assertIn("Account Center", ctx.commands["auth"]["description"])
        self.assertIn("/auth", ctx.commands["off"]["description"])


if __name__ == "__main__":
    unittest.main()
