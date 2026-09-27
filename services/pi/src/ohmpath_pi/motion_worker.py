"""Explicitly launched SSH stdio worker; no public control listener or boot startup."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import queue
import signal
import socket
import sys
import threading
import time
from pathlib import Path

from .motion_state import MotionState
from .pwm import Pi5PWM, release_outputs


def notify(message: str) -> None:
    address = os.environ.get('NOTIFY_SOCKET')
    if not address:
        return
    if address.startswith('@'):
        address = '\0' + address[1:]
    with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as sock:
        sock.sendto(message.encode(), address)


def output(message: dict) -> None:
    print(json.dumps(message, separators=(',', ':'), allow_nan=False), flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--enable-hardware', action='store_true')
    parser.add_argument('--release', action='store_true')
    args = parser.parse_args()
    if args.release:
        release_outputs()
        return
    if not args.enable_hardware or not os.environ.get('INVOCATION_ID') or not os.environ.get('WATCHDOG_USEC'):
        parser.error('Hardware requires an explicit supervised systemd launch with a watchdog.')
    import fcntl
    lock = open('/run/lock/ohmpath-servo-bench.lock', 'w')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    driver = Pi5PWM()
    state = MotionState(driver)
    state.firmware_revision = hashlib.sha256(b''.join(
        Path(__file__).with_name(name).read_bytes() for name in ('motion_worker.py', 'motion_state.py', 'pwm.py')
    )).hexdigest()[:20]
    inbox: queue.Queue = queue.Queue(maxsize=32)
    done = threading.Event()

    def reader() -> None:
        try:
            while not done.is_set():
                raw = sys.stdin.buffer.readline(8193)
                if not raw:
                    break
                if len(raw) > 8192 or not raw.endswith(b'\n'):
                    break
                data = json.loads(raw, parse_constant=lambda _: (_ for _ in ()).throw(ValueError('Nonfinite JSON')))
                inbox.put_nowait((time.monotonic(), data))
        except (ValueError, queue.Full, OSError):
            pass
        finally:
            done.set()

    def stop(*_):
        done.set()

    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, stop)
    try:
        driver.prepare()
        output({'ready': True, 'service': 'ohmpath-motion', 'protocol': 1, 'status': state.status()})
        notify('READY=1')
        threading.Thread(target=reader, name='motion-input', daemon=True).start()
        last_notify = 0.0
        while not done.is_set():
            started = time.monotonic()
            state.tick()
            if started - last_notify > 0.3:
                notify('WATCHDOG=1')
                last_notify = started
            try:
                received, request = inbox.get(timeout=0.02)
            except queue.Empty:
                continue
            try:
                if time.monotonic() - received > 0.4:
                    state.release('A queued command expired.')
                    raise ValueError('Command expired before execution.')
                response = state.request(request)
            except (ValueError, TypeError, KeyError) as exc:
                response = {'id': request.get('id') if isinstance(request, dict) else None,
                            'ok': False, 'error': str(exc)[:300], 'status': state.status()}
            output(response)
    finally:
        done.set()
        driver.release()
        lock.close()


if __name__ == '__main__':
    main()
