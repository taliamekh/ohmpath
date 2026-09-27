"""Offline coverage for the normal Windows desktop CLI discovery path."""

from __future__ import annotations

import sys
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from ohmpath.ai import executable
from ohmpath.ai.codex import PINNED_CLI_VERSION
from ohmpath.ai.live_proof import ProofFailure, restricted_command


def _codex(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"test binary placeholder")
    return path


def _version_probe(monkeypatch, versions: dict[Path, str]):
    calls: list[tuple[list[str], dict]] = []

    def run(command, **kwargs):
        calls.append((command, kwargs))
        return SimpleNamespace(returncode=0, stdout=versions.get(Path(command[0]), "other version") + "\n")

    monkeypatch.setattr(executable.subprocess, "run", run)
    return calls


@pytest.mark.skipif(sys.platform != "win32", reason="Windows desktop installation layout")
def test_discovers_official_app_binary_when_normal_path_has_no_codex(tmp_path, monkeypatch):
    installed = _codex(tmp_path / "local" / "OpenAI" / "Codex" / "bin" / "build-a" / "codex.exe")
    monkeypatch.setattr(executable.shutil, "which", lambda name: None)
    calls = _version_probe(monkeypatch, {installed: PINNED_CLI_VERSION})
    resolved = executable.resolve_codex_executable(PINNED_CLI_VERSION, environ={
        "LOCALAPPDATA": str(tmp_path / "local"), "USERPROFILE": str(tmp_path / "profile"),
    })
    assert resolved == str(installed.resolve())
    assert calls[0][0] == [resolved, "--version"]
    assert calls[0][1]["timeout"] == 5
    assert calls[0][1]["shell"] is False


@pytest.mark.skipif(sys.platform != "win32", reason="Windows desktop installation layout")
def test_incompatible_path_binary_falls_through_to_pinned_official_binary(tmp_path, monkeypatch):
    on_path = _codex(tmp_path / "path" / "codex.exe")
    installed = _codex(tmp_path / "local" / "OpenAI" / "Codex" / "bin" / "build-a" / "codex.exe")
    monkeypatch.setattr(executable.shutil, "which", lambda name: str(on_path))
    calls = _version_probe(monkeypatch, {on_path: "codex-cli old", installed: PINNED_CLI_VERSION})
    resolved = executable.resolve_codex_executable(PINNED_CLI_VERSION, environ={
        "LOCALAPPDATA": str(tmp_path / "local"), "USERPROFILE": str(tmp_path / "profile"),
    })
    assert resolved == str(installed.resolve())
    assert [Path(call[0][0]) for call in calls] == [on_path, installed]


@pytest.mark.skipif(sys.platform != "win32", reason="Windows desktop installation layout")
def test_userprofile_fallback_finds_virtualized_local_app(tmp_path, monkeypatch):
    installed = _codex(tmp_path / "profile" / "AppData" / "Local" / "OpenAI" / "Codex"
                       / "bin" / "build-a" / "codex.exe")
    monkeypatch.setattr(executable.shutil, "which", lambda name: None)
    _version_probe(monkeypatch, {installed: PINNED_CLI_VERSION})
    assert executable.resolve_codex_executable(PINNED_CLI_VERSION, environ={
        "LOCALAPPDATA": str(tmp_path / "missing"), "USERPROFILE": str(tmp_path / "profile"),
    }) == str(installed.resolve())


def test_explicit_invalid_override_does_not_fall_back_to_other_candidates(tmp_path, monkeypatch):
    candidate = _codex(tmp_path / ("codex.exe" if sys.platform == "win32" else "codex"))
    monkeypatch.setattr(executable.shutil, "which", lambda name: str(candidate))
    calls = _version_probe(monkeypatch, {candidate: PINNED_CLI_VERSION})
    with pytest.raises(executable.ExecutableUnavailable, match="codex_executable_unavailable"):
        executable.resolve_codex_executable(PINNED_CLI_VERSION, environ={
            "OHMPATH_CODEX_EXECUTABLE": str(tmp_path / "missing" / candidate.name),
        })
    assert calls == []


def test_no_arbitrary_executable_or_version_fallback(tmp_path, monkeypatch):
    wrong_name = _codex(tmp_path / "unrelated.exe")
    monkeypatch.setattr(executable.shutil, "which", lambda name: str(wrong_name))
    calls = _version_probe(monkeypatch, {wrong_name: PINNED_CLI_VERSION})
    with pytest.raises(executable.ExecutableUnavailable, match="codex_executable_unavailable"):
        executable.resolve_codex_executable(PINNED_CLI_VERSION, environ={})
    assert calls == []


def test_pinned_version_mismatch_is_a_readable_proof_failure(tmp_path, monkeypatch):
    candidate = _codex(tmp_path / ("codex.exe" if sys.platform == "win32" else "codex"))
    if sys.platform != "win32":
        candidate.chmod(0o700)
    monkeypatch.setattr(executable.shutil, "which", lambda name: str(candidate))
    _version_probe(monkeypatch, {candidate: "codex-cli incompatible"})
    monkeypatch.delenv("OHMPATH_CODEX_EXECUTABLE", raising=False)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "missing"))
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "missing"))
    with pytest.raises(ProofFailure, match="^codex_version_mismatch$"):
        restricted_command(bridge_mcp=False)


def test_restricted_command_uses_same_verified_absolute_path_for_launch(tmp_path, monkeypatch):
    candidate = _codex(tmp_path / ("codex.exe" if sys.platform == "win32" else "codex"))
    if sys.platform != "win32":
        candidate.chmod(0o700)
    config_home = tmp_path / "config"
    config_home.mkdir()
    (config_home / "config.toml").write_text("", encoding="utf-8")
    monkeypatch.setenv("CODEX_HOME", str(config_home))
    monkeypatch.setenv("OHMPATH_CODEX_EXECUTABLE", str(candidate))
    calls = _version_probe(monkeypatch, {candidate: PINNED_CLI_VERSION})
    command = restricted_command(bridge_mcp=False)
    assert command[:3] == [str(candidate.resolve()), "app-server", "--strict-config"]
    assert calls[0][0] == [command[0], "--version"]


@pytest.mark.parametrize("failure", [OSError("cannot launch"),
    subprocess.TimeoutExpired("codex", 5), UnicodeError("unreadable version"), None])
def test_unlaunchable_binary_is_not_reported_as_a_version_mismatch(tmp_path, monkeypatch, failure):
    candidate = _codex(tmp_path / ("codex.exe" if sys.platform == "win32" else "codex"))
    if sys.platform != "win32":
        candidate.chmod(0o700)

    def failed_probe(*args, **kwargs):
        if failure is not None:
            raise failure
        return SimpleNamespace(returncode=1, stdout="")

    monkeypatch.setattr(executable.subprocess, "run", failed_probe)
    with pytest.raises(executable.ExecutableUnavailable, match="codex_executable_unavailable"):
        executable.resolve_codex_executable(PINNED_CLI_VERSION, environ={
            "OHMPATH_CODEX_EXECUTABLE": str(candidate),
        })
