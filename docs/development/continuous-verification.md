# Continuous software verification

`.github/workflows/software-checks.yml` runs on pushes and pull requests. It uses a read-only repository permission and a hosted Ubuntu 24.04 runner. External GitHub Actions are pinned to immutable commit SHAs; their upstream repositories are [actions/checkout](https://github.com/actions/checkout), [actions/setup-python](https://github.com/actions/setup-python), and [pnpm/setup](https://github.com/pnpm/setup). The workflow installs Python packages from `requirements.lock`, installs the root JavaScript workspace from `pnpm-lock.yaml` with frozen resolution, and checks generated contracts, Ruff, the Python test suite, the renderer build, and desktop bridge unit tests.

The workflow installs the free `ngspice` operating-point/transient engine on its disposable runner so tests explicitly requiring actual ngspice results can run. It does not install KiCad. Tests requiring the reviewed KiCad 10 Windows executable or the Windows Media OCR runtime skip on Ubuntu with their existing reasons. A skipped engine-specific test is not evidence that the engine-backed feature passed. On the current Windows checkout, the OCR tests also report skips when execution policy blocks the local helper; no policy override is attempted.

This job has no model credentials, live subscription access, cameras, GPIO, motor or laser access. The end-to-end Electron walkthrough is intentionally excluded: it launches the desktop and relies on the local Windows development setup and simulator environment. CI checks software behavior only and cannot establish hardware acceptance or physical safety.

The workflow is source only until the repository owner publishes it. No hosted run has been claimed from local validation. On the current Windows development checkout, the relevant local checks are:

```powershell
.venv/Scripts/python.exe scripts/generate-contracts.py --check
.venv/Scripts/python.exe -m ruff check services/bench/src services/bench/tests services/pi/src services/pi/tests
.venv/Scripts/python.exe -m pytest -q
pnpm install --frozen-lockfile
pnpm run build
pnpm run test:desktop-unit
```

The workflow also installs the repository as an editable package with dependency resolution disabled. This is required for the lifecycle test to start `python -m ohmpath` in its child process; pytest's import path alone would not make that subprocess importable. Skip reasons are shown explicitly.

Local review parsed the workflow with PyYAML 6.0.3 using its string-preserving loader and checked the push/pull-request triggers, read-only permission and all 11 named steps. This verifies YAML/basic structure, not GitHub's hosted action execution. The isolated parser was installed under ignored `runtime/tools/yaml` and is not an application dependency.

For the complete local walkthrough, including the Electron end-to-end scenario, use `.venv/Scripts/python.exe scripts/verify.py` on the configured Windows development machine with the reviewed ngspice installation. Physical verification remains a separate, supervised activity.
