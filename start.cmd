@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Decision Flood - Jev System One

set NODE_CMD=node
where node >nul 2>nul
if errorlevel 1 set NODE_CMD=C:\Users\songdaili-jk\.workbuddy\binaries\node\versions\22.22.2-3\node.exe

echo.
echo   DECISION FLOOD  -  Jev System One demo
echo   -------------------------------------------
echo   http://localhost:8787
echo   Press Ctrl+C in this window to stop.
echo.

"%NODE_CMD%" server.js --open
pause
