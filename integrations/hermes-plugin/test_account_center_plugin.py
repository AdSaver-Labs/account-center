from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


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
        self.assertEqual(plugin._build_auth_message(""), "/auth help")
        self.assertEqual(plugin._build_auth_message("status --json"), "/auth status --json")
        self.assertEqual(plugin._build_auth_message("/auth status"), "/auth status")
        self.assertEqual(plugin._build_auth_message("/oauth status"), "/auth help")

    def test_redact_output_masks_token_shapes(self):
        plugin = load_plugin_module()
        redacted = plugin._redact_output('refresh_token="sample-refresh-value" access_token=sample-access-value')
        self.assertNotIn("sample-refresh-value", redacted)
        self.assertNotIn("sample-access-value", redacted)
        self.assertIn("[REDACTED]", redacted)

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
        self.assertEqual(ctx.commands["auth"]["args_hint"], "")
        self.assertIn("Account Center", ctx.commands["auth"]["description"])


if __name__ == "__main__":
    unittest.main()
