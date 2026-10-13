@echo off
chcp 936 >nul
cd /d "%~dp0"
title 旁译桌面版
set RT=%LOCALAPPDATA%\Programs\sidtrans-desktop\electron
echo.
echo   旁译桌面版 · 悬浮球
echo.

if not exist "vendor\tesseract\tesseract.min.js" (
  echo   [!] 还没同步 OCR 依赖，取字功能不可用。先跑一次：npm run vendor
  echo.
)

if not exist "%RT%\electron.exe" (
  echo   第一次运行：把 Electron 运行时放到英文路径下...
  echo   ^(它放在带中文的路径里会直接崩，这是 Electron 的老毛病^)
  if not exist "node_modules\electron\dist\electron.exe" (
    echo   [x] 项目里也没有 Electron。先在项目目录跑：npm install
    pause
    exit /b 1
  )
  xcopy /E /I /Q /Y "node_modules\electron\dist" "%RT%" >nul
  echo   放好了：%RT%
  echo.
)

echo   起来之后：屏幕右侧会出现一个暖褐色的圆球，写着一个「译」。
echo   这个黑窗口先别关 —— 关掉它等于关掉程序。
echo   要退出：托盘图标右键选「退出」，或者在这个窗口按 Ctrl+C。
echo.
"%RT%\electron.exe" .
set CODE=%ERRORLEVEL%
echo.
echo   程序退出了（退出码 %CODE%）。
echo   如果它没起来，把上面这段发我 —— 尤其是那个退出码。
pause
