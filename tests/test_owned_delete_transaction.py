#!/usr/bin/env python3
"""Hermetic tests for Dexter's owned exact-account delete transaction.

The helper is run only with HOME and its private state root set to a temporary
fixture tree; it never sees or modifies real OpenClaw credentials or state.
"""
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HELPER = Path("/home/Alej/.openclaw/workspace/3-Resources/codex-account-ops/scripts/codex-auth-delete.py")
TARGET = "fixture-delete@example.test"
PROFILE = "openai:fixture-delete@example.test"


class OwnedDeleteTransactionTest(unittest.TestCase):
    def make_home(self) -> tuple[tempfile.TemporaryDirectory, Path, Path, Path, Path]:
        temp = tempfile.TemporaryDirectory(prefix="account-center-owned-delete-")
        home = Path(temp.name)
        agent = home / ".openclaw" / "agents" / "fixture-agent" / "agent"
        agent.mkdir(parents=True)
        profile = {"version": 1, "profiles": {PROFILE: {"email": TARGET, "token": "fixture-secret"}}}
        state = {"order": {"openai": [PROFILE]}, "lastGood": {"openai": PROFILE}}
        json_path = agent / "auth-profiles.json"
        json_path.write_text(json.dumps(profile, separators=(",", ":")) + "\n")
        db_path = agent / "openclaw-agent.sqlite"
        con = sqlite3.connect(db_path)
        con.execute("create table auth_profile_store (store_key text primary key, store_json text, updated_at integer)")
        con.execute("create table auth_profile_state (state_key text primary key, state_json text, updated_at integer)")
        con.execute("insert into auth_profile_store values ('primary', ?, 1)", (json.dumps(profile, separators=(",", ":")),))
        con.execute("insert into auth_profile_state values ('primary', ?, 1)", (json.dumps(state, separators=(",", ":")),))
        con.commit()
        con.close()
        state_root = home / ".fixture-private-state"
        return temp, home, json_path, db_path, state_root

    def invoke(self, home: Path, state_root: Path, *, target: str = PROFILE, apply: bool = True, failure: str | None = None) -> subprocess.CompletedProcess[str]:
        env = {
            "HOME": str(home),
            "PATH": os.environ["PATH"],
            "CODEX_AUTH_DELETE_FIXTURE": "1",
            "CODEX_AUTH_DELETE_TEST_STATE_ROOT": str(state_root),
        }
        if failure:
            env["CODEX_AUTH_DELETE_TEST_FAIL_AFTER"] = failure
        command = [sys.executable, str(HELPER), target]
        if apply:
            command.append("--apply")
        return subprocess.run(command, env=env, text=True, capture_output=True, check=False)

    @staticmethod
    def database_profile_ids(db_path: Path) -> list[str]:
        con = sqlite3.connect(db_path)
        try:
            row = con.execute("select store_json from auth_profile_store where store_key='primary'").fetchone()
            return list(json.loads(row[0])["profiles"])
        finally:
            con.close()

    @staticmethod
    def paths_under(root: Path) -> set[Path]:
        return {path.resolve() for path in root.rglob("*") if path.is_file()}

    def test_successful_fixture_delete_uses_private_native_receipt_and_fixture_state(self) -> None:
        temp, home, json_path, db_path, state_root = self.make_home()
        self.addCleanup(temp.cleanup)
        result = self.invoke(home, state_root)
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads(result.stdout)
        self.assertEqual(receipt["action"], "account.delete")
        self.assertEqual(receipt["state"], "DELETED")
        self.assertTrue(receipt["backup"])
        self.assertTrue(receipt["verified"])
        self.assertNotIn(PROFILE, json_path.read_text())
        self.assertNotIn(PROFILE, self.database_profile_ids(db_path))
        self.assertIn("targetDigest", receipt)
        artifacts = self.paths_under(state_root)
        self.assertEqual(len(artifacts), 3)  # JSON/SQLite backup + one private receipt
        self.assertTrue(all(path.is_relative_to(home.resolve()) for path in artifacts))
        receipt_paths = list((state_root / "state" / "auth-delete-receipts").glob("*.json"))
        self.assertEqual(len(receipt_paths), 1)
        self.assertEqual(json.loads(receipt_paths[0].read_text())["state"], "DELETED")

    def test_preview_is_non_mutating_and_writes_no_private_artifacts(self) -> None:
        temp, home, json_path, db_path, state_root = self.make_home()
        self.addCleanup(temp.cleanup)
        before_json, before_db = json_path.read_bytes(), db_path.read_bytes()
        result = self.invoke(home, state_root, apply=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["state"], "PREVIEW")
        self.assertEqual(json_path.read_bytes(), before_json)
        self.assertEqual(db_path.read_bytes(), before_db)
        self.assertFalse(state_root.exists())

    def test_exact_target_not_found_is_non_mutating_and_writes_no_private_artifacts(self) -> None:
        temp, home, json_path, db_path, state_root = self.make_home()
        self.addCleanup(temp.cleanup)
        before_json, before_db = json_path.read_bytes(), db_path.read_bytes()
        result = self.invoke(home, state_root, target="openai:not-connected@example.test")
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertEqual(json.loads(result.stdout)["state"], "BLOCKED")
        self.assertEqual(json_path.read_bytes(), before_json)
        self.assertEqual(db_path.read_bytes(), before_db)
        self.assertFalse(state_root.exists())

    def test_json_failure_restores_json_and_sqlite_byte_for_byte_under_fixture_root(self) -> None:
        temp, home, json_path, db_path, state_root = self.make_home()
        self.addCleanup(temp.cleanup)
        before_json, before_db = json_path.read_bytes(), db_path.read_bytes()
        result = self.invoke(home, state_root, failure="json")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(json.loads(result.stdout)["state"], "UNPROVEN")
        self.assertEqual(json_path.read_bytes(), before_json)
        self.assertEqual(db_path.read_bytes(), before_db)
        self.assertTrue(all(path.is_relative_to(home.resolve()) for path in self.paths_under(state_root)))

    def test_sqlite_failure_restores_json_and_sqlite_byte_for_byte_under_fixture_root(self) -> None:
        temp, home, json_path, db_path, state_root = self.make_home()
        self.addCleanup(temp.cleanup)
        before_json, before_db = json_path.read_bytes(), db_path.read_bytes()
        result = self.invoke(home, state_root, failure="sqlite")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(json.loads(result.stdout)["state"], "UNPROVEN")
        self.assertEqual(json_path.read_bytes(), before_json)
        self.assertEqual(db_path.read_bytes(), before_db)
        self.assertTrue(all(path.is_relative_to(home.resolve()) for path in self.paths_under(state_root)))


if __name__ == "__main__":
    unittest.main()
