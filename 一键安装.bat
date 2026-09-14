@echo off
setlocal
cd /d "%~dp0"

rem PaperMate one-click install.
rem It detects what this folder is and picks the right installer:
rem
rem   extracted release package (has server.js / node.exe):
rem     installs this package - no Node.js, no npm, no internet, under a minute.
rem   source checkout (has app\ components\ lib\ next.config.ts):
rem     installs from source (copies the project, npm install, build).
rem     If a PaperMate install already exists it upgrades it incrementally.
rem
rem You can also drag-and-drop a papermate-windows-x64.zip onto this file.

set "SCRIPT=%~dp0scripts\install-local.ps1"
if not exist "%SCRIPT%" (
  echo.
  echo Cannot find scripts\install-local.ps1
  pause
  exit /b 1
)

if not "%~1"=="" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -PackageZip "%~1"
) else (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%"
)

if errorlevel 1 (
  echo.
  echo Install failed. See the messages above.
  pause
  exit /b 1
)

echo.
echo Install finished. Use the desktop shortcut to start PaperMate.
pause
