"""Resolve the already-installed Codex CLI without changing accounts or PATH."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Mapping


class ExecutableUnavailable(RuntimeError):
    """No usable local Codex executable was found."""


class ExecutableVersionMismatch(RuntimeError):
    """Local Codex executables exist, but none match the pinned version."""


def _local_executable(value: str | Path) -> Path | None:
    path = Path(value).expanduser()
    if not path.is_absolute() or str(path).startswith(("\\\\", "//")):
        return None
    try:
        resolved = path.resolve(strict=True)
    except (OSError, RuntimeError):
        return None
    expected_name = "codex.exe" if sys.platform == "win32" else "codex"
    if (not resolved.is_file() or resolved.name.lower() != expected_name
            or str(resolved).startswith(("\\\\", "//"))):
        return None
    if sys.platform != "win32" and not os.access(resolved, os.X_OK):
        return None
    return resolved


def _official_windows_candidates(env: Mapping[str, str]) -> list[Path]:
    if sys.platform != "win32":
        return []
    bases: list[Path] = []
    if env.get("LOCALAPPDATA"):
        bases.append(Path(env["LOCALAPPDATA"]))
    profile = env.get("USERPROFILE")
    if profile:
        bases.append(Path(profile) / "AppData" / "Local")
    found: list[Path] = []
    for base in bases:
        root = base / "OpenAI" / "Codex" / "bin"
        if not root.is_dir():
            continue
        # Only versioned executable children of the official desktop install.
        found.extend(sorted(root.glob("*/codex.exe"), key=lambda path: str(path).lower()))
    return found


def resolve_codex_executable(pinned_version: str, *, environ: Mapping[str, str] | None = None) -> str:
    """Return one verified absolute CLI path, preferring override, PATH, then app install.

    An explicit override is authoritative. Other candidates are tried in stable
    order until the exact pinned version is found. No candidate is downloaded,
    invoked through a shell, or used for a model turn during discovery.
    """
    env = os.environ if environ is None else environ
    override = env.get("OHMPATH_CODEX_EXECUTABLE", "").strip()
    if override:
        candidates: list[str | Path] = [override]
    else:
        on_path = shutil.which("codex.exe" if sys.platform == "win32" else "codex")
        candidates = ([on_path] if on_path else []) + _official_windows_candidates(env)

    seen: set[Path] = set()
    version_mismatch = False
    for candidate in candidates:
        path = _local_executable(candidate)
        if path is None or path in seen:
            continue
        seen.add(path)
        try:
            result = subprocess.run(
                [str(path), "--version"], capture_output=True, text=True,
                stdin=subprocess.DEVNULL, timeout=5, check=False, shell=False,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except (OSError, subprocess.TimeoutExpired, UnicodeError):
            continue
        if result.returncode == 0 and result.stdout.strip() == pinned_version:
            return str(path)
        if result.returncode == 0:
            version_mismatch = True

    if version_mismatch:
        raise ExecutableVersionMismatch("codex_version_mismatch")
    raise ExecutableUnavailable("codex_executable_unavailable")
