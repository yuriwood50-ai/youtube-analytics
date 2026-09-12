@echo off
rem Double-click to start the dashboard server and open the browser.
rem Closing this window stops the server.
chcp 65001 >nul
cd /d "%~dp0"
set "PY=%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
if not exist "%PY%" set "PY=python"
"%PY%" main.py %*
pause
