<#
  旁译桌面版 · 演示录帧（真拍，不画示意图）

  做两件事：
    1) 先量出球的真实位置，按主进程 placePanel() 的同一套算法算出面板会落在哪，
       把靶子摆在它旁边；然后铺一块**自己的**奶油色台面，把靶子 + 球 + 面板
       这一整块的矩形盖住；
    2) 按节拍把台面那块矩形从屏幕上裁下来存成帧，再拼 GIF。

  ⚠️ 为什么台面必须盖满整块裁切区：球和面板都是透明窗口，直接裁它们的矩形
     会把桌面壁纸一起裁进来。台面盖住之后，裁下来 100% 是我们自己的窗口 ——
     她屏幕上别的东西一个像素都不会进画面。
  ⚠️ 台面**不能**置顶：实测过一个 TopMost 窗口被激活后会盖住球（球是 screen-saver 级，
     而 Windows 只有一个置顶带，后激活的在上面）。台面做成普通窗口就行。
  ⚠️ 靶子只用我们自己造的窗口，绝不拿她的记事本/浏览器当靶子。
  ⚠️ 每个动作后面都要 DoEvents：PowerShell 里 Show 出来的窗体没有自己的消息环，
     不泵消息的话注入的鼠标事件永远躺在队列里 —— TextBox 不会出现选区。

  用法：
    powershell -NoProfile -Sta -ExecutionPolicy Bypass -File tools\demo-gif.ps1 -Scene select
    powershell -NoProfile -Sta -ExecutionPolicy Bypass -File tools\demo-gif.ps1 -Scene ocr
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('select', 'ocr')][string]$Scene,
  [int]$Interval = 100,           # 两帧之间至少歇这么久（抓屏本身还要几十毫秒）
  [int]$MaxWaitMs = 40000,        # 等结果的上限
  [int]$FrameWidth = 1266,        # GIF 宽度（台面按 1.5 倍缩放换算成逻辑像素）
  [string]$WorkDir = '',
  [switch]$NoGif
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @"
using System;using System.Text;using System.Runtime.InteropServices;
public class Dg {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint f, UIntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@ -ErrorAction SilentlyContinue
[void][Dg]::SetProcessDPIAware()   # 不做这一步，置顶的透明小窗不会被合成进画面，坐标也会差 1.5 倍

function Pump2 { try { [System.Windows.Forms.Application]::DoEvents() } catch {} }

function OurWindow($titlePart) {
  $script:Hit = [IntPtr]::Zero
  $cb = [Dg+EnumProc]{
    param($h, $l)
    if (-not [Dg]::IsWindowVisible($h)) { return $true }
    $pid2 = 0
    [void][Dg]::GetWindowThreadProcessId($h, [ref]$pid2)
    $p = Get-Process -Id $pid2 -ErrorAction SilentlyContinue
    if (-not $p) { return $true }
    if ($p.ProcessName -ne '旁译桌面版' -and $p.ProcessName -ne 'electron') { return $true }
    $sb = New-Object System.Text.StringBuilder 300
    [void][Dg]::GetWindowText($h, $sb, 300)
    if ($sb.ToString() -like ('*' + $titlePart + '*')) { $script:Hit = $h; return $false }
    return $true
  }
  [void][Dg]::EnumWindows($cb, [IntPtr]::Zero)
  return $script:Hit
}

# ---------- 量球、算面板位置 ----------
$orbH = OurWindow '旁译桌面版'
if ($orbH -eq [IntPtr]::Zero) { Write-Output '找不到悬浮球窗口（旁译桌面版要先起起来）'; exit 3 }
$or = New-Object Dg+RECT
[void][Dg]::GetWindowRect($orbH, [ref]$or)
$SCALE = 1.5      # 本机 150%
$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea   # 物理像素（本进程 DPI 感知）

$orbD = @{ x = [int]($or.L / $SCALE); y = [int]($or.T / $SCALE); w = 56; h = 56 }
$waD = @{ x = [int]($wa.X / $SCALE); y = [int]($wa.Y / $SCALE); w = [int]($wa.Width / $SCALE); h = [int]($wa.Height / $SCALE) }
# 跟 main.js placePanel() 同一套算法
$panD = @{ w = 430; h = 560 }
$px = $orbD.x + $orbD.w + 8
if ($px + $panD.w -gt $waD.x + $waD.w) { $px = $orbD.x - $panD.w - 8 }
if ($px -lt $waD.x) { $px = [Math]::Min($waD.x + 8, $waD.x + $waD.w - $panD.w - 8) }
$py = $orbD.y
if ($py + $panD.h -gt $waD.y + $waD.h) { $py = $waD.y + $waD.h - $panD.h - 8 }
if ($py -lt $waD.y) { $py = $waD.y + 8 }
$panR = @{ L = [int]($px * $SCALE); T = [int]($py * $SCALE); W = [int]($panD.w * $SCALE + 4); H = [int]($panD.h * $SCALE + 6) }
Write-Output ("orb(px) = {0},{1} {2}x{3}   panel predicted = {4},{5} {6}x{7}" -f $or.L, $or.T, ($or.R - $or.L), ($or.B - $or.T), $panR.L, $panR.T, $panR.W, $panR.H)

$blockL = [Math]::Min($or.L, $panR.L); $blockR = [Math]::Max($or.R, $panR.L + $panR.W)
$blockT = [Math]::Min($or.T, $panR.T); $blockB = [Math]::Max($or.B, $panR.T + $panR.H)

# ---------- 靶子 ----------
$tf = New-Object System.Windows.Forms.Form
$tf.FormBorderStyle = 'FixedSingle'
$tf.StartPosition = 'Manual'
$tf.Location = New-Object System.Drawing.Point(20, 20)
$tf.ShowInTaskbar = $false
$tf.TopMost = $false
$tb = $null; $pb = $null
if ($Scene -eq 'select') {
  $tf.Text = 'SIDTRANS-DEMO · 文本窗口'
  $tf.ClientSize = New-Object System.Drawing.Size(1080, 240)
  $tf.BackColor = [System.Drawing.Color]::White
  $tb = New-Object System.Windows.Forms.TextBox
  $tb.Multiline = $true; $tb.ReadOnly = $true; $tb.BorderStyle = 'None'
  $tb.Dock = 'Fill'; $tb.ScrollBars = 'None'
  $tb.Font = New-Object System.Drawing.Font('Segoe UI', 14)
  $tb.BackColor = [System.Drawing.Color]::White
  $tb.ForeColor = [System.Drawing.Color]::FromArgb(28, 28, 30)
  $tb.Text = "Nearly all commercial helium comes from a handful of gas fields,`r`nso a single outage can move the world price within days.`r`nTraders watch the spot market the way others watch the weather."
  $tf.Controls.Add($tb)
}
else {
  $tf.Text = 'SIDTRANS-DEMO · 图片窗口'
  $tf.ClientSize = New-Object System.Drawing.Size(920, 290)
  $tf.BackColor = [System.Drawing.Color]::White
  $bmp = New-Object System.Drawing.Bitmap(880, 250)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.Clear([System.Drawing.Color]::White)
  $f1 = New-Object System.Drawing.Font('Microsoft YaHei', 25, [System.Drawing.FontStyle]::Bold)
  $f2 = New-Object System.Drawing.Font('Segoe UI', 19)
  $g.DrawString('你好世界，这是一张测试图。', $f1, [System.Drawing.Brushes]::Black, 26, 34)
  $g.DrawString('Hello World 2026', $f2, [System.Drawing.Brushes]::DimGray, 28, 140)
  $g.Dispose()
  $pb = New-Object System.Windows.Forms.PictureBox
  $pb.Image = $bmp; $pb.SizeMode = 'AutoSize'
  $pb.Location = New-Object System.Drawing.Point(20, 18)
  $tf.Controls.Add($pb)
}
$tf.Show()
Pump2
Start-Sleep -Milliseconds 250
$tw = $tf.Bounds.Width; $th = $tf.Bounds.Height
Pump2

# 摆在球+面板这一块的左边（左边放不下就摆右边）
$gap = 36
$tL = $blockL - $gap - $tw
$tT = [Math]::Max($wa.Y + 8, [Math]::Min($blockT + 12, $wa.Y + $wa.Height - $th - 8))
if ($tL -lt $wa.X + 8) { $tL = $blockR + $gap }     # 左边放不下 → 摆右边
if ($tL + $tw -gt $wa.X + $wa.Width - 8) { $tL = [Math]::Max($wa.X + 8, $blockL - $gap - $tw) }
$tf.Location = New-Object System.Drawing.Point($tL, $tT)
Pump2

# ---------- 台面 = 裁切区 ----------
$m = 18
$cx1 = [Math]::Max($wa.X, [Math]::Min($tL, $blockL) - $m)
$cy1 = [Math]::Max($wa.Y, [Math]::Min($tT, $blockT) - $m)
$cx2 = [Math]::Min($wa.X + $wa.Width, [Math]::Max($tL + $tw, $blockR) + $m)
$cy2 = [Math]::Min($wa.Y + $wa.Height, [Math]::Max($tT + $th, $blockB) + $m)
$CANVAS_X = $cx1; $CANVAS_Y = $cy1; $CANVAS_W = $cx2 - $cx1; $CANVAS_H = $cy2 - $cy1
# 球占的那块（相对画布），比变化时要跳过
$script:ORBX1 = $or.L - $CANVAS_X - 16; $script:ORBY1 = $or.T - $CANVAS_Y - 16
$script:ORBX2 = $or.R - $CANVAS_X + 16; $script:ORBY2 = $or.B - $CANVAS_Y + 16
Write-Output ("canvas = {0},{1} {2}x{3}  target = {4},{5} {6}x{7}" -f $CANVAS_X, $CANVAS_Y, $CANVAS_W, $CANVAS_H, $tL, $tT, $tw, $th)

$bg = New-Object System.Windows.Forms.Form
$bg.FormBorderStyle = 'None'
$bg.StartPosition = 'Manual'
$bg.Location = New-Object System.Drawing.Point($CANVAS_X, $CANVAS_Y)
$bg.Size = New-Object System.Drawing.Size($CANVAS_W, $CANVAS_H)
$bg.BackColor = [System.Drawing.Color]::FromArgb(242, 239, 233)
$bg.TopMost = $false
$bg.ShowInTaskbar = $false
$bg.Show()
Pump2
Start-Sleep -Milliseconds 250
$tf.Activate()          # 靶子要盖回台面之上
Pump2
Start-Sleep -Milliseconds 250

function FocusForm($form) {
  for ($i = 0; $i -lt 12; $i++) {
    if ([Dg]::GetForegroundWindow() -eq $form.Handle) { return $true }
    try { [System.Windows.Forms.SendKeys]::SendWait([string][char]37) } catch {}
    Start-Sleep -Milliseconds 120
    $form.Activate()
    Pump2
    Start-Sleep -Milliseconds 220
  }
  return ([Dg]::GetForegroundWindow() -eq $form.Handle)
}
$focused = FocusForm $tf
if (-not $focused) {
  Write-Output 'CANNOT_FOCUS（本次采集作废：没抢到前台焦点就不动手）'
  $tf.Close(); $bg.Close()
  exit 2
}
[void][Dg]::SetCursorPos($wa.X + 20, $wa.Y + 20)
Pump2
Start-Sleep -Milliseconds 300
if ($Scene -eq 'select') {
  $tb.SelectionStart = 0
  $tb.SelectionLength = 0
  Pump2
  Start-Sleep -Milliseconds 150
}

# ---------- 录帧 ----------
$WorkDir = $WorkDir
if (-not $WorkDir) { $WorkDir = Join-Path (Split-Path -Parent $PSScriptRoot) ("release\_gifwork\" + $Scene) }
$FramesDir = Join-Path $WorkDir 'frames'
Remove-Item -Recurse -Force $WorkDir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $FramesDir | Out-Null

$FFMPEG = 'C:\Users\ELYSIA\Desktop\工作区\GPT-SoVITS\_ffmpeg\ffmpeg-master-latest-win64-gpl-shared\bin\ffmpeg.exe'
$script:T0 = Get-Date
$script:LastKey = ''
$script:LastWriteMs = -100000
$script:LastChangeMs = 0
$script:Frames = New-Object System.Collections.ArrayList
$script:Idx = 0

function GrabCanvas {
  $bmp = New-Object System.Drawing.Bitmap($CANVAS_W, $CANVAS_H)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($CANVAS_X, $CANVAS_Y, 0, 0, (New-Object System.Drawing.Size($CANVAS_W, $CANVAS_H)))
  $g.Dispose()
  return $bmp
}
function CanvasKey($bmp) {
  $sb = New-Object System.Text.StringBuilder
  for ($y = 6; $y -lt $bmp.Height; $y += 47) {
    for ($x = 6; $x -lt $bmp.Width; $x += 53) {
      # 跳过球那一块：它在翻译时会自己呼吸（#ball.busy 的 pulse 动画），
      # 不排除的话每一帧都算「变了」—— 上一版就因此录出 191 帧
      if ($x -ge $script:ORBX1 -and $x -le $script:ORBX2 -and $y -ge $script:ORBY1 -and $y -le $script:ORBY2) { continue }
      $c = $bmp.GetPixel($x, $y)
      # 量化到 12 级：忽略抗锯齿 / 淡入淡出的细微差异
      [void]$sb.Append(('{0:X1}{1:X1}{2:X1}' -f ([int]($c.R / 16)), ([int]($c.G / 16)), ([int]($c.B / 16))))
    }
  }
  return $sb.ToString()
}
function Snap {
  param([switch]$Force)
  $ms = [int]((Get-Date) - $script:T0).TotalMilliseconds
  $bmp = GrabCanvas
  $key = CanvasKey $bmp
  $changed = ($key -ne $script:LastKey)
  if ($changed) { $script:LastChangeMs = $ms }
  if ($Force -or $changed -or ($ms - $script:LastWriteMs) -ge 1200) {
    $script:Idx++
    $name = 'f{0:d4}.png' -f $script:Idx
    $bmp.Save((Join-Path $FramesDir $name), [System.Drawing.Imaging.ImageFormat]::Png)
    [void]$script:Frames.Add([pscustomobject]@{ file = $name; t = $ms })
    $script:LastKey = $key
    $script:LastWriteMs = $ms
  }
  $bmp.Dispose()
}
function Pump([int]$ms) {
  $end = (Get-Date).AddMilliseconds($ms)
  while ((Get-Date) -lt $end) {
    Pump2
    Snap
    Start-Sleep -Milliseconds $Interval
  }
}
function DragAndSnap($x1, $y1, $x2, $y2, [int]$steps = 20) {
  [void][Dg]::SetCursorPos($x1, $y1); Pump2
  Start-Sleep -Milliseconds 260
  Snap
  [Dg]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Pump2
  Start-Sleep -Milliseconds 150
  for ($i = 1; $i -le $steps; $i++) {
    $x = [int]($x1 + ($x2 - $x1) * $i / $steps)
    $y = [int]($y1 + ($y2 - $y1) * $i / $steps)
    [void][Dg]::SetCursorPos($x, $y)
    Pump2
    Snap
    Start-Sleep -Milliseconds 18
  }
  Pump2
  Start-Sleep -Milliseconds 180
  [Dg]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  Pump2
  Snap
  return [int]((Get-Date) - $script:T0).TotalMilliseconds
}

# 拖选/框选的起止点
if ($Scene -eq 'select') {
  $p1 = $tb.GetPositionFromCharIndex(0)
  $p3 = $tb.GetPositionFromCharIndex($tb.Text.Length - 1)
  $lh = $tb.Font.Height
  $s = $tb.PointToScreen((New-Object System.Drawing.Point(($p1.X + 2), ($p1.Y + [int]($lh * 0.6)))))
  $e = $tb.PointToScreen((New-Object System.Drawing.Point(($p3.X + 10), ($p3.Y + [int]($lh * 0.6)))))
}
else {
  $o = $pb.PointToScreen([System.Drawing.Point]::Empty)
  $s = New-Object System.Drawing.Point(($o.X + 8), ($o.Y + 8))
  $e = New-Object System.Drawing.Point(($o.X + $pb.Width - 10), ($o.Y + $pb.Height - 10))
}
Write-Output ("drag {0},{1} -> {2},{3}" -f $s.X, $s.Y, $e.X, $e.Y)

try {
  Pump 600

  if ($Scene -eq 'select') {
    Write-Output '拖选…'
    $endMs = DragAndSnap $s.X $s.Y $e.X $e.Y
  }
  else {
    Write-Output '按 Ctrl+Alt+S…'
    [Dg]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
    [Dg]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [Dg]::keybd_event(0x53, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [Dg]::keybd_event(0x53, 0, 2, [UIntPtr]::Zero)
    [Dg]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    [Dg]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)

    $t0 = Get-Date
    while (((Get-Date) - $t0).TotalMilliseconds -lt 8000) {
      Pump 150
      if ((OurWindow '旁译 · 框选') -ne [IntPtr]::Zero) { break }
    }
    if ((OurWindow '旁译 · 框选') -eq [IntPtr]::Zero) { throw '遮罩没出来，停下（不要盲拖）' }
    Write-Output '遮罩出来了'
    Pump 600
    Write-Output '框选…'
    $endMs = DragAndSnap $s.X $s.Y $e.X $e.Y
  }

  # 等结果：静了 3.5 秒、且离手 5 秒以上就收工。中间那段「翻译中」会被合并成一张静帧。
  Write-Output '等结果…'
  $t0 = Get-Date
  while (((Get-Date) - $t0).TotalMilliseconds -lt $MaxWaitMs) {
    Pump 200
    $now = [int]((Get-Date) - $script:T0).TotalMilliseconds
    if (($now - $endMs) -ge 5000 -and ($now - $script:LastChangeMs) -ge 3500) { break }
  }
  Pump 500
}
finally {
  Start-Sleep -Milliseconds 200
  try { $tf.Close() } catch {}
  try { $bg.Close() } catch {}
}

Write-Output ('帧数 = ' + $script:Frames.Count + '，目录 = ' + $FramesDir)

# ---------- 拼 GIF ----------
if (-not $NoGif -and $script:Frames.Count -ge 2) {
  # 连续相同的帧只留一张，最多占 0.9 秒
  $md5 = [System.Security.Cryptography.MD5]::Create()
  $hashOf = { param($f) [BitConverter]::ToString($md5.ComputeHash([System.IO.File]::ReadAllBytes((Join-Path $FramesDir $f)))) }
  $runs = New-Object System.Collections.ArrayList
  $i = 0
  while ($i -lt $script:Frames.Count) {
    $j = $i
    $h0 = & $hashOf $script:Frames[$i].file
    while (($j + 1) -lt $script:Frames.Count -and (& $hashOf $script:Frames[$j + 1].file) -eq $h0) { $j++ }
    $startMs = $script:Frames[$i].t
    if (($j + 1) -lt $script:Frames.Count) { $endMs2 = $script:Frames[$j + 1].t } else { $endMs2 = $startMs + 900 }
    [void]$runs.Add([pscustomobject]@{ file = $script:Frames[$i].file; dur = (($endMs2 - $startMs) / 1000.0) })
    $i = $j + 1
  }
  $listPath = Join-Path $WorkDir 'frames.txt'
  $lines = New-Object System.Collections.ArrayList
  foreach ($r in $runs) {
    $d = $r.dur
    if ($d -lt 0.06) { $d = 0.06 }
    if ($d -gt 0.9) { $d = 0.9 }
    [void]$lines.Add("file '$FramesDir\$($r.file)'")
    [void]$lines.Add(('duration {0:0.###}' -f $d))
  }
  [void]$lines.Add("file '$FramesDir\$($runs[$runs.Count - 1].file)'")
  [System.IO.File]::WriteAllLines($listPath, $lines.ToArray(), (New-Object System.Text.UTF8Encoding($false)))
  Write-Output ('去重后帧数 = ' + $runs.Count + ' / 原始 ' + $script:Frames.Count)

  $gif = Join-Path (Split-Path -Parent $PSScriptRoot) ("release\shots\feature_{0}.gif" -f $(if ($Scene -eq 'select') { '2_select' } else { '3_ocr' }))
  $h = [int]($CANVAS_H * $FrameWidth / $CANVAS_W)
  $h = $h - ($h % 2)
  $vf = "scale=${FrameWidth}:${h}:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle"
  & $FFMPEG -y -hide_banner -loglevel error -f concat -safe 0 -i $listPath -vf $vf -loop 0 $gif
  if ($LASTEXITCODE -ne 0) { Write-Output ('ffmpeg 退出码 ' + $LASTEXITCODE) }
  else {
    $fi = Get-Item $gif
    Write-Output ("GIF: {0}  {1} KB  {2}x{3}" -f $fi.FullName, [int]($fi.Length / 1024), $FrameWidth, $h)
  }
}
