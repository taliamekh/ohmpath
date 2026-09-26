from __future__ import annotations

import argparse
import json
import os
import sys
import time

from .controller import run_aim_demo
from .loopback import create_loopback_server
from .models import RevisionSnapshot
from .service import PiControlService


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Ohm Path Pi mock service")
    parser.add_argument("--demo", nargs=2, type=float, metavar=("TARGET_X", "TARGET_Y"),
                        help="run a deterministic image-space aiming simulation and exit")
    parser.add_argument("--port", type=int, default=8765, help="loopback control API port (default: 8765)")
    parser.add_argument("--target", action="append", default=[],
                        help="explicit semantic target allowed by the mock receiver; may be repeated")
    parser.add_argument("--circuit-revision", help="current circuit mapping revision for mock commands")
    parser.add_argument("--firmware-revision", help="declared Pi firmware revision (optional)")
    parser.add_argument("--calibration-revision", help="current calibration revision for mock commands")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    if args.demo is not None:
        print(json.dumps(run_aim_demo(args.demo[0], args.demo[1]), separators=(",", ":")))
        return 0

    token = os.environ.get("OHMPATH_PI_TOKEN", "")
    if len(token) < 32:
        parser.error("set a unique per-launch OHMPATH_PI_TOKEN of at least 32 characters")
    if args.target and (not args.circuit_revision or not args.calibration_revision):
        parser.error("mock targets require --circuit-revision and --calibration-revision")
    revisions = None
    if args.circuit_revision and args.calibration_revision:
        revisions = RevisionSnapshot(args.circuit_revision, args.firmware_revision, args.calibration_revision)

    service = PiControlService(initial_revisions=revisions, allowed_targets=frozenset(args.target))
    # This service is permanently mock-backed. 'connected' here means the explicit
    # local mock endpoint is accepting test commands, never that physical hardware is ready.
    service.link_state(True, now_monotonic_s=time.monotonic())
    server = create_loopback_server(service, bearer_token=token, port=args.port)
    print(f"Ohm Path Pi mock service listening on 127.0.0.1:{args.port}", flush=True)
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        service.disarm()
        service.link_state(False)
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
