$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
& .venv/Scripts/python.exe scripts/verify.py @args
exit $LASTEXITCODE
