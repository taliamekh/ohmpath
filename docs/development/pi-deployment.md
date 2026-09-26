# Raspberry Pi source deployment bundle

Build a deterministic, source-only bundle from the repository root:

```powershell
.venv\Scripts\python.exe scripts\package-pi.py
```

The ZIP is written to the ignored `runtime/pi-package/ohmpath-pi.zip`. The packager includes only the reviewed `services/pi/src/ohmpath_pi/*.py` modules from a fixed allowlist, plus a bundled README and `MANIFEST.sha256`. The manifest records SHA-256 for each included source file and README. Archive timestamps and file permissions are fixed so repeat builds from unchanged inputs have identical contents and hashes. The builder does not copy arbitrary directories, generated files, or environment data.

The bundle has no third-party runtime dependencies for the mock service, controller demo, or camera server. Use Python 3.12 to match the project baseline; create a virtual environment on the Pi if desired. `python3.12 -m ohmpath_pi --demo 390 200` runs only the deterministic synthetic demo from an extracted bundle and exits. `python3.12 -m ohmpath_pi --port 8765` starts an explicitly launched, loopback-only mock control endpoint and requires a unique per-launch `OHMPATH_PI_TOKEN` of at least 32 characters. The driver is permanently mock-backed; this package adds no physical control path.

Offline calibration fitting is available through `ohmpath_pi.calibration.fit_local_calibration(fit_samples, validation_samples, *, revisions, data_source)`. It requires at least four independent fit samples and two held-out samples, binds every sample to the supplied circuit, firmware and calibration revisions, enforces design/residual bounds, and labels input as `user_supplied` or `synthetic`. It does not collect measurements. A successful numeric fit is not physical verification or hardware arming; direction-dependent backlash and workspace repeatability remain unmeasured.

The optional live camera preview is a separate process and requires an explicit `--enable-camera` flag plus `OHMPATH_PI_VIDEO_TOKEN` of at least 32 printable characters. Picamera2 is imported/opened only after that explicit launch. Camera support comes from a compatible Raspberry Pi OS image and is not bundled or installed by the packager. The service is loopback-only and camera-only. The archive contains no systemd unit, boot-start configuration, credentials, logs, camera images, or local configuration.

For remote preview, use a separately configured SSH tunnel only after verifying the host identity/fingerprint over a trusted channel. Keep host-key checking enabled. The desktop client connects only to a local loopback port and accepts no remote-host override. Do not forward the services to a public interface.

Package tests verify the exact archive member allowlist, absence of pycache and private material, manifest hashes, reproducibility, and successful offline synthetic demo after extraction. No package manager, network, SSH, camera, GPIO/PWM, motor, or laser operation is part of package creation or testing. Physical acceptance, wiring, calibration, and interlock tests remain pending.
