$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
& .venv/Scripts/python.exe scripts/generate-contracts.py --check
if ($LASTEXITCODE -ne 0) { throw 'Generated contracts are out of date.' }
& .venv/Scripts/python.exe -m pytest -q
if ($LASTEXITCODE -ne 0) { throw 'Python verification failed.' }
$packageTool = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
if ($packageTool) { $packageTool = $packageTool.Source }
else { $packageTool = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm.cmd' }
& $packageTool run build
if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed.' }
& $packageTool run test:desktop-unit
if ($LASTEXITCODE -ne 0) { throw 'Desktop bridge verification failed.' }
& $packageTool run test:image-metadata
if ($LASTEXITCODE -ne 0) { throw 'Native image metadata verification failed.' }
& $packageTool run test:desktop
if ($LASTEXITCODE -ne 0) { throw 'Desktop walkthrough failed.' }
Write-Host 'Automated verification passed. Physical verification is still pending.'
