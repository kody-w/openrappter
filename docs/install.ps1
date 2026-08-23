#Requires -Version 5.1
<#
.SYNOPSIS
    OpenRappter One-Click Installer for Windows
.DESCRIPTION
    Installs OpenRappter (local-first AI agent framework) on Windows.
    Handles Node.js detection/install, npm global install, Copilot auth,
    gateway brainstem startup, and home directory setup.

    INSTALL (run directly in PowerShell — do NOT wrap in powershell -c):
      irm https://kody-w.github.io/openrappter/install.ps1 | iex

    If execution policy blocks it:
      Set-ExecutionPolicy Bypass -Scope Process -Force; irm https://kody-w.github.io/openrappter/install.ps1 | iex

    From Command Prompt (cmd.exe):
      powershell -ExecutionPolicy Bypass -NoProfile -Command "iex (irm 'https://kody-w.github.io/openrappter/install.ps1')"

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

    [string]$Version = "",
    [ValidateSet("canary", "nightly", "alpha", "beta", "stable")]
    [string]$Channel = "",
    [ValidateSet("canary", "nightly", "alpha", "beta", "stable")]
    [string]$Ring = "",
    [switch]$AllowDowngrade
)

# ── Strict mode ──────────────────────────────────────────────────────────────
$ErrorActionPreference = "Stop"
$METHOD_WAS_BOUND = $PSBoundParameters.ContainsKey("Method")
$VERSION_WAS_BOUND = $PSBoundParameters.ContainsKey("Version")

# Helper: run npm commands safely (npm.ps1 wrapper breaks under StrictMode)
function Invoke-Npm {
    param([Parameter(ValueFromRemainingArguments)][string[]]$Args_)
    $npmExe = Join-Path (Split-Path (Get-Command node).Source) "npm.cmd"
    if (-not (Test-Path $npmExe)) { $npmExe = "npm.cmd" }
    # Merge stderr and filter out ErrorRecords so warnings don't become exceptions
    $output = & cmd /c $npmExe @Args_ 2>&1
    foreach ($line in $output) {
        if ($line -is [System.Management.Automation.ErrorRecord]) {
            # Emit as plain string (npm warnings are not fatal)
            $line.ToString()
        } else {
            $line
        }
    }
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
$RING_FILE      = Join-Path $HOME_DIR "ring"
$GATEWAY_PID    = Join-Path $HOME_DIR "gateway.pid"
# The port the readiness probe knocks on. It must be the port the gateway
# actually binds, so it follows the CLI's own precedence: OPENRAPPTER_PORT, then
# the alpha's default. Probing a port the gateway never bound would report a
# failure for a healthy daemon, which is the same lie as reporting success for a
# dead one, only inverted.
$GATEWAY_PORT   = if ($env:OPENRAPPTER_PORT) { [int]$env:OPENRAPPTER_PORT } else { 18790 }
$CLIENT_ID      = "Iv1.b507a08c87ecfe98"
$COPILOT_SCOPE  = "read:user"
$INSTALL_STAGE  = 0
$INSTALL_TOTAL  = 4

# ── Environment variable overrides ──────────────────────────────────────────
if (-not $METHOD_WAS_BOUND -and $env:OPENRAPPTER_INSTALL_METHOD) {
    $Method = $env:OPENRAPPTER_INSTALL_METHOD
}
if (-not $VERSION_WAS_BOUND -and $env:OPENRAPPTER_VERSION) {
    $Version = $env:OPENRAPPTER_VERSION
}
if (-not $Ring -and $Channel) { $Ring = $Channel }
if (-not $Ring -and $env:OPENRAPPTER_RING) { $Ring = $env:OPENRAPPTER_RING }
if (-not $Ring -and $env:OPENRAPPTER_CHANNEL) { $Ring = $env:OPENRAPPTER_CHANNEL }
# OPENRAPPTER_BETA predates rings and resolved a dist-tag nothing published,
# so it silently failed. Keep it working as an alias for the beta ring.
if (-not $Ring -and $env:OPENRAPPTER_BETA -eq "1") { $Ring = "beta" }
if ($env:OPENRAPPTER_ALLOW_DOWNGRADE -eq "true") { $AllowDowngrade = $true }
if (-not $Ring -and (Test-Path $RING_FILE)) {
    $savedRing = (Get-Content $RING_FILE -Raw).Trim()
    if ($savedRing -notin @("stable", "beta", "canary", "alpha", "nightly")) {
        throw "Persisted release ring is invalid: $savedRing"
    }
    $Ring = $savedRing
}
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

# Ring repositories are an allowlist. A manifest fetched through its current
# pointer is accepted only after its exact source, artifact host, version,
# timestamp and SHA-256 are validated.
function Get-RingRepository {
    param([string]$Ring)
    switch ($Ring) {
        "stable"  { return "kody-w/openrappter" }
        "beta"    { return "kody-w/openrappter-beta" }
        "canary"  { return "kody-w/openrappter-canary" }
        "alpha"   { return "kody-w/openrappter-alpha" }
        "nightly" { return "kody-w/openrappter-nightly" }
        default   { throw "Unknown release ring: $Ring" }
    }
}

function Get-CanonicalJsonHash {
    param([Parameter(Mandatory)]$Value)
    New-Item -ItemType Directory -Path $HOME_DIR -Force | Out-Null
    $file = Join-Path $HOME_DIR ".ring-hash-$PID.json"
    try {
        $Value | ConvertTo-Json -Depth 100 | Set-Content -Path $file -Encoding utf8NoBOM
        $script = @'
const fs=require("node:fs"),crypto=require("node:crypto");
const canon=v=>Array.isArray(v)?v.map(canon):v&&typeof v==="object"?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canon(v[k])])):v;
process.stdout.write(crypto.createHash("sha256").update(JSON.stringify(canon(JSON.parse(fs.readFileSync(process.argv[1],"utf8"))))).digest("hex"));
'@
        return (& node -e $script $file).Trim()
    } finally {
        Remove-Item $file -Force -ErrorAction SilentlyContinue
    }
}

function Resolve-RingManifest {
    param([string]$SelectedRing)
    if (-not $SelectedRing) { $SelectedRing = "stable" }
    $repo = Get-RingRepository $SelectedRing
    $authorityRef = if ($env:OPENRAPPTER_AUTHORITY_REF) { $env:OPENRAPPTER_AUTHORITY_REF } else { "main" }
    if ($authorityRef -ne "main" -and $authorityRef -notmatch "^[0-9a-f]{40}$") {
        throw "OPENRAPPTER_AUTHORITY_REF must be main or immutable 40-hex"
    }
    try {
        $head = Invoke-RestMethod -Uri "https://raw.githubusercontent.com/kody-w/openrappter-release-train/$authorityRef/heads/$SelectedRing.json"
    } catch { throw "Could not reach $SelectedRing authority head" }
    $headKeys = @($head.PSObject.Properties.Name | Sort-Object) -join ","
    if ($headKeys -ne "authority_commit,promotion_id,receipt_path,receipt_sha256,ring,schema,sequence,target_manifest_commit,target_manifest_sha256,target_repository" -or
        $head.schema -ne "openrappter-ring-head/v1" -or $head.ring -ne $SelectedRing -or
        $head.sequence -lt 1 -or $head.target_repository -ne $repo -or
        $head.authority_commit -notmatch "^[0-9a-f]{40}$" -or
        $head.target_manifest_commit -notmatch "^[0-9a-f]{40}$" -or
        $head.promotion_id -notmatch "^[0-9a-f]{64}$" -or
        $head.receipt_sha256 -notmatch "^[0-9a-f]{64}$" -or
        $head.target_manifest_sha256 -notmatch "^[0-9a-f]{64}$" -or
        $head.receipt_path -ne "receipts/$SelectedRing/$($head.promotion_id).json") {
        throw "Authority head rejected"
    }
    try {
        $receipt = Invoke-RestMethod -Uri "https://raw.githubusercontent.com/kody-w/openrappter-release-train/$($head.authority_commit)/$($head.receipt_path)"
        $m = Invoke-RestMethod -Uri "https://raw.githubusercontent.com/$repo/$($head.target_manifest_commit)/.ring/manifest.json"
    } catch { throw "Immutable authority receipt or target manifest unreachable" }

    $top = @($m.PSObject.Properties.Name | Sort-Object) -join ","
    $source = @($m.source.PSObject.Properties.Name | Sort-Object) -join ","
    $artifact = @($m.artifact.PSObject.Properties.Name | Sort-Object) -join ","
    if ($top -ne "artifact,predecessor,promoted_at,promotion_id,reason,receipt,ring,schema,source,status,version") { throw "Ring manifest is not closed" }
    if ($source -ne "commit,repository,tag" -or $artifact -ne "install_url,provenance,sha256,url") { throw "Ring manifest children are not closed" }
    if ($m.schema -ne "openrappter-ring/v1" -or $m.ring -ne $SelectedRing) { throw "Wrong manifest schema or ring" }
    if ($m.source.repository -ne "kody-w/openrappter" -or $m.source.commit -notmatch "^[0-9a-f]{40}$") { throw "Unauthorized source identity" }
    if ($m.version -notmatch "^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$") { throw "Malformed exact version" }
    if ($m.artifact.sha256 -notmatch "^[0-9a-f]{64}$") { throw "Malformed artifact SHA-256" }
    if ($m.promotion_id -notmatch "^[0-9a-f]{64}$") { throw "Missing authority promotion id" }
    foreach ($value in @($m.artifact.url, $m.artifact.install_url)) {
        if (-not $value) { continue }
        $parsed = [Uri]$value
        if ($parsed.Scheme -ne "https" -or $parsed.Host -notin @("github.com", "registry.npmjs.org", "raw.githubusercontent.com")) { throw "Unauthorized artifact URL" }
    }
    if ([DateTimeOffset]$m.promoted_at -gt [DateTimeOffset]::UtcNow.AddMinutes(5)) { throw "Future ring manifest" }
    if ($m.status -ne "published") { throw "$SelectedRing is $($m.status): $($m.reason)" }
    if (-not $m.artifact.install_url) { throw "Published manifest has no install URL" }
    $npmUrl = "https://registry.npmjs.org/openrappter/-/openrappter-$($m.version).tgz"
    $releasePrefix = if ($m.source.tag) { "https://github.com/kody-w/openrappter/releases/download/$($m.source.tag)/" } else { "" }
    $npmBound = $m.artifact.provenance -eq "npm-registry-download-sha256" -and $m.artifact.url -eq $npmUrl -and $m.artifact.install_url -eq $npmUrl
    $releaseBound = $m.artifact.provenance -eq "github-release-download-sha256" -and $releasePrefix -and $m.artifact.url.StartsWith($releasePrefix) -and $m.artifact.install_url -eq $m.artifact.url
    $candidatePattern = "^https://raw\.githubusercontent\.com/kody-w/openrappter/[0-9a-f]{40}/candidates/$($m.source.commit)/$($m.artifact.sha256)\.tar\.gz$"
    $candidateBound = $m.artifact.provenance -eq "github-candidate-bundle-sha256" -and $m.artifact.url -match $candidatePattern -and $m.artifact.install_url -eq $m.artifact.url
    if (-not $npmBound -and -not $releaseBound -and -not $candidateBound) { throw "Artifact is not bound to canonical package/version" }

    if ((Get-CanonicalJsonHash $receipt) -ne $head.receipt_sha256 -or
        (Get-CanonicalJsonHash $m) -ne $head.target_manifest_sha256 -or
        $receipt.schema -ne "openrappter-promotion-receipt/v1" -or
        $receipt.target_repository -ne $repo -or $receipt.target_ring -ne $SelectedRing -or
        $receipt.promotion_id -ne $head.promotion_id -or $m.promotion_id -ne $head.promotion_id -or
        $receipt.target_manifest_commit -ne $head.target_manifest_commit -or
        $receipt.target_manifest_sha256 -ne $head.target_manifest_sha256 -or
        ($null -ne $receipt.sequence -and [int]$receipt.sequence -ne [int]$head.sequence) -or
        $receipt.source_repository -ne $m.source.repository -or
        $receipt.source_commit -ne $m.source.commit -or
        $receipt.source_tag -ne $m.source.tag -or $receipt.version -ne $m.version -or
        $receipt.artifact_url -ne $m.artifact.url -or
        $receipt.install_url -ne $m.artifact.install_url -or
        $receipt.artifact_sha256 -ne $m.artifact.sha256 -or
        $receipt.artifact_provenance -ne $m.artifact.provenance) {
        throw "Immutable authority receipt does not authorize manifest"
    }
    $sequenceFile = Join-Path $HOME_DIR "ring-head-sequences.json"
    $sequences = @{}
    if (Test-Path $sequenceFile) {
        $stored = Get-Content $sequenceFile -Raw | ConvertFrom-Json
        foreach ($property in $stored.PSObject.Properties) { $sequences[$property.Name] = [int]$property.Value }
    }
    $previousSequence = if ($sequences.ContainsKey($SelectedRing)) { $sequences[$SelectedRing] } else { 0 }
    if ([int]$head.sequence -lt $previousSequence) { throw "Authority head sequence rollback" }
    if ([int]$head.sequence -gt $previousSequence) {
        $sequences[$SelectedRing] = [int]$head.sequence
        $sequenceTemp = "$sequenceFile.$PID.new"
        $sequences | ConvertTo-Json | Set-Content -Path $sequenceTemp -Encoding utf8NoBOM
        Move-Item -Force $sequenceTemp $sequenceFile
    }
    if ($Version -and $Version -ne $m.version) { throw "Version must equal the ring's exact version $($m.version)" }
    return $m
}

function Compare-SemVer {
    param([Parameter(Mandatory)][string]$Left, [Parameter(Mandatory)][string]$Right)
    $pattern = '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$'
    $a = [regex]::Match($Left, $pattern)
    $b = [regex]::Match($Right, $pattern)
    if (-not $a.Success -or -not $b.Success) { throw "Invalid SemVer comparison: $Left, $Right" }
    for ($i = 1; $i -le 3; $i++) {
        $av = [System.Numerics.BigInteger]::Parse($a.Groups[$i].Value)
        $bv = [System.Numerics.BigInteger]::Parse($b.Groups[$i].Value)
        if ($av -lt $bv) { return -1 }
        if ($av -gt $bv) { return 1 }
    }
    $aHasPre = $a.Groups[4].Success
    $bHasPre = $b.Groups[4].Success
    [string[]]$ap = if ($aHasPre) { $a.Groups[4].Value.Split('.') } else { @() }
    [string[]]$bp = if ($bHasPre) { $b.Groups[4].Value.Split('.') } else { @() }
    if (-not $aHasPre -and -not $bHasPre) { return 0 }
    if (-not $aHasPre) { return 1 }
    if (-not $bHasPre) { return -1 }
    foreach ($id in @($ap + $bp)) {
        if ($id -match '^\d+$' -and $id -match '^0\d+') { throw "Invalid numeric SemVer identifier: $id" }
    }
    $length = [Math]::Max($ap.Count, $bp.Count)
    for ($i = 0; $i -lt $length; $i++) {
        if ($i -ge $ap.Count) { return -1 }
        if ($i -ge $bp.Count) { return 1 }
        if ($ap[$i] -ceq $bp[$i]) { continue }
        $an = $ap[$i] -match '^\d+$'
        $bn = $bp[$i] -match '^\d+$'
        if ($an -and $bn) {
            $av = [System.Numerics.BigInteger]::Parse($ap[$i])
            $bv = [System.Numerics.BigInteger]::Parse($bp[$i])
            if ($av -lt $bv) { return -1 }
            return 1
        }
        if ($an -ne $bn) { return $(if ($an) { -1 } else { 1 }) }
        return $(if ([string]::CompareOrdinal($ap[$i], $bp[$i]) -lt 0) { -1 } else { 1 })
    }
    return 0
}

function Install-ViaNpm {
    $selected = if ($Ring) { $Ring } else { "stable" }
    $manifest = Resolve-RingManifest $selected
    Write-Info "Release ring: $selected -> $($manifest.version) @ $($manifest.source.commit)"

    $current = ""
    try {
        $listed = Invoke-Npm list -g openrappter --depth=0 --json | ConvertFrom-Json
        $current = $listed.dependencies.openrappter.version
    } catch {}
    if ($current -and -not $AllowDowngrade) {
        if ((Compare-SemVer $manifest.version $current) -lt 0) {
            throw "Refusing downgrade $current -> $($manifest.version); pass -AllowDowngrade"
        }
    }

    if ($DryRun) {
        Write-Info "[dry-run] Would verify and install $($manifest.artifact.url)"
        return
    }

    $downloads = Join-Path $HOME_DIR ".downloads"
    New-Item -ItemType Directory -Path $downloads -Force | Out-Null
    $artifact = Join-Path $downloads "openrappter-$($manifest.version).tgz"
    Invoke-WebRequest -Uri $manifest.artifact.url -OutFile $artifact
    $actual = (Get-FileHash -Algorithm SHA256 -Path $artifact).Hash.ToLowerInvariant()
    if ($actual -ne $manifest.artifact.sha256) {
        Remove-Item $artifact -Force -ErrorAction SilentlyContinue
        throw "Artifact checksum mismatch (expected $($manifest.artifact.sha256), got $actual)"
    }

    if ($manifest.artifact.provenance -eq "github-candidate-bundle-sha256") {
        $candidateDir = Join-Path $HOME_DIR ".candidate-$($manifest.artifact.sha256)"
        Remove-Item $candidateDir -Recurse -Force -ErrorAction SilentlyContinue
        New-Item -ItemType Directory -Path $candidateDir -Force | Out-Null
        & tar -xzf $artifact -C $candidateDir
        if ($LASTEXITCODE -ne 0) { throw "Candidate bundle extraction failed" }
        $checks = Get-Content (Join-Path $candidateDir "SHA256SUMS")
        foreach ($line in $checks) {
            if ($line -notmatch '^([0-9a-f]{64})\s+\*?(.+)$') { throw "Malformed candidate checksum line" }
            $file = Join-Path $candidateDir $Matches[2]
            if ((Get-FileHash -Algorithm SHA256 $file).Hash.ToLowerInvariant() -ne $Matches[1]) {
                throw "Candidate inner checksum mismatch: $($Matches[2])"
            }
        }
        $packages = @(Get-ChildItem $candidateDir -Filter "openrappter-*.tgz" -File)
        if ($packages.Count -ne 1) { throw "Candidate bundle must contain exactly one npm tarball" }
        $artifact = $packages[0].FullName
    }

    Write-Info "Running: npm install -g verified artifact"
    # Set SHARP_IGNORE_GLOBAL_LIBVIPS to prevent native module download issues
    $env:SHARP_IGNORE_GLOBAL_LIBVIPS = "1"

    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        Invoke-Npm install -g $artifact | ForEach-Object { Write-Info "$_" }
        if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
    } catch {
        Write-Warn "npm install failed. Retrying..."
        Invoke-Npm install -g $artifact --omit=optional | ForEach-Object { Write-Info "$_" }
        if ($LASTEXITCODE -ne 0) {
            throw "npm install failed after retry"
        }
    } finally {
        $ErrorActionPreference = $prevEAP
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
    $selected = if ($Ring) { $Ring } else { "stable" }
    $manifest = Resolve-RingManifest $selected
    if (-not (Test-GitAvailable)) {
        Install-Git
    }

    if (Test-Path (Join-Path $InstallDir ".git")) {
        Write-Info "Existing git clone found at $InstallDir -- fetching exact source..."
        if (-not $DryRun) {
            Push-Location $InstallDir
            try {
                & git fetch --depth 1 origin $manifest.source.commit 2>&1 | ForEach-Object { Write-Info $_ }
            } finally {
                Pop-Location
            }
        }
    } else {
        Write-Info "Cloning $REPO_URL to $InstallDir..."
        if (-not $DryRun) {
            & git clone --no-checkout --filter=blob:none $REPO_URL $InstallDir 2>&1 | ForEach-Object { Write-Info $_ }
            & git -C $InstallDir fetch --depth 1 origin $manifest.source.commit 2>&1 | ForEach-Object { Write-Info $_ }
        }
    }
    if (-not $DryRun) {
        & git -C $InstallDir checkout --detach $manifest.source.commit 2>&1 | ForEach-Object { Write-Info $_ }
        $head = (& git -C $InstallDir rev-parse HEAD).Trim()
        if ($head -ne $manifest.source.commit) { throw "Exact source checkout verification failed" }
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
    $binDir = Join-Path (Join-Path $env:USERPROFILE ".openrappter") "bin"
    if (-not (Test-Path $binDir)) {
        New-Item -ItemType Directory -Path $binDir -Force | Out-Null
    }

    $launcherPath = Join-Path $binDir "openrappter.cmd"
    $distIndex = Join-Path (Join-Path $tsDir "dist") "index.js"
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

function Resolve-GatewayEntry {
    param([string]$LauncherPath)

    # `Get-Command openrappter` finds a launcher, not the JavaScript entry point,
    # and dist/index.js is not one level above that launcher under EITHER install
    # method: `npm install -g` leaves the shim in %APPDATA%\npm with the package
    # under node_modules\, and the git method writes .openrappter\bin\openrappter.cmd
    # for a build that lives in .openrappter\typescript\dist. The old
    # "<launcher>\..\dist\index.js" guess therefore named a file that exists in
    # neither layout, so node exited immediately with MODULE_NOT_FOUND.
    $candidates = New-Object System.Collections.Generic.List[string]

    if ($LauncherPath) {
        $launcherDir = Split-Path $LauncherPath
        # npm -g on Windows: shim in <prefix>, package under <prefix>\node_modules
        $candidates.Add([System.IO.Path]::Combine($launcherDir, "node_modules", "openrappter", "dist", "index.js"))
        # npm -g with a Unix-style prefix: shim in <prefix>\bin, package under <prefix>\lib\node_modules
        $candidates.Add([System.IO.Path]::Combine($launcherDir, "..", "lib", "node_modules", "openrappter", "dist", "index.js"))
        # Launcher shipped inside the package itself (bin\ sits next to dist\)
        $candidates.Add([System.IO.Path]::Combine($launcherDir, "..", "dist", "index.js"))
    }

    # git method: .openrappter\bin\openrappter.cmd runs .openrappter\typescript\dist\index.js
    $candidates.Add([System.IO.Path]::Combine($InstallDir, "typescript", "dist", "index.js"))

    try {
        $npmRoot = (Invoke-Npm root -g | Where-Object { $_ } | Select-Object -Last 1)
        if ($npmRoot) {
            $candidates.Add([System.IO.Path]::Combine($npmRoot.ToString().Trim(), "openrappter", "dist", "index.js"))
        }
    } catch {
        # `npm root -g` is one hint among several; its absence is not fatal.
    }

    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }

    return $null
}

function Test-GatewayAnswering {
    param([int]$Port)

    # /readyz is handled before the origin check in gateway/server.ts, so a
    # loopback probe needs no token and no Origin header.
    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/readyz" `
            -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
        return [pscustomobject]@{
            Answering = ($response.StatusCode -eq 200)
            Detail    = "answered HTTP $($response.StatusCode)"
        }
    } catch {
        # Connection refused while it boots, or 503 while it is still degraded.
        return [pscustomobject]@{ Answering = $false; Detail = $_.Exception.Message }
    }
}

function Wait-GatewayReady {
    param(
        [System.Diagnostics.Process]$Process,
        [int]$Port,
        [int]$TimeoutSeconds = 60
    )

    # A PID is not readiness. Start-Process hands back an ID for a process that
    # has already died, so the only honest evidence that a gateway is serving is
    # a gateway answering.
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $lastReason = "no response on port $Port"

    while ((Get-Date) -lt $deadline) {
        if ($Process.HasExited) {
            return [pscustomobject]@{
                Ready  = $false
                Reason = "the process exited with code $($Process.ExitCode) before answering on port $Port"
            }
        }

        $probe = Test-GatewayAnswering -Port $Port
        if ($probe.Answering) {
            return [pscustomobject]@{ Ready = $true; Reason = $null }
        }
        $lastReason = "port $Port not ready yet ($($probe.Detail))"

        Start-Sleep -Milliseconds 500
    }

    return [pscustomobject]@{
        Ready  = $false
        Reason = "timed out after $TimeoutSeconds seconds -- $lastReason"
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
        Write-Warn "openrappter not on PATH -- skipping gateway start. Restart your terminal and run: openrappter --daemon"
        return
    }

    $entry = Resolve-GatewayEntry -LauncherPath $openrappterBin.Source
    if (-not $entry) {
        Write-Warn "Could not locate the gateway entry point (dist\index.js) -- skipping gateway start."
        Write-Info "Start manually with: openrappter --daemon"
        return
    }

    # A gateway already answering on this port would satisfy the readiness probe
    # below no matter what was launched, so "this PID is serving" is only a
    # claim worth making when the port was silent first.
    if ((Test-GatewayAnswering -Port $GATEWAY_PORT).Answering) {
        Write-Success "Gateway already running on port $GATEWAY_PORT"
        return
    }

    try {
        # `openrappter gateway` is not a registered command. Commander read the
        # word as the [message] positional, sent it to the model as a chat
        # prompt, printed an answer about network gateways, and exited 0 -- while
        # this installer recorded its PID and announced a running daemon. The
        # daemon is `--daemon`, and no port is passed so the CLI keeps its own
        # port precedence, which $GATEWAY_PORT mirrors.
        $proc = Start-Process -FilePath "node" `
            -ArgumentList @($entry, "--daemon") `
            -WindowStyle Hidden `
            -PassThru `
            -ErrorAction Stop
    } catch {
        Write-Warn "Could not start gateway: $_"
        Write-Info "Start manually with: openrappter --daemon"
        return
    }

    $readiness = Wait-GatewayReady -Process $proc -Port $GATEWAY_PORT
    if (-not $readiness.Ready) {
        Write-Warn "Gateway did not become ready: $($readiness.Reason)"
        if (-not $proc.HasExited) {
            # Leave nothing half-started behind to hold the port and confuse the
            # next run's probe.
            Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        }
        Write-Info "Start manually with: openrappter --daemon"
        return
    }

    # Recorded only now: the file says "a gateway answered on this port", not
    # "a process was spawned".
    if (-not (Test-Path $HOME_DIR)) {
        New-Item -ItemType Directory -Path $HOME_DIR -Force | Out-Null
    }
    $proc.Id | Set-Content -Path $GATEWAY_PID

    Write-Success "Gateway brainstem ready (PID $($proc.Id), port $GATEWAY_PORT)"
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
    if ($isUpgrade -and -not $METHOD_WAS_BOUND -and -not $env:OPENRAPPTER_INSTALL_METHOD) {
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
    $selectedRing = if ($Ring) { $Ring } else { "stable" }
    New-Item -ItemType Directory -Path $HOME_DIR -Force | Out-Null
    Set-Content -Path $RING_FILE -Value $selectedRing -Encoding ascii

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
    if (-not $installedVersion -and (Test-Path (Join-Path (Join-Path $InstallDir "typescript") "package.json"))) {
        try {
            $pkg = Get-Content (Join-Path (Join-Path $InstallDir "typescript") "package.json") | ConvertFrom-Json
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
    Write-Kv "Start gateway" "openrappter --daemon"
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
if ($env:OPENRAPPTER_INSTALL_PS1_NO_RUN -ne "1") {
  try {
    Main
  } catch {
    Write-Host ""
    Write-Err "Installation failed: $_"
    Write-Host ""
    Write-Info "If you see 'Access is denied', run this command directly in PowerShell:"
    Write-Host ""
    Write-Host "  irm https://kody-w.github.io/openrappter/install.ps1 | iex" -ForegroundColor Cyan
    Write-Host ""
    Write-Info "If execution policy blocks it, run this first:"
    Write-Host "  Set-ExecutionPolicy Bypass -Scope Process -Force" -ForegroundColor DarkGray
    Write-Host ""
    Write-Info "If this keeps happening, please file an issue:"
    Write-Info "https://github.com/kody-w/openrappter/issues"
    Write-Host ""
    exit 1
  }
}
