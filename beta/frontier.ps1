$ErrorActionPreference = "Stop"

$repo = if ($env:RAPP_FRONTIER_REPO) {
    $env:RAPP_FRONTIER_REPO
} else {
    "microsoft/aibast-agents-library"
}
if ($repo -notmatch "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$") {
    throw "Invalid RAPP_FRONTIER_REPO: $repo"
}

$api = if ($env:RAPP_FRONTIER_API) { $env:RAPP_FRONTIER_API } else { "https://api.github.com/repos/$repo" }
$gitUrl = "https://github.com/$repo.git"
$headers = @{ Accept = "application/vnd.github+json" }
# The unauthenticated GitHub API is quota-limited per source address; honor a
# token when present and fall back to `git ls-remote` when the API refuses.
$token = if ($env:GITHUB_TOKEN) { $env:GITHUB_TOKEN } elseif ($env:GH_TOKEN) { $env:GH_TOKEN } else { $null }
if ($token) { $headers["Authorization"] = "Bearer $token" }

$tag = $null
try {
    $releases = Invoke-RestMethod -Headers $headers -Uri "$api/releases?per_page=30"
    $release = @(
        $releases | Where-Object {
            -not $_.draft -and $_.tag_name.StartsWith("brainstem-beta-v")
        }
    )[0]
    if ($release) { $tag = $release.tag_name }
} catch {
    Write-Warning "GitHub API did not answer (rate limit or network); resolving the release tag with git..."
}
if (-not $tag) {
    $tag = @(
        & git ls-remote --tags --refs $gitUrl "brainstem-beta-v*" 2>$null |
            ForEach-Object { ($_ -split "\s+")[1] -replace "^refs/tags/", "" } |
            Sort-Object { [version](($_ -replace "^brainstem-beta-v", "") -replace "-.*$", "") }, { $_ }
    )[-1]
}
if (-not $tag) {
    throw "No published OpenRappter release was found in $repo. If you are behind a shared network, set GITHUB_TOKEN to a read-only token and retry."
}

$commit = $null
try {
    $commit = (
        Invoke-RestMethod -Headers $headers -Uri "$api/commits/$([uri]::EscapeDataString($tag))"
    ).sha.ToLowerInvariant()
} catch {
    # The peeled ref (tag^{}) is the commit behind an annotated tag.
    $refs = & git ls-remote $gitUrl "refs/tags/$tag^{}" "refs/tags/$tag" 2>$null
    $peeled = $refs | Where-Object { $_ -match "refs/tags/$([regex]::Escape($tag))\^\{\}$" } | Select-Object -First 1
    $plain = $refs | Where-Object { $_ -match "refs/tags/$([regex]::Escape($tag))$" } | Select-Object -First 1
    $line = if ($peeled) { $peeled } else { $plain }
    if ($line) { $commit = (($line -split "\s+")[0]).ToLowerInvariant() }
}
if ($commit -notmatch "^[0-9a-f]{40}$") {
    throw "The Frontier release did not resolve to a full commit SHA."
}

if ($env:RAPP_FRONTIER_RESOLVE_ONLY -eq "1") {
    Write-Output "$repo $tag $commit"
    return
}

$env:BRAINSTEM_BETA_REPO_URL = "https://github.com/$repo.git"
$env:BRAINSTEM_BETA_RELEASE_TAG = $tag
$env:BRAINSTEM_BETA_RUNTIME_VERSION_URL =
    "https://raw.githubusercontent.com/$repo/$commit/rapp_brainstem/VERSION"
$env:BRAINSTEM_BETA_COMMIT = $commit
$env:BRAINSTEM_BETA_BOOTSTRAP_URL =
    "https://raw.githubusercontent.com/$repo/$commit/install.ps1"
$installer = Join-Path $env:TEMP "rapp-frontier-$commit.cmd"
try {
    Invoke-WebRequest `
        "https://raw.githubusercontent.com/$repo/$commit/beta/install.cmd" `
        -OutFile $installer `
        -UseBasicParsing
    & $installer
    if ($LASTEXITCODE -ne 0) {
        throw "Frontier installer exited with code $LASTEXITCODE."
    }
} finally {
    Remove-Item $installer -Force -ErrorAction SilentlyContinue
}
