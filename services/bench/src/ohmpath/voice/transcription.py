from __future__ import annotations

import io
import os
import re
import secrets
import socket
import subprocess
import tempfile
import threading
import time
import wave
from pathlib import Path

import httpx

from ohmpath.session.store import DomainError


class WhisperWorker:
    """Lazy persistent local whisper.cpp process; raw audio is not retained."""

    def __init__(self):
        root = self._installation_root()
        self.executable = Path(os.environ["OHMPATH_WHISPER"]) if os.environ.get("OHMPATH_WHISPER") else root / "tools/whisper-b5130/Release/whisper-server.exe"
        self.model = Path(os.environ["OHMPATH_SPEECH_MODEL"]) if os.environ.get("OHMPATH_SPEECH_MODEL") else root / "models/ggml-small.en.bin"
        self.process = None
        self.url = None
        self.lock = threading.Lock()
        self._temp = None

    @staticmethod
    def _installation_root() -> Path:
        """Use the installer's LocalAppData location, with one known per-user fallback.

        Electron and standalone shells can inherit different LOCALAPPDATA values.
        The fallback is the current user's ordinary Windows LocalAppData directory;
        it is selected only when both pinned assets are there together.
        """
        local = os.environ.get("LOCALAPPDATA")
        primary = Path(local) / "OhmPath" if local else Path.home() / "OhmPath"
        profile = os.environ.get("USERPROFILE")
        if profile:
            fallback = Path(profile) / "AppData/Local/OhmPath"
            if fallback != primary and not (
                (primary / "tools/whisper-b5130/Release/whisper-server.exe").is_file()
                and (primary / "models/ggml-small.en.bin").is_file()
            ) and (
                (fallback / "tools/whisper-b5130/Release/whisper-server.exe").is_file()
                and (fallback / "models/ggml-small.en.bin").is_file()
            ):
                return fallback
        return primary

    def status(self):
        executable_exists = self.executable.is_file()
        model_exists = self.model.is_file()
        return {"provider": "whisper.cpp", "model": "small.en", "local_only": True,
                "status": "ready" if self.process and self.process.poll() is None else "installed" if executable_exists and model_exists else "not_installed",
                "microphone": "user_controlled", "recording": False, "hands_free": "unverified",
                "installation": {"executable": str(self.executable), "executable_exists": executable_exists,
                                 "model": str(self.model), "model_exists": model_exists}}

    def start(self):
        if self.process and self.process.poll() is None:
            return
        if not self.executable.is_file() or not self.model.is_file():
            raise DomainError("speech_unavailable", "Install the local speech tools with scripts/install-speech.ps1.")
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        # Random inference path limits other local clients; server never binds to LAN.
        route = "/" + secrets.token_hex(32)
        self.url = f"http://127.0.0.1:{port}{route}"
        try:
            self._temp = tempfile.TemporaryDirectory(prefix="ohmpath-speech-")
            self.process = subprocess.Popen([str(self.executable), "--model", str(self.model), "--host", "127.0.0.1",
                "--port", str(port), "--inference-path", route, "--public", self._temp.name,
                "--language", "en", "--threads", "6", "--no-gpu", "--max-context", "0"],
                cwd=self.executable.parent, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            with httpx.Client(timeout=1, trust_env=False) as client:
                for _ in range(150):
                    if self.process.poll() is not None:
                        raise DomainError("speech_worker_failed", "The local speech worker could not start.")
                    try:
                        response = client.get(f"http://127.0.0.1:{port}/")
                        if response.status_code == 200 and self.process.poll() is None:
                            return
                    except httpx.HTTPError:
                        pass
                    time.sleep(.2)
            raise DomainError("speech_timeout", "The local speech model did not load in time.")
        except OSError:
            self.close()
            raise DomainError("speech_worker_failed", "The local speech worker could not start.") from None
        except DomainError:
            self.close()
            raise

    def transcribe(self, wav_data: bytes):
        if len(wav_data) > 1_500_000:
            raise DomainError("speech_too_long", "Keep each spoken question or reading under 20 seconds.", 422)
        try:
            with wave.open(io.BytesIO(wav_data), "rb") as audio:
                if audio.getnchannels() != 1 or audio.getsampwidth() != 2 or audio.getframerate() != 16000 or audio.getnframes() > 320000:
                    raise ValueError
                raw = audio.readframes(audio.getnframes())
                if not raw:
                    raise ValueError
                import array
                values = array.array("h", raw)
                if max(abs(v) for v in values) < 80:
                    return {"text": "", "status": "silence", "model": "small.en", "local_only": True}
        except (wave.Error, ValueError, EOFError):
            raise DomainError("speech_audio_invalid", "Expected up to 20 seconds of mono 16 kHz PCM WAV.", 422) from None
        if not self.lock.acquire(blocking=False):
            raise DomainError("speech_busy", "Wait for the current utterance to finish.", 429)
        try:
            self.start()
            start = time.monotonic()
            with httpx.Client(timeout=60, trust_env=False) as client:
                response = client.post(self.url, files={"file": ("utterance.wav", wav_data, "audio/wav")},
                                       data={"response_format": "json", "language": "en", "temperature": "0.0"})
            response.raise_for_status()
            text = response.json().get("text", "").strip()
            if len(text) > 4096:
                raise DomainError("speech_output_invalid", "Speech output exceeded the transcript limit.")
            non_speech = bool(re.fullmatch(
                r"(?:\s*(?:\[BLANK_AUDIO\]|\[NO_SPEECH\]|\[silence\]|\(silence\))\s*[.!]?\s*)+",
                text, re.IGNORECASE))
            if non_speech:
                text = ""
            return {"text": text, "status": "silence" if non_speech else "final" if text else "empty", "model": "small.en", "local_only": True,
                    "duration_seconds": time.monotonic() - start}
        except httpx.HTTPError:
            raise DomainError("speech_failed", "The local speech worker did not return a reliable transcript.") from None
        finally:
            self.lock.release()

    def close(self):
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=2)
        if self._temp:
            self._temp.cleanup()
        self.process = None
        self.url = None
        self._temp = None
