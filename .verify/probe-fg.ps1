# Debug helper: can we actually push a probe window to the foreground?
# Pure ASCII on purpose (PowerShell 5.1 reads non-BOM files as GBK).
$ErrorActionPreference = 'SilentlyContinue'
$dir = Join-Path $env:TEMP 'dsc-front-probe'
$exe = Join-Path $dir 'dsc-front-probe.exe'
if (-not (Test-Path $exe)) { 'no probe exe'; exit 1 }

$sig = '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); ' +
       '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid); ' +
       '[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f); ' +
       '[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId(); ' +
       '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); ' +
       '[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h); ' +
       '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n); ' +
       '[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h); ' +
       '[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);'
Add-Type -MemberDefinition $sig -Name Fg2 -Namespace DscProbe | Out-Null

function FgInfo {
  $h = [DscProbe.Fg2]::GetForegroundWindow()
  $fgPid = 0
  $t = [DscProbe.Fg2]::GetWindowThreadProcessId($h, [ref]$fgPid)
  $pr = Get-Process -Id $fgPid
  return "hwnd=$h pid=$fgPid thread=$t name=$($pr.ProcessName)"
}

"BEFORE:      " + (FgInfo)

$p = Start-Process -FilePath $exe -PassThru
Start-Sleep -Milliseconds 1800
$p.Refresh()
$h = $p.MainWindowHandle
"probe:       pid=$($p.Id) hwnd=$h visible=$([DscProbe.Fg2]::IsWindowVisible($h)) responding=$($p.Responding)"
"AFTER-LAUNCH:" + (FgInfo)

if ($h -eq 0) { 'no main window handle'; Stop-Process -Id $p.Id -Force; exit 1 }

$fg = [DscProbe.Fg2]::GetForegroundWindow()
$fgPid = 0
$ft = [DscProbe.Fg2]::GetWindowThreadProcessId($fg, [ref]$fgPid)
$mt = [DscProbe.Fg2]::GetCurrentThreadId()
"threads:     mine=$mt fg=$ft"

# attempt 1: plain
"try1 plain           -> " + [DscProbe.Fg2]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 400
"after try1:  " + (FgInfo)

# attempt 2: AttachThreadInput
[void][DscProbe.Fg2]::AttachThreadInput($mt, $ft, $true)
[void][DscProbe.Fg2]::ShowWindow($h, 9)
[void][DscProbe.Fg2]::BringWindowToTop($h)
$r2 = [DscProbe.Fg2]::SetForegroundWindow($h)
[void][DscProbe.Fg2]::AttachThreadInput($mt, $ft, $false)
"try2 attach+restore  -> $r2"
Start-Sleep -Milliseconds 400
"after try2:  " + (FgInfo)

# attempt 3: ALT key trick (fake user input unlocks the foreground lock)
[void][DscProbe.Fg2]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
[void][DscProbe.Fg2]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
$r3 = [DscProbe.Fg2]::SetForegroundWindow($h)
"try3 alt-then-setfg -> $r3"
Start-Sleep -Milliseconds 400
"after try3:  " + (FgInfo)

Stop-Process -Id $p.Id -Force
"killed probe $($p.Id)"
