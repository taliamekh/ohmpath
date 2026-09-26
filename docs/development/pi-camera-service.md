# Raspberry Pi camera video service

This is a standalone **opt-in** MJPEG process. It binds only to loopback, requires a per-launch bearer token, keeps at most the camera wrapper's latest frame, caps frame rate/size/concurrent clients, and does not provide control or laser endpoints. It is separate from the mock control service and starts no SSH tunnel. No hardware test was performed as part of this work.

## Raspberry Pi OS setup

The service uses the Python standard library plus the existing `ohmpath_pi` package. For a Raspberry Pi OS installation, install Picamera2 from the OS package repository:

```sh
sudo apt update
sudo apt install python3-picamera2
```

Use the reviewed Ohm Path deployment source and a Python environment that can import the OS-provided Picamera2 package (for example, a venv created with `--system-site-packages`). Do not install a second camera stack with `pip`. This setup is free of subscription services and does not require an API key.

## Explicit local start

Generate a fresh random secret for this process and place it in the environment variable `OHMPATH_PI_VIDEO_TOKEN` using the OS's protected environment mechanism. Do not put the token in shell history, a command-line argument, a URL, or logs. Then, from an environment that can import `ohmpath_pi`, run:

```sh
python3 -m ohmpath_pi.video_server --enable-camera --port 8766 --max-fps 15
```

Without `--enable-camera`, the process exits with an error before constructing or opening Picamera2. The token must be 32–256 printable characters. `--max-fps` is limited to 1–20; concurrent clients are limited to 1–8 with a default of three. The service logs its loopback address and port only. Ctrl+C stops the service and releases the camera. Health is `GET /v1/health`; the live stream is `GET /v1/stream.mjpg`. Both require `Authorization: Bearer <token>`. The token must stay in the header; query-string tokens are not accepted.

## Desktop link

The service listens at `127.0.0.1:8766` on the Pi. For remote viewing, use the existing reviewed `PiTunnelConfig` with its independently paired known-host fingerprint and call `ssh_args("video")`; launch that as a separate SSH process from the control tunnel. The returned forward terminates on desktop loopback. Do not open the Pi port to a LAN, reuse the control tunnel, auto-connect, or bypass the host-key pin. A desktop viewer must attach the bearer header to requests; the secret is not suitable for embedding in an image URL. The UI should keep video frame handling separate from the control API and drop obsolete frames.

This module does not pair SSH identities, start SSH, manage the bearer-token lifecycle, provide camera calibration, or act as a physical safety interlock. A real Pi deployment and camera permission check remain pending. Tests use a fake camera and synthetic JPEG bytes only.

## API and checks

- `create_video_server(camera, *, bearer_token, port=8766, max_fps=15.0, max_frame_bytes=2*1024*1024, max_clients=3)` creates, but does not serve or start, the authenticated loopback listener. The `camera` must implement `take_latest_frame(timeout_s=...)` and `stop()`; closing the server stops the source.
- `python -m ohmpath_pi.video_server --help` shows the options without opening a camera. Starting the actual video server requires explicit `--enable-camera` and `OHMPATH_PI_VIDEO_TOKEN`.

Verification: `.venv/Scripts/python.exe -m pytest services/pi/tests/test_video_server.py -q` uses injected fake frames. The combined check `.venv/Scripts/python.exe -m pytest services/pi/tests services/bench/tests/test_pi_link.py -q` returned **36 passed in 2.14s**. Tests check loopback-only binding, token authentication, MJPEG framing, frame and client bounds, client-disconnect cleanup, source release, inert default CLI, and the explicit camera startup branch without instantiating physical Picamera2. `python -m ohmpath_pi.video_server --help` also returned normally without camera access.
