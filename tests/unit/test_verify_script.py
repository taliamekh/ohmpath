"""The offline verification profile must stay explicit and previewable."""

import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("ohmpath_verify", ROOT / "scripts/verify.py")
assert SPEC and SPEC.loader
verify = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verify)


def test_no_voice_plan_is_an_explicit_allowlist_with_photo_and_camera_coverage():
    plan = verify.command_plan("python", "pnpm", "node", no_voice=True)
    labels = [label for label, _ in plan]
    commands = [command for _, command in plan]
    assert labels == [
        "generated contracts", "Python lint", "offline Python regressions",
        "desktop build", "offline bridge regressions", "native image metadata",
        "native photo upload", "native image paste", "offline visual regressions",
    ]
    assert all("*" not in argument for command in commands for argument in command)
    assert "services/bench/tests/test_photo_help.py" in commands[2]
    assert "services/bench/tests/test_photo_runtime.py" in commands[2]
    assert "tests/unit/pi-video.test.cjs" in commands[4]
    assert "tests/electron/photo-upload.cjs" in commands[6]
    assert "tests/unit/photo-clipboard.test.cjs" in commands[4]
    assert "tests/electron/photo-clipboard.cjs" in commands[7]
    assert "tests/end-to-end/camera-focus.spec.ts" in commands[8]
    assert "tests/end-to-end/camera-snapshot-lifecycle.spec.ts" in commands[8]
    assert "tests/end-to-end/dual-camera-workspace.spec.ts" in commands[8]
    assert "tests/end-to-end/photo-help-replay.spec.ts" in commands[8]
    assert "tests/end-to-end/visual-workspace.spec.ts" in commands[8]
    forbidden = ("voice", "speech", "elevenlabs", "live-proof", "live_proof")
    selected_tests = [argument.lower() for command in commands for argument in command if argument.startswith(("tests/", "services/"))]
    assert not any(word in argument for argument in selected_tests for word in forbidden)


def test_list_only_prints_the_selected_plan_without_spawning_or_requiring_tools(monkeypatch, capsys):
    monkeypatch.setattr(verify, "executable_paths", lambda root: ("missing-python", None, None))

    def forbidden_spawn(*args, **kwargs):
        raise AssertionError("--list must not spawn a command")

    monkeypatch.setattr(verify.subprocess, "run", forbidden_spawn)
    assert verify.main(["--no-voice", "--list"]) == 0
    lines = capsys.readouterr().out.splitlines()
    assert len(lines) == 9
    listed = [json.loads(line.split(": ", 1)[1]) for line in lines]
    assert listed[2][0] == "missing-python"
    assert listed[3] == ["pnpm", "run", "build"]
    assert listed[-1][-1] == "tests/end-to-end/desktop-crash.spec.ts"


def test_default_plan_is_preserved_and_execution_stops_on_failure(monkeypatch):
    default = verify.command_plan("python", "pnpm", "node", no_voice=False)
    assert [command for _, command in default] == [
        ["python", "scripts/generate-contracts.py", "--check"],
        ["python", "-m", "ruff", "check", "services", "scripts"],
        ["python", "-m", "pytest", "-q"],
        ["pnpm", "run", "build"],
        ["pnpm", "run", "test:desktop-unit"],
        ["pnpm", "run", "test:image-metadata"],
        ["pnpm", "run", "test:desktop"],
    ]
    monkeypatch.setattr(verify, "executable_paths", lambda root: (str(ROOT / "scripts/verify.py"), "pnpm", "node"))
    seen = []

    def fail_second(command, **kwargs):
        seen.append(command)
        assert kwargs["cwd"] == ROOT
        assert kwargs["check"] is False
        return SimpleNamespace(returncode=7 if len(seen) == 2 else 0)

    monkeypatch.setattr(verify.subprocess, "run", fail_second)
    assert verify.main(["--no-voice"]) == 7
    assert seen == [command for _, command in verify.command_plan(str(ROOT / "scripts/verify.py"), "pnpm", "node", no_voice=True)[:2]]
