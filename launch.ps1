# Build + launch DS Companion (dev build) and wait until the window is actually up.
#
# WHY a script: the checks everyone forgets before "try it and see" are
#   1) the exe may be a rebuild behind (Cargo writes it, but a running instance
#      locks the file -- an old instance silently keeps serving the old build)
#   2) you need to know it ACTUALLY came up, not just that a process exists
#
# Usage (from the project root):
#   .\launch.ps1                  # just build + run
#   .\launch.ps1 -Cdp             # also expose CDP on 9222 (for verify scripts)
#   .\launch.ps1 -NoBuild         # skip cargo build
#   .\launch.ps1 -DataDir C:\tmp\x  # isolated data dir (see verify-run.ps1)
#
# ASCII-only on purpose: Windows PowerShell 5.1 reads a BOM-less .ps1 as GBK and
# mangles non-ASCII quotes (this bit us before).

param(
  [switch]$Cdp,
  [switch]$NoBuild,
  [string]$DataDir = '',
  [int]$Port = 9222
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$exe = Join-Path $root 'src-tauri\target\debug\ds-companion.exe'

# 1) a running instance locks the exe -- stop it first or the build will fail
$running = Get-CimInstance Win32_Process -Filter "Name='ds-companion.exe'"
if ($running.Count -gt 0) {
  Write-Host ('stopping running instance(s): ' + ($running.ProcessId -join ', '))
  $running | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Start-Sleep -Seconds 2
}

# 2) build
#
# NOTE: do NOT pipe cargo into Select-Object/Write-Host. Cargo writes progress to
# stderr, and with $ErrorActionPreference='Stop' each stderr line becomes a
# terminating error ("NativeCommandError") -- the build actually succeeds but the
# script dies reporting failure. Redirect to a file, show the tail, check LASTEXITCODE.
if (-not $NoBuild) {
  Write-Host 'building...'
  $log = Join-Path $env:TEMP 'dsc-build.log'
  # 用 Start-Process 而不是 `cargo build 2>&1 | ...`：
  #   · cargo 的进度与警告走 stderr
  #   · PowerShell 5.1 在 $ErrorActionPreference='Stop' 下会把原生命令的每一行 stderr
  #     当成 terminating error（NativeCommandError），于是"编译成功但脚本报失败"
  #   · 重定向到文件 + 读文件是唯一稳的姿势（这条踩了两次）
  $p = Start-Process -FilePath 'cargo' -ArgumentList 'build' -WorkingDirectory (Join-Path $root 'src-tauri') `
       -NoNewWindow -Wait -PassThru -RedirectStandardOutput $log -RedirectStandardError ($log + '.err')
  $code = $p.ExitCode
  Get-Content $log -Tail 3 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host ('  ' + $_) }
  Get-Content ($log + '.err') -Tail 6 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host ('  ' + $_) }
  if ($code -ne 0) { throw ('cargo build failed (exit ' + $code + ') -- see ' + $log) }
}
if (-not (Test-Path $exe)) { throw "not found: $exe" }
Write-Host ('exe: ' + (Get-Item $exe).LastWriteTime)

# 3) launch
$env:DSC_PROBE_AUTOEXIT = $null
Remove-Item Env:\DSC_PROBE_AUTOEXIT -ErrorAction SilentlyContinue
if ($DataDir -ne '') {
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
  $env:DSC_DATA_DIR = $DataDir
  Write-Host ('isolated data dir: ' + $DataDir)
} else {
  Remove-Item Env:\DSC_DATA_DIR -ErrorAction SilentlyContinue
}
if ($Cdp) {
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=' + $Port
  Write-Host ('CDP: http://127.0.0.1:' + $Port)
}

$p = Start-Process -FilePath $exe -PassThru
Write-Host ('started pid=' + $p.Id)

# 4) wait until it is really up (window built + page loaded), not just "process exists"
$log = Join-Path $env:TEMP 'ds-companion.log'
$deadline = (Get-Date).AddSeconds(45)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 700
  if ($p.HasExited) { throw ('the app exited right away (code ' + $p.ExitCode + ') -- check ' + $log) }
  if (Test-Path $log) {
    $tail = (Get-Content $log -Tail 30 -ErrorAction SilentlyContinue) -join "`n"
    if ($tail -match '\[main\] window built ok' -and $tail -match '\[pageload\] finished') {
      Write-Host 'window is up.'
      if ($Cdp) {
        for ($i = 0; $i -lt 20; $i++) {
          try {
            $ok = (Invoke-WebRequest ('http://127.0.0.1:' + $Port + '/json/version') -UseBasicParsing -TimeoutSec 2).StatusCode
            if ($ok -eq 200) { Write-Host 'CDP is ready.'; break }
          } catch { Start-Sleep -Milliseconds 500 }
        }
      }
      exit 0
    }
  }
}
Write-Host 'timed out waiting for the window -- check the log:'
Get-Content $log -Tail 20 -Encoding UTF8
exit 1
