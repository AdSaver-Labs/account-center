import json
import os
import pathlib
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
HELPER = ROOT / "scripts" / "persist_blocked_delete_receipt.py"


class BlockedDeleteReceiptTests(unittest.TestCase):
    def run_helper(self, root):
        return subprocess.run(["python3", str(HELPER), str(root)], capture_output=True, text=True, check=False)

    def test_private_descriptor_receipt_is_opaque_and_durable(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp) / "data"
            result = self.run_helper(root)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(stat_mode(root), 0o700)
            directory = root / "blocked-delete-receipts"
            self.assertEqual(stat_mode(directory), 0o700)
            files = list(directory.iterdir())
            self.assertEqual(len(files), 1)
            self.assertRegex(files[0].name, r"^rcpt_[A-Za-z0-9_-]+\.json$")
            self.assertEqual(stat_mode(files[0]), 0o600)
            record = json.loads(files[0].read_text())
            self.assertEqual(record, {"schemaVersion": "account-center.blocked-delete-receipt.v1", "action": "account.delete", "outcome": "unproven", "applied": False, "dryRun": True, "liveRuntimeMutation": False, "receiptId": "receipt-redacted", "warningCodes": ["status_adapter_unavailable", "no_live_mutation"]})

    def test_shared_or_symlinked_root_fails_without_persistence(self):
        with tempfile.TemporaryDirectory() as temp:
            base = pathlib.Path(temp)
            shared = base / "shared"
            shared.mkdir(mode=0o755)
            os.chmod(shared, 0o755)
            self.assertNotEqual(self.run_helper(shared).returncode, 0)
            target = base / "target"
            target.mkdir(mode=0o700)
            link = base / "link"
            link.symlink_to(target, target_is_directory=True)
            self.assertNotEqual(self.run_helper(link).returncode, 0)
            self.assertFalse((target / "blocked-delete-receipts").exists())


def stat_mode(path):
    return path.stat().st_mode & 0o777


if __name__ == "__main__":
    unittest.main()
