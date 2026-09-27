# Installs a pinned free Cloudflare helper locally; no service or account is created.
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$phoneToolDir = Join-Path $projectRoot 'runtime/tools'
$phoneToolPath = Join-Path $phoneToolDir 'cloudflared.exe'
$phoneToolDownload = Join-Path $phoneToolDir 'cloudflared.download'
$expectedHash = 'f096265ec2fcbe9bb6e2d64268db167ced3fcbb83d894bdb9e2fcdb26f2ea7e2'
New-Item -ItemType Directory -Path $phoneToolDir -Force | Out-Null
if ((Test-Path -LiteralPath $phoneToolPath) -and ((Get-FileHash -LiteralPath $phoneToolPath -Algorithm SHA256).Hash -eq $expectedHash)) {
    Write-Output 'The verified phone-camera helper is already installed.'
    exit 0
}
try {
    Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/download/2026.9.3/cloudflared-windows-amd64.exe' -OutFile $phoneToolDownload
    if ((Get-FileHash -LiteralPath $phoneToolDownload -Algorithm SHA256).Hash -ne $expectedHash) {
        throw 'Phone-camera helper checksum did not match the official release. Installation stopped.'
    }
    Move-Item -LiteralPath $phoneToolDownload -Destination $phoneToolPath -Force
    Write-Output 'Installed the verified free phone-camera helper (cloudflared 2026.9.3).'
} finally {
    if (Test-Path -LiteralPath $phoneToolDownload) { Remove-Item -LiteralPath $phoneToolDownload }
}
