@echo off
:: ============================================================================
:: OpenRappter One-Click Installer for Windows
:: Double-click this file or run from Command Prompt to install OpenRappter.
:: Tries pwsh (PowerShell 7+) first, falls back to powershell (5.1).
:: ============================================================================

title OpenRappter Installer

:: Determine script directory
set "SCRIPT_DIR=%~dp0"

:: ── Try PowerShell 7+ (pwsh) first ─────────────────────────────────────────
where pwsh >nul 2>&1
if %errorlevel% equ 0 (
    if exist "%SCRIPT_DIR%install.ps1" (
        echo Starting OpenRappter installer [pwsh - local]...
        pwsh -ExecutionPolicy Bypass -NoProfile -File "%SCRIPT_DIR%install.ps1" %*
        goto :done
    )
    echo Downloading OpenRappter installer [pwsh]...
    pwsh -ExecutionPolicy Bypass -NoProfile -Command "iex (irm 'https://kody-w.github.io/openrappter/install.ps1')"
    goto :done
)

:: ── Fall back to Windows PowerShell 5.1 ─────────────────────────────────────
where powershell >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] PowerShell is required but not found.
    echo Please install PowerShell from https://aka.ms/PSWindows and try again.
    pause
    exit /b 1
)

if exist "%SCRIPT_DIR%install.ps1" (
    echo Starting OpenRappter installer [powershell - local]...
    powershell -ExecutionPolicy Bypass -NoProfile -File "%SCRIPT_DIR%install.ps1" %*
    goto :done
)

echo Downloading OpenRappter installer [powershell]...
powershell -ExecutionPolicy Bypass -NoProfile -Command "iex (irm 'https://kody-w.github.io/openrappter/install.ps1')"

:done
if %errorlevel% neq 0 (
    echo.
    echo Installation encountered an error. See above for details.
    echo If you see "Access is denied", open PowerShell directly and run:
    echo   irm https://kody-w.github.io/openrappter/install.ps1 ^| iex
    echo.
)
pause
