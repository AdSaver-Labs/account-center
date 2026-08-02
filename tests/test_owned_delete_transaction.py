#!/usr/bin/env python3
"""Hermetic tests for Dexter's owned exact-account delete transaction.

The helper is run only with HOME set to a temporary fixture tree; it never sees
or modifies the real OpenClaw credential directories.
"""
import json
import os
import shutil
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
    def make_home(self) -> tuple[tempfile.TemporaryDirectory, Path, Path, Path]:
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
        return temp, home, json_path, db_path

    def invoke(self, home: Path, failure: str | None = None) -> subprocess.CompletedProcess[str]:
        env = {"HOME": str(home), "PATH": os.environ["PATH"]}
        if failure:
            env["CODEX_AUTH_DELETE_TEST_FAIL_AFTER"] = failure
        return subprocess.run(
            [sys.executable, str(HELPER), PROFILE, "--apply"],
            env=env, text=True, capture_output=True, check=False,
        )

    @staticmethod
    def database_profile_ids(db_path: Path) -> list[str]:
        con = sqlite3.connect(db_path)
        try:
            row = con.execute("select store_json from auth_profile_store where store_key='primary'").fetchone()
            return list(json.loads(row[0])["profiles"])
        finally:
            con.close()

    def test_successful_fixture_delete_uses_private_native_receipt(self) -> None:
        temp, home, json_path, db_path = self.make_home()
        self.addCleanup(temp.cleanup)
        result = self.invoke(home)
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads(result.stdout)
        self.assertEqual(receipt["action"], "account.delete")
        self.assertEqual(receipt["state"], "DELETED")
        self.assertTrue(receipt["backup"])
        self.assertTrue(receipt["verified"])
        self.assertNotIn(PROFILE, json_path.read_text())
        self.assertNotIn(PROFILE, self.database_profile_ids(db_path))
        # The helper's target digest remains private. Consumers must project it
        # to the separately tested opaque-owned-delete contract.
        self.assertIn("targetDigest", receipt)

    def test_json_failure_restores_json_and_sqlite_byte_for_byte(self) -> None:
        temp, home, json_path, db_path = self.make_home()
        self.addCleanup(temp.cleanup)
        before_json, before_db = json_path.read_bytes(), db_path.read_bytes()
        result = self.invoke(home, "json")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(json.loads(result.stdout)["state"], "UNPROVEN")
        self.assertEqual(json_path.read_bytes(), before_json)
        self.assertEqual(db_path.read_bytes(), before_db)

    def test_sqlite_failure_restores_json_and_sqlite_byte_for_byte(self) -> None:
        temp, home, json_path, db_path = self.make_home()
        self.addCleanup(temp.cleanup)
        before_json, before_db = json_path.read_bytes(), db_path.read_bytes()
        result = self.invoke(home, "sqlite")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(json.loads(result.stdout)["state"], "UNPROVEN")
        self.assertEqual(json_path.read_bytes(), before_json)
        self.assertEqual(db_path.read_bytes(), before_db)


if __name__ == "__main__":
    unittest.main()
