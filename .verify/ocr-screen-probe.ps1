# Probe 2: screenshot the real screen and OCR it -- the whole pipeline, end to end.
# Pure ASCII (PowerShell 5.1 decodes non-BOM files as GBK).
#
# Findings so far (probe 1): this machine already ships a Chinese OCR engine
# (zh-Hans-CN, Windows.Media.Ocr) -- offline, free, nothing to download, ~290ms.
# So the question is no longer "which OCR project to install" but "is the whole
# 截图->识别->清洗 pipeline good enough to be useful, and what does it cost".
#
# Two things this probe settles:
#   1. can we grab the screen at the right DPI (unaware processes get a blurry upscale)
#   2. how bad is the Chinese output really -- Windows OCR puts a SPACE between every
#      character ("工 具 （ 让 她"), which has to be squeezed back out before it is
#      worth injecting into a prompt.
#
# Usage: powershell -NoProfile -File .verify\ocr-screen-probe.ps1 [-Out <png>]

param([string]$Out = "")

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing, System.Windows.Forms | Out-Null

# DPI awareness FIRST -- otherwise CopyFromScreen returns a scaled-up blurry image
# on a 175% display (this machine is 175%), and OCR quality collapses.
Add-Type -Namespace Dsc -Name Dpi -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
public struct RECT { public int Left, Top, Right, Bottom; }
'@ | Out-Null
[void][Dsc.Dpi]::SetProcessDPIAware()

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $bmp.Size)
$g.Dispose()
$shotMs = $sw.ElapsedMilliseconds

$tmp = if ($Out -ne "") { $Out } else { Join-Path $env:TEMP ("dsc-ocr-" + [guid]::NewGuid().ToString("N") + ".png") }
$bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
$size = (Get-Item $tmp).Length

# --- WinRT bridge ---
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await($op, $type) {
    $m = $asTaskGeneric.MakeGenericMethod($type)
    $t = $m.Invoke($null, @($op)); $t.Wait(-1) | Out-Null; return $t.Result
}
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null

$ocrSw = [System.Diagnostics.Stopwatch]::StartNew()
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($tmp)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$ocrSw.Stop()
$stream.Dispose()

Write-Output ("screen: " + $vs.Width + "x" + $vs.Height + "  shot=" + $shotMs + "ms  png=" + [math]::Round($size / 1024) + "KB")
Write-Output ("ocr: " + $ocrSw.ElapsedMilliseconds + "ms  lines=" + $result.Lines.Count)
Write-Output ""

# --- the squeeze: Windows OCR separates EVERY Han character with a space ---
$cjk = '[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]'
$raw = @()
$clean = @()
foreach ($line in $result.Lines) {
    $t = $line.Text
    $raw += $t
    # repeat: lookarounds do not overlap, so "工 具 全" needs two passes to fully close up
    for ($i = 0; $i -lt 3; $i++) {
        $t = $t -replace "(?<=$cjk)\s+(?=$cjk)", ''
    }
    $t = $t -replace '\s{2,}', ' '
    $t = $t.Trim()
    if ($t -ne '') { $clean += $t }
}

Write-Output "=== RAW (first 6 lines, exactly as Windows OCR gives it) ==="
$raw | Select-Object -First 6 | ForEach-Object { Write-Output ("  " + $_) }
Write-Output ""
Write-Output "=== CLEANED (what we would actually hand to her) ==="
$clean | Select-Object -First 25 | ForEach-Object { Write-Output ("  " + $_) }
Write-Output ""
$joined = ($clean -join ' ')
Write-Output ("cleaned chars: " + $joined.Length + "   (raw: " + (($raw -join ' ').Length) + ")")
Write-Output ("full pipeline: " + $sw.ElapsedMilliseconds + "ms")

if ($Out -eq "" -and (Test-Path $tmp)) { Remove-Item $tmp -Force }
