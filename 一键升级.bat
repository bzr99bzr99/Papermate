@echo off
setlocal
cd /d "%~dp0"

rem PaperMate one-click upgrade (development workspace entry point).
rem
rem   Prebuilt-package install (install folder has server.js / node.exe):
rem     builds this source and copies only the runtime output
rem     (.next / server.js / package.json / scripts) into the install, then
rem     restarts the service and opens the page. About a minute.
rem   Source install (install.ps1 based):
rem     runs install.ps1 -Upgrade (incremental source sync + rebuild).
rem
rem   Drag a .patch onto this file to apply it before deploying.
rem   Roll back the last development deploy:
rem     powershell -ExecutionPolicy Bypass -File scripts\upgrade-local.ps1 -Undo
rem   List rollback points:
rem     powershell -ExecutionPolicy Bypass -File scripts\upgrade-local.ps1 -ListBackups

set "SCRIPT=%~dp0scripts\upgrade-local.ps1"
if not exist "%SCRIPT%" (
  echo.
  echo Cannot find scripts\upgrade-local.ps1
  pause
  exit /b 1
)

if not "%~1"=="" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -Patch "%~1"
) else (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%"
)

if errorlevel 1 (
  echo.
  echo Upgrade failed. See the messages above.
  pause
  exit /b 1
)

pause
