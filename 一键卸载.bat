@echo off
setlocal
cd /d "%~dp0"
if exist "%LOCALAPPDATA%\PaperMate\uninstall.ps1" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%LOCALAPPDATA%\PaperMate\uninstall.ps1"
) else (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\uninstall.ps1"
)
echo.
pause
