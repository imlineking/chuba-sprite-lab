@echo off
setlocal
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="
if exist "%~dp0portable\Chuba Sprite Lab.exe" (
  start "" "%~dp0portable\Chuba Sprite Lab.exe" %*
  exit /b 0
)
if not exist "%~dp0node_modules\electron\dist\electron.exe" (
  echo Sprite Lab runtime is missing. Run npm ci in this project first.
  pause
  exit /b 1
)
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0." %*
exit /b 0
