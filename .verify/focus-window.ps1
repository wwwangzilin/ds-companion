# Push a window (found by a substring of its title) to the foreground, and optionally
# park the mouse in its centre.
#
# Why this exists: the app captures **the foreground window**. During verification the
# foreground must be our own stand-in window (.verify/see-target.ps1) and not the app
# itself (it skips capturing its own windows) nor the browser. Also, the mouse position
# is the "focus" hint baked into the screenshot, so it has to be inside that window.
#
# Pure ASCII on purpose (PowerShell 5.1 decodes BOM-less files as GBK).
#
# Output (one line, easy to parse):
#   hwnd=.. fg=True|False cursorBefore=x,y cursorAfter=x,y
param(
    [string]$Title = 'DSC SEE VERIFY TARGET',
    [switch]$PutCursor
)

$ErrorActionPreference = 'Stop'

Add-Type -Namespace DscFocus -Name Api -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
[DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
public struct POINT { public int X, Y; }
public struct RECT { public int Left, Top, Right, Bottom; }
'@ | Out-Null

$before = New-Object DscFocus.Api+POINT
[void][DscFocus.Api]::GetCursorPos([ref]$before)

$proc = Get-Process | Where-Object { $_.MainWindowTitle -like "*$Title*" } | Select-Object -First 1
if (-not $proc) { "hwnd=0 fg=False cursorBefore=$($before.X),$($before.Y) cursorAfter=$($before.X),$($before.Y) err=no-window"; exit 1 }

$h = $proc.MainWindowHandle
$fg = [DscFocus.Api]::GetForegroundWindow()
$fgPid = 0
$ft = [DscFocus.Api]::GetWindowThreadProcessId($fg, [ref]$fgPid)
$mt = [DscFocus.Api]::GetCurrentThreadId()
[void][DscFocus.Api]::AttachThreadInput($mt, $ft, $true)
[void][DscFocus.Api]::ShowWindow($h, 9)
[void][DscFocus.Api]::BringWindowToTop($h)
$ok = [DscFocus.Api]::SetForegroundWindow($h)
[void][DscFocus.Api]::AttachThreadInput($mt, $ft, $false)
Start-Sleep -Milliseconds 350

if ($PutCursor) {
    $r = New-Object DscFocus.Api+RECT
    if ([DscFocus.Api]::GetWindowRect($h, [ref]$r)) {
        $cx = [int](($r.Left + $r.Right) / 2)
        $cy = [int](($r.Top + $r.Bottom) / 2)
        [void][DscFocus.Api]::SetCursorPos($cx, $cy)
        Start-Sleep -Milliseconds 150
    }
}

$after = New-Object DscFocus.Api+POINT
[void][DscFocus.Api]::GetCursorPos([ref]$after)
$now = [DscFocus.Api]::GetForegroundWindow()
"hwnd=$h fg=$($now -eq $h) set=$ok title=$($proc.MainWindowTitle) cursorBefore=$($before.X),$($before.Y) cursorAfter=$($after.X),$($after.Y)"
