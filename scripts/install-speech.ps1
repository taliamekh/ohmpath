$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$toolRoot = Join-Path $env:LOCALAPPDATA 'OhmPath/tools/whisper-b5130'
$modelRoot = Join-Path $env:LOCALAPPDATA 'OhmPath/models'
New-Item -ItemType Directory -Force -Path $toolRoot,$modelRoot | Out-Null
$release = Invoke-RestMethod 'https://api.github.com/repos/ggml-org/whisper.cpp/releases/tags/b5130'
$asset = $release.assets | Where-Object { $_.name -eq 'whisper-bin-x64.zip' }
if (-not $asset) { throw 'Pinned official whisper.cpp build unavailable.' }
$archive = Join-Path $toolRoot 'whisper-bin-x64.zip'
if (-not (Test-Path -LiteralPath $archive)) {
    Invoke-WebRequest -UseBasicParsing -Uri $asset.browser_download_url -OutFile $archive
}
if ($asset.digest -and $asset.digest.StartsWith('sha256:')) {
    $actualHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $asset.digest.Substring(7)) { throw 'Speech executable download hash mismatch.' }
}
Expand-Archive -LiteralPath $archive -DestinationPath $toolRoot -Force
$model = Join-Path $modelRoot 'ggml-small.en.bin'
$expectedModelHash = 'c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d'
if (-not (Test-Path -LiteralPath $model)) {
    $partialModel = Join-Path $modelRoot 'ggml-small.en.bin.partial'
    Invoke-WebRequest -UseBasicParsing -Uri 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin' -OutFile $partialModel
    if ((Get-FileHash -LiteralPath $partialModel -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedModelHash) {
        throw 'Speech model checksum mismatch; the partial download will not be used.'
    }
    Move-Item -LiteralPath $partialModel -Destination $model
}
if ((Get-FileHash -LiteralPath $model -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedModelHash) { throw 'Installed speech model checksum mismatch.' }
Write-Output 'Installed local whisper.cpp CPU build and small.en speech model. No cloud transcription provider used.'
Get-ChildItem -LiteralPath $toolRoot -Filter 'whisper-*.exe' -Recurse | Select-Object Name,FullName
Get-FileHash -LiteralPath $model -Algorithm SHA256
