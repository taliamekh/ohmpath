param([string]$Python = '', [switch]$WithSpeech)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

if (-not $Python) {
    $bundledPython = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'
    if (Test-Path -LiteralPath $bundledPython) { $Python = $bundledPython }
    else { $Python = (Get-Command python -ErrorAction Stop).Source }
}
& $Python -c 'import sys; assert sys.version_info >= (3,12), "Python 3.12 or newer is required"'
if ($LASTEXITCODE -ne 0) { throw 'Python version check failed.' }
if (-not (Test-Path -LiteralPath '.venv/Scripts/python.exe')) {
    & $Python -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the local Python environment.' }
}
& .venv/Scripts/python.exe -m pip install -r requirements.lock
if ($LASTEXITCODE -ne 0) { throw 'Python dependency installation failed.' }
& .venv/Scripts/python.exe -m pip install --no-deps -e .
if ($LASTEXITCODE -ne 0) { throw 'Could not install Ohm Path.' }
$packageTool = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
if ($packageTool) { $packageTool = $packageTool.Source }
else { $packageTool = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm.cmd' }
if (-not (Test-Path -LiteralPath $packageTool)) { throw 'Install the free pnpm 11 package manager and Node.js 22 or newer, then rerun setup.' }
& $packageTool install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw 'Desktop dependency installation failed.' }
& $packageTool run build
if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed.' }
if ($WithSpeech) { & (Join-Path $PSScriptRoot 'install-speech.ps1') }
Write-Host 'Ohm Path is ready. Start it with scripts/start.ps1. No hardware has been opened.'
