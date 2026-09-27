from pathlib import Path

import pytest

from ohmpath.session.store import DomainError
from ohmpath.voice import transcription


def _install(root: Path) -> tuple[Path, Path]:
    exe = root / "tools/whisper-b5130/Release/whisper-server.exe"
    model = root / "models/ggml-small.en.bin"
    exe.parent.mkdir(parents=True)
    model.parent.mkdir(parents=True)
    exe.touch()
    model.touch()
    return exe, model


def test_redirected_localappdata_uses_pinned_user_install(monkeypatch, tmp_path):
    profile = tmp_path / "user"
    exe, model = _install(profile / "AppData/Local/OhmPath")
    monkeypatch.setenv("USERPROFILE", str(profile))
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "redirected"))
    monkeypatch.delenv("OHMPATH_WHISPER", raising=False)
    monkeypatch.delenv("OHMPATH_SPEECH_MODEL", raising=False)

    worker = transcription.WhisperWorker()

    assert (worker.executable, worker.model) == (exe, model)
    assert worker.status()["status"] == "installed"
    assert worker.status()["installation"] == {
        "executable": str(exe), "executable_exists": True,
        "model": str(model), "model_exists": True,
    }


def test_existing_redirected_install_wins_and_overrides_remain_explicit(monkeypatch, tmp_path):
    profile = tmp_path / "user"
    _install(profile / "AppData/Local/OhmPath")
    redirected = tmp_path / "redirected"
    exe, model = _install(redirected / "OhmPath")
    monkeypatch.setenv("USERPROFILE", str(profile))
    monkeypatch.setenv("LOCALAPPDATA", str(redirected))
    monkeypatch.delenv("OHMPATH_WHISPER", raising=False)
    monkeypatch.delenv("OHMPATH_SPEECH_MODEL", raising=False)
    assert (transcription.WhisperWorker().executable, transcription.WhisperWorker().model) == (exe, model)

    explicit = tmp_path / "missing-explicit.exe"
    monkeypatch.setenv("OHMPATH_WHISPER", str(explicit))
    worker = transcription.WhisperWorker()
    assert worker.executable == explicit
    assert worker.model == model
    assert worker.status()["status"] == "not_installed"
    assert worker.status()["installation"] == {
        "executable": str(explicit), "executable_exists": False,
        "model": str(model), "model_exists": True,
    }


def test_failed_launch_cleans_temporary_directory(monkeypatch, tmp_path):
    exe, model = _install(tmp_path / "OhmPath")
    monkeypatch.setenv("OHMPATH_WHISPER", str(exe))
    monkeypatch.setenv("OHMPATH_SPEECH_MODEL", str(model))
    created = []
    real_temp = transcription.tempfile.TemporaryDirectory

    def make_temp(*args, **kwargs):
        directory = real_temp(*args, dir=tmp_path, **kwargs)
        created.append(Path(directory.name))
        return directory

    def fail_launch(*args, **kwargs):
        raise OSError("simulated missing runtime dependency")

    monkeypatch.setattr(transcription.tempfile, "TemporaryDirectory", make_temp)
    monkeypatch.setattr(transcription.subprocess, "Popen", fail_launch)
    worker = transcription.WhisperWorker()
    with pytest.raises(DomainError) as error:
        worker.start()
    assert error.value.code == "speech_worker_failed"
    assert created and not created[0].exists()
    assert worker.process is None and worker.url is None and worker._temp is None
