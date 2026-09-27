#!/usr/bin/env python3
"""Build a deterministic, source-only Raspberry Pi deployment archive."""

from __future__ import annotations

import argparse
import hashlib
from pathlib import Path
import stat
import zipfile


FILES = (
    "__init__.py",
    "__main__.py",
    "calibration.py",
    "camera.py",
    "controller.py",
    "loopback.py",
    "models.py",
    "service.py",
    "video_server.py",
    "pwm.py",
    "motion_state.py",
    "motion_worker.py",
    "camera_worker.py",
)
PACKAGE_README = """# Ohm Path Pi service source bundle

This is a source-only bundle of the reviewed `ohmpath_pi` package. It contains no credentials, camera frames, private configuration, logs, compiled Python files, or auto-start/service-install configuration.

The offline `ohmpath_pi.calibration.fit_local_calibration` helper fits a local 2x2 image Jacobian only from caller-supplied fit and held-out samples. It never acquires frames or moves hardware. Sample data source and circuit/firmware/calibration revisions are explicit, and a failed fit returns no usable calibration.

## Runtime requirements

- Python 3.12, matching the Ohm Path project runtime baseline.
- The mock control service, controller simulation, and video server use only the Python standard library. No pip package installation is required for those paths.
- The optional camera path imports Picamera2 only when explicitly started. Picamera2 and camera drivers are supplied by a compatible Raspberry Pi OS image; they are intentionally not bundled or installed by this archive.

## Offline simulation

After extracting this archive, run:

```sh
python3.12 -m ohmpath_pi --demo 390 200
```

This prints deterministic synthetic frames and exits. It does not open a camera, bind a socket, control GPIO/PWM, move a motor, or enable a laser.

## Mock-only local control endpoint

The control endpoint is permanently backed by `MockMotorDriver` and binds to `127.0.0.1`. It is not a physical motion service. To launch it for local software integration, provide a unique per-launch token in the environment and start it explicitly:

```sh
export OHMPATH_PI_TOKEN="<unique-local-token-of-at-least-32-characters>"
python3.12 -m ohmpath_pi --port 8765
```

The process is interactive and stops with Ctrl+C. This package does not install a system service or configure boot startup.

## Optional camera-only preview

Camera access is a separate opt-in process. First confirm that the target operating system supports Picamera2 and that its camera stack is configured by the device owner. Then explicitly launch:

```sh
export OHMPATH_PI_VIDEO_TOKEN="<unique-per-launch-token-of-at-least-32-characters>"
python3.12 -m ohmpath_pi.video_server --enable-camera --port 8766
```

The service binds only to `127.0.0.1`, serves authenticated MJPEG, and provides no control or laser-enable endpoint. It is not started by the mock control process and is not installed for boot startup. For a remote preview, prepare a separate SSH tunnel only after verifying the Pi host key/fingerprint through a trusted channel. Do not disable host-key checking or connect using an unverified host identity. The desktop client accepts a local tunnel port and token; it has no remote-host field.

## Explicit physical movement worker

The separate `motion_worker` is a real Raspberry Pi 5 PWM driver for GPIO12 and GPIO13. It can only launch with `--enable-hardware` inside a systemd watchdog unit. It starts with both outputs disabled and requires fresh local-user arming, a current epoch/profile revision and continuing heartbeats. It has no laser output. The existing mock endpoint remains mock-only.

The desktop's separate pinned SSH control and camera connections use this worker and `camera_worker`; neither opens a network listener or installs boot startup. A fixed independent systemd ExecStopPost command releases both outputs. Only an explicitly paired, private Pi is accepted. See the repository's docs/development/turret-control.md for operation and limits.

Packaging and automated software tests do not establish physical acceptance, motor position feedback, calibrated laser accuracy, or an independent laser interlock.
"""


def _payloads(repo_root: Path) -> dict[str, bytes]:
    package_root = repo_root / "services" / "pi" / "src" / "ohmpath_pi"
    payload = {f"ohmpath_pi/{name}": (package_root / name).read_bytes() for name in FILES}
    payload["README.md"] = PACKAGE_README.encode("utf-8")
    manifest = "".join(
        f"{hashlib.sha256(contents).hexdigest()}  {name}\n"
        for name, contents in sorted(payload.items())
    )
    payload["MANIFEST.sha256"] = manifest.encode("ascii")
    return payload


def build_archive(repo_root: Path, output: Path) -> Path:
    """Write a deterministic allowlisted archive and return its resolved path."""
    repo_root = repo_root.resolve(strict=True)
    output = output.resolve()
    payload = _payloads(repo_root)
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, contents in sorted(payload.items()):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            info.extra = b""
            info.comment = b""
            archive.writestr(info, contents, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    return output


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, help="archive path (default: runtime/pi-package/ohmpath-pi.zip)")
    args = parser.parse_args(argv)
    repo_root = Path(__file__).resolve().parents[1]
    output = args.output or repo_root / "runtime" / "pi-package" / "ohmpath-pi.zip"
    result = build_archive(repo_root, output)
    print(f"Created {result} ({result.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
