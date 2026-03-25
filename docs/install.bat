@echo off
:: ============================================================================
:: OpenRappter One-Click Installer for Windows
:: Double-click this file or run from Command Prompt to install OpenRappter.
:: ============================================================================

title OpenRappter Installer

:: Check for PowerShell
where powershell >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] PowerShell is required but not found.
    echo Please install PowerShell and try again.
    pause
    exit /b 1
)

:: Determine script directory
set "SCRIPT_DIR=%~dp0"

:: Check if install.ps1 exists locally (running from repo clone)
if exist "%SCRIPT_DIR%install.ps1" (
    echo Starting OpenRappter installer...
    powershell -ExecutionPolicy Bypass -NoProfile -File "%SCRIPT_DIR%install.ps1" %*
    goto :done
)

:: Download and run from GitHub Pages
echo Downloading OpenRappter installer...
powershell -ExecutionPolicy Bypass -NoProfile -Command "& { irm https://kody-w.github.io/openrappter/install.ps1 | iex }"

:done
if %errorlevel% neq 0 (
    echo.
    echo Installation encountered an error. See above for details.
    echo.
)
pause
