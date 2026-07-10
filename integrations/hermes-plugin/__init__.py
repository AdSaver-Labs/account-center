"""Hermes plugin for Account Center `/auth` commands.

This plugin intentionally registers a slash command rather than a model tool:
manual `/auth ...` messages should execute outside the LLM/tool prompt path and
should never expose provider tokens to the model.
"""

from __future__ import annotations

import os
import re
import shlex
import subprocess
from pathlib import Path
from typing import Any

_REDACTION_PATTERNS = [
    re.compile(r"rt\.1\.[A-Za-z0-9._~+/=-]{12,}"),
    re.compile(r"eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{12,}"),
    re.compile(r"sk-[A-Za-z0-9_-]{20,}"),
    re.compile(r"(?i)(access_token|refresh_token|id_token|api_key|agent_key)([\"'\s:=]+)([^\s\"']{4,})"),
]


def _cfg_get(path: str, default: Any = None) -> Any:
    try:
        from hermes_cli.config import cfg_get

        value = cfg_get(path, default)
        return default if value is None else value
    except Exception:
        return default


def _account_center_root() -> Path:
    configured = (
        os.environ.get("ACCOUNT_CENTER_ROOT")
        or _cfg_get("account_center.root")
        or ""
    )
    candidates = [configured] if configured else []
    candidates.extend([
        "/home/Alej/account-center-draft",
        str(Path.home() / "account-center-draft"),
        str(Path.home() / "account-center"),
    ])
    for raw in candidates:
        if not raw:
            continue
        path = Path(str(raw)).expanduser().resolve()
        if (path / "scripts" / "chatops.mjs").exists():
            return path
    raise RuntimeError(
        "Account Center root not found. Set account_center.root in ~/.hermes/config.yaml "
        "or ACCOUNT_CENTER_ROOT to the repo containing scripts/chatops.mjs."
    )


def _build_auth_message(raw_args: str) -> str:
    text = (raw_args or "").strip()
    if not text:
        return "/auth"
    if text.lower().startswith("/oauth"):
        return "/auth help"
    if text.lower().startswith("/auth"):
        return text
    return f"/auth {text}".strip()


def _redact_output(text: str) -> str:
    redacted = text or ""
    for pattern in _REDACTION_PATTERNS:
        def repl(match: re.Match[str]) -> str:
            if match.lastindex and match.lastindex >= 2:
                return f"{match.group(1)}{match.group(2)}[REDACTED]"
            return "[REDACTED]"
        redacted = pattern.sub(repl, redacted)
    return redacted


def _env_for_account_center() -> dict[str, str]:
    env = dict(os.environ)
    default_source = _cfg_get("account_center.default_source", "openclaw")
    if default_source:
        env.setdefault("ACCOUNT_CENTER_SOURCE", str(default_source))
    openclaw_workspace = _cfg_get("account_center.openclaw_workspace")
    if openclaw_workspace:
        env.setdefault("ACCOUNT_CENTER_OPENCLAW_WORKSPACE", str(openclaw_workspace))
    openclaw_cli = _cfg_get("account_center.openclaw_cli")
    if openclaw_cli:
        env.setdefault("ACCOUNT_CENTER_OPENCLAW_CLI", str(openclaw_cli))
    return env


def _run_auth(raw_args: str) -> str:
    root = _account_center_root()
    message = _build_auth_message(raw_args)
    timeout = int(_cfg_get("account_center.command_timeout", 45) or 45)
    proc = subprocess.run(
        ["node", str(root / "scripts" / "chatops.mjs"), message],
        cwd=str(root),
        env=_env_for_account_center(),
        text=True,
        capture_output=True,
        timeout=timeout,
        check=False,
    )
    output = (proc.stdout or "").strip()
    if proc.returncode != 0:
        stderr = (proc.stderr or "").strip()
        detail = stderr or output or f"exit code {proc.returncode}"
        return "Account Center `/auth` command failed:\n\n```text\n" + _redact_output(detail)[:3500] + "\n```"
    return _redact_output(output or "Account Center returned no output.")[:3900]


def _run_off_alias(raw_args: str) -> str:
    """Compatibility alias for voice/STT confusion around `/auth`.

    The canonical manual command remains `/auth`; `/off` exists only so a user
    who hears or transcribes "auth" as "off" still reaches the same Account
    Center command surface.
    """
    result = _run_auth(raw_args)
    return "`/off` is an alias; canonical command is `/auth`.\n\n" + result


def register(ctx: Any) -> None:
    ctx.register_command(
        "auth",
        _run_auth,
        description="Account Center status, routing, probes, and Sentinel controls",
        args_hint="",
    )
    ctx.register_command(
        "off",
        _run_off_alias,
        description="Alias for /auth Account Center commands",
        args_hint="",
    )
