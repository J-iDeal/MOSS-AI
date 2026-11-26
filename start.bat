@echo off
chcp 65001 >nul 2>&1
title Moss AI Web Launcher

set "ROOT=%~dp0"
set "LOGDIR=%ROOT%logs"

rem ---- check Node.js ----
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found. Please install Node.js first.
    pause
    exit /b 1
)

rem ---- create logs dir ----
if not exist "%LOGDIR%" mkdir "%LOGDIR%"

rem ---- auto install if node_modules missing ----
if not exist "%ROOT%server\node_modules" (
    echo [SETUP] Installing server dependencies...
    cd /d "%ROOT%server" && call npm install
)
if not exist "%ROOT%client\node_modules" (
    echo [SETUP] Installing client dependencies...
    cd /d "%ROOT%client" && call npm install
)

rem ---- launch backend (hidden) ----
echo [START] Launching server (Express on :3000) ...
powershell -NoProfile -Command ^
  "$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c npm run dev' -WorkingDirectory '%ROOT%server' -WindowStyle Hidden -PassThru -RedirectStandardOutput '%LOGDIR%\server.log' -RedirectStandardError '%LOGDIR%\server.err.log'; $p.Id | Out-File -FilePath '%ROOT%server.pid' -Encoding ASCII"

rem ---- launch frontend (hidden) ----
echo [START] Launching client (Vite) ...
powershell -NoProfile -Command ^
  "$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c npm run dev' -WorkingDirectory '%ROOT%client' -WindowStyle Hidden -PassThru -RedirectStandardOutput '%LOGDIR%\client.log' -RedirectStandardError '%LOGDIR%\client.err.log'; $p.Id | Out-File -FilePath '%ROOT%client.pid' -Encoding ASCII"

rem ---- wait & health check ----
echo [CHECK] Waiting for services to come up ...
ping 127.0.0.1 -n 6 >nul

powershell -NoProfile -Command ^
  "$server = try { (Invoke-WebRequest -Uri 'http://127.0.0.1:3000' -UseBasicParsing -TimeoutSec 3).StatusCode } catch { $_.Exception.Response.StatusCode.value__ }; if ($server) { echo '  Server  : OK (:3000)' } else { echo '  Server  : NOT READY - check logs/server.err.log' }"

echo.
echo ========================================
echo   Moss AI Web is running in background
echo   Server : http://localhost:3000
echo   Logs   : %LOGDIR%
echo   Stop   : double-click stop.bat
echo ========================================
echo.
ping 127.0.0.1 -n 4 >nul
