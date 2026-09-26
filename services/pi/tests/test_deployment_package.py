from __future__ import annotations

import hashlib
import os
from pathlib import Path
import subprocess
import sys
import zipfile


ROOT = Path(__file__).resolve().parents[3]
PACKAGER = ROOT / "scripts" / "package-pi.py"
SOURCE_FILES = {
    "ohmpath_pi/__init__.py",
    "ohmpath_pi/__main__.py",
    "ohmpath_pi/calibration.py",
    "ohmpath_pi/camera.py",
    "ohmpath_pi/controller.py",
    "ohmpath_pi/loopback.py",
    "ohmpath_pi/models.py",
    "ohmpath_pi/service.py",
    "ohmpath_pi/video_server.py",
}
EXPECTED_FILES = SOURCE_FILES | {"README.md", "MANIFEST.sha256"}


def _build(destination: Path) -> bytes:
    subprocess.run([sys.executable, str(PACKAGER), "--output", str(destination)],
                   cwd=ROOT, check=True, capture_output=True, text=True, timeout=10)
    return destination.read_bytes()


def test_bundle_is_allowlisted_hashed_deterministic_and_demo_runs_offline(tmp_path: Path) -> None:
    archive_path = tmp_path / "ohmpath-pi.zip"
    first = _build(archive_path)
    second = _build(archive_path)
    assert first == second

    with zipfile.ZipFile(archive_path) as archive:
        names = set(archive.namelist())
        assert names == EXPECTED_FILES
        assert all("__pycache__" not in name and not name.endswith((".pyc", ".pyo")) for name in names)
        assert not any(name.lower().endswith((".env", ".key", ".pem", ".sqlite", ".log", ".jpg", ".jpeg", ".png")) for name in names)
        manifest = archive.read("MANIFEST.sha256").decode("ascii")
        entries = {}
        for line in manifest.splitlines():
            checksum, name = line.split("  ", 1)
            entries[name] = checksum
        assert set(entries) == SOURCE_FILES | {"README.md"}
        for name, checksum in entries.items():
            assert hashlib.sha256(archive.read(name)).hexdigest() == checksum

        extract = tmp_path / "extracted"
        archive.extractall(extract)

    environment = os.environ.copy()
    environment.pop("PYTHONPATH", None)
    environment.pop("PYTHONHOME", None)
    demo = subprocess.run(
        [sys.executable, "-m", "ohmpath_pi", "--demo", "390", "200"],
        cwd=extract, env=environment, check=True, capture_output=True, text=True, timeout=5,
    )
    import json
    result = json.loads(demo.stdout)
    assert result["mode"] == "simulation"
    assert result["laser_enabled"] is False
    assert result["frames"]
    assert result["converged"] is True

    fit_script = "from ohmpath_pi.calibration import fit_local_calibration; " \
        "from ohmpath_pi.models import RevisionSnapshot; " \
        "r=RevisionSnapshot('c1','f1','k1'); " \
        "s=lambda y,p: {'yaw_deg':y,'pitch_deg':p,'dx_px':12*y+3*p,'dy_px':-2*y+15*p," \
        "'circuit_revision':'c1','firmware_revision':'f1','calibration_revision':'k1'}; " \
        "x=fit_local_calibration([s(1,0),s(-1,0),s(0,1),s(0,-1)],[s(1,1),s(2,-1)]," \
        "revisions=r,data_source='synthetic'); " \
        "assert x.status=='accepted' and x.hardware_armed is False; " \
        "assert x.calibration.jacobian_px_per_degree[0][0]==12"
    fitted = subprocess.run([sys.executable, "-c", fit_script], cwd=extract, env=environment,
                            check=True, capture_output=True, text=True, timeout=5)
    assert fitted.stdout == ""
