"""UTF-8 app-server protocol regression; no Codex account or network use."""

from __future__ import annotations

import sys

from ohmpath.ai.live_proof import Protocol


def test_protocol_decodes_utf8_json_on_windows_locale():
    expected = "Ω µ “quoted” café — 日本語 مرحبا"
    child = r'''import json, os, sys
first = json.loads(sys.stdin.readline())
os.write(1, (json.dumps({"id": first["id"], "result": {"text": first["params"]["text"]}}, ensure_ascii=False) + "\n").encode("utf-8"))
second = json.loads(sys.stdin.readline())
os.write(1, (json.dumps({"method": "fixture/notice", "params": {"text": second["text"]}}, ensure_ascii=False) + "\n").encode("utf-8"))
'''
    protocol = Protocol([sys.executable, "-c", child], {})
    try:
        response = protocol.request("fixture/echo", {"text": expected}, timeout=3)
        assert response == {"text": expected}
        protocol.send({"text": expected})
        notification = protocol.receive(timeout=3)
        assert notification == {"method": "fixture/notice", "params": {"text": expected}}
    finally:
        protocol.close()
