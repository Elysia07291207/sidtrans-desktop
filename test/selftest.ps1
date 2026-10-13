# 旁译桌面版 · 一条命令跑完全部能自动跑的自检
#
#   1) 离线自检（语法 / 文件 / 引擎 / 剪贴板闸门 / 缓存 / 坐标）
#   2) OCR 引擎（真的跑一次 Tesseract，认中英两张图）
#   3) 界面（Edge 无头跑真实的 orb.html / panel.html）
#   4) OCR 依赖是否就位（vendor，缺了会提示 npm run vendor）
#
# 要跑「整机冒烟」（真 Electron、真剪贴板、真托盘）另跑：
#   npm run smoke      ← 必须在正常桌面环境里，受限环境里 Electron 起不来
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File .\test\selftest.ps1
#   powershell -ExecutionPolicy Bypass -File .\test\selftest.ps1 -SkipBrowser
#
# ⚠️ 这个文件必须存成 UTF-8 **带 BOM**。PowerShell 5.1 按 GBK 读无 BOM 的 UTF-8
#    会把中文注释读崩（浏览器版那边踩过）。

param(
  [switch]$SkipBrowser
)

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$results = @()

function Step($name, $cmd) {
  Write-Host ""
  Write-Host ("=== " + $name + " ===") -ForegroundColor Cyan
  & $cmd
  $code = $LASTEXITCODE
  $script:results += [pscustomobject]@{ Name = $name; Code = $code }
  if ($code -ne 0) {
    Write-Host ("[未通过] " + $name) -ForegroundColor Red
  } else {
    Write-Host ("[通过] " + $name) -ForegroundColor Green
  }
}

if (-not (Test-Path "node_modules")) {
  Write-Host "没有 node_modules：先跑 npm install，再跑 npm run vendor。" -ForegroundColor Yellow
  exit 1
}
if (-not (Test-Path "vendor\tesseract\tesseract.min.js")) {
  Write-Host "vendor 里没有 OCR 依赖，先跑 npm run vendor（离线自检会因此报一项）。" -ForegroundColor Yellow
}

Step "1/4 离线自检" { node "test\selftest.mjs" }
Step "2/4 OCR 引擎" { node "test\ocr_engine.mjs" }
if (-not $SkipBrowser) {
  Step "3/4 界面（Edge 无头）" { node "test\render_check.mjs" }
} else {
  Write-Host ""
  Write-Host "=== 3/4 界面（按 -SkipBrowser 跳过）===" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "=== 4/4 OCR 依赖（vendor）===" -ForegroundColor Cyan
& node "scripts\sync_vendor.mjs" --check
$vendorCode = $LASTEXITCODE
$results += [pscustomobject]@{ Name = "4/4 OCR 依赖"; Code = $vendorCode }
if ($vendorCode -ne 0) { Write-Host "缺依赖：跑 npm run vendor" -ForegroundColor Red } else { Write-Host "[通过] 4/4 OCR 依赖" -ForegroundColor Green }

Write-Host ""
Write-Host "==================== 汇总 ====================" -ForegroundColor Cyan
$bad = 0
foreach ($r in $results) {
  $mark = if ($r.Code -eq 0) { "通过" } else { "失败" }
  if ($r.Code -ne 0) { $bad++ }
  Write-Host ("  [" + $mark + "] " + $r.Name)
}
Write-Host ""
if ($bad -gt 0) {
  Write-Host ("有 " + $bad + " 步没过。") -ForegroundColor Red
  exit 1
}
Write-Host "全绿。整机冒烟另跑： npm run smoke （需正常桌面环境）" -ForegroundColor Green
exit 0
