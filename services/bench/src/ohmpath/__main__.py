import argparse
import json
import os
import socket
import sys
import threading
from pathlib import Path

import uvicorn

from ohmpath.api.app import create_app


def main():
    parser = argparse.ArgumentParser(description="Ohm Path private local bench service")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--data-dir", type=Path)
    parser.add_argument("--parent-stdin", action="store_true")
    args = parser.parse_args()
    token = os.environ.get("OHMPATH_USER_TOKEN", "")
    if len(token) < 32:
        raise SystemExit("Start through the Ohm Path launcher, which supplies an ephemeral local capability.")
    data_dir = args.data_dir or Path(os.environ.get("LOCALAPPDATA", Path.home() / ".local/share")) / "OhmPath"
    app = create_app(data_dir, token, os.environ.get("OHMPATH_MODEL_TOKEN"))
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", args.port))
    port = sock.getsockname()[1]
    app.state.investigations.base_url = f"http://127.0.0.1:{port}"
    print(json.dumps({"service": "Ohm Path", "port": port}), flush=True)
    server = uvicorn.Server(uvicorn.Config(app, log_level="warning", access_log=False, timeout_graceful_shutdown=5))
    if args.parent_stdin:
        def parent_lease():
            # EOF means the owning desktop exited. Never leave a detached bench.
            sys.stdin.buffer.read()
            server.should_exit = True
        threading.Thread(target=parent_lease, daemon=True).start()
    server.run(sockets=[sock])


if __name__ == "__main__":
    main()
