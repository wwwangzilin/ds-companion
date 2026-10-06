# A stand-in "screen" for verification: a window whose contents we control.
#
# Why not verify against the real screen: this chain has to be checked by asserting what
# she actually read back. A real screen gives no assertable expectation, and its content
# would be uploaded to the account for real. So we open a window with fixed text, push it
# to the foreground, and let the shell capture *that*.
#
# The two things worth asserting: (1) the big headline (did she take in the whole screen)
# and (2) the line `* release code 7788` -- the only dark-red text on the board, i.e. the
# intended "focus". It checks whether the mouse ring + the prompt actually land her
# attention in the right place instead of her just reading the biggest headline.
#
# TWO BOARDS: the label comes from the environment variable DSC_BOARD_TAG, so you can run
# two boards with different content ("A" and "B") and alternate them as the foreground.
# That is needed to verify "send the last 3 shots at once": the shell skips a capture whose
# OCR text is identical to the previous one, so a single board would never fill the window.
#
# Why an env var and not a param: `powershell -File xxx.ps1 -Tag A` did not deliver the
# value in practice (the window title came out empty). Start-Process children inherit the
# environment as of launch time, so changing the variable between two launches works.
#
# Pure ASCII is a hard requirement here: PowerShell 5.1 decodes BOM-less files as GBK, and
# a Chinese comment can mangle the parse (this project has hit it more than once).
#
# Run it in the background; it does not exit on its own:
#   $env:DSC_BOARD_TAG='A'; Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','.verify\see-target.ps1' -WindowStyle Minimized
$boardTag = if ($env:DSC_BOARD_TAG) { $env:DSC_BOARD_TAG } else { 'A' }
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = "DSC SEE TARGET $boardTag"
$form.ClientSize = New-Object System.Drawing.Size(900, 620)
$form.StartPosition = 'CenterScreen'
$form.BackColor = [System.Drawing.Color]::White

$form.Add_Paint({
    param($sender, $e)
    $g = $e.Graphics
    $g.Clear([System.Drawing.Color]::White)

    $f1 = New-Object System.Drawing.Font('Segoe UI', 40, [System.Drawing.FontStyle]::Bold)
    $g.DrawString("VERIFY TARGET $boardTag", $f1, [System.Drawing.Brushes]::Black, 40, 36)

    $f2 = New-Object System.Drawing.Font('Segoe UI', 18)
    $g.DrawString("this window stands in for the real screen (board $boardTag)", $f2, [System.Drawing.Brushes]::DimGray, 40, 160)

    # The line she is expected to quote back. It carries the board tag because when three
    # shots go out at once, a line that looks IDENTICAL across all of them stops being
    # "the most notable thing on this screen" -- the first run had a fixed `release code
    # 7788` and she correctly picked `checksum A/B` instead (that one distinguished the
    # boards). Keep the marker, vary the tag.
    $f3 = New-Object System.Drawing.Font('Consolas', 26, [System.Drawing.FontStyle]::Bold)
    $g.DrawString("* release code 7788-$boardTag", $f3, [System.Drawing.Brushes]::DarkRed, 40, 288)
    $g.DrawString("* checksum $boardTag", $f3, [System.Drawing.Brushes]::DarkSlateBlue, 40, 356)

    $f4 = New-Object System.Drawing.Font('Segoe UI', 11)
    $g.DrawString('footer: nothing important down here, ignore this line', $f4, [System.Drawing.Brushes]::Gray, 40, 560)

    $f1.Dispose(); $f2.Dispose(); $f3.Dispose(); $f4.Dispose()
})

[void]$form.Show()
$form.Activate()

# Push ourselves to the foreground. SetForegroundWindow alone gets silently refused by the
# Windows foreground lock (returns False, no error, the window just stays behind) -- you
# have to AttachThreadInput and borrow the current foreground thread's input queue first.
# This combo was proven out in .verify/probe-fg.ps1.
Add-Type -Namespace DscSee -Name Fg -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
'@ | Out-Null

$h = $form.Handle
$fg = [DscSee.Fg]::GetForegroundWindow()
$fgPid = 0
$ft = [DscSee.Fg]::GetWindowThreadProcessId($fg, [ref]$fgPid)
$mt = [DscSee.Fg]::GetCurrentThreadId()
[void][DscSee.Fg]::AttachThreadInput($mt, $ft, $true)
[void][DscSee.Fg]::ShowWindow($h, 9)
[void][DscSee.Fg]::BringWindowToTop($h)
$ok = [DscSee.Fg]::SetForegroundWindow($h)
[void][DscSee.Fg]::AttachThreadInput($mt, $ft, $false)
Write-Output "ready tag=$boardTag hwnd=$h fg=$ok pid=$PID"

[System.Windows.Forms.Application]::Run($form)
