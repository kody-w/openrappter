$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$installer = Join-Path $root "install.ps1"
$env:OPENRAPPTER_INSTALL_PS1_NO_RUN = "1"

$env:OPENRAPPTER_INSTALL_METHOD = "npm"
$env:OPENRAPPTER_VERSION = "9.9.9"
& {
    . $installer -Method git -Version "1.2.3"
    if ($Method -ne "git") { throw "Explicit -Method lost to environment: $Method" }
    if ($Version -ne "1.2.3") { throw "Explicit -Version lost to environment: $Version" }
    if ((Compare-SemVer "1.9.8-beta.1" "1.9.8") -ne -1) { throw "release/prerelease ordering failed" }
    if ((Compare-SemVer "1.9.8-beta.2" "1.9.8-beta.10") -ne -1) { throw "numeric ordering failed" }
    if ((Compare-SemVer "1.9.8-2" "1.9.8-beta") -ne -1) { throw "numeric/lexical ordering failed" }
    $candidate = "https://raw.githubusercontent.com/kody-w/openrappter/$("b"*40)/candidates/$("a"*40)/release/tag-djEuMTMuMA/$("c"*64).tar.gz"
    if ((Parse-CandidateBundleUrl $candidate).CandidateId -ne "tag-djEuMTMuMA") { throw "candidate URL parser failed" }
    try { Parse-CandidateBundleUrl "$candidate?mutable=1"; throw "candidate query accepted" } catch {
        if ($_.Exception.Message -eq "candidate query accepted") { throw }
    }
    try { Parse-CandidateBundleUrl ($candidate.Replace("raw.githubusercontent.com", "RAW.GITHUBUSERCONTENT.COM")); throw "candidate host case accepted" } catch {
        if ($_.Exception.Message -eq "candidate host case accepted") { throw }
    }
    try { Parse-CandidateBundleUrl ($candidate.Replace("raw.githubusercontent.com", "raw.githubusercontent.com:443")); throw "candidate port accepted" } catch {
        if ($_.Exception.Message -eq "candidate port accepted") { throw }
    }
}

& {
    . $installer
    if ($Method -ne "npm") { throw "Environment did not default unbound Method: $Method" }
    if ($Version -ne "9.9.9") { throw "Environment did not default unbound Version: $Version" }
}

Write-Host "PowerShell installer precedence and SemVer tests passed"
