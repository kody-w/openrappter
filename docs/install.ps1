#Requires -Version 5.1
<#
.SYNOPSIS
    OpenRappter One-Click Installer for Windows
.DESCRIPTION
    Installs OpenRappter (local-first AI agent framework) on Windows.
    Handles Node.js detection/install, npm global install, Copilot auth,
    gateway brainstem startup, and home directory setup.
.PARAMETER Method
    Install method: "npm" (default) or "git"
.PARAMETER NoPrompt
    Non-interactive mode for CI/automation
.PARAMETER NoCopilot
    Skip Copilot GitHub token setup
.PARAMETER NoOnboard
    Skip the onboard wizard after install
.PARAMETER DryRun
    Show what would happen without making changes
.PARAMETER Verbose
    Enable verbose output
.PARAMETER Version
    Pin a specific npm version (e.g., "1.9.3")
.EXAMPLE
    irm https://kody-w.github.io/openrappter/install.ps1 | iex
.EXAMPLE
    .\install.ps1 -Method npm -NoCopilot
.EXAMPLE
    .\install.ps1 -DryRun
#>
[CmdletBinding()]
param(
    [ValidateSet("npm", "git")]
    [string]$Method = "npm",

    [string]$InstallDir = "",

    [switch]$NoPrompt,
    [switch]$NoCopilot,
    [switch]$NoOnboard,
    [switch]$DryRun,
    [switch]$VerboseOutput,

    [string]$Version = ""
)

# ── Strict mode ──────────────────────────────────────────────────────────────
$ErrorActionPreference = "Stop"

# Helper: run npm commands safely (npm.ps1 wrapper breaks under StrictMode)
function Invoke-Npm {
    param([Parameter(ValueFromRemainingArguments)][string[]]$Args_)
    $npmExe = Join-Path (Split-Path (Get-Command node).Source) "npm.cmd"
    if (-not (Test-Path $npmExe)) { $npmExe = "npm.cmd" }
    & cmd /c $npmExe @Args_ 2>&1
}

# ── Constants ────────────────────────────────────────────────────────────────
# Use ASCII raptor — safe on all Windows terminals (cmd, PowerShell, ConHost, WT)
# Emoji (U+1F996) corrupts on legacy consoles and piped installs (irm | iex)
$EMOJI = ">=>"
$NAME           = "openrappter"
$NPM_PACKAGE    = "openrappter"
$REPO_URL       = "https://github.com/kody-w/openrappter.git"
$MIN_NODE       = 20
$HOME_DIR       = Join-Path $env:USERPROFILE ".openrappter"
$GATEWAY_PID    = Join-Path $HOME_DIR "gateway.pid"
$CLIENT_ID      = "Iv1.b507a08c87ecfe98"
$COPILOT_SCOPE  = "read:user"
$INSTALL_STAGE  = 0
$INSTALL_TOTAL  = 4

# ── Environment variable overrides ──────────────────────────────────────────
if ($env:OPENRAPPTER_INSTALL_METHOD) { $Method  = $env:OPENRAPPTER_INSTALL_METHOD }
if ($env:OPENRAPPTER_VERSION)        { $Version = $env:OPENRAPPTER_VERSION }
if ($env:OPENRAPPTER_HOME)           { $InstallDir = $env:OPENRAPPTER_HOME }
if ($env:OPENRAPPTER_NO_PROMPT -eq "true") { $NoPrompt = $true }
if (-not $InstallDir) { $InstallDir = $HOME_DIR }

# ── Colors ───────────────────────────────────────────────────────────────────
function Write-Accent   { param([string]$Text) Write-Host $Text -ForegroundColor Green }
function Write-Info     { param([string]$Text) Write-Host "  $Text" -ForegroundColor DarkGray }
function Write-Success  { param([string]$Text) Write-Host "  [OK] $Text" -ForegroundColor Cyan }
function Write-Warn     { param([string]$Text) Write-Host "  [!] $Text" -ForegroundColor Yellow }
function Write-Err      { param([string]$Text) Write-Host "  [X] $Text" -ForegroundColor Red }
function Write-Kv       { param([string]$Key, [string]$Val) Write-Host ("  {0,-18} {1}" -f $Key, $Val) -ForegroundColor DarkGray }

function Write-Stage {
    param([string]$Label)
    $script:INSTALL_STAGE++
    Write-Host ""
    Write-Host "  [$script:INSTALL_STAGE/$INSTALL_TOTAL] $Label" -ForegroundColor Green
    Write-Host ("  " + ("-" * 50)) -ForegroundColor DarkGray
}

# ── Taglines ─────────────────────────────────────────────────────────────────
$TAGLINES = @(
    "Your terminal just evolved -- type something and let the raptor handle the busywork."
    "Welcome to the command line: where agents compile and confidence segfaults."
    "Gateway online -- please keep hands, feet, and appendages inside the shell at all times."
    "I speak fluent PowerShell, mild sarcasm, and aggressive tab-completion energy."
    "One CLI to rule them all, and one more restart because you changed the port."
    "Your .env is showing; don't worry, I'll pretend I didn't see it."
    "Type the command with confidence -- nature will provide the stack trace if needed."
    "Hot reload for config, cold sweat for deploys."
    "Automation with claws: minimal fuss, maximal pinch."
    "Your task has been queued; your dignity has been deprecated."
    "AI agents powered by your existing GitHub Copilot subscription."
    "No extra API keys. No new accounts. No additional monthly bills."
    "Your data stays local. Your agents stay loyal."
    "Dual runtime. Single file agents. Zero API keys."
    "Who needs API keys when you have GitHub Copilot?"
    "The raptor has entered the chat. Your workflow will never be the same."
    "Local-first AI that actually remembers things. Revolutionary, we know."
    "npm install -g openrappter -- because you deserve nice things."
    "One command to install, zero commands to regret."
    "Your PATH is about to get a lot more interesting."
    "Build tools? I'll handle those. You just sit there and look productive."
    "I auto-detect your install method. I'm basically psychic, but for shells."
    "Windows native, baby. No WSL required."
    "PowerShell goes brrrr. Your agents go further."
)

function Get-Tagline {
    if ($env:OPENRAPPTER_TAGLINE_INDEX) {
        $idx = [int]$env:OPENRAPPTER_TAGLINE_INDEX % $TAGLINES.Count
        return $TAGLINES[$idx]
    }
    return $TAGLINES[(Get-Random -Maximum $TAGLINES.Count)]
}

# ── Banner ───────────────────────────────────────────────────────────────────
function Show-Banner {
    $tagline = Get-Tagline
    $title = "$EMOJI  OpenRappter Installer for Windows"
    Write-Host ""
    Write-Host ""
    Write-Host "    $title" -ForegroundColor Green
    Write-Host ("    " + ("-" * 44)) -ForegroundColor DarkGray
    Write-Host ""
    Write-Info $tagline
    Write-Host ""
}

# ── Prerequisite checks ─────────────────────────────────────────────────────

function Test-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-NodeVersion {
    try {
        $ver = & node --version 2>$null
        if ($ver -match 'v(\d+)') {
            return [int]$Matches[1]
        }
    } catch {}
    return 0
}

function Install-NodeJs {
    Write-Info "Node.js >= $MIN_NODE required but not found."

    # Try winget first (built into Windows 11 and recent Windows 10)
    $hasWinget = $null -ne (Get-Command winget -ErrorAction SilentlyContinue)
    if ($hasWinget) {
        Write-Info "Installing Node.js via winget..."
        if (-not $DryRun) {
            & winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent 2>$null
            # Refresh PATH so node is available in this session
            $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
            $userPath    = [Environment]::GetEnvironmentVariable("Path", "User")
            $env:Path    = "$machinePath;$userPath"
        }
        $nodeVer = Get-NodeVersion
        if ($nodeVer -ge $MIN_NODE) {
            Write-Success "Node.js v$nodeVer installed via winget"
            return
        }
    }

    # Try chocolatey
    $hasChoco = $null -ne (Get-Command choco -ErrorAction SilentlyContinue)
    if ($hasChoco) {
        Write-Info "Installing Node.js via Chocolatey..."
        if (-not $DryRun) {
            & choco install nodejs-lts -y 2>$null
            $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
            $userPath    = [Environment]::GetEnvironmentVariable("Path", "User")
            $env:Path    = "$machinePath;$userPath"
        }
        $nodeVer = Get-NodeVersion
        if ($nodeVer -ge $MIN_NODE) {
            Write-Success "Node.js v$nodeVer installed via Chocolatey"
            return
        }
    }

    # Manual download fallback
    Write-Err "Could not install Node.js automatically."
    Write-Err "Please install Node.js >= $MIN_NODE from https://nodejs.org and re-run this script."
    throw "Node.js not found"
}

function Test-GitAvailable {
    return $null -ne (Get-Command git -ErrorAction SilentlyContinue)
}

function Install-Git {
    $hasWinget = $null -ne (Get-Command winget -ErrorAction SilentlyContinue)
    if ($hasWinget) {
        Write-Info "Installing Git via winget..."
        if (-not $DryRun) {
            & winget install --id Git.Git --accept-source-agreements --accept-package-agreements --silent 2>$null
            $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
            $userPath    = [Environment]::GetEnvironmentVariable("Path", "User")
            $env:Path    = "$machinePath;$userPath"
        }
        if (Test-GitAvailable) {
            Write-Success "Git installed via winget"
            return
        }
    }

    $hasChoco = $null -ne (Get-Command choco -ErrorAction SilentlyContinue)
    if ($hasChoco) {
        Write-Info "Installing Git via Chocolatey..."
        if (-not $DryRun) {
            & choco install git -y 2>$null
            $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
            $userPath    = [Environment]::GetEnvironmentVariable("Path", "User")
            $env:Path    = "$machinePath;$userPath"
        }
        if (Test-GitAvailable) {
            Write-Success "Git installed via Chocolatey"
            return
        }
    }

    Write-Err "Could not install Git automatically."
    Write-Err "Please install Git from https://git-scm.com and re-run this script."
    throw "Git not found"
}

# ── Existing install detection ───────────────────────────────────────────────

function Get-ExistingInstall {
    # Check npm global
    try {
        $npmList = Invoke-Npm list -g --depth=0 | Select-String "openrappter"
        if ($npmList) { return "npm" }
    } catch {}

    # Check git clone
    $gitDir = Join-Path $InstallDir ".git"
    if (Test-Path $gitDir) { return "git" }

    return "none"
}

# ── npm install ──────────────────────────────────────────────────────────────

function Install-ViaNpm {
    $pkg = $NPM_PACKAGE
    if ($Version) {
        $pkg = "${NPM_PACKAGE}@${Version}"
    } elseif ($env:OPENRAPPTER_BETA -eq "1") {
        $pkg = "${NPM_PACKAGE}@beta"
    }

    Write-Info "Running: npm install -g $pkg"
    if ($DryRun) {
        Write-Info "[dry-run] Would run: npm install -g $pkg"
        return
    }

    # Set SHARP_IGNORE_GLOBAL_LIBVIPS to prevent native module download issues
    $env:SHARP_IGNORE_GLOBAL_LIBVIPS = "1"

    try {
        Invoke-Npm install -g $pkg | ForEach-Object { Write-Info $_ }
        if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
    } catch {
        Write-Warn "npm install failed. Retrying..."
        Invoke-Npm install -g $pkg --no-optional | ForEach-Object { Write-Info $_ }
        if ($LASTEXITCODE -ne 0) {
            throw "npm install failed after retry"
        }
    }

    # Verify
    $bin = Get-Command openrappter -ErrorAction SilentlyContinue
    if ($bin) {
        Write-Success "openrappter installed at: $($bin.Source)"
    } else {
        Write-Warn "openrappter not found on PATH after install. You may need to restart your terminal."
    }
}

# ── git install ──────────────────────────────────────────────────────────────

function Install-ViaGit {
    if (-not (Test-GitAvailable)) {
        Install-Git
    }

    if (Test-Path (Join-Path $InstallDir ".git")) {
        Write-Info "Existing git clone found at $InstallDir -- pulling latest..."
        if (-not $DryRun) {
            Push-Location $InstallDir
            try {
                & git pull --ff-only 2>&1 | ForEach-Object { Write-Info $_ }
            } finally {
                Pop-Location
            }
        }
    } else {
        Write-Info "Cloning $REPO_URL to $InstallDir..."
        if (-not $DryRun) {
            & git clone $REPO_URL $InstallDir 2>&1 | ForEach-Object { Write-Info $_ }
        }
    }

    if ($DryRun) {
        Write-Info "[dry-run] Would build TypeScript package"
        return
    }

    # Build TypeScript
    $tsDir = Join-Path $InstallDir "typescript"
    if (Test-Path $tsDir) {
        Write-Info "Installing dependencies and building..."
        Push-Location $tsDir
        try {
            Invoke-Npm install | ForEach-Object { Write-Info $_ }
            Invoke-Npm run build | ForEach-Object { Write-Info $_ }
        } finally {
            Pop-Location
        }
    }

    # Create launcher script in a PATH-accessible location
    $binDir = Join-Path $env:USERPROFILE ".openrappter" "bin"
    if (-not (Test-Path $binDir)) {
        New-Item -ItemType Directory -Path $binDir -Force | Out-Null
    }

    $launcherPath = Join-Path $binDir "openrappter.cmd"
    $distIndex = Join-Path $tsDir "dist" "index.js"
    @"
@echo off
node "$distIndex" %*
"@ | Set-Content -Path $launcherPath -Encoding ASCII

    # Add bin dir to user PATH if not already there
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath -notlike "*$binDir*") {
        [Environment]::SetEnvironmentVariable("Path", "$userPath;$binDir", "User")
        $env:Path = "$env:Path;$binDir"
        Write-Success "Added $binDir to PATH"
    }

    Write-Success "openrappter built from source at $InstallDir"
}

# ── Copilot device code auth ────────────────────────────────────────────────

function Invoke-CopilotDeviceLogin {
    Write-Info "Requesting GitHub device code..."

    $body = "client_id=$CLIENT_ID&scope=$COPILOT_SCOPE"
    try {
        $response = Invoke-RestMethod -Uri "https://github.com/login/device/code" `
            -Method Post `
            -ContentType "application/x-www-form-urlencoded" `
            -Headers @{ Accept = "application/json" } `
            -Body $body
    } catch {
        Write-Err "Failed to get device code from GitHub: $_"
        return $null
    }

    $userCode        = $response.user_code
    $deviceCode      = $response.device_code
    $verificationUri = $response.verification_uri
    $interval        = if ($response.interval) { $response.interval } else { 5 }
    $expiresIn       = if ($response.expires_in) { $response.expires_in } else { 900 }

    if (-not $userCode -or -not $deviceCode) {
        Write-Err "Failed to parse device code response"
        return $null
    }

    # Display code to user
    Write-Host ""
    Write-Host "  +------------------------------------------+" -ForegroundColor Cyan
    Write-Host "  |                                          |" -ForegroundColor Cyan
    Write-Host ("  |   Enter code:  {0,-26} |" -f $userCode) -ForegroundColor Cyan
    Write-Host ("  |   URL: {0,-33} |" -f $verificationUri) -ForegroundColor Cyan
    Write-Host "  |                                          |" -ForegroundColor Cyan
    Write-Host "  +------------------------------------------+" -ForegroundColor Cyan
    Write-Host ""

    # Try to open browser
    try {
        Start-Process $verificationUri -ErrorAction SilentlyContinue
    } catch {}

    Write-Info "Waiting for GitHub authorization..."

    # Poll for token
    $deadline   = (Get-Date).AddSeconds($expiresIn)
    $waitSecs   = $interval

    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds $waitSecs

        $tokenBody = "client_id=$CLIENT_ID&device_code=$deviceCode&grant_type=urn:ietf:params:oauth:grant-type:device_code"
        try {
            $tokenResponse = Invoke-RestMethod -Uri "https://github.com/login/oauth/access_token" `
                -Method Post `
                -ContentType "application/x-www-form-urlencoded" `
                -Headers @{ Accept = "application/json" } `
                -Body $tokenBody
        } catch {
            continue
        }

        if ($tokenResponse.access_token -and $tokenResponse.access_token -ne "null") {
            return $tokenResponse.access_token
        }

        switch ($tokenResponse.error) {
            "authorization_pending" { <# keep polling #> }
            "slow_down"             { $waitSecs += 2 }
            "access_denied"         { Write-Err "GitHub login was cancelled"; return $null }
            "expired_token"         { Write-Err "Device code expired -- please try again"; return $null }
            default {
                if ($tokenResponse.error) {
                    Write-Err "GitHub device flow error: $($tokenResponse.error)"
                    return $null
                }
            }
        }
    }

    Write-Err "Device code expired -- please try again"
    return $null
}

function Test-CopilotToken {
    param([string]$Token)
    try {
        $response = Invoke-RestMethod -Uri "https://api.github.com/copilot_internal/v2/token" `
            -Headers @{
                Accept        = "application/json"
                Authorization = "Bearer $Token"
            } `
            -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Save-GitHubToken {
    param([string]$Token, [string]$Source)

    $envFile = Join-Path $HOME_DIR ".env"
    if (-not (Test-Path $HOME_DIR)) {
        New-Item -ItemType Directory -Path $HOME_DIR -Force | Out-Null
    }

    # Build new .env content, replacing any old token lines
    $lines = @("# openrappter environment -- managed by installer", "")
    if (Test-Path $envFile) {
        $existing = Get-Content $envFile | Where-Object {
            $_ -notmatch "^(GITHUB_TOKEN|COPILOT_GITHUB_TOKEN)="
        }
        $lines += $existing
    }
    $lines += "COPILOT_GITHUB_TOKEN=`"$Token`""
    $lines += ""

    $lines | Set-Content -Path $envFile -Encoding UTF8
    Write-Success "Copilot token saved ($Source) -> $envFile"
}

function Setup-CopilotSdk {
    if ($NoCopilot) {
        Write-Info "Copilot setup skipped (--NoCopilot)"
        return
    }

    $token = $null
    $source = ""

    # Check env var first
    if ($env:COPILOT_GITHUB_TOKEN) {
        $token = $env:COPILOT_GITHUB_TOKEN
        $source = "COPILOT_GITHUB_TOKEN env"
    }
    # Check existing .env
    elseif (Test-Path (Join-Path $HOME_DIR ".env")) {
        $envContent = Get-Content (Join-Path $HOME_DIR ".env") -ErrorAction SilentlyContinue
        $tokenLine = $envContent | Where-Object { $_ -match "^COPILOT_GITHUB_TOKEN=" } | Select-Object -First 1
        if ($tokenLine) {
            $token = ($tokenLine -replace '^COPILOT_GITHUB_TOKEN="?([^"]*)"?$', '$1')
            $source = "cached .env"
        }
    }
    # Try gh CLI
    if (-not $token) {
        try {
            $ghToken = & gh auth token 2>$null
            if ($ghToken) {
                $token = $ghToken.Trim()
                $source = "gh CLI"
            }
        } catch {}
    }

    # Validate existing token
    if ($token) {
        Write-Info "Validating token ($source)..."
        if (Test-CopilotToken $token) {
            Write-Success "Copilot token valid ($source)"
            Save-GitHubToken -Token $token -Source $source
            return
        }
        Write-Warn "Token from $source is invalid or expired"
        $token = $null
    }

    # Device code flow (interactive only)
    if ($NoPrompt) {
        Write-Warn "No valid token found. Run 'openrappter onboard' to authenticate for Copilot."
        return
    }

    Write-Info "Starting GitHub device code login for Copilot..."
    $newToken = Invoke-CopilotDeviceLogin
    if ($newToken) {
        if (Test-CopilotToken $newToken) {
            Write-Success "Copilot authenticated!"
            Save-GitHubToken -Token $newToken -Source "device code"
            return
        }
        # Token obtained but doesn't validate for Copilot
        Write-Warn "Token obtained but Copilot validation failed. Saving anyway."
        Save-GitHubToken -Token $newToken -Source "device code (unvalidated)"
        return
    }

    Write-Warn "Could not obtain a Copilot token. Run 'openrappter onboard' later to retry."
}

# ── Gateway brainstem management ─────────────────────────────────────────────

function Stop-GatewayIfRunning {
    if (-not (Test-Path $GATEWAY_PID)) { return }

    $pidText = Get-Content $GATEWAY_PID -ErrorAction SilentlyContinue
    if (-not $pidText) { return }

    $pid = [int]$pidText
    try {
        $proc = Get-Process -Id $pid -ErrorAction Stop
        if ($proc.ProcessName -match "node") {
            Write-Info "Stopping existing gateway brainstem (PID $pid)..."
            if (-not $DryRun) {
                Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
                Start-Sleep -Seconds 1
            }
            Write-Success "Gateway stopped"
        }
    } catch {
        # Process not running, clean up stale PID file
        Remove-Item $GATEWAY_PID -Force -ErrorAction SilentlyContinue
    }
}

function Start-GatewayBrainstem {
    Write-Info "Starting gateway brainstem daemon..."
    if ($DryRun) {
        Write-Info "[dry-run] Would start gateway in background"
        return
    }

    $openrappterBin = Get-Command openrappter -ErrorAction SilentlyContinue
    if (-not $openrappterBin) {
        Write-Warn "openrappter not on PATH -- skipping gateway start. Restart your terminal and run: openrappter gateway"
        return
    }

    try {
        # Start gateway in background
        $proc = Start-Process -FilePath "node" `
            -ArgumentList @((Join-Path (Split-Path $openrappterBin.Source) ".." "dist" "index.js"), "gateway") `
            -WindowStyle Hidden `
            -PassThru `
            -ErrorAction Stop

        # Save PID
        if (-not (Test-Path $HOME_DIR)) {
            New-Item -ItemType Directory -Path $HOME_DIR -Force | Out-Null
        }
        $proc.Id | Set-Content -Path $GATEWAY_PID

        Write-Success "Gateway brainstem started (PID $($proc.Id), port 18790)"
    } catch {
        Write-Warn "Could not start gateway: $_"
        Write-Info "Start manually with: openrappter gateway"
    }
}

# ── Doctor ───────────────────────────────────────────────────────────────────

function Invoke-DoctorIfAvailable {
    $bin = Get-Command openrappter -ErrorAction SilentlyContinue
    if (-not $bin) { return }

    try {
        & openrappter doctor --json 2>$null | Out-Null
    } catch {}
}

# ── Install plan display ────────────────────────────────────────────────────

function Show-InstallPlan {
    Write-Host ""
    Write-Host "  Install Plan" -ForegroundColor Green
    Write-Host "  ============" -ForegroundColor DarkGray
    Write-Kv "Method"    $Method
    Write-Kv "Directory" $InstallDir
    Write-Kv "Node.js"   "$(node --version 2>$null)"
    Write-Kv "Platform"  "Windows $([Environment]::OSVersion.Version)"
    Write-Kv "Arch"      $env:PROCESSOR_ARCHITECTURE
    if ($Version)    { Write-Kv "Version" $Version }
    if ($NoCopilot)  { Write-Kv "Copilot" "skipped" }
    if ($DryRun)     { Write-Kv "Mode" "DRY RUN" }
    Write-Host ""
}

# ── Completion messages ──────────────────────────────────────────────────────

$COMPLETION_MESSAGES = @(
    "Ahh nice, I like it here. Got any snacks?"
    "Home sweet home. Don't worry, I won't rearrange the furniture."
    "I'm in. Let's cause some responsible chaos."
    "Installation complete. Your productivity is about to get weird."
    "Settled in. Time to automate your life whether you're ready or not."
    "Finally unpacked. Now point me at your problems."
    "*cracks claws* Alright, what are we building?"
    "The raptor has landed. Your terminal will never be the same."
    "All done! I promise to only judge your code a little bit."
    "Local-first, baby. Your data stays right here."
    "Windows native! No WSL, no fuss, all raptor."
)

$UPGRADE_MESSAGES = @(
    "Leveled up! New agents unlocked. You're welcome."
    "Fresh code, same raptor. Miss me?"
    "Update complete. I learned some new tricks while I was out."
    "Upgraded! Now with 23% more data sloshing."
    "Patched, polished, and ready to execute. Let's go."
    "The raptor has molted. Harder shell, sharper claws."
    "Update done! Check the changelog or just trust me, it's good."
    "New version installed. Old version sends its regards."
    "Version bump! Same chaos energy, fewer crashes (probably)."
)

# ═══════════════════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════════════════

function Main {
    Show-Banner

    $isUpgrade = $false
    $existingMethod = Get-ExistingInstall
    if ($existingMethod -ne "none") {
        $isUpgrade = $true
        Write-Info "Existing install detected: $existingMethod"
    }

    # ── Stage 1: Preparing environment ──
    Write-Stage "Preparing environment"

    Write-Success "Platform: Windows $([Environment]::OSVersion.Version)"
    Write-Success "Architecture: $env:PROCESSOR_ARCHITECTURE"

    # Check Node.js
    $nodeVer = Get-NodeVersion
    if ($nodeVer -ge $MIN_NODE) {
        Write-Success "Node.js v$nodeVer found"
    } else {
        Install-NodeJs
    }

    # Ensure npm is available
    $npmCmd = Get-Command npm -ErrorAction SilentlyContinue
    if (-not $npmCmd) {
        Write-Err "npm not found even though Node.js is installed. Check your PATH."
        throw "npm not found"
    }
    $npmVer = (Invoke-Npm --version | Select-Object -First 1).ToString().Trim()
    Write-Success "npm $npmVer found"

    # Ensure home dir exists
    if (-not (Test-Path $HOME_DIR)) {
        New-Item -ItemType Directory -Path $HOME_DIR -Force | Out-Null
        Write-Success "Created $HOME_DIR"
    }

    # ── Stage 2: Choose install method ──
    Write-Stage "Choosing install method"

    # If upgrading, match existing method unless overridden
    if ($isUpgrade -and -not $env:OPENRAPPTER_INSTALL_METHOD) {
        $Method = $existingMethod
        Write-Info "Matching existing install method: $Method"
    }

    Show-InstallPlan

    if ($DryRun) {
        Write-Success "Dry run complete (no changes made)"
        return
    }

    # ── Stage 3: Install openrappter ──
    Write-Stage "Installing openrappter"

    if ($Method -eq "npm") {
        Install-ViaNpm
    } else {
        Install-ViaGit
    }

    # ── Copilot SDK setup ──
    Setup-CopilotSdk

    # ── Stage 4: Finalizing setup ──
    Write-Stage "Finalizing setup"

    # Gateway management on upgrades
    if ($isUpgrade) {
        Stop-GatewayIfRunning
    }

    # Doctor check on upgrades
    if ($isUpgrade) {
        Invoke-DoctorIfAvailable
    }

    # Verify binary
    $openrappterBin = Get-Command openrappter -ErrorAction SilentlyContinue
    if ($openrappterBin) {
        try {
            & openrappter --status 2>$null | Out-Null
        } catch {}
    }

    # Resolve installed version
    $installedVersion = ""
    try {
        $verOutput = & openrappter --version 2>$null
        if ($verOutput) { $installedVersion = $verOutput.Trim() }
    } catch {}
    if (-not $installedVersion -and (Test-Path (Join-Path $InstallDir "typescript" "package.json"))) {
        try {
            $pkg = Get-Content (Join-Path $InstallDir "typescript" "package.json") | ConvertFrom-Json
            $installedVersion = $pkg.version
        } catch {}
    }

    # ── Success! ──
    Write-Host ""
    if ($installedVersion) {
        Write-Host "  $EMOJI openrappter installed successfully (v$installedVersion)!" -ForegroundColor Cyan
    } else {
        Write-Host "  $EMOJI openrappter installed successfully!" -ForegroundColor Cyan
    }

    if ($isUpgrade) {
        $msg = $UPGRADE_MESSAGES[(Get-Random -Maximum $UPGRADE_MESSAGES.Count)]
    } else {
        $msg = $COMPLETION_MESSAGES[(Get-Random -Maximum $COMPLETION_MESSAGES.Count)]
    }
    Write-Host "  $msg" -ForegroundColor DarkGray
    Write-Host ""

    # ── What's next ──
    Write-Host "  What's next" -ForegroundColor Green
    Write-Host "  ===========" -ForegroundColor DarkGray
    Write-Kv "Setup wizard" "openrappter onboard"
    Write-Kv "Check status" "openrappter --status"
    Write-Kv "List agents"  "openrappter --list-agents"
    Write-Kv "Chat"         'openrappter "hello"'
    Write-Kv "Start gateway" "openrappter gateway"
    if ($Method -eq "git") {
        Write-Kv "Install dir" $InstallDir
        Write-Kv "Update"      "cd $InstallDir && git pull && cd typescript && npm run build"
    } else {
        Write-Kv "Method"      "npm global"
        Write-Kv "Update"      "npm update -g openrappter"
    }
    Write-Host ""

    # Auto-run onboard wizard
    if (-not $NoOnboard -and $openrappterBin) {
        Write-Info "Running setup wizard..."
        Write-Host ""
        try {
            & openrappter onboard
        } catch {
            Write-Info "Setup wizard skipped. Run 'openrappter onboard' to complete setup."
        }
    }

    # Footer
    Write-Host ""
    Write-Host "  Docs:    https://kody-w.github.io/openrappter" -ForegroundColor DarkGray
    Write-Host "  GitHub:  https://github.com/kody-w/openrappter" -ForegroundColor DarkGray
    Write-Host "  Issues:  https://github.com/kody-w/openrappter/issues" -ForegroundColor DarkGray
    Write-Host ""
}

# ── Entry point ──────────────────────────────────────────────────────────────
try {
    Main
} catch {
    Write-Host ""
    Write-Err "Installation failed: $_"
    Write-Host ""
    Write-Info "If this keeps happening, please file an issue:"
    Write-Info "https://github.com/kody-w/openrappter/issues"
    Write-Host ""
    exit 1
}
