from __future__ import annotations

from dataclasses import dataclass
import base64
import hashlib
from pathlib import Path
import re
from typing import Literal


_HOST = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$")
_USER = re.compile(r"^[A-Za-z_][A-Za-z0-9_-]{0,31}$")
_KEY_TYPE = re.compile(r"^ssh-(?:ed25519|rsa)$|^ecdsa-sha2-nistp(?:256|384|521)$")


def fingerprint_known_host(path: Path, hostname: str) -> str:
    """Read a literal host entry and calculate its OpenSSH SHA256 fingerprint."""
    if not path.is_file():
        raise ValueError("known_hosts file does not exist")
    if path.stat().st_size > 1_000_000:
        raise ValueError("known_hosts file exceeds the 1 MB inspection limit")
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) < 3 or parts[0].startswith("|"):
            continue
        names, key_type, key_data = parts[:3]
        if key_type != "@revoked" and _KEY_TYPE.fullmatch(key_type) and hostname in names.split(","):
            try:
                raw = base64.b64decode(key_data, validate=True)
            except ValueError as exc:
                raise ValueError("known_hosts contains an invalid host key") from exc
            digest = base64.b64encode(hashlib.sha256(raw).digest()).decode("ascii").rstrip("=")
            return f"SHA256:{digest}"
    raise ValueError("pinned literal host key was not found; pair and review it first")


@dataclass(frozen=True, slots=True)
class PiTunnelConfig:
    hostname: str
    username: str
    known_hosts_file: Path
    identity_file: Path
    expected_fingerprint: str
    local_control_port: int = 18765
    remote_control_port: int = 8765
    local_video_port: int = 18766
    remote_video_port: int = 8766

    def __post_init__(self) -> None:
        if not _HOST.fullmatch(self.hostname) or not _USER.fullmatch(self.username):
            raise ValueError("host name or SSH username is invalid")
        ports = (self.local_control_port, self.remote_control_port,
                 self.local_video_port, self.remote_video_port)
        if any(not 1 <= port <= 65535 for port in ports):
            raise ValueError("tunnel ports must be valid TCP ports")
        if self.local_control_port == self.local_video_port or self.remote_control_port == self.remote_video_port:
            raise ValueError("video and control must use distinct ports and tunnels")
        if not self.expected_fingerprint.startswith("SHA256:"):
            raise ValueError("an explicitly reviewed SHA256 host-key fingerprint is required")

    def ssh_args(self, channel: Literal["control", "video"]) -> list[str]:
        """Return a fixed SSH argv list; caller must launch a separate process per channel."""
        actual = fingerprint_known_host(self.known_hosts_file, self.hostname)
        if actual != self.expected_fingerprint:
            raise ValueError("pinned host-key fingerprint changed; review pairing before connecting")
        if not self.identity_file.is_file():
            raise ValueError("dedicated Pi SSH identity file is missing")
        local_port = self.local_control_port if channel == "control" else self.local_video_port
        remote_port = self.remote_control_port if channel == "control" else self.remote_video_port
        return [
            "ssh", "-N", "-T", "-o", "BatchMode=yes",
            "-o", "StrictHostKeyChecking=yes",
            "-o", f"UserKnownHostsFile={self.known_hosts_file}",
            "-o", f"IdentityFile={self.identity_file}",
            "-o", "IdentitiesOnly=yes", "-o", "ControlMaster=no",
            "-o", "ControlPath=none", "-o", "ControlPersist=no",
            "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=1",
            "-o", "ServerAliveCountMax=3",
            "-L", f"127.0.0.1:{local_port}:127.0.0.1:{remote_port}",
            f"{self.username}@{self.hostname}",
        ]
