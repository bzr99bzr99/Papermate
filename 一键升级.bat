@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\upgrade.ps1"
if errorlevel 1 (
  echo.
  echo Upgrade failed. See the messages above.
  pause
  exit /b 1
)
echo.
echo Upgrade finished. Your data is preserved.
pause
