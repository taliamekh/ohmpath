"""Prepare the free local development dependencies without changing shell policy."""

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="check prerequisites and prepared files without installing")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    if sys.version_info < (3, 12):
        raise SystemExit("Use Python 3.12 or newer to prepare Ohm Path.")
    node = shutil.which("node")
    pnpm = shutil.which("pnpm.cmd" if os.name == "nt" else "pnpm")
    if not pnpm and os.name == "nt":
        bundled = Path.home() / ".cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm.cmd"
        if bundled.is_file():
            pnpm = str(bundled)
    if not node or not pnpm:
        raise SystemExit("Install the free Node.js 22+ and pnpm 11 tools, then rerun setup.")
    node_version = subprocess.check_output([node, "-p", "process.versions.node"], text=True).strip()
    pnpm_version = subprocess.check_output([pnpm, "--version"], text=True).strip()
    if int(node_version.split(".")[0]) < 22 or pnpm_version != "11.25.0":
        raise SystemExit("This checkout expects Node.js 22+ and the locked pnpm 11.25.0 release.")
    python = root / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    print(f"Python {sys.version.split()[0]}, Node.js {node_version}, pnpm {pnpm_version}", flush=True)
    if args.check:
        prepared = [python, root / "node_modules/electron/package.json", root / "dist/desktop/index.html"]
        missing = [str(path.relative_to(root)) for path in prepared if not path.is_file()]
        if missing:
            raise SystemExit("Setup is needed; missing: " + ", ".join(missing))
        print("Prepared development files are present. Run scripts/verify.py for behavioral checks.")
        return 0
    if not python.is_file():
        subprocess.run([sys.executable, "-m", "venv", str(root / ".venv")], check=True)
    for command in [
        [str(python), "-m", "pip", "install", "-r", "requirements.lock"],
        [str(python), "-m", "pip", "install", "--no-deps", "-e", "."],
        [pnpm, "install", "--frozen-lockfile"],
        [pnpm, "run", "build"],
    ]:
        subprocess.run(command, cwd=root, check=True)
    print("Desktop dependencies and build are ready. On Windows, open scripts/start.cmd.")
    print("Install ngspice, KiCad and optional local speech separately as described in README.md. No hardware was opened.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
