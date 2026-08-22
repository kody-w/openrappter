@echo off
setlocal EnableExtensions EnableDelayedExpansion
title OpenRappter Installer

if not defined OPENRAPPTER_HOME set "OPENRAPPTER_HOME=%USERPROFILE%\.openrappter"
set "BRAINSTEM_HOME=%OPENRAPPTER_HOME%\brainstem"
if defined OPENRAPPTER_BRAINSTEM_HOME set "BRAINSTEM_HOME=%OPENRAPPTER_BRAINSTEM_HOME%"
set "BETA_HOME=%OPENRAPPTER_HOME%\desktop"
if defined BRAINSTEM_BETA_HOME set "BETA_HOME=%BRAINSTEM_BETA_HOME%"
set "BETA_SOURCE=%BETA_HOME%\src"

powershell.exe -NoProfile -Command "$ErrorActionPreference='Stop'; function N([string]$p) { $full=[IO.Path]::GetFullPath($p).TrimEnd([IO.Path]::DirectorySeparatorChar); $root=[IO.Path]::GetPathRoot($full); $cursor=$root; foreach($part in $full.Substring($root.Length).Split([IO.Path]::DirectorySeparatorChar,[StringSplitOptions]::RemoveEmptyEntries)) { $cursor=[IO.Path]::Combine($cursor,$part); if(Test-Path -LiteralPath $cursor) { $item=Get-Item -Force -LiteralPath $cursor; if(-not $item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'unsafe path component' } } else { break } }; return $full }; function W([string]$child,[string]$parent) { return $child.Equals($parent,[StringComparison]::OrdinalIgnoreCase) -or $child.StartsWith($parent+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) }; function O([string]$a,[string]$b) { return (W $a $b) -or (W $b $a) }; $open=N $env:OPENRAPPTER_HOME; $brain=N $env:BRAINSTEM_HOME; $beta=N $env:BETA_HOME; $bare=N ([IO.Path]::Combine($env:USERPROFILE,'.brainstem')); if((O $open $bare) -or (O $brain $bare) -or (O $beta $bare) -or $brain.Equals($open,[StringComparison]::OrdinalIgnoreCase) -or -not (W $brain $open) -or $beta.Equals($open,[StringComparison]::OrdinalIgnoreCase) -or -not (W $beta $open) -or (O $brain $beta)) { exit 42 }"
if errorlevel 1 (
  echo [X] Refusing species driftback: OpenRappter paths must be canonical, non-reparse children of its own home.
  exit /b 1
)
if "%BRAINSTEM_BETA_VALIDATE_PATHS_ONLY%"=="1" exit /b 0
set "REPO_URL=https://github.com/kody-w/openrappter.git"
set "REPO_REF=main"
set "REPO_COMMIT="
set "RELEASE_TAG="
set "RUNTIME_VERSION_URL="
set "PRESERVE_RUNTIME=0"
set "RUNTIME_COMMIT="
set "NODE_VERSION=24.19.0"
set "FRONTIER_VERSION=0.1.0-beta.9"
set "BOOTSTRAP_URL=https://raw.githubusercontent.com/kody-w/aibast-agents-library/3900fc7e445c87e2ee10c25a1f6a24cd96770253/install.ps1"
set "BOOTSTRAP_SHA256=dc7c997550920a3069c583f23e076f8451087f02b9e8508bc47cf57b6a4d3993"
set "TRANSITION_HELPER_BASE64=aW1wb3J0IHsKICBjaG1vZFN5bmMsCiAgbHN0YXRTeW5jLAogIHJlYWRGaWxlU3luYywKICByZW5hbWVTeW5jLAogIHJtU3luYywKICB3cml0ZUZpbGVTeW5jLAp9IGZyb20gIm5vZGU6ZnMiOwppbXBvcnQgcGF0aCBmcm9tICJub2RlOnBhdGgiOwoKY29uc3QgQ09NTUlUX1BBVFRFUk4gPSAvXlswLTlhLWZdezQwfSQvaTsKY29uc3QgVkVSU0lPTl9QQVRURVJOID0gL15bMC05QS1aYS16Ll8tXSskLzsKY29uc3QgW3JlcXVlc3RQYXRoLCByb2xsYmFja1BhdGgsIHRhcmdldEluc3RhbGxlcl0gPSBwcm9jZXNzLmFyZ3Yuc2xpY2UoMik7CgpmdW5jdGlvbiByZXF1aXJlUmVndWxhckZpbGUoZmlsZSwgbGFiZWwpIHsKICBjb25zdCBzdGF0ID0gbHN0YXRTeW5jKGZpbGUpOwogIGlmICghc3RhdC5pc0ZpbGUoKSB8fCBzdGF0LmlzU3ltYm9saWNMaW5rKCkpIHsKICAgIHRocm93IG5ldyBFcnJvcihgJHtsYWJlbH0gbXVzdCBiZSBhIHJlZ3VsYXIgZmlsZS5gKTsKICB9Cn0KCmZ1bmN0aW9uIHNoZWxsUXVvdGUodmFsdWUpIHsKICByZXR1cm4gYCcke1N0cmluZyh2YWx1ZSkucmVwbGFjZUFsbCgiJyIsICInXFwnJyIpfSdgOwp9CgpmdW5jdGlvbiBwb3dlcnNoZWxsUXVvdGUodmFsdWUpIHsKICByZXR1cm4gYCcke1N0cmluZyh2YWx1ZSkucmVwbGFjZUFsbCgiJyIsICInJyIpfSdgOwp9Cgpmb3IgKGNvbnN0IFt2YWx1ZSwgbGFiZWxdIG9mIFsKICBbcmVxdWVzdFBhdGgsICJ1cGRhdGUgcmVxdWVzdCJdLAogIFtyb2xsYmFja1BhdGgsICJyb2xsYmFjayBpbnN0YWxsZXIiXSwKICBbdGFyZ2V0SW5zdGFsbGVyLCAidGFyZ2V0IGluc3RhbGxlciJdLApdKSB7CiAgaWYgKCF2YWx1ZSB8fCAhcGF0aC5pc0Fic29sdXRlKHZhbHVlKSkgewogICAgdGhyb3cgbmV3IEVycm9yKGAke2xhYmVsfSBwYXRoIG11c3QgYmUgYWJzb2x1dGUuYCk7CiAgfQp9CnJlcXVpcmVSZWd1bGFyRmlsZShyZXF1ZXN0UGF0aCwgIlVwZGF0ZSByZXF1ZXN0Iik7CnJlcXVpcmVSZWd1bGFyRmlsZShyb2xsYmFja1BhdGgsICJSb2xsYmFjayBpbnN0YWxsZXIiKTsKcmVxdWlyZVJlZ3VsYXJGaWxlKHRhcmdldEluc3RhbGxlciwgIlRhcmdldCBpbnN0YWxsZXIiKTsKCmNvbnN0IHJlcXVlc3QgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhyZXF1ZXN0UGF0aCwgInV0ZjgiKSk7CmlmICh0eXBlb2YgcmVxdWVzdC5yZWxlYXNlVGFnID09PSAic3RyaW5nIiAmJiByZXF1ZXN0LnJlbGVhc2VUYWcpIHsKICBwcm9jZXNzLmV4aXQoMCk7Cn0KZm9yIChjb25zdCBrZXkgb2YgWwogICJicmFpbnN0ZW1FeHBlY3RlZEhlYWQiLAogICJicmFpbnN0ZW1SZXBvUm9vdCIsCiAgImN1cnJlbnRWZXJzaW9uIiwKICAiZ2l0RXhlY3V0YWJsZSIsCiAgInJlbW90ZVVybCIsCiAgInJvbGxiYWNrQ29tbWl0IiwKXSkgewogIGlmICh0eXBlb2YgcmVxdWVzdFtrZXldICE9PSAic3RyaW5nIiB8fCAhcmVxdWVzdFtrZXldKSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoYExlZ2FjeSB1cGRhdGUgcmVxdWVzdCBpcyBtaXNzaW5nICR7a2V5fS5gKTsKICB9Cn0KaWYgKAogICFDT01NSVRfUEFUVEVSTi50ZXN0KHJlcXVlc3QuYnJhaW5zdGVtRXhwZWN0ZWRIZWFkKQogIHx8ICFDT01NSVRfUEFUVEVSTi50ZXN0KHJlcXVlc3Qucm9sbGJhY2tDb21taXQpCikgewogIHRocm93IG5ldyBFcnJvcigiTGVnYWN5IHVwZGF0ZSByZXF1ZXN0IGhhcyBhbiBpbnZhbGlkIGNvbW1pdC4iKTsKfQppZiAoIVZFUlNJT05fUEFUVEVSTi50ZXN0KHJlcXVlc3QuY3VycmVudFZlcnNpb24pKSB7CiAgdGhyb3cgbmV3IEVycm9yKCJMZWdhY3kgdXBkYXRlIHJlcXVlc3QgaGFzIGFuIGludmFsaWQgY3VycmVudCB2ZXJzaW9uLiIpOwp9CmNvbnN0IHJlbW90ZSA9IG5ldyBVUkwocmVxdWVzdC5yZW1vdGVVcmwpOwpjb25zdCBtYXRjaCA9IHJlbW90ZS5ocmVmLm1hdGNoKAogIC9eaHR0cHM6XC9cL2dpdGh1YlwuY29tXC8oW0EtWmEtejAtOV8uLV0rKVwvKFtBLVphLXowLTlfLi1dKz8pKD86XC5naXQpP1wvPyQvLAopOwppZiAoIW1hdGNoKSB7CiAgdGhyb3cgbmV3IEVycm9yKCJMZWdhY3kgdXBkYXRlIHJlcXVlc3QgaGFzIGFuIHVuc3VwcG9ydGVkIHJlcG9zaXRvcnkgVVJMLiIpOwp9Cgpjb25zdCBydW50aW1lVmVyc2lvblVybCA9IFsKICAiaHR0cHM6Ly9yYXcuZ2l0aHVidXNlcmNvbnRlbnQuY29tIiwKICBtYXRjaFsxXSwKICBtYXRjaFsyXSwKICByZXF1ZXN0LmJyYWluc3RlbUV4cGVjdGVkSGVhZCwKICAicmFwcF9icmFpbnN0ZW0vVkVSU0lPTiIsCl0uam9pbigiLyIpOwpjb25zdCBwb3NpeFNjcmlwdCA9IGAjIS9iaW4vYmFzaApzZXQgLWV1byBwaXBlZmFpbApleHBvcnQgQlJBSU5TVEVNX0JFVEFfVFJBTlNJVElPTl9ST0xMQkFDSz0xCmV4cG9ydCBCUkFJTlNURU1fQkVUQV9SRUxFQVNFX1RBRz0ke3NoZWxsUXVvdGUoYGJyYWluc3RlbS1iZXRhLXYke3JlcXVlc3QuY3VycmVudFZlcnNpb259YCl9CmV4cG9ydCBCUkFJTlNURU1fQkVUQV9SVU5USU1FX1ZFUlNJT05fVVJMPSR7c2hlbGxRdW90ZShydW50aW1lVmVyc2lvblVybCl9CmV4cG9ydCBCUkFJTlNURU1fQkVUQV9QUkVTRVJWRV9SVU5USU1FPTEKZXhwb3J0IEJSQUlOU1RFTV9CRVRBX1JVTlRJTUVfQ09NTUlUPSR7c2hlbGxRdW90ZShyZXF1ZXN0LmJyYWluc3RlbUV4cGVjdGVkSGVhZCl9CnVuc2V0IEJSQUlOU1RFTV9CRVRBX0JPT1RTVFJBUF9VUkwgQlJBSU5TVEVNX0JFVEFfQk9PVFNUUkFQX1NIQTI1Ngoke3NoZWxsUXVvdGUocmVxdWVzdC5naXRFeGVjdXRhYmxlKX0gLUMgJHtzaGVsbFF1b3RlKHJlcXVlc3QuYnJhaW5zdGVtUmVwb1Jvb3QpfSBjaGVja291dCAtLWRldGFjaCAke3NoZWxsUXVvdGUocmVxdWVzdC5icmFpbnN0ZW1FeHBlY3RlZEhlYWQpfQpleGVjIC9iaW4vYmFzaCAke3NoZWxsUXVvdGUodGFyZ2V0SW5zdGFsbGVyKX0KYDsKY29uc3QgcG93ZXJzaGVsbFNjcmlwdCA9IGAkRXJyb3JBY3Rpb25QcmVmZXJlbmNlID0gJ1N0b3AnCiRlbnY6QlJBSU5TVEVNX0JFVEFfVFJBTlNJVElPTl9ST0xMQkFDSyA9ICcxJwokZW52OkJSQUlOU1RFTV9CRVRBX1JFTEVBU0VfVEFHID0gJHtwb3dlcnNoZWxsUXVvdGUoYGJyYWluc3RlbS1iZXRhLXYke3JlcXVlc3QuY3VycmVudFZlcnNpb259YCl9CiRlbnY6QlJBSU5TVEVNX0JFVEFfUlVOVElNRV9WRVJTSU9OX1VSTCA9ICR7cG93ZXJzaGVsbFF1b3RlKHJ1bnRpbWVWZXJzaW9uVXJsKX0KJGVudjpCUkFJTlNURU1fQkVUQV9QUkVTRVJWRV9SVU5USU1FID0gJzEnCiRlbnY6QlJBSU5TVEVNX0JFVEFfUlVOVElNRV9DT01NSVQgPSAke3Bvd2Vyc2hlbGxRdW90ZShyZXF1ZXN0LmJyYWluc3RlbUV4cGVjdGVkSGVhZCl9ClJlbW92ZS1JdGVtIEVudjpCUkFJTlNURU1fQkVUQV9CT09UU1RSQVBfVVJMIC1FcnJvckFjdGlvbiBTaWxlbnRseUNvbnRpbnVlClJlbW92ZS1JdGVtIEVudjpCUkFJTlNURU1fQkVUQV9CT09UU1RSQVBfU0hBMjU2IC1FcnJvckFjdGlvbiBTaWxlbnRseUNvbnRpbnVlCiYgJHtwb3dlcnNoZWxsUXVvdGUocmVxdWVzdC5naXRFeGVjdXRhYmxlKX0gLUMgJHtwb3dlcnNoZWxsUXVvdGUocmVxdWVzdC5icmFpbnN0ZW1SZXBvUm9vdCl9IGNoZWNrb3V0IC0tZGV0YWNoICR7cG93ZXJzaGVsbFF1b3RlKHJlcXVlc3QuYnJhaW5zdGVtRXhwZWN0ZWRIZWFkKX0KaWYgKCRMQVNURVhJVENPREUgLW5lIDApIHsgZXhpdCAkTEFTVEVYSVRDT0RFIH0KJiAke3Bvd2Vyc2hlbGxRdW90ZSh0YXJnZXRJbnN0YWxsZXIpfQpleGl0ICRMQVNURVhJVENPREUKYDsKY29uc3Qgc2NyaXB0ID0gcm9sbGJhY2tQYXRoLnRvTG93ZXJDYXNlKCkuZW5kc1dpdGgoIi5jbWQiKQogID8gYEBlY2hvIG9mZlxyXG5wb3dlcnNoZWxsLmV4ZSAtTm9Qcm9maWxlIC1Ob25JbnRlcmFjdGl2ZSAtRXhlY3V0aW9uUG9saWN5IEJ5cGFzcyAtRW5jb2RlZENvbW1hbmQgJHsKICAgICAgQnVmZmVyLmZyb20ocG93ZXJzaGVsbFNjcmlwdCwgInV0ZjE2bGUiKS50b1N0cmluZygiYmFzZTY0IikKICAgIH1cclxuYAogIDogcG9zaXhTY3JpcHQ7Cgpjb25zdCB0ZW1wb3JhcnlQYXRoID0gYCR7cm9sbGJhY2tQYXRofS4ke3Byb2Nlc3MucGlkfS50bXBgOwp0cnkgewogIHdyaXRlRmlsZVN5bmModGVtcG9yYXJ5UGF0aCwgc2NyaXB0LCB7IGVuY29kaW5nOiAidXRmOCIsIGZsYWc6ICJ3eCIsIG1vZGU6IDBvNzAwIH0pOwogIHJlbmFtZVN5bmModGVtcG9yYXJ5UGF0aCwgcm9sbGJhY2tQYXRoKTsKICBjaG1vZFN5bmMocm9sbGJhY2tQYXRoLCAwbzcwMCk7Cn0gZmluYWxseSB7CiAgcm1TeW5jKHRlbXBvcmFyeVBhdGgsIHsgZm9yY2U6IHRydWUgfSk7Cn0K"

if defined BRAINSTEM_BETA_REPO_URL set "REPO_URL=%BRAINSTEM_BETA_REPO_URL%"
REM The kernel's home, which is not necessarily the Frontier's home. Defaults to
REM REPO_URL so existing forks are unaffected; a downstream that ships only beta/
REM sets this to a repository that actually hosts the kernel.
REM This distribution ships only the Frontier, so the kernel comes from upstream.
set "KERNEL_REPO_URL=https://github.com/microsoft/aibast-agents-library.git"
if defined BRAINSTEM_BETA_KERNEL_REPO_URL set "KERNEL_REPO_URL=%BRAINSTEM_BETA_KERNEL_REPO_URL%"
set "KERNEL_REPO_REF=main"
if defined BRAINSTEM_BETA_KERNEL_REPO_REF set "KERNEL_REPO_REF=%BRAINSTEM_BETA_KERNEL_REPO_REF%"
if defined BRAINSTEM_BETA_REF set "REPO_REF=%BRAINSTEM_BETA_REF%"
set "UPDATE_REF=%REPO_REF%"
if defined BRAINSTEM_BETA_UPDATE_REF set "UPDATE_REF=%BRAINSTEM_BETA_UPDATE_REF%"
if defined BRAINSTEM_BETA_COMMIT set "REPO_COMMIT=%BRAINSTEM_BETA_COMMIT%"
if defined BRAINSTEM_BETA_RELEASE_TAG set "RELEASE_TAG=%BRAINSTEM_BETA_RELEASE_TAG%"
if defined BRAINSTEM_BETA_RUNTIME_VERSION_URL set "RUNTIME_VERSION_URL=%BRAINSTEM_BETA_RUNTIME_VERSION_URL%"
if defined BRAINSTEM_BETA_PRESERVE_RUNTIME set "PRESERVE_RUNTIME=%BRAINSTEM_BETA_PRESERVE_RUNTIME%"
if defined BRAINSTEM_BETA_RUNTIME_COMMIT set "RUNTIME_COMMIT=%BRAINSTEM_BETA_RUNTIME_COMMIT%"
if defined BRAINSTEM_BETA_NODE_VERSION set "NODE_VERSION=%BRAINSTEM_BETA_NODE_VERSION%"
if defined BRAINSTEM_BETA_BOOTSTRAP_URL (
  if defined BRAINSTEM_BETA_BOOTSTRAP_SHA256 (
    set "BOOTSTRAP_URL=%BRAINSTEM_BETA_BOOTSTRAP_URL%"
    set "BOOTSTRAP_SHA256=%BRAINSTEM_BETA_BOOTSTRAP_SHA256%"
  ) else (
    echo Ignoring an unpaired Brainstem bootstrap override; URL and SHA-256 are both required.
  )
) else if defined BRAINSTEM_BETA_BOOTSTRAP_SHA256 (
  echo Ignoring an unpaired Brainstem bootstrap override; URL and SHA-256 are both required.
)
set "BETA_SOURCE=%BETA_HOME%\src"

echo.
echo OpenRappter Launcher
echo OpenRappter is the fully built-out twin; Brainstem is the bare twin
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
  ) else (
    set "RELEASE_TAG=brainstem-beta-v%FRONTIER_VERSION%"
  )
  set "REPO_REF=%REPO_COMMIT%"
)

where curl.exe >nul 2>&1 || (
  echo [X] Windows curl.exe is required.
  exit /b 1
)

if not "%BRAINSTEM_BETA_TRANSITION_ROLLBACK%"=="1" (
  set "UPDATE_INSTALLER_NAME=%~nx0"
  if /i "!UPDATE_INSTALLER_NAME:~0,17!"=="update-installer-" (
    set "TRANSITION_ID=!UPDATE_INSTALLER_NAME:~17!"
    set "TRANSITION_ID=!TRANSITION_ID:.cmd=!"
    set "TRANSITION_REQUEST=%~dp0update-request-!TRANSITION_ID!.json"
    set "TRANSITION_ROLLBACK=%~dp0rollback-installer-!TRANSITION_ID!.cmd"
    if not exist "!TRANSITION_REQUEST!" (
      echo [X] The legacy update transition is missing its request.
      goto :fail
    )
    if not exist "!TRANSITION_ROLLBACK!" (
      echo [X] The legacy update transition is missing its rollback installer.
      goto :fail
    )
    if not defined BRAINSTEM_BETA_NODE_EXE (
      echo [X] The legacy update transition is missing its managed Node runtime.
      goto :fail
    )
    if not exist "!BRAINSTEM_BETA_NODE_EXE!" (
      echo [X] The legacy update transition managed Node runtime is missing.
      goto :fail
    )
    "!BRAINSTEM_BETA_NODE_EXE!" --input-type=module -e "await import('data:text/javascript;base64,'+process.env.TRANSITION_HELPER_BASE64)" dummy "!TRANSITION_REQUEST!" "!TRANSITION_ROLLBACK!" "%~f0"
    if errorlevel 1 (
      echo [X] The legacy update rollback could not be made safe.
      goto :fail
    )
  )
)

if "%PRESERVE_RUNTIME%"=="1" (
  powershell.exe -NoProfile -Command "if ($env:BRAINSTEM_BETA_RUNTIME_COMMIT -notmatch '^[0-9a-fA-F]{40}$') { exit 1 }"
  if errorlevel 1 (
    echo [X] BRAINSTEM_BETA_RUNTIME_COMMIT must be a full 40-character commit SHA.
    exit /b 1
  )
  if not exist "%BRAINSTEM_HOME%\src\rapp_brainstem\brainstem.py" (
    echo [X] The preserved Brainstem runtime is missing.
    goto :fail
  )
  if not exist "%BRAINSTEM_HOME%\venv\Scripts\python.exe" (
    echo [X] The preserved Brainstem Python environment is missing.
    goto :fail
  )
  set "GIT_EXE="
  for /f "delims=" %%G in ('where git.exe 2^>nul') do if not defined GIT_EXE set "GIT_EXE=%%G"
  if not defined GIT_EXE if exist "%ProgramFiles%\Git\cmd\git.exe" set "GIT_EXE=%ProgramFiles%\Git\cmd\git.exe"
  if not defined GIT_EXE (
    echo [X] Git is required to verify the preserved Brainstem runtime.
    goto :fail
  )
  set "RUNTIME_COMMIT_FILE=%TEMP%\rapp-runtime-commit-%RANDOM%-%RANDOM%.txt"
  "!GIT_EXE!" -C "%BRAINSTEM_HOME%\src" rev-parse HEAD > "!RUNTIME_COMMIT_FILE!"
  if errorlevel 1 goto :cleanup_runtime_commit
  set /p "ACTUAL_RUNTIME_COMMIT="<"!RUNTIME_COMMIT_FILE!"
  del "!RUNTIME_COMMIT_FILE!" >nul 2>nul
  set "RUNTIME_COMMIT_FILE="
  if /i not "!ACTUAL_RUNTIME_COMMIT!"=="%RUNTIME_COMMIT%" (
    echo [X] The preserved Brainstem runtime is at !ACTUAL_RUNTIME_COMMIT! instead of %RUNTIME_COMMIT%.
    goto :fail
  )
  echo [OK] Preserved Brainstem runtime at !ACTUAL_RUNTIME_COMMIT!.
  goto :brainstem_ready
)

if not exist "%BETA_HOME%" mkdir "%BETA_HOME%"
set "BOOTSTRAP=%TEMP%\rapp-brainstem-bootstrap-%RANDOM%.ps1"
echo [..] Preparing the shared global Brainstem...
curl.exe -fL --progress-bar "%BOOTSTRAP_URL%" -o "%BOOTSTRAP%"
if errorlevel 1 goto :fail
set "ACTUAL_BOOTSTRAP_HASH="
for /f "skip=1 tokens=* delims=" %%H in ('certutil -hashfile "%BOOTSTRAP%" SHA256') do if not defined ACTUAL_BOOTSTRAP_HASH set "ACTUAL_BOOTSTRAP_HASH=%%H"
set "ACTUAL_BOOTSTRAP_HASH=!ACTUAL_BOOTSTRAP_HASH: =!"
if /i not "!ACTUAL_BOOTSTRAP_HASH!"=="%BOOTSTRAP_SHA256%" (
  echo [X] The pinned Brainstem installer checksum did not match.
  del /q "%BOOTSTRAP%" >nul 2>&1
  goto :fail
)
set "BRAINSTEM_BIN=%OPENRAPPTER_HOME%\kernel-bin"
set "BRAINSTEM_REPO_URL=%KERNEL_REPO_URL%"
set "BRAINSTEM_REPO_REF=%KERNEL_REPO_REF%"
if defined RELEASE_TAG (
  set "BRAINSTEM_REPO_URL=%REPO_URL%"
  set "BRAINSTEM_REPO_REF=%RELEASE_TAG%"
  set "BRAINSTEM_VERSION_URL=%RUNTIME_VERSION_URL%"
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%BOOTSTRAP%" --no-launch
) else (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%BOOTSTRAP%" --no-launch
)
set "BOOTSTRAP_EXIT=%ERRORLEVEL%"
del /q "%BOOTSTRAP%" >nul 2>&1
if not "%BOOTSTRAP_EXIT%"=="0" goto :fail
if not exist "%BRAINSTEM_HOME%\src\rapp_brainstem\brainstem.py" (
  echo [X] The global Brainstem runtime was not installed.
  goto :fail
)
if not exist "%BRAINSTEM_HOME%\venv\Scripts\python.exe" (
  echo [X] The global Brainstem Python environment was not installed.
  goto :fail
)

set "GIT_EXE="
for /f "delims=" %%G in ('where git.exe 2^>nul') do if not defined GIT_EXE set "GIT_EXE=%%G"
if not defined GIT_EXE if exist "%ProgramFiles%\Git\cmd\git.exe" set "GIT_EXE=%ProgramFiles%\Git\cmd\git.exe"
if not defined GIT_EXE (
  echo [X] Git was not available after the Brainstem bootstrap.
  goto :fail
)
if defined REPO_COMMIT (
  set "RUNTIME_COMMIT_FILE=%TEMP%\rapp-runtime-commit-%RANDOM%-%RANDOM%.txt"
  "%GIT_EXE%" -C "%BRAINSTEM_HOME%\src" rev-parse HEAD > "!RUNTIME_COMMIT_FILE!"
  if errorlevel 1 goto :cleanup_runtime_commit
  set /p "RUNTIME_COMMIT="<"!RUNTIME_COMMIT_FILE!"
  del "!RUNTIME_COMMIT_FILE!" >nul 2>nul
  set "RUNTIME_COMMIT_FILE="
  if /i not "!RUNTIME_COMMIT!"=="%REPO_COMMIT%" (
    echo [X] Brainstem runtime resolved to !RUNTIME_COMMIT! instead of %REPO_COMMIT%.
    goto :fail
  )
)

:brainstem_ready
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
REM Put the portable runtime first on PATH. npm.cmd runs the package's own
REM scripts, and `npm test` is `node --test` — where `node` resolves from PATH,
REM not from the npm that invoked it. Without this, a machine with an older
REM system Node installs with the portable runtime and then verifies with the
REM wrong one: node:sqlite is absent before 22.5, so eleven test files fail to
REM load and the install reports failure while the correct runtime sits unused
REM beside it. install.sh has done this since line 247; this is its counterpart.
set "PATH=%NODE_DIR%;%PATH%"

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
>>"%LAUNCHER%" echo set "OPENRAPPTER_HOME=%OPENRAPPTER_HOME%"
>>"%LAUNCHER%" echo set "OPENRAPPTER_BRAINSTEM_HOME=%BRAINSTEM_HOME%"
>>"%LAUNCHER%" echo set "BRAINSTEM_HOME=%BRAINSTEM_HOME%"
>>"%LAUNCHER%" echo set "BRAINSTEM_BETA_HOME=%BETA_HOME%"
>>"%LAUNCHER%" echo set "BRAINSTEM_BETA_REPO_URL=%REPO_URL%"
>>"%LAUNCHER%" echo set "BRAINSTEM_BETA_UPDATE_REF=%UPDATE_REF%"
>>"%LAUNCHER%" echo set "BRAINSTEM_BETA_OWN_PORT=1"
>>"%LAUNCHER%" echo start "" "%ELECTRON_EXE%" "%BETA_SOURCE%\beta"

set "SURGEON_LAUNCHER=%BETA_HOME%\openrappter-surgeon.cmd"
> "%SURGEON_LAUNCHER%" echo @echo off
>>"%SURGEON_LAUNCHER%" echo set "BRAINSTEM_HOME=%BRAINSTEM_HOME%"
>>"%SURGEON_LAUNCHER%" echo set "BRAINSTEM_BETA_HOME=%BETA_HOME%"
>>"%SURGEON_LAUNCHER%" echo set "BRAINSTEM_BETA_LAUNCHER=%LAUNCHER%"
>>"%SURGEON_LAUNCHER%" echo "%NODE_DIR%\node.exe" "%BETA_SOURCE%\beta\scripts\surgeon-chat.mjs" %%*
set "USER_BIN=%USERPROFILE%\.local\bin"
if not exist "%USER_BIN%" mkdir "%USER_BIN%"
copy /y "%LAUNCHER%" "%USER_BIN%\openrappter-app.cmd" >nul
copy /y "%LAUNCHER%" "%USER_BIN%\brainstem-frontier.cmd" >nul
copy /y "%LAUNCHER%" "%USER_BIN%\brainstem-beta.cmd" >nul
if exist "%LOCALAPPDATA%\Microsoft\WindowsApps" copy /y "%LAUNCHER%" "%LOCALAPPDATA%\Microsoft\WindowsApps\openrappter-app.cmd" >nul
if exist "%LOCALAPPDATA%\Microsoft\WindowsApps" copy /y "%LAUNCHER%" "%LOCALAPPDATA%\Microsoft\WindowsApps\brainstem-frontier.cmd" >nul
if exist "%LOCALAPPDATA%\Microsoft\WindowsApps" copy /y "%LAUNCHER%" "%LOCALAPPDATA%\Microsoft\WindowsApps\brainstem-beta.cmd" >nul
copy /y "%SURGEON_LAUNCHER%" "%USER_BIN%\openrappter-surgeon.cmd" >nul
copy /y "%SURGEON_LAUNCHER%" "%USER_BIN%\brainstem-surgeon.cmd" >nul
if exist "%LOCALAPPDATA%\Microsoft\WindowsApps" copy /y "%SURGEON_LAUNCHER%" "%LOCALAPPDATA%\Microsoft\WindowsApps\openrappter-surgeon.cmd" >nul
if exist "%LOCALAPPDATA%\Microsoft\WindowsApps" copy /y "%SURGEON_LAUNCHER%" "%LOCALAPPDATA%\Microsoft\WindowsApps\brainstem-surgeon.cmd" >nul

set "CHAT_LAUNCHER=%BETA_HOME%\openrappter-chat.cmd"
> "%CHAT_LAUNCHER%" echo @echo off
>>"%CHAT_LAUNCHER%" echo set "OPENRAPPTER_HOME=%OPENRAPPTER_HOME%"
>>"%CHAT_LAUNCHER%" echo set "BRAINSTEM_HOME=%BRAINSTEM_HOME%"
>>"%CHAT_LAUNCHER%" echo set "BRAINSTEM_BETA_HOME=%BETA_HOME%"
>>"%CHAT_LAUNCHER%" echo set "BRAINSTEM_BETA_LAUNCHER=%LAUNCHER%"
>>"%CHAT_LAUNCHER%" echo "%NODE_DIR%\node.exe" "%BETA_SOURCE%\beta\scripts\openrappter-chat.mjs" %%*
copy /y "%CHAT_LAUNCHER%" "%USER_BIN%\openrappter-chat.cmd" >nul
if exist "%LOCALAPPDATA%\Microsoft\WindowsApps" copy /y "%CHAT_LAUNCHER%" "%LOCALAPPDATA%\Microsoft\WindowsApps\openrappter-chat.cmd" >nul

set "DRIVE_LAUNCHER=%BETA_HOME%\openrappter-drive.cmd"
> "%DRIVE_LAUNCHER%" echo @echo off
>>"%DRIVE_LAUNCHER%" echo set "OPENRAPPTER_HOME=%OPENRAPPTER_HOME%"
>>"%DRIVE_LAUNCHER%" echo set "BRAINSTEM_HOME=%BRAINSTEM_HOME%"
>>"%DRIVE_LAUNCHER%" echo set "BRAINSTEM_BETA_HOME=%BETA_HOME%"
>>"%DRIVE_LAUNCHER%" echo set "BRAINSTEM_BETA_LAUNCHER=%LAUNCHER%"
>>"%DRIVE_LAUNCHER%" echo "%NODE_DIR%\node.exe" "%BETA_SOURCE%\beta\scripts\brainstem-chat.mjs" %%*
copy /y "%DRIVE_LAUNCHER%" "%USER_BIN%\openrappter-drive.cmd" >nul
copy /y "%DRIVE_LAUNCHER%" "%USER_BIN%\brainstem-chat.cmd" >nul
if exist "%LOCALAPPDATA%\Microsoft\WindowsApps" copy /y "%DRIVE_LAUNCHER%" "%LOCALAPPDATA%\Microsoft\WindowsApps\openrappter-drive.cmd" >nul
if exist "%LOCALAPPDATA%\Microsoft\WindowsApps" copy /y "%DRIVE_LAUNCHER%" "%LOCALAPPDATA%\Microsoft\WindowsApps\brainstem-chat.cmd" >nul

set "WALKTHROUGH_LAUNCHER=%BETA_HOME%\brainstem-walkthrough.cmd"
> "%WALKTHROUGH_LAUNCHER%" echo @echo off
>>"%WALKTHROUGH_LAUNCHER%" echo set "BRAINSTEM_HOME=%BRAINSTEM_HOME%"
>>"%WALKTHROUGH_LAUNCHER%" echo set "BRAINSTEM_BETA_HOME=%BETA_HOME%"
>>"%WALKTHROUGH_LAUNCHER%" echo set "BRAINSTEM_BETA_LAUNCHER=%LAUNCHER%"
>>"%WALKTHROUGH_LAUNCHER%" echo "%NODE_DIR%\node.exe" "%BETA_SOURCE%\beta\scripts\walkthrough-via-chat.mjs" %%*
copy /y "%WALKTHROUGH_LAUNCHER%" "%USER_BIN%\openrappter-walkthrough.cmd" >nul
copy /y "%WALKTHROUGH_LAUNCHER%" "%USER_BIN%\brainstem-walkthrough.cmd" >nul
if exist "%LOCALAPPDATA%\Microsoft\WindowsApps" copy /y "%WALKTHROUGH_LAUNCHER%" "%LOCALAPPDATA%\Microsoft\WindowsApps\openrappter-walkthrough.cmd" >nul
if exist "%LOCALAPPDATA%\Microsoft\WindowsApps" copy /y "%WALKTHROUGH_LAUNCHER%" "%LOCALAPPDATA%\Microsoft\WindowsApps\brainstem-walkthrough.cmd" >nul

set "TILE_LAUNCHER=%BETA_HOME%\openrappter-tile.cmd"
> "%TILE_LAUNCHER%" echo @echo off
>>"%TILE_LAUNCHER%" echo if not defined BRAINSTEM_HOME set "BRAINSTEM_HOME=%BRAINSTEM_HOME%"
>>"%TILE_LAUNCHER%" echo if not defined BRAINSTEM_BETA_HOME set "BRAINSTEM_BETA_HOME=%BETA_HOME%"
>>"%TILE_LAUNCHER%" echo if not defined BRAINSTEM_BETA_SOURCE_DIR set "BRAINSTEM_BETA_SOURCE_DIR=%BRAINSTEM_RUNTIME_DIR%"
>>"%TILE_LAUNCHER%" echo "%NODE_DIR%\node.exe" "%BETA_SOURCE%\beta\scripts\openrappter-tile.mjs" %%*
copy /y "%TILE_LAUNCHER%" "%USER_BIN%\openrappter-tile.cmd" >nul
if exist "%LOCALAPPDATA%\Microsoft\WindowsApps" copy /y "%TILE_LAUNCHER%" "%LOCALAPPDATA%\Microsoft\WindowsApps\openrappter-tile.cmd" >nul

set "PACK_LAUNCHER=%BETA_HOME%\openrappter-pack.cmd"
> "%PACK_LAUNCHER%" echo @echo off
>>"%PACK_LAUNCHER%" echo if not defined OPENRAPPTER_HOME set "OPENRAPPTER_HOME=%OPENRAPPTER_HOME%"
>>"%PACK_LAUNCHER%" echo if not defined BRAINSTEM_HOME set "BRAINSTEM_HOME=%BRAINSTEM_HOME%"
>>"%PACK_LAUNCHER%" echo if not defined BRAINSTEM_BETA_HOME set "BRAINSTEM_BETA_HOME=%BETA_HOME%"
>>"%PACK_LAUNCHER%" echo "%NODE_DIR%\node.exe" "%BETA_SOURCE%\beta\scripts\rappter-pack.mjs" %%*
copy /y "%PACK_LAUNCHER%" "%USER_BIN%\openrappter-pack.cmd" >nul
if exist "%LOCALAPPDATA%\Microsoft\WindowsApps" copy /y "%PACK_LAUNCHER%" "%LOCALAPPDATA%\Microsoft\WindowsApps\openrappter-pack.cmd" >nul

set "PACK_NODE_LAUNCHER=%BETA_HOME%\openrappter-pack-node.cmd"
> "%PACK_NODE_LAUNCHER%" echo @echo off
>>"%PACK_NODE_LAUNCHER%" echo if not defined OPENRAPPTER_HOME set "OPENRAPPTER_HOME=%OPENRAPPTER_HOME%"
>>"%PACK_NODE_LAUNCHER%" echo if not defined BRAINSTEM_HOME set "BRAINSTEM_HOME=%BRAINSTEM_HOME%"
>>"%PACK_NODE_LAUNCHER%" echo if not defined BRAINSTEM_BETA_HOME set "BRAINSTEM_BETA_HOME=%BETA_HOME%"
>>"%PACK_NODE_LAUNCHER%" echo "%NODE_DIR%\node.exe" "%BETA_SOURCE%\beta\scripts\rappter-pack-node.mjs"
copy /y "%PACK_NODE_LAUNCHER%" "%USER_BIN%\openrappter-pack-node.cmd" >nul
if exist "%LOCALAPPDATA%\Microsoft\WindowsApps" copy /y "%PACK_NODE_LAUNCHER%" "%LOCALAPPDATA%\Microsoft\WindowsApps\openrappter-pack-node.cmd" >nul

set "HATCH_LAUNCHER=%BETA_HOME%\openrappter-hatch.cmd"
> "%HATCH_LAUNCHER%" echo @echo off
>>"%HATCH_LAUNCHER%" echo if not defined OPENRAPPTER_HOME set "OPENRAPPTER_HOME=%OPENRAPPTER_HOME%"
>>"%HATCH_LAUNCHER%" echo if not defined BRAINSTEM_HOME set "BRAINSTEM_HOME=%BRAINSTEM_HOME%"
>>"%HATCH_LAUNCHER%" echo if not defined BRAINSTEM_BETA_SOURCE_DIR set "BRAINSTEM_BETA_SOURCE_DIR=%BRAINSTEM_RUNTIME_DIR%"
>>"%HATCH_LAUNCHER%" echo if not defined BRAINSTEM_BETA_PYTHON set "BRAINSTEM_BETA_PYTHON=%PYTHON_EXE%"
>>"%HATCH_LAUNCHER%" echo if not defined RAPPTER_PACK_CONFIG set "RAPPTER_PACK_CONFIG=%OPENRAPPTER_HOME%\pack.json"
>>"%HATCH_LAUNCHER%" echo "%NODE_DIR%\node.exe" "%BETA_SOURCE%\beta\scripts\openrappter-hatch.mjs" %%*
copy /y "%HATCH_LAUNCHER%" "%USER_BIN%\openrappter-hatch.cmd" >nul
if exist "%LOCALAPPDATA%\Microsoft\WindowsApps" copy /y "%HATCH_LAUNCHER%" "%LOCALAPPDATA%\Microsoft\WindowsApps\openrappter-hatch.cmd" >nul

cscript.exe //nologo "%BETA_SOURCE%\beta\scripts\create-windows-shortcuts.js" "%LAUNCHER%" "%BETA_SOURCE%\beta" "%ELECTRON_EXE%"
if errorlevel 1 goto :fail

echo.
echo [OK] OpenRappter is installed.
echo      Brainstem runtime data: %BRAINSTEM_HOME%
echo      Start later with: openrappter-app
echo      Use the OpenRappter desktop or Start Menu shortcut.
echo.
if not "%BRAINSTEM_BETA_NO_LAUNCH%"=="1" start "" "%ELECTRON_EXE%" "%BETA_SOURCE%\beta"
exit /b 0

:cleanup_runtime_commit
if defined RUNTIME_COMMIT_FILE del "%RUNTIME_COMMIT_FILE%" >nul 2>nul
set "RUNTIME_COMMIT_FILE="
goto :fail

:cleanup_actual_commit
if defined ACTUAL_COMMIT_FILE del "%ACTUAL_COMMIT_FILE%" >nul 2>nul
set "ACTUAL_COMMIT_FILE="
goto :fail

:fail
echo.
echo [X] OpenRappter installation failed.
echo     Review the error above and re-run this installer.
exit /b 1
