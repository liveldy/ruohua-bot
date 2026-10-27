@echo off
rem RuoHua launcher - keep this file ASCII-only and CRLF (cmd.exe reads .bat with the console code page).
rem There is only one panel: it comes up together with the bot itself, so this script just starts the bot.
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install Node 20 or newer from https://nodejs.org/ then run this again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies, this may take a while ...
  call npm install
  if errorlevel 1 (
    echo [ERROR] "npm install" failed. Check your network or run it manually.
    pause
    exit /b 1
  )
)

echo Starting RuoHua - the control panel starts with it (default http://127.0.0.1:8787).
node src\main.js %*
echo.
echo RuoHua stopped. Press any key to close this window.
pause >nul
