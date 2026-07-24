import importlib.util
import json
import os
import pathlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[2]
HELPER = ROOT / "scripts" / "persist_blocked_delete_receipt.py"
SPEC = importlib.util.spec_from_file_location("persist_blocked_delete_receipt", HELPER)
assert SPEC and SPEC.loader
RECEIPT_HELPER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RECEIPT_HELPER)


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

    def test_short_write_fixture_completes_the_full_payload(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp) / "data"
            real_write = os.write

            def short_write(fd, data):
                return real_write(fd, data[:7])

            with patch.object(RECEIPT_HELPER.os, "write", side_effect=short_write) as mocked_write:
                self.assertTrue(RECEIPT_HELPER.persist(str(root)))
            self.assertGreater(mocked_write.call_count, 1)
            files = list((root / "blocked-delete-receipts").iterdir())
            self.assertEqual(len(files), 1)
            self.assertEqual(json.loads(files[0].read_text())["action"], "account.delete")

    def test_write_or_sync_fault_fixture_returns_false_without_partial_receipt_success(self):
        for fault in ("write", "file_fsync"):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as temp:
                root = pathlib.Path(temp) / "data"
                if fault == "write":
                    real_write = os.write
                    calls = 0

                    def fail_after_partial(fd, data):
                        nonlocal calls
                        calls += 1
                        if calls == 1:
                            return real_write(fd, data[:5])
                        raise OSError("injected write failure")

                    patched = patch.object(RECEIPT_HELPER.os, "write", side_effect=fail_after_partial)
                else:
                    real_fsync = os.fsync

                    def fail_file_sync(fd):
                        if not os.path.isdir(f"/proc/self/fd/{fd}"):
                            raise OSError("injected file sync failure")
                        return real_fsync(fd)

                    patched = patch.object(RECEIPT_HELPER.os, "fsync", side_effect=fail_file_sync)
                with patched:
                    self.assertFalse(RECEIPT_HELPER.persist(str(root)))
                directory = root / "blocked-delete-receipts"
                self.assertTrue(directory.is_dir())
                self.assertEqual(list(directory.iterdir()), [])

    def test_created_components_are_parent_synced_before_descending(self):
        with tempfile.TemporaryDirectory() as temp:
            base = pathlib.Path(temp)
            root = base / "first" / "second"
            events = []
            real_mkdir = os.mkdir
            real_fsync = os.fsync

            def identity(fd):
                info = os.fstat(fd)
                return info.st_dev, info.st_ino

            def record_mkdir(name, mode=0o777, *, dir_fd=None):
                events.append(("mkdir", identity(dir_fd), name))
                return real_mkdir(name, mode, dir_fd=dir_fd)

            def record_fsync(fd):
                events.append(("fsync", identity(fd)))
                return real_fsync(fd)

            with patch.object(RECEIPT_HELPER.os, "mkdir", side_effect=record_mkdir), patch.object(RECEIPT_HELPER.os, "fsync", side_effect=record_fsync):
                self.assertTrue(RECEIPT_HELPER.persist(str(root)))

            mkdir_events = [event for event in events if event[0] == "mkdir"]
            self.assertEqual([event[2] for event in mkdir_events[-3:]], ["first", "second", "blocked-delete-receipts"])
            for index, event in enumerate(events):
                if event[0] == "mkdir":
                    self.assertEqual(events[index + 1], ("fsync", event[1]))

    def test_receipt_parent_sync_fault_removes_new_receipt_directory(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp) / "data"
            root.mkdir(mode=0o700)
            os.chmod(root, 0o700)
            root_info = root.stat()
            root_identity = root_info.st_dev, root_info.st_ino
            real_fsync = os.fsync

            def fail_receipt_parent_sync(fd):
                info = os.fstat(fd)
                if (info.st_dev, info.st_ino) == root_identity:
                    raise OSError("injected receipt-parent sync failure")
                return real_fsync(fd)

            with patch.object(RECEIPT_HELPER.os, "fsync", side_effect=fail_receipt_parent_sync):
                self.assertFalse(RECEIPT_HELPER.persist(str(root)))
            self.assertFalse((root / "blocked-delete-receipts").exists())


def stat_mode(path):
    return path.stat().st_mode & 0o777


if __name__ == "__main__":
    unittest.main()
