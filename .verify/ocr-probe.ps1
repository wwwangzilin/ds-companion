# Probe: does this machine have a usable OFFLINE Chinese OCR, and how good is it?
# Pure ASCII (PowerShell 5.1 decodes non-BOM files as GBK).
#
# Why PowerShell first: Windows ships an OCR engine (Windows.Media.Ocr) that is
# offline, free and already installed. If it reads Chinese well, we need ZERO new
# binaries and zero model downloads -- which is the whole point of this project's
# "must compile offline" rule. If it doesn't, we go look for a model-based OCR.
#
# Usage: powershell -NoProfile -File .verify\ocr-probe.ps1 <image-path>

param([string]$Image = "")

$ErrorActionPreference = 'Stop'

# --- WinRT async -> .NET Task bridge (PS 5.1 cannot await WinRT directly) ---
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($op, $type) {
    $m = $asTaskGeneric.MakeGenericMethod($type)
    $t = $m.Invoke($null, @($op))
    $t.Wait(-1) | Out-Null
    return $t.Result
}

# --- load the WinRT types ---
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null

Write-Output "=== available OCR languages ==="
foreach ($l in [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages) {
    Write-Output ("  " + $l.LanguageTag + "  " + $l.DisplayName)
}

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) {
    Write-Output "engine: NULL (no recognizer for user profile languages)"
    exit 2
}
Write-Output ("engine from user profile: " + $engine.RecognizerLanguage.LanguageTag)

if ($Image -eq "" -or -not (Test-Path $Image)) {
    Write-Output "no image given -> language probe only"
    exit 0
}

Write-Output ""
Write-Output ("=== OCR: " + $Image + " ===")
$sw = [System.Diagnostics.Stopwatch]::StartNew()

$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync((Resolve-Path $Image).Path)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

$sw.Stop()
Write-Output ("elapsed: " + $sw.ElapsedMilliseconds + " ms   lines: " + $result.Lines.Count)
Write-Output "--- text ---"
foreach ($line in $result.Lines) {
    Write-Output $line.Text
}
Write-Output "--- end ---"
