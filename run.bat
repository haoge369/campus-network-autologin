@echo off
title Campus Login
cd /d "%~dp0"
echo Starting Campus Login Script...
"C:\Program Files\nodejs\node.exe" campus_login.js
echo.
echo Done. Press any key to exit...
pause >nul
