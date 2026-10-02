# Start DS Companion with an ISOLATED data dir (+ CDP debug port) for verification.
#
# Why this exists: verify scripts really write and delete (save memories, reset state,
# save personas). Without isolation they hit %APPDATA%\ds-companion -- the data the
# owner is actually using. That is not hypothetical: memory-trash had 100+ test
# leftovers and there were *.testpollution-backup files next to real state.
#
# Usage (from the project root):
#   .\verify-run.ps1                 # isolated data + CDP 9222, auto-exit after 90s
#   .\verify-run.ps1 -Port 9224      # another port (when two instances run together)
#   .\verify-run.ps1 -Keep           # do not auto-exit
#
# NOTE: this file is intentionally ASCII-only. Windows PowerShell 5.1 reads a
# BOM-less .ps1 as GBK, which mangles non-ASCII quotes and breaks parsing.

param(
  [int]$Port = 9222,
  [int]$AutoExitSeconds = 90,
  [switch]$Keep
)

$ErrorActionPreference = 'Stop'
# script lives in the project root, so PSScriptRoot IS the project root
$root = $PSScriptRoot
$exe = Join-Path $root 'src-tauri\target\debug\ds-companion.exe'
if (-not (Test-Path $exe)) {
  throw "not found: $exe -- run 'cargo build' in src-tauri first"
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$dataDir = Join-Path $env:TEMP ('dsc-verify-' + $stamp)
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

# Seed the isolated config with safe defaults.
# WHY: an isolated instance still runs the page with the OWNER's login. If the config
# had proactive enabled it would send "are you ignoring me" messages on the owner's
# account every idle window. Tools off + empty workspace = it can only read at most,
# never write, and never speaks on its own.
$seed = '{"cadence":"first","proactiveMode":"off","extractEveryTurns":0,"selfReviewMode":"manual","senseMode":"local","toolsEnabled":false,"workspace":""}'
Set-Content -Path (Join-Path $dataDir 'config.json') -Value $seed -Encoding UTF8

$env:DSC_DATA_DIR = $dataDir
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=' + $Port
if (-not $Keep) { $env:DSC_PROBE_AUTOEXIT = "$AutoExitSeconds" }

Write-Host ('isolated data dir : ' + $dataDir)
Write-Host ('CDP port          : ' + $Port)
if ($Keep) {
  Write-Host 'auto exit         : off (Ctrl+C or tray -> quit)'
} else {
  Write-Host ('auto exit         : ' + $AutoExitSeconds + ' s')
}
Write-Host ''

$p = Start-Process -FilePath $exe -PassThru
Write-Host ('started pid=' + $p.Id)
Write-Host ("verify scripts    : `$env:DSC_CDP='http://127.0.0.1:$Port'; node .verify\verify-personas.mjs")
