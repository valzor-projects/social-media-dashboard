@echo off
setlocal
cd /d "%~dp0"

if not exist "backend\package.json" (
    echo [ERROR] backend\package.json not found.
    exit /b 1
)

if not exist "frontend\package.json" (
    echo [ERROR] frontend\package.json not found.
    exit /b 1
)

echo Installing backend dependencies...
cd /d "%~dp0backend"
call npm install
if %errorlevel% neq 0 (
    echo [ERROR] Backend npm install failed.
    pause
    exit /b 1
)

echo Installing frontend dependencies...
cd /d "%~dp0frontend"
call npm install
if %errorlevel% neq 0 (
    echo [ERROR] Frontend npm install failed.
    pause
    exit /b 1
)

cd /d "%~dp0"

start "Backend - API" cmd /k "cd /d ""%~dp0backend"" && npm run dev"
start "Frontend - Vite" cmd /k "cd /d ""%~dp0frontend"" && npm run dev"

echo Backend and frontend are launching in separate windows.
echo Press Ctrl+C in each window to stop the servers.
