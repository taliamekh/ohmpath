"""Explicitly opted-in image route proof; never part of automatic verification.

Sends only a generated blank PNG through the signed-in subscription route. This
proves transport/validation, not real circuit diagnosis or physical inspection.
"""
import argparse
import base64
import json
import secrets
import tempfile
import time
import zlib
from pathlib import Path
from uuid import uuid4

from fastapi.testclient import TestClient
from ohmpath.api.app import create_app


def blank_image():
    def chunk(kind, data):
        return len(data).to_bytes(4, "big") + kind + data + zlib.crc32(kind + data).to_bytes(4, "big")
    side = 128
    header = side.to_bytes(4, "big") * 2 + bytes((8, 6, 0, 0, 0))
    pixels = (b"\0" + b"\xff\xff\xff\xff" * side) * side
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b"")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--authorized-live-proof", action="store_true")
    args = parser.parse_args()
    if not args.authorized_live_proof:
        parser.error("This consumes subscription allowance; explicit --authorized-live-proof is required.")
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="ohmpath-photo-proof-") as directory:
        token = secrets.token_hex(32)
        app = create_app(Path(directory), token, secrets.token_hex(32))
        with TestClient(app, headers={"Authorization": f"Bearer {token}"}) as client:
            context_id = str(uuid4())
            response = client.post("/v1/photo-help/investigate", json={
                "context_id": context_id,
                "question": "What can you actually see in this uploaded image? Explain whether there is enough visual information to help with a circuit. Do not assume a practice circuit or any physical measurements.",
                "images": [{"image_id": str(uuid4()), "mime_type": "image/png",
                            "image_base64": base64.b64encode(blank_image()).decode()}],
            })
            response.raise_for_status()
            result = response.json()
            while result.get("status") == "running" and time.monotonic() - started < 100:
                time.sleep(.5)
                status = client.get(f"/v1/photo-help/{result['turn_id']}")
                status.raise_for_status()
                result = status.json()
            client.post("/v1/photo-help/cancel", json={"context_id": context_id})
            report = {"status": result.get("status"), "seconds": round(time.monotonic() - started, 2),
                      "fixture": "generated blank white PNG", "physical_verification": False,
                      "audio_generated": False, "result": result}
            output = Path("runtime/photo-help-live-proof.json")
            output.parent.mkdir(exist_ok=True)
            output.write_text(json.dumps(report, indent=2), encoding="utf-8")
            print(json.dumps(report))
            return 0 if result.get("status") == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
