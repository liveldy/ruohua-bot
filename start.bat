@echo off
rem RuoHua launcher - keep this file ASCII-only and CRLF.
rem Rationale: cmd.exe reads .bat with the console code page (GBK on zh-CN Windows).
rem A UTF-8 batch file makes cmd lose its byte offset inside multi-byte characters, so
rem lines get executed from the middle ("'dp0"' is not recognized as a command).
rem Chinese output comes from Node itself, which is safe; chcp 65001 makes it render right.
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

node src\main.js %*
echo.
echo RuoHua stopped. Press any key to close this window.
pause >nul
