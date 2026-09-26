"""Verify the desktop's process lease without opening hardware or accounts."""

import json
import os
import secrets
import subprocess
import sys
import time

import httpx


def test_bench_exits_when_owning_desktop_closes_stdin(tmp_path):
    token = secrets.token_urlsafe(32)
    process = subprocess.Popen(
        [sys.executable, "-m", "ohmpath", "--parent-stdin", "--data-dir", str(tmp_path)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
        env={**os.environ, "OHMPATH_USER_TOKEN": token, "OHMPATH_MODEL_TOKEN": secrets.token_urlsafe(32)},
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    try:
        ready = json.loads(process.stdout.readline())
        assert ready["service"] == "Ohm Path"
        with httpx.Client(base_url=f"http://127.0.0.1:{ready['port']}", timeout=1,
                          headers={"Authorization": f"Bearer {token}"}) as client:
            for attempt in range(50):
                try:
                    response = client.get("/v1/health")
                    assert response.status_code == 200
                    break
                except httpx.TransportError:
                    time.sleep(.1)
            else:
                raise AssertionError("Bench did not become ready")
        process.stdin.close()
        assert process.wait(timeout=8) == 0
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=3)
