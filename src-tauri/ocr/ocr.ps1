# 截一次当前前台窗口，用 Windows 自带的 OCR 认字，把**原始行**吐回给壳。
#
# 【它为什么只管"看图说话"】判断逻辑（去汉字间空格、滤掉导航栏那类噪音、截断到 240 字）
# 全在 Rust 侧的 screen.rs 里 —— 那些是**规则**，得有单测盯着；而这个脚本只调用系统能力。
# 分工清楚了，调参就不用改脚本、更不用重新编译才能试。
#
# 【为什么整段被 -EncodedCommand 送进来】不落盘：壳把这段脚本转成 UTF-16LE 再 base64，
# 直接当命令行参数交给 powershell，机器上不会多出一个 .ps1（也顺手绕开
# "PowerShell 5.1 按 GBK 解读无 BOM 文件"那类编码坑）。
#
# 【为什么截图只截前台窗口】全屏会把任务栏、旁边的窗口、聊天记录全读进来 ——
# 噪音多、识别更慢，而且"他此刻在看什么"问的本来就只有前台那一个窗口。
#
# 输出约定（壳按这个解析，别改）：
#   第一行  #meta w=.. h=.. shot=..ms ocr=..ms lines=.. mode=memory|temp cursor=0|1 img=512x320
#   之后每行一条识别出来的文字（原样，未清洗）
#   最后一行（有才输出）#img <base64 的 PNG> —— 缩过的截图，给她**亲眼**看用

$ErrorActionPreference = 'Stop'
# 中文要原样送回 Rust，所以 stdout 必须是 UTF-8（否则会变成一串问号）
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing, System.Windows.Forms | Out-Null

# 【必须先声明 DPI 感知】不声明的话 CopyFromScreen 在这台 175% 缩放的机器上拿到的是一张
# 被放大过的糊图，OCR 质量会明显掉下来（实测过）。顺带一个好处：声明之后 GetCursorPos 和
# GetWindowRect 给的都是**同一套物理像素**，画鼠标圈时不用再做任何换算。
Add-Type -Namespace DscOcr -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
[DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
public struct RECT { public int Left, Top, Right, Bottom; }
public struct POINT { public int X, Y; }
'@ | Out-Null
[void][DscOcr.Native]::SetProcessDPIAware()

# ── 1. 取前台窗口的区域；不像样就退回整个虚拟屏幕 ────────────────────────────
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
$x = $vs.Left; $y = $vs.Top; $w = $vs.Width; $h = $vs.Height

$fg = [DscOcr.Native]::GetForegroundWindow()
if ($fg -ne [IntPtr]::Zero -and -not [DscOcr.Native]::IsIconic($fg)) {
    $r = New-Object DscOcr.Native+RECT
    if ([DscOcr.Native]::GetWindowRect($fg, [ref]$r)) {
        $cw = $r.Right - $r.Left
        $ch = $r.Bottom - $r.Top
        # 太小的（工具提示/浮动条）不值得看一眼；比屏幕还大的裁到屏幕内
        if ($cw -ge 320 -and $ch -ge 240) {
            if ($r.Left -gt $vs.Left) { $x = $r.Left }
            if ($r.Top -gt $vs.Top) { $y = $r.Top }
            $w = [Math]::Min($cw, $vs.Right - $x)
            $h = [Math]::Min($ch, $vs.Bottom - $y)
        }
    }
}

# ── 2. 截到内存里（不落盘）────────────────────────────────────────────────
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($w, $h)))
$g.Dispose()
$shotMs = $sw.ElapsedMilliseconds

# ── 3. WinRT 的异步桥（PS 5.1 没法直接 await WinRT）───────────────────────
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
[Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) { Write-Output "#meta err=no-engine"; exit 0 }

# BitmapDecoder 要一个 IRandomAccessStream。优先走**内存流**（一个字节都不落盘）；
# 内存流这条路在哪台机器上不通时退回临时文件，并且用完立刻删。
$mode = 'memory'
$memErr = ''
$stream = $null
$tmp = $null
try {
    # 【别用 New-Object】WinRT 类型得走 ::new()（第一版写成 New-Object，直接抛错退到临时文件）
    $ms = [Windows.Storage.Streams.InMemoryRandomAccessStream]::new()
    $net = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForWrite($ms)
    $bmp.Save($net, [System.Drawing.Imaging.ImageFormat]::Png)
    $net.Flush(); $ms.Seek(0)
    $stream = $ms
} catch {
    $mode = 'temp'
    $memErr = $_.Exception.Message
    $tmp = Join-Path $env:TEMP ("dsc-ocr-" + [guid]::NewGuid().ToString("N") + ".png")
    $bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($tmp)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
}

# ── 4. 认字 ───────────────────────────────────────────────────────────────
$ocrSw = [System.Diagnostics.Stopwatch]::StartNew()
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$ocrSw.Stop()
try { $stream.Dispose() } catch {}
if ($tmp -and (Test-Path $tmp)) { Remove-Item $tmp -Force }

# ── 5. 顺手留一张缩过的图：让她**亲眼**看，而不是只靠认字 ────────────────────
#
# 【为什么要它】OCR 只吐字，吐不出"主人在看哪一块" —— 而"焦点在哪"正是这一版要的。
# 而且有个硬事实：**屏幕截图里没有鼠标指针**（BitBlt / PrintWindow 都不带光标），
# 所以她拿不到任何"他在看哪儿"的证据，只能瞎猜（实测就是只会念最大那个标题）。
# 所以这里把鼠标位置**画成一个圈**烙进图里 —— 那是零成本、又唯一可靠的焦点证据。
#
# 【为什么缩到 512 宽】同一张图实测：1600px 要 962 token，512px 只要 200（触底），
# 而 512 那档连 13px 的页脚都还认得出来。差 4.8 倍的钱，信息一点没少。
$imgW = 512
$scale = $imgW / [double]$w
if ($scale -gt 1) { $scale = 1.0 }
$nw = [int][Math]::Max(1, [Math]::Round($w * $scale))
$nh = [int][Math]::Max(1, [Math]::Round($h * $scale))

$cursorIn = $false
$cx = 0.0
$cy = 0.0
$cur = New-Object DscOcr.Native+POINT
if ([DscOcr.Native]::GetCursorPos([ref]$cur)) {
    if ($cur.X -ge $x -and $cur.X -lt ($x + $w) -and $cur.Y -ge $y -and $cur.Y -lt ($y + $h)) {
        $cursorIn = $true
        $cx = ($cur.X - $x) * $scale
        $cy = ($cur.Y - $y) * $scale
    }
}

$imgB64 = ''
try {
    $small = New-Object System.Drawing.Bitmap($nw, $nh)
    $g2 = [System.Drawing.Graphics]::FromImage($small)
    $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g2.DrawImage($bmp, 0, 0, $nw, $nh)
    if ($cursorIn) {
        # 白描边 + 洋红：屏幕内容绝大多数是黑白灰，这两种颜色放哪儿都跳得出来
        $rad = [float]14
        $penW = [System.Drawing.Pen]::new([System.Drawing.Color]::White, [float]5)
        $penM = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(255, 255, 45, 149), [float]2.5)
        foreach ($p in @($penW, $penM)) {
            $g2.DrawEllipse($p, [float]($cx - $rad), [float]($cy - $rad), [float]($rad * 2), [float]($rad * 2))
            $g2.DrawLine($p, [float]($cx - $rad - 7), [float]$cy, [float]($cx + $rad + 7), [float]$cy)
            $g2.DrawLine($p, [float]$cx, [float]($cy - $rad - 7), [float]$cx, [float]($cy + $rad + 7))
        }
        $penW.Dispose(); $penM.Dispose()
    }
    $g2.Dispose()
    # 【用 PNG，不压 JPEG】主人拍板：画质优先，别为了体积牺牲小字。
    # 账是这样的：同一屏 PNG 146KB / JPEG(q82) 23KB —— 差 6 倍，但那 6 倍只省在**本地传输**
    # （PS→Rust 的 stdout、Rust→页面的 IPC），token 是按像素算的，跟编码格式无关；
    # 而且上游多半自己会重编码一遍，本地压了可能白压。5 分钟一次的 146KB，不值当。
    # 【真要改 JPEG】必须显式给质量参数（不给的话 .NET 默认 75，块效应明显）。
    $ms2 = New-Object System.IO.MemoryStream
    $small.Save($ms2, [System.Drawing.Imaging.ImageFormat]::Png)
    $imgB64 = [Convert]::ToBase64String($ms2.ToArray())
    $ms2.Dispose()
    $small.Dispose()
} catch {
    $imgB64 = ''
}
$bmp.Dispose()

# ── 6. 输出 ───────────────────────────────────────────────────────────────
$lines = @()
foreach ($line in $result.Lines) { $lines += $line.Text }
$metaLine = "#meta w=" + $w + " h=" + $h + " shot=" + $shotMs + "ms ocr=" + $ocrSw.ElapsedMilliseconds + "ms lines=" + $lines.Count + " mode=" + $mode
$metaLine += " cursor=" + $(if ($cursorIn) { "1" } else { "0" }) + " img=" + $nw + "x" + $nh
if ($memErr) { $metaLine += " memErr=" + $memErr }
Write-Output $metaLine
foreach ($l in $lines) { Write-Output $l }
if ($imgB64) { Write-Output ("#img " + $imgB64) }
