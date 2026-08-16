@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1" -ChooseInstallDir
if errorlevel 1 (
  echo.
  echo Install failed. See the messages above.
  pause
  exit /b 1
)
echo.
echo Install finished. Use the desktop shortcut to start PaperMate.
pause
