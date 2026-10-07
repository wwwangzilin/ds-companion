# Focus the LARGEST visible window of a process and capture it into a PNG.
#
# Why this exists: the owner eyeballs UI by looking at a screenshot file, and the model in
# this session cannot see images. So verification ends with "here is the PNG, look".
#
# Why "largest window by PID" instead of MainWindowTitle: ds-companion runs the chat window
# AND a 200x344 desktop-pet window. The OS designates the PET as the process main window
# (observed: MainWindowTitle = "DS Companion - 桌宠"), so matching by title focuses and
# captures the pet instead of the chat. Picking the biggest window by area is unambiguous.
#
# Focus is done here on purpose: CopyFromScreen grabs a screen region, so the window must be
# foreground and unobstructed or whatever covers it lands in the picture. The technique
# (AttachThreadInput + ShowWindow(SW_RESTORE) + BringWindowToTop + SetForegroundWindow) is the
# same one .verify/focus-window.ps1 uses -- that script focuses by title, this one by area.
#
# Pure ASCII on purpose (PowerShell 5.1 decodes BOM-less files as GBK and mangles quotes).
#
# Usage: powershell -File .verify/shot-window.ps1 -Out 'D:\abs\path\x.png' [-Process ds-companion]
#        -Out must be ABSOLUTE (a relative path resolves against the process CWD, not
#        PowerShell's location -- that trap bit us before).
param(
    [string]$Process = 'ds-companion',
    [Parameter(Mandatory = $true)][string]$Out,
    [int]$MinWidth = 400
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing
Add-Type -Namespace DscShot -Name Api -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
public delegate bool EnumProc(IntPtr h, IntPtr p);
public struct RECT { public int Left, Top, Right, Bottom; }
'@ | Out-Null

$procs = @(Get-Process -Name $Process -ErrorAction SilentlyContinue)
if ($procs.Count -eq 0) { throw "no process named '$Process'" }
$pids = @($procs | ForEach-Object { [uint32]$_.Id })

$found = New-Object System.Collections.ArrayList
$cb = [DscShot.Api+EnumProc] {
    param($h, $p)
    $wpid = [uint32]0
    [void][DscShot.Api]::GetWindowThreadProcessId($h, [ref]$wpid)
    if ($pids -notcontains $wpid) { return $true }
    if (-not [DscShot.Api]::IsWindowVisible($h)) { return $true }
    $r = New-Object DscShot.Api+RECT
    if (-not [DscShot.Api]::GetWindowRect($h, [ref]$r)) { return $true }
    $sb = New-Object System.Text.StringBuilder 256
    [void][DscShot.Api]::GetWindowTextW($h, $sb, 256)
    [void]$found.Add([pscustomobject]@{
        Hwnd  = $h
        Title = $sb.ToString()
        W     = $r.Right - $r.Left
        H     = $r.Bottom - $r.Top
        R     = $r
    })
    return $true
}
[void][DscShot.Api]::EnumWindows($cb, [IntPtr]::Zero)

# Always print what we saw: when the pick looks wrong this line is the diagnosis.
foreach ($f in $found) { "  cand hwnd=$($f.Hwnd) $($f.W)x$($f.H) '$($f.Title)'" }

$pick = $found | Where-Object { $_.W -ge $MinWidth } | Sort-Object { $_.W * $_.H } -Descending | Select-Object -First 1
if (-not $pick) { throw "no visible window of '$Process' wider than $MinWidth" }

$h = $pick.Hwnd
$cur = [DscShot.Api]::GetForegroundWindow()
$curPid = [uint32]0
$ft = [DscShot.Api]::GetWindowThreadProcessId($cur, [ref]$curPid)
$mt = [DscShot.Api]::GetCurrentThreadId()
[void][DscShot.Api]::AttachThreadInput($mt, $ft, $true)
[void][DscShot.Api]::ShowWindow($h, 9)   # SW_RESTORE
[void][DscShot.Api]::BringWindowToTop($h)
[void][DscShot.Api]::SetForegroundWindow($h)
[void][DscShot.Api]::AttachThreadInput($mt, $ft, $false)
Start-Sleep -Milliseconds 600

$fg = [DscShot.Api]::GetForegroundWindow()
# Not fatal: SetForegroundWindow silently fails when another app owns the foreground lock.
# It is reported so a picture of the wrong window is never mistaken for a real result.
"fg=$($fg -eq $h)"

$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path -LiteralPath $dir)) {
    [void](New-Item -ItemType Directory -Path $dir -Force)
}

$r = New-Object DscShot.Api+RECT
[void][DscShot.Api]::GetWindowRect($h, [ref]$r)
$w = $r.Right - $r.Left
$hh = $r.Bottom - $r.Top
$bmp = New-Object System.Drawing.Bitmap($w, $hh)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size($w, $hh)))
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()

"ok=$Out w=$w h=$hh at=$($r.Left),$($r.Top) title=$($pick.Title)"
