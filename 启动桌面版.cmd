@echo off
chcp 936 >nul
cd /d "%~dp0"
title 旁译桌面版
echo.
echo   正在启动旁译桌面版（悬浮球）...
echo   起来之后：屏幕右侧会出现一个暖褐色的圆球，写着一个「译」。
echo   这个黑窗口先别关 —— 关掉它等于关掉程序。
echo   要退出：托盘图标右键选「退出」，或者在这个窗口按 Ctrl+C。
echo.
if not exist "node_modules\electron\dist\electron.exe" (
  echo   [x] 没找到 Electron。先在项目目录跑：npm install
  pause
  exit /b 1
)
if not exist "vendor\tesseract\tesseract.min.js" (
  echo   [!] 还没同步 OCR 依赖，取字功能会不可用。跑一次：npm run vendor
)
"node_modules\electron\dist\electron.exe" .
echo.
echo   程序退出了（退出码 %ERRORLEVEL%）。如果它是自己崩的，把上面的报错发给我。
pause
