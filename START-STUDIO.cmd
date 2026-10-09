@echo off
cd /d "%~dp0"
echo Starting Model Studio at http://127.0.0.1:4174
call npm start
if errorlevel 1 pause
