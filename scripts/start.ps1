param([switch]$Rebuild)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$pythonPath = Join-Path $projectRoot '.venv/Scripts/python.exe'
$electronPath = Join-Path $projectRoot 'node_modules/electron/dist/electron.exe'
if (-not (Test-Path -LiteralPath $pythonPath) -or -not (Test-Path -LiteralPath $electronPath)) {
    throw 'Run scripts/setup.ps1 first to install the free local development dependencies.'
}
if ($Rebuild -or -not (Test-Path -LiteralPath 'dist/desktop/index.html')) {
    $packageTool = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
    if ($packageTool) { $packageTool = $packageTool.Source }
    else { $packageTool = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm.cmd' }
    & $packageTool run build
    if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed.' }
}
# The application is intentionally visible. It owns and closes its local service.
& $electronPath $projectRoot
