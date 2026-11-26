@echo off
chcp 65001 >nul 2>&1
title Moss AI Web Stopper

echo ========================================
echo   Moss AI Web - Stop All Services
echo ========================================
echo.

set "KILLED=0"

rem ---- kill by PID files (most precise) ----
set "ROOT=%~dp0"
if exist "%ROOT%server.pid" (
    for /f "usebackq delims=" %%i in ("%ROOT%server.pid") do (
        echo [STOP] Server PID %%i ...
        taskkill /PID %%i /F >nul 2>&1
        set "KILLED=1"
    )
    del /q "%ROOT%server.pid"
)
if exist "%ROOT%client.pid" (
    for /f "usebackq delims=" %%i in ("%ROOT%client.pid") do (
        echo [STOP] Client PID %%i ...
        taskkill /PID %%i /F >nul 2>&1
        set "KILLED=1"
    )
    del /q "%ROOT%client.pid"
)

rem ---- fallback: kill any node on ports 3000 / 5173 ----
for %%p in (3000 5173) do (
    for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%%p" ^| findstr LISTENING') do (
        echo [STOP] Port %%p PID %%a ...
        taskkill /PID %%a /F >nul 2>&1
        set "KILLED=1"
    )
)

rem ---- extra fallback: kill leftover node spawned from our paths ----
powershell -NoProfile -Command ^
  "Get-CimInstance Win32_Process -Filter \"name = 'node.exe'\" | Where-Object { $_.CommandLine -match 'server\\\\|client\\\\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; echo ('[STOP] orphan node PID ' + $_.ProcessId) }"

if "%KILLED%"=="0" echo [INFO] No running Moss AI Web processes found.

echo.
echo [DONE] All services stopped.
ping 127.0.0.1 -n 3 >nul
