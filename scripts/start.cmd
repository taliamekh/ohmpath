@echo off
cd /d "%~dp0.."
if not exist "node_modules\electron\dist\electron.exe" (
  echo Run scripts\setup.ps1 first to prepare Ohm Path.
  pause
  exit /b 1
)
if not exist "dist\desktop\index.html" (
  echo Build Ohm Path with pnpm run build before starting it.
  pause
  exit /b 1
)
"node_modules\electron\dist\electron.exe" .
