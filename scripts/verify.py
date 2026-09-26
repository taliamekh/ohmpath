"""Run the local software verification suite without opening physical devices."""

from pathlib import Path
import os
import shutil
import subprocess
import sys


def main():
    root = Path(__file__).resolve().parents[1]
    python = root / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    pnpm = shutil.which("pnpm.cmd" if os.name == "nt" else "pnpm")
    if not pnpm and os.name == "nt":
        bundled = Path.home() / ".cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm.cmd"
        if bundled.is_file():
            pnpm = str(bundled)
    if not python.is_file() or not pnpm:
        raise SystemExit("Set up the local Python environment and pnpm first; see README.md.")
    checks = [
        [str(python), "scripts/generate-contracts.py", "--check"],
        [str(python), "-m", "ruff", "check", "services", "scripts"],
        [str(python), "-m", "pytest", "-q"],
        [pnpm, "run", "build"],
        [pnpm, "run", "test:desktop-unit"],
        [pnpm, "run", "test:desktop"],
    ]
    for command in checks:
        result = subprocess.run(command, cwd=root, check=False)
        if result.returncode:
            return result.returncode
    print("Local automated verification passed. Physical acceptance remains pending.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
