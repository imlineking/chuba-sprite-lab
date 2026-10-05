@echo off
setlocal
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="
if not exist "%~dp0node_modules\electron\dist\electron.exe" (
  echo Sprite Lab runtime is missing. Run npm ci in this project first.
  pause
  exit /b 1
)
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0." %*
exit /b 0
