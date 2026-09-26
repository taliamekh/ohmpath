[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $InputPath,
    [ValidateRange(1, 20)]
    [int] $TimeoutSeconds = 10
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)

function Write-JsonResult {
    param([hashtable] $Value)
    $json = ConvertTo-Json -InputObject $Value -Depth 8 -Compress
    [Console]::Out.WriteLine($json)
}

function Wait-WinRtOperation {
    param([Parameter(Mandatory = $true)] $Operation)
    $method = [System.WindowsRuntimeSystemExtensions].GetMethods() |
        Where-Object {
            $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and
            $_.GetParameters().Count -eq 1 -and
            $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
        } | Select-Object -First 1
    if ($null -eq $method) { throw 'WinRT async bridge is unavailable' }
    $resultType = $Operation.GetType().GetGenericArguments()[0]
    $task = $method.MakeGenericMethod(@($resultType)).Invoke($null, @($Operation))
    $remainingMs = [int]($script:ocrTimeoutMs - $script:ocrStopwatch.ElapsedMilliseconds)
    if ($remainingMs -le 0 -or -not $task.Wait([Math]::Max(1, $remainingMs))) {
        try { $Operation.Cancel() } catch { }
        throw 'OCR operation timed out'
    }
    return $task.Result
}

$result = @{
    schema_version = '1.0.0'
    status = 'failed'
    provider = 'Windows.Media.Ocr'
    provenance = 'local_ocr_candidate'
    confirmed = $false
    candidate_text = ''
    lines = @()
    source_sha256 = $null
    error = $null
}
$stream = $null
$bitmap = $null
$script:ocrStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$script:ocrTimeoutMs = $TimeoutSeconds * 1000
try {
    if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSEdition -ne 'Desktop') {
        throw 'helper requires stock Windows PowerShell 5.1'
    }
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $item = Get-Item -LiteralPath $InputPath -Force
    if ($item.PSIsContainer) { throw 'input must be one explicit image file' }
    $fullPath = [System.IO.Path]::GetFullPath($item.FullName)
    if ($fullPath -notmatch '^[A-Za-z]:\\') { throw 'input crop must be on a local drive' }
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'reparse-point image inputs are not accepted'
    }
    if ($item.Extension.ToLowerInvariant() -notin @('.png', '.jpg', '.jpeg', '.bmp')) {
        throw 'input must be a PNG, JPEG, or BMP crop'
    }
    if ($item.Length -le 0 -or $item.Length -gt 10MB) { throw 'crop file must be between 1 byte and 10 MB' }
    $result.source_sha256 = (Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash.ToLowerInvariant()

    $fileType = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
    $file = Wait-WinRtOperation ($fileType::GetFileFromPathAsync($fullPath))
    $accessMode = [Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime]::Read
    $stream = Wait-WinRtOperation ($file.OpenAsync($accessMode))
    $decoderType = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
    $decoder = Wait-WinRtOperation ($decoderType::CreateAsync($stream))
    if ($decoder.PixelWidth -gt 4096 -or $decoder.PixelHeight -gt 4096 -or
        ([long]$decoder.PixelWidth * [long]$decoder.PixelHeight) -gt 8000000) {
        throw 'crop dimensions exceed the 4096-pixel side / 8-megapixel limit'
    }
    $bitmap = Wait-WinRtOperation ($decoder.GetSoftwareBitmapAsync())

    $ocrType = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
    $engine = $ocrType::TryCreateFromUserProfileLanguages()
    if ($null -eq $engine) {
        $result.status = 'unavailable'
        $result.error = 'no supported Windows OCR language is available in the current user profile'
    } else {
        $recognized = Wait-WinRtOperation ($engine.RecognizeAsync($bitmap))
        $lines = @()
        foreach ($line in $recognized.Lines) {
            $text = [string]$line.Text
            if (-not [string]::IsNullOrWhiteSpace($text)) {
                $lines += @{ text = $text }
            }
        }
        $result.candidate_text = (@($lines | ForEach-Object { $_.text }) -join "`n")
        $result.lines = @($lines)
        $result.status = 'succeeded'
        $result.error = $null
    }
} catch {
    $message = [string]$_.Exception.Message
    if ($message -match 'timed out') {
        $result.status = 'timed_out'
        $result.error = 'Windows OCR exceeded the configured timeout'
    } else {
        # Keep filesystem locations and runtime details out of the OCR output.
        $result.status = 'failed'
        if ($message -match '^(input|reparse-point|crop|no supported|helper requires)') {
            $result.error = $message
        } elseif ($message -match 'WinRT async bridge|WindowsRuntime|OCR runtime') {
            $result.error = 'Windows OCR runtime is not available'
        } else {
            $result.error = 'Windows OCR could not process the supplied crop'
        }
    }
} finally {
    if ($null -ne $bitmap) {
        try { $bitmap.Dispose() } catch { }
    }
    if ($null -ne $stream) {
        try { $stream.Dispose() } catch { }
    }
}

Write-JsonResult $result
