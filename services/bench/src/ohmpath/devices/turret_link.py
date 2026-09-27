"""Paired SSH transport. Fixed remote modules; never accepts shell text from a model or UI."""
from __future__ import annotations

import base64
import hashlib
from importlib.resources import files
import ipaddress
import json
import math
from pathlib import Path
import queue
import re
import shlex
import subprocess
import threading
import time
import uuid

import cv2
import numpy as np
from ohmpath.vision.tracking import _dimensions


def load_pairing(path: Path) -> dict:
    try:
        raw = path.read_bytes()
    except FileNotFoundError as exc:
        raise ValueError('Pi connection settings are missing. Restore the verified pairing in your user profile before connecting.') from exc
    if len(raw) > 8192:
        raise ValueError('Invalid local Pi pairing file.')
    config = json.loads(raw)
    required = {'host', 'user', 'host_alias', 'fingerprint', 'identity_file', 'known_hosts_file', 'remote_root'}
    if set(config) != required or any(not isinstance(v, str) for v in config.values()):
        raise ValueError('Invalid local Pi pairing fields.')
    if not ipaddress.ip_address(config['host']).is_private:
        raise ValueError('The turret requires the paired private Ethernet address.')
    if not re.fullmatch(r'[a-z_][a-z0-9_-]{0,31}', config['user']):
        raise ValueError('Invalid paired Pi username.')
    if not re.fullmatch(r'[a-zA-Z0-9.-]{1,100}', config['host_alias']):
        raise ValueError('Invalid paired host alias.')
    if not re.fullmatch(r'/home/[a-z_][a-z0-9_-]*/[a-zA-Z0-9_./-]+', config['remote_root']) or '..' in config['remote_root'].split('/'):
        raise ValueError('Invalid installed Pi source directory.')
    for key in ('identity_file', 'known_hosts_file'):
        if not Path(config[key]).is_file():
            raise ValueError('The paired SSH key or known-host file is missing.')
    matched = False
    for line in Path(config['known_hosts_file']).read_text().splitlines():
        fields = line.split()
        if len(fields) >= 3 and config['host_alias'] in fields[0].split(',') and fields[1] == 'ssh-ed25519':
            fingerprint = 'SHA256:' + base64.b64encode(hashlib.sha256(base64.b64decode(fields[2], validate=True)).digest()).decode().rstrip('=')
            if fingerprint != config['fingerprint']:
                raise ValueError('The Pi host identity changed. Pair it again before connecting.')
            matched = True
    if not matched:
        raise ValueError('The verified Pi host identity is absent from known_hosts.')
    return config


def ssh_args(config: dict, mode: str) -> list[str]:
    args = ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
            '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ControlPersist=no',
            '-o', 'ConnectTimeout=5', '-o', 'ServerAliveInterval=1', '-o', 'ServerAliveCountMax=3',
            '-o', 'IdentitiesOnly=yes', '-o', f"HostKeyAlias={config['host_alias']}",
            '-o', f"UserKnownHostsFile={config['known_hosts_file']}", '-i', config['identity_file'],
            f"{config['user']}@{config['host']}"]
    if mode == 'control':
        remote = ['sudo', '-n', 'systemd-run', '--unit=ohmpath-motion', '--wait', '--pipe', '--collect',
                  '--property=Type=notify', '--property=NotifyAccess=main', '--property=WatchdogSec=2s',
                  '--property=TimeoutStartSec=10s', '--property=TimeoutStopSec=1s',
                  '--property=WorkingDirectory=' + config['remote_root'],
                  '--property=ExecStopPost=/usr/bin/python3 -m ohmpath_pi.motion_worker --release',
                  '/usr/bin/python3', '-u', '-m', 'ohmpath_pi.motion_worker', '--enable-hardware']
        return args + [shlex.join(remote)]
    if mode == 'video':
        return args + ['cd ' + shlex.quote(config['remote_root']) + ' && exec /usr/bin/python3 -u -m ohmpath_pi.camera_worker --enable-camera']
    raise ValueError('Unknown Pi channel.')


class ControlLink:
    def __init__(self, pairing: dict):
        self.pairing = pairing
        self.process = None
        self.state: dict = {}
        self.lock = threading.RLock()
        self.responses: queue.Queue = queue.Queue(maxsize=16)
        self.error = ''

    def start(self) -> dict:
        self.process = subprocess.Popen(ssh_args(self.pairing, 'control'), stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        process = self.process
        def read():
            try:
                while self.process is process:
                    line = process.stdout.readline(32769)
                    if not line or len(line) > 32768:
                        break
                    self.responses.put_nowait(json.loads(line))
            except (ValueError, OSError, queue.Full):
                pass
            finally:
                try:
                    self.responses.put_nowait({'transport_closed': True})
                except queue.Full:
                    pass
        def errors():
            for raw in iter(process.stderr.readline, b''):
                self.error = (self.error + raw.decode(errors='replace'))[-3000:]
        threading.Thread(target=read, daemon=True).start()
        threading.Thread(target=errors, daemon=True).start()
        try:
            message = self.responses.get(timeout=12)
            if message.get('ready') is not True or message.get('service') != 'ohmpath-motion' or message.get('protocol') != 1:
                raise RuntimeError('The Pi control service did not start. ' + self.error[-700:])
            self.state = message['status']
            expected = hashlib.sha256(b''.join(files('ohmpath_pi').joinpath(name).read_bytes()
                for name in ('motion_worker.py', 'motion_state.py', 'pwm.py'))).hexdigest()[:20]
            if self.state.get('firmware_revision') != expected or self.state.get('armed') is not False:
                raise RuntimeError('The Pi motion software differs from this app, or did not start released. Deploy the matching package.')
            return self.state
        except Exception:
            self.close()
            raise

    def request(self, op: str, body: dict | None = None) -> dict:
        with self.lock:
            if not self.process or self.process.poll() is not None:
                raise RuntimeError('The Pi control connection is closed.')
            ident = str(uuid.uuid4())
            request = {'id': ident, 'op': op, 'epoch': self.state['epoch'],
                       'revision': self.state['revision'], 'body': body or {}}
            try:
                self.process.stdin.write(json.dumps(request, allow_nan=False).encode() + b'\n')
                self.process.stdin.flush()
                response = self.responses.get(timeout=2)
                if response.get('id') != ident:
                    raise RuntimeError('Control connection lost; command outcome is unknown.')
                self.state = response['status']
            except Exception:
                self.close()
                raise
            if response.get('ok') is not True:
                raise ValueError(response.get('error', 'The Pi rejected that movement.'))
            return self.state

    def close(self) -> None:
        process, self.process = self.process, None
        if process:
            try:
                process.stdin.close()
                process.wait(timeout=2.5)
            except (OSError, subprocess.TimeoutExpired):
                process.kill()
                process.wait(timeout=3)
            self.state = {**self.state, 'armed': False, 'holding': False}


class VideoLink:
    def __init__(self, pairing: dict):
        self.pairing = pairing
        self.process = None
        self.lock = threading.Lock()
        self.latest = None
        self.generation = str(uuid.uuid4())
        self.offset: float | None = None
        self.error = None
        self.focus_dioptres = None

    def _validate_header(self, header):
        length = header.get('length')
        if header.get('protocol') != 3 or type(length) is not int or not 4 <= length <= 2_000_000:
            raise RuntimeError('Invalid Pi camera frame header; deploy the matching camera package.')
        focus = header.get('focus_dioptres')
        if (type(focus) not in (int, float) or not math.isfinite(focus) or not 0 <= focus <= 100
                or header.get('focus_locked') is not True or type(header.get('focus_success')) is not bool):
            raise RuntimeError('Camera focus is not locked; reconnect and recalibrate.')
        if self.focus_dioptres is not None and focus != self.focus_dioptres:
            raise RuntimeError('Camera focus changed; reconnect and recalibrate.')
        self.focus_dioptres = focus
        return length

    def start(self) -> None:
        self.process = subprocess.Popen(ssh_args(self.pairing, 'video'), stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        process = self.process
        def read():
            sequence = 0
            try:
                while self.process is process:
                    line = process.stdout.readline(1025)
                    if not line or len(line) > 1024:
                        raise RuntimeError('The Pi camera stream stopped.')
                    header = json.loads(line)
                    length = self._validate_header(header)
                    raw = process.stdout.read(length)
                    received = time.monotonic()
                    sent, captured = header['send_s'], header['capture_s']
                    if any(type(v) not in (int, float) or not math.isfinite(v) for v in (sent, captured)) or not 0 <= sent - captured <= 0.5:
                        raise RuntimeError('The Pi camera frame is stale.')
                    offset = received - sent
                    self.offset = offset if self.offset is None else min(self.offset, offset)
                    age = max(0.0, received - captured - self.offset)
                    if len(raw) != length or age > 0.5:
                        raise RuntimeError('The Pi camera frame is delayed or incomplete.')
                    if _dimensions(raw) != (1280, 720):
                        raise RuntimeError('The Pi camera frame dimensions changed.')
                    image = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
                    if image is None or image.shape[:2] != (720, 1280):
                        raise RuntimeError('The Pi camera geometry changed; reconnect and recalibrate.')
                    sequence += 1
                    with self.lock:
                        self.latest = {'sequence': sequence, 'image': image, 'jpeg': raw,
                                       'received': received, 'age': age, 'generation': self.generation,
                                       'focus_dioptres': self.focus_dioptres, 'focus_success': header['focus_success']}
            except Exception as exc:
                self.error = str(exc)
            finally:
                with self.lock:
                    self.latest = None
        threading.Thread(target=read, name='turret-video', daemon=True).start()

    def frame(self):
        with self.lock:
            if self.latest is None or time.monotonic() - self.latest['received'] + self.latest['age'] > 0.5:
                return None
            return dict(self.latest)

    def close(self):
        process, self.process = self.process, None
        if process:
            try:
                process.stdin.close()
                process.wait(timeout=2)
            except (OSError, subprocess.TimeoutExpired):
                process.kill()
                process.wait(timeout=3)
        with self.lock:
            self.latest = None
