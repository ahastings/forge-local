@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Local API Dev Lab requires Node.js 22 or newer. Install it from https://nodejs.org/
  pause
  exit /b 1
)
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-Forge.ps1"
if errorlevel 1 pause
