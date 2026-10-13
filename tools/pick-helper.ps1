<#
  旁译桌面版 · 取词帮手（划词即译用）

  它做的事很小：盯着鼠标，发现「拖选松手」或「双击选词」，就去问一次「选中了什么」。

  两条取词路：
    1) 无障碍接口（UI Automation）：问焦点控件「你选中的文本是什么」。不碰剪贴板。
       文档类（Word / WPS）、部分编辑器会老实回答；浏览器里的网页多半不说话。
    2) 模拟一次 Ctrl+C 读剪贴板（有道 / 欧路那一类工具的做法）。
       动手之前先把剪贴板抄下来，读完立刻还回去；用剪贴板序号判断「这次到底复制到新东西没有」，
       比比对文本可靠（选中的字跟原来剪贴板里的字一模一样时，比对文本会误判）。

  ⚠️ 不注入任何进程、不装任何东西，只用 Windows 自带的接口（P/Invoke + .NET 的无障碍与剪贴板）。

  用法：
    正常跑（盯鼠标，每取到一次就往 stdout 打一行 JSON）：
      powershell -NoProfile -Sta -ExecutionPolicy Bypass -File pick-helper.ps1
    只取一次（自检与手动排查用）：
      powershell -NoProfile -Sta -ExecutionPolicy Bypass -File pick-helper.ps1 -Once -Method clipboard

  输出（每行一个 JSON）：
    {"t":"ready","pid":123,"method":"auto"}
    {"t":"sel","text":"...","how":"uia|clip","app":"winword","hwnd":123,"ms":180,"len":12,"restored":true}
    {"t":"err","msg":"..."}
#>
param(
  [switch]$Once,
  [string]$Method = 'auto',
  [int]$MinDrag = 6,
  [int]$DelayMs = 150,
  # 防误触：拖选时得同时按着这个键才取词（'' = 不要求）。alt / ctrl / shift
  [string]$NeedKey = '',
  # 这些程序里拖一下不等于「选字」（比如资源管理器里拖文件），不发 Ctrl+C
  [string]$SkipApps = 'explorer',
  [int]$DoubleClick = 1,
  # 自检用：不用「焦点控件」，直接问指定窗口句柄的那个元素（不依赖前台焦点）
  [int64]$Handle = 0
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

Add-Type -AssemblyName System.Windows.Forms | Out-Null
Add-Type -AssemblyName UIAutomationClient | Out-Null
Add-Type -AssemblyName UIAutomationTypes | Out-Null

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class PkApi {
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
}
'@ -ErrorAction SilentlyContinue

function Emit($obj) {
  try {
    [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
  } catch {}
}

function Get-ForegroundInfo {
  $r = [ordered]@{ hwnd = 0; pid = 0; app = '' }
  try {
    $h = [PkApi]::GetForegroundWindow()
    $r.hwnd = [int64]$h
    $procId = 0
    [PkApi]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
    $r.pid = $procId
    if ($procId -gt 0) {
      try { $r.app = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch {}
    }
  } catch {}
  return $r
}

# ---- 路一：无障碍接口。只读，不动剪贴板 ----
# $useHandle > 0 时直接问那个窗口的元素（自检用，不依赖前台焦点）；
# 否则问焦点控件（产品里用的就是这条）。
function Read-SelectionUia([int64]$useHandle = 0) {
  try {
    if ($useHandle -gt 0) {
      $el = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$useHandle)
    } else {
      $el = [System.Windows.Automation.AutomationElement]::FocusedElement
    }
    if (-not $el) { return '' }
    $pat = $null
    $ok = $el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pat)
    if (-not $ok -or -not $pat) { return '' }
    $ranges = $pat.GetSelection()
    if (-not $ranges -or $ranges.Count -eq 0) { return '' }
    $sb = New-Object System.Text.StringBuilder
    foreach ($r in $ranges) { [void]$sb.Append($r.GetText(-1)) }
    return $sb.ToString()
  } catch {
    return ''
  }
}

# ---- 路二：模拟一次 Ctrl+C 读剪贴板，读完把原来的还回去 ----
function Read-SelectionClipboard {
  $wasText = $false
  $before = ''
  try {
    $wasText = [System.Windows.Forms.Clipboard]::ContainsText()
    if ($wasText) { $before = [System.Windows.Forms.Clipboard]::GetText() }
  } catch {}

  $seqBefore = [PkApi]::GetClipboardSequenceNumber()

  # Ctrl+C
  [PkApi]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)   # Ctrl down
  [PkApi]::keybd_event(0x43, 0, 0, [UIntPtr]::Zero)   # C down
  [PkApi]::keybd_event(0x43, 0, 2, [UIntPtr]::Zero)   # C up
  [PkApi]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)   # Ctrl up

  # 等剪贴板序号变化（最多 800ms）
  $text = ''
  $deadline = (Get-Date).AddMilliseconds(800)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 40
    if ([PkApi]::GetClipboardSequenceNumber() -ne $seqBefore) {
      Start-Sleep -Milliseconds 40      # 再给一点时间让内容落全
      try { if ([System.Windows.Forms.Clipboard]::ContainsText()) { $text = [System.Windows.Forms.Clipboard]::GetText() } } catch {}
      break
    }
  }

  $restored = $false
  if ($text) {
    # 还回去：只有原来是文本才还得回去（图片那类救不回来，只能留着新选中的字）
    if ($wasText) {
      try { [System.Windows.Forms.Clipboard]::SetText($before); $restored = $true } catch {}
    }
  }
  return @{ text = $text; restored = $restored; hadText = $wasText }
}

function Read-OnceOnce {
  $t0 = Get-Date
  $fw = Get-ForegroundInfo
  $text = ''
  $how = ''
  $restored = $false

  if ($Method -ne 'clipboard') {
    $text = Read-SelectionUia -useHandle $Handle
    if ($text) { $how = 'uia' }
  }
  if (-not $text -and $Method -ne 'uia') {
    $r = Read-SelectionClipboard
    $text = $r.text
    $restored = $r.restored
    if ($text) { $how = 'clip' }
  }

  Emit ([ordered]@{
    t = 'sel'; text = $text; how = $how; app = $fw.app; hwnd = $fw.hwnd
    ms = [int]((Get-Date) - $t0).TotalMilliseconds; len = $text.Length; restored = $restored
  })
}

if ($Once) {
  Read-OnceOnce
  exit 0
}

# ---------------- 盯鼠标 ----------------
$vkNeed = switch ($NeedKey.ToLower()) {
  'alt' { 0x12 } 'ctrl' { 0x11 } 'shift' { 0x10 } default { 0 }
}
$skipList = @()
if ($SkipApps) { $skipList = $SkipApps.ToLower().Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ } }

Emit ([ordered]@{ t = 'ready'; pid = $PID; method = $Method; minDrag = $MinDrag; delayMs = $DelayMs; needKey = $NeedKey; skipApps = ($skipList -join ',') })

$VK_LBUTTON = 0x01
$isDown = $false
$sx = 0; $sy = 0
$lastUp = (Get-Date)
$lastFire = (Get-Date).AddSeconds(-10)

while ($true) {
  try {
    $pressed = (([PkApi]::GetAsyncKeyState($VK_LBUTTON)) -band 0x8000) -ne 0
    $pt = New-Object PkApi+POINT
    [PkApi]::GetCursorPos([ref]$pt) | Out-Null

    if ($pressed -and -not $isDown) {
      $isDown = $true; $sx = $pt.X; $sy = $pt.Y
    }
    elseif (-not $pressed -and $isDown) {
      $isDown = $false
      $dx = $pt.X - $sx; $dy = $pt.Y - $sy
      $dist = [Math]::Sqrt(($dx * $dx) + ($dy * $dy))
      $now = Get-Date
      $gapMs = ($now - $lastUp).TotalMilliseconds
      $lastUp = $now
      $isDouble = $gapMs -lt 420          # 双击：也算一次选词（选一个词）

      if ($dist -ge $MinDrag -or ($isDouble -and $DoubleClick -eq 1)) {
        if (($now - $lastFire).TotalMilliseconds -ge 700) {   # 防抖
          $lastFire = $now
          # 要求按住某个键时，没按就不取（随手一划不会被翻）
          $keyOk = $true
          if ($vkNeed -ne 0) {
            $keyOk = (([PkApi]::GetAsyncKeyState($vkNeed)) -band 0x8000) -ne 0
          }
          $fwNow = Get-ForegroundInfo
          $isSkip = $skipList -contains $fwNow.app.ToLower()
          if ($keyOk -and -not $isSkip) {
            Start-Sleep -Milliseconds $DelayMs                  # 等应用把选区定下来
            Read-OnceOnce
          }
        }
      }
    }
  } catch {
    Emit ([ordered]@{ t = 'err'; msg = "$($_.Exception.Message)" })
  }
  Start-Sleep -Milliseconds 30
}
