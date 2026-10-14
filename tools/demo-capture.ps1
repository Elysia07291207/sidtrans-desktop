# 正式采集（划词 / 剪贴板 共用）
# 帧1：靶子窗口有这段字（未选）+ 球
# 帧2：拖选之后 → 面板出译文
# 所有裁剪都内缩 8 像素，避免带出她屏幕上的东西。
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;using System.Text;using System.Runtime.InteropServices;
public class M5 {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@ -ErrorAction SilentlyContinue
[void][M5]::SetProcessDPIAware()

$SHOTS = Join-Path (Split-Path -Parent $PSScriptRoot) 'release\shots'
if (-not (Test-Path $SHOTS)) { New-Item -ItemType Directory -Force -Path $SHOTS | Out-Null }
$TEXT = @(
  'Helium is the second most abundant element in the universe,'
  'yet on Earth it is so rare that the entire global supply'
  'comes from a handful of natural gas fields.'
) -join "`r`n"

function GrabAll {
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
  $g.Dispose()
  return $bmp
}
function Cut($bmp, $rect, $name, $pad = 8) {
  $r = New-Object System.Drawing.Rectangle(($rect.L + $pad), ($rect.T + $pad), (($rect.R - $rect.L) - 2 * $pad), (($rect.B - $rect.T) - 2 * $pad))
  $c = $bmp.Clone($r, $bmp.PixelFormat)
  $c.Save((Join-Path $SHOTS $name), [System.Drawing.Imaging.ImageFormat]::Png)
  $c.Dispose()
}
function Ours {
  $list = New-Object System.Collections.ArrayList
  $cb = [M5+EnumProc]{
    param($h, $l)
    $pid2 = 0
    [void][M5]::GetWindowThreadProcessId($h, [ref]$pid2)
    if ($pid2 -gt 0) {
      $p = Get-Process -Id $pid2 -ErrorAction SilentlyContinue
      if ($p -and $p.ProcessName -eq 'electron' -and [M5]::IsWindowVisible($h)) {
        $sb = New-Object System.Text.StringBuilder 256
        [void][M5]::GetWindowText($h, $sb, 256)
        $r = New-Object M5+RECT
        [void][M5]::GetWindowRect($h, [ref]$r)
        [void]$list.Add([pscustomobject]@{ title = $sb.ToString(); L = $r.L; T = $r.T; R = $r.R; B = $r.B })
      }
    }
    return $true
  }
  [void][M5]::EnumWindows($cb, [IntPtr]::Zero)
  return $list
}

# ---- 靶子窗口（TopMost，自己控制，不碰她的窗口）----
$form = New-Object System.Windows.Forms.Form
$form.Text = 'SIDTRANS-DEMO-TARGET'
$form.FormBorderStyle = 'FixedSingle'
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(120, 330)
$form.ClientSize = New-Object System.Drawing.Size(940, 230)
$form.BackColor = [System.Drawing.Color]::FromArgb(250, 248, 245)
$tb = New-Object System.Windows.Forms.TextBox
$tb.Multiline = $true; $tb.ReadOnly = $true; $tb.BorderStyle = 'None'; $tb.Dock = 'Fill'
$tb.Font = New-Object System.Drawing.Font('Segoe UI', 13.5)
$tb.BackColor = [System.Drawing.Color]::FromArgb(250, 248, 245)
$tb.ForeColor = [System.Drawing.Color]::FromArgb(30, 30, 30)
$tb.Text = $TEXT
$form.TopMost = $true
$form.Controls.Add($tb)
$form.Show(); $form.Activate()
[System.Windows.Forms.Application]::DoEvents()
Start-Sleep -Milliseconds 900

# ⚠️ 先确认焦点真的在我的靶子上（不确认就不动手，宁可作废重来）
$tr0 = New-Object M5+RECT
[void][M5]::GetWindowRect($form.Handle, [ref]$tr0)
[void][M5]::SetCursorPos([int](($tr0.L + $tr0.R) / 2), ($tr0.T + 10))
Start-Sleep -Milliseconds 120
[M5]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60
[M5]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 300
$focused = $false
for ($i = 0; $i -lt 6; $i++) {
  if ([M5]::GetForegroundWindow() -eq $form.Handle) { $focused = $true; break }
  [System.Windows.Forms.SendKeys]::SendWait('%')
  Start-Sleep -Milliseconds 150
  $form.Activate()
  Start-Sleep -Milliseconds 250
}
if (-not $focused) { Write-Output 'CANNOT_FOCUS（本次采集作废）'; $form.Close(); exit 2 }
Write-Output 'focused OK'

$tr = New-Object M5+RECT
[void][M5]::GetWindowRect($form.Handle, [ref]$tr)

# 帧1
$b1 = GrabAll
Cut $b1 $tr 's1_target.png'
$ours = Ours
$ball = $ours | Where-Object { $_.title -eq '旁译桌面版' } | Select-Object -First 1
if ($ball) { Cut $b1 (New-Object M5+RECT -Property @{ L=$ball.L; T=$ball.T; R=$ball.R; B=$ball.B }) 's1_ball.png' 6 }
$b1.Dispose()
Write-Output 'frame1 done'

# 拖选（在靶子窗口里）
[void][M5]::SetCursorPos(($tr.L + 400), ($tr.T + 120))
Start-Sleep -Milliseconds 120
[M5]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60
[M5]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 200
$y  = $tr.T + 40
$x1 = $tr.L + 16
$x2 = $tr.L + 720
[void][M5]::SetCursorPos($x1, $y)
Start-Sleep -Milliseconds 150
[M5]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 120
for ($x = $x1; $x -le $x2; $x += 24) { [void][M5]::SetCursorPos($x, $y); Start-Sleep -Milliseconds 14 }
Start-Sleep -Milliseconds 120
[M5]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
Write-Output 'drag done, waiting for the panel...'
Start-Sleep -Seconds 7

# 帧2
$b2 = GrabAll
Cut $b2 $tr 's2_target.png'
$ours2 = Ours
$ball2  = $ours2 | Where-Object { $_.title -eq '旁译桌面版' } | Select-Object -First 1
$panel  = $ours2 | Where-Object { $_.title -like '旁译*面板*' } | Select-Object -First 1
if ($ball2)  { Cut $b2 (New-Object M5+RECT -Property @{ L=$ball2.L; T=$ball2.T; R=$ball2.R; B=$ball2.B }) 's2_ball.png' 6 }
if ($panel)  { Cut $b2 (New-Object M5+RECT -Property @{ L=$panel.L; T=$panel.T; R=$panel.R; B=$panel.B }) 's2_panel.png' }
Write-Output ('panel found = ' + [bool]$panel)
$b2.Dispose()

$form.Close()
Write-Output 'DONE'
