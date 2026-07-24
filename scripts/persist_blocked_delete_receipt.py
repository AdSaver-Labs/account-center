#!/usr/bin/env python3
"""Persist one redacted blocked-delete receipt under a process-owned root.

This CLI-boundary helper deliberately accepts no requested receipt pathname.
It uses descriptor-relative traversal and no-follow opens on POSIX systems.
"""
import json
import os
import secrets
import stat
import sys


def fail() -> int:
    return 1


def open_dir_component(parent_fd: int, name: str, create: bool) -> int:
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    try:
        return os.open(name, flags, dir_fd=parent_fd)
    except FileNotFoundError:
        if not create:
            raise
        os.mkdir(name, 0o700, dir_fd=parent_fd)
        return os.open(name, flags, dir_fd=parent_fd)


def private_root(path: str) -> int:
    if not os.path.isabs(path):
        raise ValueError("root must be absolute")
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        parts = [part for part in path.split("/") if part]
        if not parts or any(part in (".", "..") for part in parts):
            raise ValueError("invalid root")
        for part in parts:
            next_fd = open_dir_component(fd, part, True)
            os.close(fd)
            fd = next_fd
        info = os.fstat(fd)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
            raise ValueError("unsafe root")
        # Do not silently repair a shared root; privacy is a required contract.
        if stat.S_IMODE(info.st_mode) != 0o700:
            raise ValueError("root is not private")
        return fd
    except Exception:
        os.close(fd)
        raise


def persist(root: str) -> bool:
    root_fd = private_root(root)
    try:
        receipts_fd = open_dir_component(root_fd, "blocked-delete-receipts", True)
        try:
            info = os.fstat(receipts_fd)
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
                return False
            record = {
                "schemaVersion": "account-center.blocked-delete-receipt.v1",
                "action": "account.delete",
                "outcome": "unproven",
                "applied": False,
                "dryRun": True,
                "liveRuntimeMutation": False,
                "receiptId": "receipt-redacted",
                "warningCodes": ["status_adapter_unavailable", "no_live_mutation"],
            }
            data = (json.dumps(record, separators=(",", ":")) + "\n").encode("utf-8")
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
            for _ in range(8):
                name = "rcpt_" + secrets.token_urlsafe(24) + ".json"
                try:
                    receipt_fd = os.open(name, flags, 0o600, dir_fd=receipts_fd)
                except FileExistsError:
                    continue
                try:
                    info = os.fstat(receipt_fd)
                    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600:
                        return False
                    os.write(receipt_fd, data)
                    os.fsync(receipt_fd)
                finally:
                    os.close(receipt_fd)
                os.fsync(receipts_fd)
                return True
            return False
        finally:
            os.close(receipts_fd)
    finally:
        os.close(root_fd)


def main() -> int:
    if len(sys.argv) != 2:
        return fail()
    try:
        return 0 if persist(sys.argv[1]) else fail()
    except (OSError, ValueError):
        return fail()


if __name__ == "__main__":
    raise SystemExit(main())
