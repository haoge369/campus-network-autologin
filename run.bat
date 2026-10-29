@echo off
title Campus Login
cd /d "%~dp0"

echo ================================================
echo  Campus Network Auto Login
echo ================================================
echo.
echo  TIP: if this window cannot open at all, or Windows
echo       shows "cmd.exe - Application Error (0xc0000142)",
echo       please double-click  run_now.vbs  instead.
echo       (run_now.vbs does not use cmd.exe at all.)
echo.
echo  NOTE: auto-enabling a disabled NIC needs administrator
echo        rights. The scheduled tasks already run elevated;
echo        for manual test run this as administrator.
echo.

set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node.exe"

"%NODE_EXE%" campus_login.js
set "RC=%errorlevel%"

echo.
if not "%RC%"=="0" echo Script exited with code %RC% - see campus_login.log for details.
echo Done. Press any key to exit...
pause >nul
exit /b %RC%
