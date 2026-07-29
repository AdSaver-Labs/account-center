"""Hermetic fixtures for the real Hermes Account Center delete bridge.

The native transaction is never launched: subprocess.run is replaced before any
`/auth delete` command is exercised. The fixture root contains only the public
receipt contract and a presence-only ChatOps path required for root discovery.
"""

from __future__ import annotations

import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

REPO_ROOT = Path(__file__).resolve().parents[2]
PLUGIN = REPO_ROOT / "integrations" / "hermes-plugin" / "__init__.py"
CONTRACT = REPO_ROOT / "contracts" / "owned-delete-receipt.v1.json"


class HermesOwnedDeleteContractTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="account-center-hermes-plugin-")
        self.root = Path(self.temp.name)
        (self.root / "contracts").mkdir()
        (self.root / "scripts").mkdir()
        (self.root / "contracts" / CONTRACT.name).write_text(CONTRACT.read_text(encoding="utf-8"), encoding="utf-8")
        (self.root / "scripts" / "chatops.mjs").write_text("// fixture presence only\n", encoding="utf-8")
        self.old_root = os.environ.get("ACCOUNT_CENTER_ROOT")
        os.environ["ACCOUNT_CENTER_ROOT"] = str(self.root)
        spec = importlib.util.spec_from_file_location(f"account_center_hermes_fixture_{id(self)}", PLUGIN)
        assert spec and spec.loader
        self.plugin = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.plugin)
        self.contract = json.loads(CONTRACT.read_text(encoding="utf-8"))
        self.calls: list[tuple[list[str], str]] = []

    def tearDown(self) -> None:
        if self.old_root is None:
            os.environ.pop("ACCOUNT_CENTER_ROOT", None)
        else:
            os.environ["ACCOUNT_CENTER_ROOT"] = self.old_root
        self.temp.cleanup()

    def install_result(self, *, stdout: str, returncode: int = 0) -> None:
        def fake_run(command: list[str], **kwargs: object) -> SimpleNamespace:
            self.calls.append((command, str(kwargs["cwd"])))
            return SimpleNamespace(stdout=stdout, returncode=returncode)
        self.plugin.subprocess.run = fake_run

    def test_uses_one_contract_for_applied_and_unproven_delete_outcomes(self) -> None:
        for output in (self.contract["public"]["appliedText"], self.contract["public"]["unprovenText"]):
            self.install_result(stdout=output)
            self.assertEqual(self.plugin._run_auth("delete opaque-target --apply"), output)
        self.assertEqual(len(self.calls), 2)
        for command, cwd in self.calls:
            self.assertEqual(command[0], "node")
            self.assertEqual(command[1], str(self.root / "scripts" / "chatops.mjs"))
            self.assertEqual(command[2], "/auth delete opaque-target --apply")
            self.assertEqual(cwd, str(self.root))

    def test_injected_or_failed_transport_cannot_create_a_delete_success(self) -> None:
        unproven = self.contract["public"]["unprovenText"]
        self.install_result(stdout=self.contract["public"]["appliedText"] + "private@example.test\n")
        self.assertEqual(self.plugin._run_auth("delete opaque-target --apply"), unproven)
        self.install_result(stdout=self.contract["public"]["appliedText"], returncode=1)
        self.assertEqual(self.plugin._run_auth("delete opaque-target --apply"), unproven)

        def unavailable(*_args: object, **_kwargs: object) -> None:
            raise OSError("fixture transport unavailable")
        self.plugin.subprocess.run = unavailable
        self.assertEqual(self.plugin._run_auth("delete opaque-target --apply"), unproven)


if __name__ == "__main__":
    unittest.main()
