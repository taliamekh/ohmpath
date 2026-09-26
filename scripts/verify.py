"""Run local software checks; --no-voice selects an explicit offline-only profile."""

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys


NO_VOICE_PYTEST = (
    "tests/unit/test_verify_script.py",
    "services/bench/tests/test_ai_runtime.py",
    "services/bench/tests/test_assembly.py",
    "services/bench/tests/test_calibration_api.py",
    "services/bench/tests/test_circuits.py",
    "services/bench/tests/test_circuits_kicad.py",
    "services/bench/tests/test_diagnosis.py",
    "services/bench/tests/test_firmware.py",
    "services/bench/tests/test_integrated_tools.py",
    "services/bench/tests/test_laboratory.py",
    "services/bench/tests/test_measurement_review.py",
    "services/bench/tests/test_meter_ocr.py",
    "services/bench/tests/test_photo_help.py",
    "services/bench/tests/test_photo_runtime.py",
    "services/bench/tests/test_pi_link.py",
    "services/bench/tests/test_process_lifecycle.py",
    "services/bench/tests/test_report.py",
    "services/bench/tests/test_session.py",
    "services/bench/tests/test_vision_frames.py",
    "services/bench/tests/test_vision_geometry.py",
    "services/bench/tests/test_vision_meter.py",
    "services/bench/tests/test_windows_ocr.py",
    "services/pi/tests/test_calibration_fit.py",
    "services/pi/tests/test_deployment_package.py",
    "services/pi/tests/test_video_server.py",
)
NO_VOICE_NODE = (
    "tests/unit/photo-clipboard.test.cjs",
    "tests/unit/photo-images.test.cjs",
    "tests/unit/photo-upload.test.cjs",
    "tests/unit/pi-video.test.cjs",
    "tests/unit/reviewed-image.test.cjs",
    "tests/unit/turret-preference.test.cjs",
)
NO_VOICE_DESKTOP = (
    "tests/end-to-end/visual-workspace.spec.ts",
    "tests/end-to-end/photo-help-replay.spec.ts",
    "tests/end-to-end/camera-focus.spec.ts",
    "tests/end-to-end/camera-snapshot-lifecycle.spec.ts",
    "tests/end-to-end/pi-camera-recovery.spec.ts",
    "tests/end-to-end/photo-workspace-session.spec.ts",
    "tests/end-to-end/troubleshoot-lifecycle.spec.ts",
    "tests/end-to-end/renderer-recovery.spec.ts",
    "tests/end-to-end/compact-workspace.spec.ts",
    "tests/end-to-end/character-motion.spec.ts",
    "tests/end-to-end/desktop.spec.ts",
    "tests/end-to-end/desktop-crash.spec.ts",
)


def executable_paths(root: Path) -> tuple[str, str | None, str | None]:
    python = root / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    pnpm = shutil.which("pnpm.cmd" if os.name == "nt" else "pnpm")
    if not pnpm and os.name == "nt":
        bundled = Path.home() / ".cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm.cmd"
        if bundled.is_file():
            pnpm = str(bundled)
    return str(python), pnpm, shutil.which("node.exe" if os.name == "nt" else "node")


def command_plan(python: str, pnpm: str, node: str | None, *, no_voice: bool) -> list[tuple[str, list[str]]]:
    """Return a fixed command allowlist, not a discovered test glob."""
    common = [
        ("generated contracts", [python, "scripts/generate-contracts.py", "--check"]),
        ("Python lint", [python, "-m", "ruff", "check", "services", "scripts"]),
    ]
    if no_voice:
        return common + [
            ("offline Python regressions", [python, "-m", "pytest", "-q", *NO_VOICE_PYTEST]),
            ("desktop build", [pnpm, "run", "build"]),
            ("offline bridge regressions", [node or "node", "--test", *NO_VOICE_NODE]),
            ("native image metadata", [pnpm, "exec", "electron", "tests/electron/image-metadata.cjs"]),
            ("native photo upload", [pnpm, "exec", "electron", "tests/electron/photo-upload.cjs"]),
            ("native image paste", [pnpm, "exec", "electron", "tests/electron/photo-clipboard.cjs"]),
            ("offline visual regressions", [pnpm, "exec", "playwright", "test", "--config", "tests/end-to-end/playwright.config.ts", *NO_VOICE_DESKTOP]),
        ]
    return common + [
        ("Python regressions", [python, "-m", "pytest", "-q"]),
        ("desktop build", [pnpm, "run", "build"]),
        ("desktop bridge regressions", [pnpm, "run", "test:desktop-unit"]),
        ("native image metadata", [pnpm, "run", "test:image-metadata"]),
        ("desktop walkthrough", [pnpm, "run", "test:desktop"]),
    ]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--no-voice", action="store_true", help="Use only explicit offline tests with no voice or ElevenLabs cases.")
    parser.add_argument("--list", action="store_true", help="Print the selected commands without executing them.")
    options = parser.parse_args(argv)

    root = Path(__file__).resolve().parents[1]
    python, pnpm, node = executable_paths(root)
    plan = command_plan(python, pnpm or "pnpm", node, no_voice=options.no_voice)
    if options.list:
        for label, command in plan:
            print(f"{label}: {json.dumps(command)}")
        return 0
    if not Path(python).is_file() or not pnpm or (options.no_voice and not node):
        raise SystemExit("Set up the local Python environment, Node.js and pnpm first; see README.md.")
    for label, command in plan:
        print(f"Running {label}...", flush=True)
        result = subprocess.run(command, cwd=root, check=False)
        if result.returncode:
            return result.returncode
    print("Local automated verification passed. Physical acceptance remains pending.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
