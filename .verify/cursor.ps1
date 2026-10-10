# Move / click the REAL mouse cursor, so the pet's hit-test, drag and context menu can be
# verified end to end.
#
# ASCII ONLY on purpose: PowerShell 5.1 reads a BOM-less non-ASCII .ps1 as GBK, which eats
# quotes/braces and turns the script into a parse error (project rule, hit again today).
#
# Coordinates are PHYSICAL pixels. -Scale compensates DPI virtualisation: this process is
# DPI-unaware (screen is at 175%), so user32 gives/takes virtualised coordinates
# (value * 1.75). Without the correction "move the cursor onto her (2662,1591)" becomes
# 4658,2784 and lands in the corner of the screen. SetProcessDPIAware() is unreliable here
# (the console host has already fixed the process DPI context at startup).
#
# usage:
#   powershell -File cursor.ps1 -Action pos -Scale 1.75          -> prints "x y" (physical)
#   powershell -File cursor.ps1 -Action move -X 2662 -Y 1591 -Scale 1.75
#   powershell -File cursor.ps1 -Action click -HoldMs 110        -> down + up in ONE process
#   powershell -File cursor.ps1 -Action rclick -HoldMs 110
#   powershell -File cursor.ps1 -Action down | up | rdown | rup
#
# Why the compound click actions exist: every invocation starts a PowerShell (300-500ms
# here). Calling down and up separately inserts half a second between them, which blows
# past the page's "held shorter than 400ms = a click, longer = a drag" rule - the test
# then never exercises the click path (that mis-diagnosis already happened once).
param(
  [Parameter(Mandatory = $true)][string]$Action,
  [int]$X = 0,
  [int]$Y = 0,
  [double]$Scale = 1.0,
  [int]$HoldMs = 110
)

Add-Type -Namespace Dsc -Name Cursor -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)]
public struct POINT { public int X; public int Y; }
[DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, uint e);
public static void LeftDown() { mouse_event(0x0002, 0, 0, 0, 0); }
public static void LeftUp()   { mouse_event(0x0004, 0, 0, 0, 0); }
public static void RightDown(){ mouse_event(0x0008, 0, 0, 0, 0); }
public static void RightUp()  { mouse_event(0x0010, 0, 0, 0, 0); }
'@

switch ($Action) {
  'pos' {
    $p = New-Object Dsc.Cursor+POINT
    [void][Dsc.Cursor]::GetCursorPos([ref]$p)
    $fx = [int][Math]::Round($p.X * $Scale)
    $fy = [int][Math]::Round($p.Y * $Scale)
    Write-Output "$fx $fy"
  }
  'move' {
    $vx = [int][Math]::Round($X / $Scale)
    $vy = [int][Math]::Round($Y / $Scale)
    [void][Dsc.Cursor]::SetCursorPos($vx, $vy)
    Write-Output "moved $X $Y"
  }
  'click' {
    [Dsc.Cursor]::LeftDown()
    Start-Sleep -Milliseconds $HoldMs
    [Dsc.Cursor]::LeftUp()
    Write-Output "clicked"
  }
  'rclick' {
    [Dsc.Cursor]::RightDown()
    Start-Sleep -Milliseconds $HoldMs
    [Dsc.Cursor]::RightUp()
    Write-Output "rclicked"
  }
  'down' { [Dsc.Cursor]::LeftDown(); Write-Output 'down' }
  'up' { [Dsc.Cursor]::LeftUp(); Write-Output 'up' }
  'rdown' { [Dsc.Cursor]::RightDown(); Write-Output 'rdown' }
  'rup' { [Dsc.Cursor]::RightUp(); Write-Output 'rup' }
  # Fast move to (X,Y) in N steps, then release: a REAL throw. Doing this with separate
  # 'move' calls cannot work - each spawns a process, so the cursor crawls and the release
  # velocity stays under the throw threshold (measured ~100px/s vs the 220px/s minimum).
  'throw' {
    $p = New-Object Dsc.Cursor+POINT
    [void][Dsc.Cursor]::GetCursorPos([ref]$p)
    $sx = $p.X; $sy = $p.Y
    $tx = $X / $Scale; $ty = $Y / $Scale
    for ($i = 1; $i -le 12; $i++) {
      $nx = [int]($sx + ($tx - $sx) * $i / 12)
      $ny = [int]($sy + ($ty - $sy) * $i / 12)
      [void][Dsc.Cursor]::SetCursorPos($nx, $ny)
      Start-Sleep -Milliseconds 12
    }
    [Dsc.Cursor]::LeftUp()
    Write-Output 'thrown'
  }
  default { Write-Output "unknown action $Action"; exit 1 }
}
