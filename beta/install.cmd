@echo off
setlocal EnableExtensions EnableDelayedExpansion
title RAPP Brainstem Frontier Installer

set "BRAINSTEM_HOME=%USERPROFILE%\.brainstem"
set "BETA_HOME=%BRAINSTEM_HOME%\beta-launcher"
set "BETA_SOURCE=%BETA_HOME%\src"
set "REPO_URL=https://github.com/microsoft/aibast-agents-library.git"
set "REPO_REF=main"
set "REPO_COMMIT="
set "RELEASE_TAG="
set "RUNTIME_VERSION_URL="
set "NODE_VERSION=24.19.0"
set "BOOTSTRAP_URL=https://raw.githubusercontent.com/microsoft/aibast-agents-library/main/install.ps1"

if defined BRAINSTEM_BETA_HOME set "BETA_HOME=%BRAINSTEM_BETA_HOME%"
if defined BRAINSTEM_BETA_REPO_URL set "REPO_URL=%BRAINSTEM_BETA_REPO_URL%"
if defined BRAINSTEM_BETA_REF set "REPO_REF=%BRAINSTEM_BETA_REF%"
set "UPDATE_REF=%REPO_REF%"
if defined BRAINSTEM_BETA_UPDATE_REF set "UPDATE_REF=%BRAINSTEM_BETA_UPDATE_REF%"
if defined BRAINSTEM_BETA_COMMIT set "REPO_COMMIT=%BRAINSTEM_BETA_COMMIT%"
if defined BRAINSTEM_BETA_RELEASE_TAG set "RELEASE_TAG=%BRAINSTEM_BETA_RELEASE_TAG%"
if defined BRAINSTEM_BETA_RUNTIME_VERSION_URL set "RUNTIME_VERSION_URL=%BRAINSTEM_BETA_RUNTIME_VERSION_URL%"
if defined BRAINSTEM_BETA_NODE_VERSION set "NODE_VERSION=%BRAINSTEM_BETA_NODE_VERSION%"
if defined BRAINSTEM_BETA_BOOTSTRAP_URL set "BOOTSTRAP_URL=%BRAINSTEM_BETA_BOOTSTRAP_URL%"
set "BETA_SOURCE=%BETA_HOME%\src"

echo.
echo RAPP Brainstem Frontier Launcher
echo Skill Recorder-style desktop launch over the shared global Brainstem
echo.

if defined REPO_COMMIT (
  powershell.exe -NoProfile -Command "if ($env:BRAINSTEM_BETA_COMMIT -notmatch '^[0-9a-fA-F]{40}$') { exit 1 }"
  if errorlevel 1 (
    echo [X] BRAINSTEM_BETA_COMMIT must be a full 40-character commit SHA.
    exit /b 1
  )
  if defined RELEASE_TAG (
    powershell.exe -NoProfile -Command "if ($env:BRAINSTEM_BETA_RELEASE_TAG -notmatch '^brainstem-beta-v[0-9A-Za-z._-]+$') { exit 1 }"
    if errorlevel 1 (
      echo [X] BRAINSTEM_BETA_RELEASE_TAG must be a Frontier release tag.
      exit /b 1
    )
    if not defined RUNTIME_VERSION_URL (
      echo [X] BRAINSTEM_BETA_RUNTIME_VERSION_URL is required for a Frontier release.
      exit /b 1
    )
  )
  set "REPO_REF=%REPO_COMMIT%"
)

where curl.exe >nul 2>&1 || (
  echo [X] Windows curl.exe is required.
  exit /b 1
)

if not exist "%BETA_HOME%" mkdir "%BETA_HOME%"
set "BOOTSTRAP=%TEMP%\rapp-brainstem-bootstrap-%RANDOM%.ps1"
echo [..] Preparing the shared global Brainstem...
curl.exe -fL --progress-bar "%BOOTSTRAP_URL%" -o "%BOOTSTRAP%"
if errorlevel 1 goto :fail
if /i not "%REPO_URL%"=="https://github.com/microsoft/aibast-agents-library.git" (
  set "GIT_CONFIG_COUNT=1"
  set "GIT_CONFIG_KEY_0=url.%REPO_URL%.insteadOf"
  set "GIT_CONFIG_VALUE_0=https://github.com/microsoft/aibast-agents-library.git"
)
if defined RELEASE_TAG (
  set "BRAINSTEM_REPO_URL=%REPO_URL%"
  set "BRAINSTEM_REPO_REF=%RELEASE_TAG%"
  set "BRAINSTEM_VERSION_URL=%RUNTIME_VERSION_URL%"
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%BOOTSTRAP%" --no-launch
) else if defined REPO_COMMIT (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%BOOTSTRAP%" --no-launch --version "%REPO_COMMIT%"
) else (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%BOOTSTRAP%" --no-launch
)
set "BOOTSTRAP_EXIT=%ERRORLEVEL%"
del /q "%BOOTSTRAP%" >nul 2>&1
if not "%BOOTSTRAP_EXIT%"=="0" goto :fail

set "GIT_EXE="
for /f "delims=" %%G in ('where git.exe 2^>nul') do if not defined GIT_EXE set "GIT_EXE=%%G"
if not defined GIT_EXE if exist "%ProgramFiles%\Git\cmd\git.exe" set "GIT_EXE=%ProgramFiles%\Git\cmd\git.exe"
if not defined GIT_EXE (
  echo [X] Git was not available after the Brainstem bootstrap.
  goto :fail
)

echo.
echo [..] Downloading only the Frontier launcher source...
if exist "%BETA_SOURCE%\.git" (
  "%GIT_EXE%" -C "%BETA_SOURCE%" remote set-url origin "%REPO_URL%"
  if errorlevel 1 goto :fail
  "%GIT_EXE%" -C "%BETA_SOURCE%" sparse-checkout init --cone
  if errorlevel 1 goto :fail
  "%GIT_EXE%" -C "%BETA_SOURCE%" sparse-checkout set beta tools/rapp1
  if errorlevel 1 goto :fail
  "%GIT_EXE%" -C "%BETA_SOURCE%" config remote.origin.promisor true
  "%GIT_EXE%" -C "%BETA_SOURCE%" config remote.origin.partialclonefilter blob:none
  "%GIT_EXE%" -C "%BETA_SOURCE%" fetch --progress --filter=blob:none --depth 1 origin "%REPO_REF%"
  if errorlevel 1 goto :fail
  "%GIT_EXE%" -C "%BETA_SOURCE%" reset --hard FETCH_HEAD
  if errorlevel 1 goto :fail
) else (
  if exist "%BETA_SOURCE%" move "%BETA_SOURCE%" "%BETA_SOURCE%.incomplete.%RANDOM%" >nul
  "%GIT_EXE%" init "%BETA_SOURCE%"
  if errorlevel 1 goto :fail
  "%GIT_EXE%" -C "%BETA_SOURCE%" remote add origin "%REPO_URL%"
  if errorlevel 1 goto :fail
  "%GIT_EXE%" -C "%BETA_SOURCE%" sparse-checkout init --cone
  if errorlevel 1 goto :fail
  "%GIT_EXE%" -C "%BETA_SOURCE%" sparse-checkout set beta tools/rapp1
  if errorlevel 1 goto :fail
  "%GIT_EXE%" -C "%BETA_SOURCE%" config remote.origin.promisor true
  "%GIT_EXE%" -C "%BETA_SOURCE%" config remote.origin.partialclonefilter blob:none
  "%GIT_EXE%" -C "%BETA_SOURCE%" fetch --progress --filter=blob:none --depth 1 origin "%REPO_REF%"
  if errorlevel 1 goto :fail
  "%GIT_EXE%" -C "%BETA_SOURCE%" reset --hard FETCH_HEAD
  if errorlevel 1 goto :fail
)
if defined REPO_COMMIT (
  set "ACTUAL_COMMIT="
  set "ACTUAL_COMMIT_FILE=%TEMP%\rapp-beta-commit-%RANDOM%-%RANDOM%.txt"
  "%GIT_EXE%" -C "%BETA_SOURCE%" rev-parse HEAD > "!ACTUAL_COMMIT_FILE!"
  if errorlevel 1 goto :cleanup_actual_commit
  set /p "ACTUAL_COMMIT="<"!ACTUAL_COMMIT_FILE!"
  del "!ACTUAL_COMMIT_FILE!" >nul 2>nul
  set "ACTUAL_COMMIT_FILE="
  if /i not "!ACTUAL_COMMIT!"=="%REPO_COMMIT%" (
    echo [X] Beta checkout resolved to !ACTUAL_COMMIT! instead of %REPO_COMMIT%.
    goto :fail
  )
)
if not exist "%BETA_SOURCE%\beta\package.json" (
  echo [X] beta\package.json is missing from %REPO_REF%.
  goto :fail
)
if exist "%BETA_SOURCE%\solutions" (
  echo [X] Solution bundles leaked into the beta checkout.
  goto :fail
)
echo [OK] Beta checkout excludes the solution library.

set "NODE_PLATFORM=win-x64"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "NODE_PLATFORM=win-arm64"
set "NODE_ARCHIVE=node-v%NODE_VERSION%-%NODE_PLATFORM%.zip"
set "NODE_DIR=%BETA_HOME%\node-v%NODE_VERSION%-%NODE_PLATFORM%"
set "CACHE=%BETA_HOME%\cache"
if not exist "%CACHE%" mkdir "%CACHE%"

REM A half-extracted runtime (node.exe present, npm.cmd missing) used to pass
REM the node.exe check forever and no re-run could repair it. Treat it as absent.
if exist "%NODE_DIR%\node.exe" if not exist "%NODE_DIR%\npm.cmd" (
  echo [..] Portable Node.js at %NODE_DIR% is incomplete; replacing it...
  rmdir /s /q "%NODE_DIR%"
)
if not exist "%NODE_DIR%\node.exe" (
  echo.
  echo [..] Downloading portable Node.js v%NODE_VERSION%...
  curl.exe -fL --progress-bar "https://nodejs.org/dist/v%NODE_VERSION%/SHASUMS256.txt" -o "%CACHE%\SHASUMS256.txt"
  if errorlevel 1 goto :fail
  curl.exe -fL --progress-bar "https://nodejs.org/dist/v%NODE_VERSION%/%NODE_ARCHIVE%" -o "%CACHE%\%NODE_ARCHIVE%"
  if errorlevel 1 goto :fail

  set "EXPECTED_HASH="
  for /f "tokens=1" %%H in ('findstr /i /c:" %NODE_ARCHIVE%" "%CACHE%\SHASUMS256.txt"') do set "EXPECTED_HASH=%%H"
  set "ACTUAL_HASH="
  for /f "skip=1 tokens=* delims=" %%H in ('certutil -hashfile "%CACHE%\%NODE_ARCHIVE%" SHA256') do if not defined ACTUAL_HASH set "ACTUAL_HASH=%%H"
  set "ACTUAL_HASH=!ACTUAL_HASH: =!"
  if not defined EXPECTED_HASH (
    echo [X] Node.js checksum entry was not found.
    goto :fail
  )
  if /i not "!ACTUAL_HASH!"=="!EXPECTED_HASH!" (
    echo [X] Node.js archive checksum mismatch.
    goto :fail
  )
  REM Extract into a scratch directory and move the finished tree into place,
  REM so an interrupted extraction never leaves a partial %NODE_DIR% behind.
  set "NODE_EXTRACT=%CACHE%\node-extract-%RANDOM%%RANDOM%"
  if exist "!NODE_EXTRACT!" rmdir /s /q "!NODE_EXTRACT!"
  mkdir "!NODE_EXTRACT!"
  tar.exe -xf "%CACHE%\%NODE_ARCHIVE%" -C "!NODE_EXTRACT!"
  if errorlevel 1 goto :fail
  if not exist "!NODE_EXTRACT!\node-v%NODE_VERSION%-%NODE_PLATFORM%\npm.cmd" (
    echo [X] Portable Node.js archive is incomplete.
    goto :fail
  )
  if exist "%NODE_DIR%" rmdir /s /q "%NODE_DIR%"
  move "!NODE_EXTRACT!\node-v%NODE_VERSION%-%NODE_PLATFORM%" "%NODE_DIR%" >nul
  if errorlevel 1 goto :fail
  rmdir /s /q "!NODE_EXTRACT!"
)
if not exist "%NODE_DIR%\node.exe" (
  echo [X] Portable Node.js extraction failed.
  goto :fail
)
if not exist "%NODE_DIR%\npm.cmd" (
  echo [X] Portable Node.js is missing npm.
  goto :fail
)
echo [OK] Portable Node.js verified.

"%NODE_DIR%\node.exe" -e "const fs=require('node:fs');fs.writeFileSync(process.argv[1],JSON.stringify({repositoryUrl:process.argv[2],updateRef:process.argv[3]},null,2)+'\n')" "%BETA_HOME%\update-config.json" "%REPO_URL%" "%UPDATE_REF%"
if errorlevel 1 goto :fail

echo.
echo [..] Installing Electron and the bundled GitHub Copilot CLI...
set "npm_config_cache=%BETA_HOME%\npm-cache"
pushd "%BETA_SOURCE%\beta"
REM --ignore-scripts: a package postinstall must not fetch and execute a native
REM binary during install (ffmpeg-static did). Electron's own download runs
REM explicitly below, exactly as beta/install.sh does.
call "%NODE_DIR%\npm.cmd" ci --ignore-scripts --no-audit --no-fund
if errorlevel 1 goto :fail
echo [..] Installing Electron runtime...
"%NODE_DIR%\node.exe" node_modules\electron\install.js
if errorlevel 1 goto :fail
call "%NODE_DIR%\npm.cmd" run check
if errorlevel 1 goto :fail
set "BRAINSTEM_BETA_RUNTIME_DIR=%BRAINSTEM_HOME%\src\rapp_brainstem"
call "%NODE_DIR%\npm.cmd" test
if errorlevel 1 goto :fail
popd

set "ELECTRON_EXE=%BETA_SOURCE%\beta\node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON_EXE%" (
  echo [X] Electron runtime is missing.
  goto :fail
)

set "LAUNCHER=%BETA_HOME%\launch.cmd"
> "%LAUNCHER%" echo @echo off
>>"%LAUNCHER%" echo set "BRAINSTEM_HOME=%BRAINSTEM_HOME%"
>>"%LAUNCHER%" echo set "BRAINSTEM_BETA_HOME=%BETA_HOME%"
>>"%LAUNCHER%" echo set "BRAINSTEM_BETA_REPO_URL=%REPO_URL%"
>>"%LAUNCHER%" echo set "BRAINSTEM_BETA_UPDATE_REF=%UPDATE_REF%"
>>"%LAUNCHER%" echo start "" "%ELECTRON_EXE%" "%BETA_SOURCE%\beta"

set "SURGEON_LAUNCHER=%BETA_HOME%\brainstem-surgeon.cmd"
> "%SURGEON_LAUNCHER%" echo @echo off
>>"%SURGEON_LAUNCHER%" echo set "BRAINSTEM_HOME=%BRAINSTEM_HOME%"
>>"%SURGEON_LAUNCHER%" echo set "BRAINSTEM_BETA_HOME=%BETA_HOME%"
>>"%SURGEON_LAUNCHER%" echo set "BRAINSTEM_BETA_LAUNCHER=%LAUNCHER%"
>>"%SURGEON_LAUNCHER%" echo "%NODE_DIR%\node.exe" "%BETA_SOURCE%\beta\scripts\surgeon-chat.mjs" %%*
set "USER_BIN=%USERPROFILE%\.local\bin"
if not exist "%USER_BIN%" mkdir "%USER_BIN%"
copy /y "%LAUNCHER%" "%USER_BIN%\brainstem-frontier.cmd" >nul
copy /y "%LAUNCHER%" "%USER_BIN%\brainstem-beta.cmd" >nul
if exist "%LOCALAPPDATA%\Microsoft\WindowsApps" copy /y "%LAUNCHER%" "%LOCALAPPDATA%\Microsoft\WindowsApps\brainstem-frontier.cmd" >nul
if exist "%LOCALAPPDATA%\Microsoft\WindowsApps" copy /y "%LAUNCHER%" "%LOCALAPPDATA%\Microsoft\WindowsApps\brainstem-beta.cmd" >nul
copy /y "%SURGEON_LAUNCHER%" "%USER_BIN%\brainstem-surgeon.cmd" >nul
if exist "%LOCALAPPDATA%\Microsoft\WindowsApps" copy /y "%SURGEON_LAUNCHER%" "%LOCALAPPDATA%\Microsoft\WindowsApps\brainstem-surgeon.cmd" >nul

set "CHAT_LAUNCHER=%BETA_HOME%\brainstem-chat.cmd"
> "%CHAT_LAUNCHER%" echo @echo off
>>"%CHAT_LAUNCHER%" echo set "BRAINSTEM_HOME=%BRAINSTEM_HOME%"
>>"%CHAT_LAUNCHER%" echo set "BRAINSTEM_BETA_HOME=%BETA_HOME%"
>>"%CHAT_LAUNCHER%" echo set "BRAINSTEM_BETA_LAUNCHER=%LAUNCHER%"
>>"%CHAT_LAUNCHER%" echo "%NODE_DIR%\node.exe" "%BETA_SOURCE%\beta\scripts\brainstem-chat.mjs" %%*
copy /y "%CHAT_LAUNCHER%" "%USER_BIN%\brainstem-chat.cmd" >nul
if exist "%LOCALAPPDATA%\Microsoft\WindowsApps" copy /y "%CHAT_LAUNCHER%" "%LOCALAPPDATA%\Microsoft\WindowsApps\brainstem-chat.cmd" >nul

set "WALKTHROUGH_LAUNCHER=%BETA_HOME%\brainstem-walkthrough.cmd"
> "%WALKTHROUGH_LAUNCHER%" echo @echo off
>>"%WALKTHROUGH_LAUNCHER%" echo set "BRAINSTEM_HOME=%BRAINSTEM_HOME%"
>>"%WALKTHROUGH_LAUNCHER%" echo set "BRAINSTEM_BETA_HOME=%BETA_HOME%"
>>"%WALKTHROUGH_LAUNCHER%" echo set "BRAINSTEM_BETA_LAUNCHER=%LAUNCHER%"
>>"%WALKTHROUGH_LAUNCHER%" echo "%NODE_DIR%\node.exe" "%BETA_SOURCE%\beta\scripts\walkthrough-via-chat.mjs" %%*
copy /y "%WALKTHROUGH_LAUNCHER%" "%USER_BIN%\brainstem-walkthrough.cmd" >nul
if exist "%LOCALAPPDATA%\Microsoft\WindowsApps" copy /y "%WALKTHROUGH_LAUNCHER%" "%LOCALAPPDATA%\Microsoft\WindowsApps\brainstem-walkthrough.cmd" >nul

cscript.exe //nologo "%BETA_SOURCE%\beta\scripts\create-windows-shortcuts.js" "%ELECTRON_EXE%" "%BETA_SOURCE%\beta"
if errorlevel 1 goto :fail

echo.
echo [OK] RAPP Brainstem Frontier is installed.
echo      Frontier and standard Brainstem share: %BRAINSTEM_HOME%
echo      Start later with: brainstem-frontier
echo      Use the RAPP Brainstem Frontier desktop or Start Menu shortcut.
echo.
if not "%BRAINSTEM_BETA_NO_LAUNCH%"=="1" start "" "%ELECTRON_EXE%" "%BETA_SOURCE%\beta"
exit /b 0

:cleanup_actual_commit
if defined ACTUAL_COMMIT_FILE del "%ACTUAL_COMMIT_FILE%" >nul 2>nul
set "ACTUAL_COMMIT_FILE="
goto :fail

:fail
echo.
echo [X] RAPP Brainstem Frontier installation failed.
echo     Review the error above and re-run this installer.
exit /b 1
