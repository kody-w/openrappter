#!/bin/bash
set -euo pipefail

# OpenRappter desktop application.
# Brainstem is the bare twin. OpenRappter is the fully built-out twin: same
# /chat wire, separate app state, runtime home, worker ports, and lifecycle.

OPENRAPPTER_HOME="${OPENRAPPTER_HOME:-$HOME/.openrappter}"
BRAINSTEM_HOME="${OPENRAPPTER_BRAINSTEM_HOME:-$OPENRAPPTER_HOME/brainstem}"
BETA_HOME="${BRAINSTEM_BETA_HOME:-$OPENRAPPTER_HOME/desktop}"
BETA_SOURCE="$BETA_HOME/src"
REPO_URL="${BRAINSTEM_BETA_REPO_URL:-https://github.com/kody-w/openrappter.git}"
# Where the Brainstem KERNEL comes from, which is not necessarily where the
# Frontier comes from. They coincide in this distribution and do not in a
# downstream that ships only beta/ — pointing REPO_URL at such a repository used
# to redirect the kernel clone there too, and the install failed fetching a kernel
# that was never there. Defaults to REPO_URL so existing forks are unaffected.
# This distribution ships only the Frontier, so the kernel comes from upstream
# rather than from here. Overridable, but it must be a repository that actually
# hosts the Brainstem kernel and its installer.
KERNEL_REPO_URL="${BRAINSTEM_BETA_KERNEL_REPO_URL:-https://github.com/microsoft/aibast-agents-library.git}"
KERNEL_REPO_REF="${BRAINSTEM_BETA_KERNEL_REPO_REF:-main}"
KERNEL_BOOTSTRAP_URL="https://raw.githubusercontent.com/kody-w/aibast-agents-library/3900fc7e445c87e2ee10c25a1f6a24cd96770253/install.sh"
KERNEL_BOOTSTRAP_SHA256="46b99381b76982c23232c9e7a891b1676ac53d4bfcf6ad8feeed488445c02a42"
TRANSITION_HELPER_BASE64="aW1wb3J0IHsKICBjaG1vZFN5bmMsCiAgbHN0YXRTeW5jLAogIHJlYWRGaWxlU3luYywKICByZW5hbWVTeW5jLAogIHJtU3luYywKICB3cml0ZUZpbGVTeW5jLAp9IGZyb20gIm5vZGU6ZnMiOwppbXBvcnQgcGF0aCBmcm9tICJub2RlOnBhdGgiOwoKY29uc3QgQ09NTUlUX1BBVFRFUk4gPSAvXlswLTlhLWZdezQwfSQvaTsKY29uc3QgVkVSU0lPTl9QQVRURVJOID0gL15bMC05QS1aYS16Ll8tXSskLzsKY29uc3QgW3JlcXVlc3RQYXRoLCByb2xsYmFja1BhdGgsIHRhcmdldEluc3RhbGxlcl0gPSBwcm9jZXNzLmFyZ3Yuc2xpY2UoMik7CgpmdW5jdGlvbiByZXF1aXJlUmVndWxhckZpbGUoZmlsZSwgbGFiZWwpIHsKICBjb25zdCBzdGF0ID0gbHN0YXRTeW5jKGZpbGUpOwogIGlmICghc3RhdC5pc0ZpbGUoKSB8fCBzdGF0LmlzU3ltYm9saWNMaW5rKCkpIHsKICAgIHRocm93IG5ldyBFcnJvcihgJHtsYWJlbH0gbXVzdCBiZSBhIHJlZ3VsYXIgZmlsZS5gKTsKICB9Cn0KCmZ1bmN0aW9uIHNoZWxsUXVvdGUodmFsdWUpIHsKICByZXR1cm4gYCcke1N0cmluZyh2YWx1ZSkucmVwbGFjZUFsbCgiJyIsICInXFwnJyIpfSdgOwp9CgpmdW5jdGlvbiBwb3dlcnNoZWxsUXVvdGUodmFsdWUpIHsKICByZXR1cm4gYCcke1N0cmluZyh2YWx1ZSkucmVwbGFjZUFsbCgiJyIsICInJyIpfSdgOwp9Cgpmb3IgKGNvbnN0IFt2YWx1ZSwgbGFiZWxdIG9mIFsKICBbcmVxdWVzdFBhdGgsICJ1cGRhdGUgcmVxdWVzdCJdLAogIFtyb2xsYmFja1BhdGgsICJyb2xsYmFjayBpbnN0YWxsZXIiXSwKICBbdGFyZ2V0SW5zdGFsbGVyLCAidGFyZ2V0IGluc3RhbGxlciJdLApdKSB7CiAgaWYgKCF2YWx1ZSB8fCAhcGF0aC5pc0Fic29sdXRlKHZhbHVlKSkgewogICAgdGhyb3cgbmV3IEVycm9yKGAke2xhYmVsfSBwYXRoIG11c3QgYmUgYWJzb2x1dGUuYCk7CiAgfQp9CnJlcXVpcmVSZWd1bGFyRmlsZShyZXF1ZXN0UGF0aCwgIlVwZGF0ZSByZXF1ZXN0Iik7CnJlcXVpcmVSZWd1bGFyRmlsZShyb2xsYmFja1BhdGgsICJSb2xsYmFjayBpbnN0YWxsZXIiKTsKcmVxdWlyZVJlZ3VsYXJGaWxlKHRhcmdldEluc3RhbGxlciwgIlRhcmdldCBpbnN0YWxsZXIiKTsKCmNvbnN0IHJlcXVlc3QgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhyZXF1ZXN0UGF0aCwgInV0ZjgiKSk7CmlmICh0eXBlb2YgcmVxdWVzdC5yZWxlYXNlVGFnID09PSAic3RyaW5nIiAmJiByZXF1ZXN0LnJlbGVhc2VUYWcpIHsKICBwcm9jZXNzLmV4aXQoMCk7Cn0KZm9yIChjb25zdCBrZXkgb2YgWwogICJicmFpbnN0ZW1FeHBlY3RlZEhlYWQiLAogICJicmFpbnN0ZW1SZXBvUm9vdCIsCiAgImN1cnJlbnRWZXJzaW9uIiwKICAiZ2l0RXhlY3V0YWJsZSIsCiAgInJlbW90ZVVybCIsCiAgInJvbGxiYWNrQ29tbWl0IiwKXSkgewogIGlmICh0eXBlb2YgcmVxdWVzdFtrZXldICE9PSAic3RyaW5nIiB8fCAhcmVxdWVzdFtrZXldKSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoYExlZ2FjeSB1cGRhdGUgcmVxdWVzdCBpcyBtaXNzaW5nICR7a2V5fS5gKTsKICB9Cn0KaWYgKAogICFDT01NSVRfUEFUVEVSTi50ZXN0KHJlcXVlc3QuYnJhaW5zdGVtRXhwZWN0ZWRIZWFkKQogIHx8ICFDT01NSVRfUEFUVEVSTi50ZXN0KHJlcXVlc3Qucm9sbGJhY2tDb21taXQpCikgewogIHRocm93IG5ldyBFcnJvcigiTGVnYWN5IHVwZGF0ZSByZXF1ZXN0IGhhcyBhbiBpbnZhbGlkIGNvbW1pdC4iKTsKfQppZiAoIVZFUlNJT05fUEFUVEVSTi50ZXN0KHJlcXVlc3QuY3VycmVudFZlcnNpb24pKSB7CiAgdGhyb3cgbmV3IEVycm9yKCJMZWdhY3kgdXBkYXRlIHJlcXVlc3QgaGFzIGFuIGludmFsaWQgY3VycmVudCB2ZXJzaW9uLiIpOwp9CmNvbnN0IHJlbW90ZSA9IG5ldyBVUkwocmVxdWVzdC5yZW1vdGVVcmwpOwpjb25zdCBtYXRjaCA9IHJlbW90ZS5ocmVmLm1hdGNoKAogIC9eaHR0cHM6XC9cL2dpdGh1YlwuY29tXC8oW0EtWmEtejAtOV8uLV0rKVwvKFtBLVphLXowLTlfLi1dKz8pKD86XC5naXQpP1wvPyQvLAopOwppZiAoIW1hdGNoKSB7CiAgdGhyb3cgbmV3IEVycm9yKCJMZWdhY3kgdXBkYXRlIHJlcXVlc3QgaGFzIGFuIHVuc3VwcG9ydGVkIHJlcG9zaXRvcnkgVVJMLiIpOwp9Cgpjb25zdCBydW50aW1lVmVyc2lvblVybCA9IFsKICAiaHR0cHM6Ly9yYXcuZ2l0aHVidXNlcmNvbnRlbnQuY29tIiwKICBtYXRjaFsxXSwKICBtYXRjaFsyXSwKICByZXF1ZXN0LmJyYWluc3RlbUV4cGVjdGVkSGVhZCwKICAicmFwcF9icmFpbnN0ZW0vVkVSU0lPTiIsCl0uam9pbigiLyIpOwpjb25zdCBwb3NpeFNjcmlwdCA9IGAjIS9iaW4vYmFzaApzZXQgLWV1byBwaXBlZmFpbApleHBvcnQgQlJBSU5TVEVNX0JFVEFfVFJBTlNJVElPTl9ST0xMQkFDSz0xCmV4cG9ydCBCUkFJTlNURU1fQkVUQV9SRUxFQVNFX1RBRz0ke3NoZWxsUXVvdGUoYGJyYWluc3RlbS1iZXRhLXYke3JlcXVlc3QuY3VycmVudFZlcnNpb259YCl9CmV4cG9ydCBCUkFJTlNURU1fQkVUQV9SVU5USU1FX1ZFUlNJT05fVVJMPSR7c2hlbGxRdW90ZShydW50aW1lVmVyc2lvblVybCl9CmV4cG9ydCBCUkFJTlNURU1fQkVUQV9QUkVTRVJWRV9SVU5USU1FPTEKZXhwb3J0IEJSQUlOU1RFTV9CRVRBX1JVTlRJTUVfQ09NTUlUPSR7c2hlbGxRdW90ZShyZXF1ZXN0LmJyYWluc3RlbUV4cGVjdGVkSGVhZCl9CnVuc2V0IEJSQUlOU1RFTV9CRVRBX0JPT1RTVFJBUF9VUkwgQlJBSU5TVEVNX0JFVEFfQk9PVFNUUkFQX1NIQTI1Ngoke3NoZWxsUXVvdGUocmVxdWVzdC5naXRFeGVjdXRhYmxlKX0gLUMgJHtzaGVsbFF1b3RlKHJlcXVlc3QuYnJhaW5zdGVtUmVwb1Jvb3QpfSBjaGVja291dCAtLWRldGFjaCAke3NoZWxsUXVvdGUocmVxdWVzdC5icmFpbnN0ZW1FeHBlY3RlZEhlYWQpfQpleGVjIC9iaW4vYmFzaCAke3NoZWxsUXVvdGUodGFyZ2V0SW5zdGFsbGVyKX0KYDsKY29uc3QgcG93ZXJzaGVsbFNjcmlwdCA9IGAkRXJyb3JBY3Rpb25QcmVmZXJlbmNlID0gJ1N0b3AnCiRlbnY6QlJBSU5TVEVNX0JFVEFfVFJBTlNJVElPTl9ST0xMQkFDSyA9ICcxJwokZW52OkJSQUlOU1RFTV9CRVRBX1JFTEVBU0VfVEFHID0gJHtwb3dlcnNoZWxsUXVvdGUoYGJyYWluc3RlbS1iZXRhLXYke3JlcXVlc3QuY3VycmVudFZlcnNpb259YCl9CiRlbnY6QlJBSU5TVEVNX0JFVEFfUlVOVElNRV9WRVJTSU9OX1VSTCA9ICR7cG93ZXJzaGVsbFF1b3RlKHJ1bnRpbWVWZXJzaW9uVXJsKX0KJGVudjpCUkFJTlNURU1fQkVUQV9QUkVTRVJWRV9SVU5USU1FID0gJzEnCiRlbnY6QlJBSU5TVEVNX0JFVEFfUlVOVElNRV9DT01NSVQgPSAke3Bvd2Vyc2hlbGxRdW90ZShyZXF1ZXN0LmJyYWluc3RlbUV4cGVjdGVkSGVhZCl9ClJlbW92ZS1JdGVtIEVudjpCUkFJTlNURU1fQkVUQV9CT09UU1RSQVBfVVJMIC1FcnJvckFjdGlvbiBTaWxlbnRseUNvbnRpbnVlClJlbW92ZS1JdGVtIEVudjpCUkFJTlNURU1fQkVUQV9CT09UU1RSQVBfU0hBMjU2IC1FcnJvckFjdGlvbiBTaWxlbnRseUNvbnRpbnVlCiYgJHtwb3dlcnNoZWxsUXVvdGUocmVxdWVzdC5naXRFeGVjdXRhYmxlKX0gLUMgJHtwb3dlcnNoZWxsUXVvdGUocmVxdWVzdC5icmFpbnN0ZW1SZXBvUm9vdCl9IGNoZWNrb3V0IC0tZGV0YWNoICR7cG93ZXJzaGVsbFF1b3RlKHJlcXVlc3QuYnJhaW5zdGVtRXhwZWN0ZWRIZWFkKX0KaWYgKCRMQVNURVhJVENPREUgLW5lIDApIHsgZXhpdCAkTEFTVEVYSVRDT0RFIH0KJiAke3Bvd2Vyc2hlbGxRdW90ZSh0YXJnZXRJbnN0YWxsZXIpfQpleGl0ICRMQVNURVhJVENPREUKYDsKY29uc3Qgc2NyaXB0ID0gcm9sbGJhY2tQYXRoLnRvTG93ZXJDYXNlKCkuZW5kc1dpdGgoIi5jbWQiKQogID8gYEBlY2hvIG9mZlxyXG5wb3dlcnNoZWxsLmV4ZSAtTm9Qcm9maWxlIC1Ob25JbnRlcmFjdGl2ZSAtRXhlY3V0aW9uUG9saWN5IEJ5cGFzcyAtRW5jb2RlZENvbW1hbmQgJHsKICAgICAgQnVmZmVyLmZyb20ocG93ZXJzaGVsbFNjcmlwdCwgInV0ZjE2bGUiKS50b1N0cmluZygiYmFzZTY0IikKICAgIH1cclxuYAogIDogcG9zaXhTY3JpcHQ7Cgpjb25zdCB0ZW1wb3JhcnlQYXRoID0gYCR7cm9sbGJhY2tQYXRofS4ke3Byb2Nlc3MucGlkfS50bXBgOwp0cnkgewogIHdyaXRlRmlsZVN5bmModGVtcG9yYXJ5UGF0aCwgc2NyaXB0LCB7IGVuY29kaW5nOiAidXRmOCIsIGZsYWc6ICJ3eCIsIG1vZGU6IDBvNzAwIH0pOwogIHJlbmFtZVN5bmModGVtcG9yYXJ5UGF0aCwgcm9sbGJhY2tQYXRoKTsKICBjaG1vZFN5bmMocm9sbGJhY2tQYXRoLCAwbzcwMCk7Cn0gZmluYWxseSB7CiAgcm1TeW5jKHRlbXBvcmFyeVBhdGgsIHsgZm9yY2U6IHRydWUgfSk7Cn0K"
if [[ -n "${BRAINSTEM_BETA_BOOTSTRAP_URL:-}" && -n "${BRAINSTEM_BETA_BOOTSTRAP_SHA256:-}" ]]; then
    KERNEL_BOOTSTRAP_URL="$BRAINSTEM_BETA_BOOTSTRAP_URL"
    KERNEL_BOOTSTRAP_SHA256="$BRAINSTEM_BETA_BOOTSTRAP_SHA256"
elif [[ -n "${BRAINSTEM_BETA_BOOTSTRAP_URL:-}" || -n "${BRAINSTEM_BETA_BOOTSTRAP_SHA256:-}" ]]; then
    echo "Ignoring an unpaired Brainstem bootstrap override; URL and SHA-256 are both required." >&2
fi
REPO_REF="${BRAINSTEM_BETA_REF:-main}"
UPDATE_REF="${BRAINSTEM_BETA_UPDATE_REF:-$REPO_REF}"
REPO_COMMIT="${BRAINSTEM_BETA_COMMIT:-}"
RELEASE_TAG="${BRAINSTEM_BETA_RELEASE_TAG:-}"
RUNTIME_VERSION_URL="${BRAINSTEM_BETA_RUNTIME_VERSION_URL:-}"
PRESERVE_RUNTIME="${BRAINSTEM_BETA_PRESERVE_RUNTIME:-0}"
RUNTIME_COMMIT="${BRAINSTEM_BETA_RUNTIME_COMMIT:-}"
NODE_VERSION="${BRAINSTEM_BETA_NODE_VERSION:-24.19.0}"
NO_LAUNCH="${BRAINSTEM_BETA_NO_LAUNCH:-0}"
PORTABLE_NODE_DIR=""
BETA_LAUNCHER_PATH=""

canonical_future_directory() {
    local raw="$1"
    [[ "$raw" != *$'\n'* && "$raw" != *$'\r'* && -n "$raw" ]] || return 1
    local absolute="$raw"
    [[ "$absolute" == /* ]] || absolute="$PWD/$absolute"
    local -a parts=()
    local -a segments=()
    local segment
    IFS='/' read -r -a segments <<< "$absolute"
    for segment in "${segments[@]}"; do
        case "$segment" in
            ""|".") ;;
            "..")
                ((${#parts[@]})) && unset "parts[$((${#parts[@]} - 1))]"
                ;;
            *) parts+=("$segment") ;;
        esac
    done
    local normalized=""
    for segment in "${parts[@]}"; do normalized="$normalized/$segment"; done
    [[ -n "$normalized" ]] || normalized="/"
    local ancestor="$normalized"
    local suffix=""
    while [[ ! -e "$ancestor" ]]; do
        suffix="/${ancestor##*/}$suffix"
        ancestor="${ancestor%/*}"
        [[ -n "$ancestor" ]] || ancestor="/"
    done
    [[ -d "$ancestor" ]] || return 1
    local physical
    physical="$(cd -P -- "$ancestor" 2>/dev/null && pwd -P)" || return 1
    printf '%s%s\n' "${physical%/}" "$suffix"
}

path_within() {
    [[ "$1" == "$2" || "$1" == "$2/"* ]]
}

paths_overlap() {
    path_within "$1" "$2" || path_within "$2" "$1"
}

canonical_future_directory "$HOME" >/dev/null || {
    echo "[X] Refusing species driftback: HOME is not a safe directory path." >&2
    exit 1
}
CANONICAL_BARE="$(canonical_future_directory "$HOME/.brainstem")" || exit 1
CANONICAL_OPENRAPPTER="$(canonical_future_directory "$OPENRAPPTER_HOME")" || exit 1
CANONICAL_BRAINSTEM="$(canonical_future_directory "$BRAINSTEM_HOME")" || exit 1
CANONICAL_BETA="$(canonical_future_directory "$BETA_HOME")" || exit 1

if paths_overlap "$CANONICAL_OPENRAPPTER" "$CANONICAL_BARE" \
    || paths_overlap "$CANONICAL_BRAINSTEM" "$CANONICAL_BARE" \
    || paths_overlap "$CANONICAL_BETA" "$CANONICAL_BARE" \
    || [[ "$CANONICAL_BRAINSTEM" == "$CANONICAL_OPENRAPPTER" ]] \
    || ! path_within "$CANONICAL_BRAINSTEM" "$CANONICAL_OPENRAPPTER" \
    || [[ "$CANONICAL_BETA" == "$CANONICAL_OPENRAPPTER" ]] \
    || ! path_within "$CANONICAL_BETA" "$CANONICAL_OPENRAPPTER" \
    || paths_overlap "$CANONICAL_BRAINSTEM" "$CANONICAL_BETA"; then
    echo "[X] Refusing species driftback: OpenRappter paths must be canonical, isolated children of its own home." >&2
    exit 1
fi

OPENRAPPTER_HOME="$CANONICAL_OPENRAPPTER"
BRAINSTEM_HOME="$CANONICAL_BRAINSTEM"
BETA_HOME="$CANONICAL_BETA"
BETA_SOURCE="$BETA_HOME/src"

if [[ "${BRAINSTEM_BETA_VALIDATE_PATHS_ONLY:-0}" == "1" ]]; then
    printf 'OpenRappter paths are isolated: %s\n' "$OPENRAPPTER_HOME"
    exit 0
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

run_with_heartbeat() {
    local label="$1"
    shift
    if [ ! -t 1 ]; then
        echo "  [..] $label"
        "$@"
        return
    fi

    local log_file
    log_file=$(mktemp "${TMPDIR:-/tmp}/brainstem-beta-XXXXXX")
    "$@" >"$log_file" 2>&1 &
    local pid=$!
    local started=$SECONDS
    local frame=0
    while kill -0 "$pid" 2>/dev/null; do
        local glyph
        case "$frame" in
            0) glyph='|' ;;
            1) glyph='/' ;;
            2) glyph='-' ;;
            *) glyph="\\" ;;
        esac
        printf "\r  [%s] %s (%ss)" "$glyph" "$label" "$((SECONDS - started))"
        frame=$(( (frame + 1) % 4 ))
        sleep 1
    done

    local status=0
    wait "$pid" || status=$?
    if [ "$status" -eq 0 ]; then
        printf "\r  [OK] %s (%ss)\n" "$label" "$((SECONDS - started))"
        rm -f "$log_file"
        return 0
    fi
    printf "\r  [X] %s failed after %ss\n" "$label" "$((SECONDS - started))"
    cat "$log_file" >&2
    rm -f "$log_file"
    return "$status"
}

fail() {
    echo -e "  ${RED}[X]${NC} $1" >&2
    exit 1
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

validate_source_ref() {
    if [ -n "$RELEASE_TAG" ]; then
        case "$RELEASE_TAG" in
            brainstem-beta-v[0-9A-Za-z._-]*) ;;
            *) fail "BRAINSTEM_BETA_RELEASE_TAG must be a Frontier release tag" ;;
        esac
    fi
    [ -z "$REPO_COMMIT" ] && return
    case "$REPO_COMMIT" in
        *[!0-9a-fA-F]*) fail "BRAINSTEM_BETA_COMMIT must be a full 40-character commit SHA" ;;
    esac
    [ "${#REPO_COMMIT}" -eq 40 ] \
        || fail "BRAINSTEM_BETA_COMMIT must be a full 40-character commit SHA"
    REPO_COMMIT=$(printf '%s' "$REPO_COMMIT" | tr 'A-F' 'a-f')
    REPO_REF="$REPO_COMMIT"
}

git_supports_sparse_checkout() {
    local version
    version=$(git --version | awk '{print $3}')
    local major=${version%%.*}
    local rest=${version#*.}
    local minor=${rest%%.*}
    [ "$major" -gt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -ge 25 ]; }
}

sync_beta_source() {
    echo ""
    echo "Downloading the Frontier launcher source..."
    mkdir -p "$BETA_HOME"
    if [ -d "$BETA_SOURCE/.git" ]; then
        git -C "$BETA_SOURCE" remote set-url origin "$REPO_URL"
        git -C "$BETA_SOURCE" sparse-checkout init --cone >/dev/null
        git -C "$BETA_SOURCE" sparse-checkout set beta tools/rapp1 >/dev/null
        git -C "$BETA_SOURCE" config remote.origin.promisor true
        git -C "$BETA_SOURCE" config remote.origin.partialclonefilter blob:none
        git -C "$BETA_SOURCE" fetch --progress --filter=blob:none --depth 1 origin "$REPO_REF"
        git -C "$BETA_SOURCE" reset --hard FETCH_HEAD >/dev/null
    else
        if [ -e "$BETA_SOURCE" ]; then
            mv "$BETA_SOURCE" "$BETA_SOURCE.incomplete.$(date +%s)"
        fi
        mkdir -p "$BETA_SOURCE"
        git -C "$BETA_SOURCE" init --quiet
        git -C "$BETA_SOURCE" remote add origin "$REPO_URL"
        git -C "$BETA_SOURCE" sparse-checkout init --cone >/dev/null
        git -C "$BETA_SOURCE" sparse-checkout set beta tools/rapp1 >/dev/null
        git -C "$BETA_SOURCE" config remote.origin.promisor true
        git -C "$BETA_SOURCE" config remote.origin.partialclonefilter blob:none
        git -C "$BETA_SOURCE" fetch --progress --filter=blob:none --depth 1 origin "$REPO_REF"
        git -C "$BETA_SOURCE" reset --hard FETCH_HEAD >/dev/null
    fi

    if [ -n "$REPO_COMMIT" ]; then
        local actual_commit
        actual_commit=$(git -C "$BETA_SOURCE" rev-parse HEAD | tr 'A-F' 'a-f')
        [ "$actual_commit" = "$REPO_COMMIT" ] \
            || fail "beta checkout resolved to $actual_commit instead of $REPO_COMMIT"
    fi

    [ -f "$BETA_SOURCE/beta/package.json" ] || fail "beta/package.json is missing from $REPO_REF"
    [ ! -e "$BETA_SOURCE/solutions" ] || fail "solution bundles leaked into the beta launcher checkout"
    echo -e "  ${GREEN}[OK]${NC} Frontier checkout contains beta/ plus RAPP/1 test vectors"
}

stage_transition_rollback() {
    [ "${BRAINSTEM_BETA_TRANSITION_ROLLBACK:-0}" != "1" ] || return
    local installer_path="$0"
    local installer_name="${installer_path##*/}"
    case "$installer_name" in
        update-installer-*.sh) ;;
        *) return ;;
    esac

    local update_id="${installer_name#update-installer-}"
    update_id="${update_id%.sh}"
    local cache_dir
    cache_dir=$(cd -P -- "$(dirname -- "$installer_path")" && pwd -P)
    installer_path="$cache_dir/$installer_name"
    local request_path="$cache_dir/update-request-$update_id.json"
    local rollback_path="$cache_dir/rollback-installer-$update_id.sh"
    local node="${BRAINSTEM_BETA_NODE_EXE:-}"
    [ -x "$node" ] || fail "the legacy update transition is missing its managed Node runtime"
    [ -f "$request_path" ] || fail "the legacy update transition is missing its request"
    [ -f "$rollback_path" ] || fail "the legacy update transition is missing its rollback installer"
    TRANSITION_HELPER_BASE64="$TRANSITION_HELPER_BASE64" \
    "$node" \
        --input-type=module \
        -e "await import('data:text/javascript;base64,'+process.env.TRANSITION_HELPER_BASE64)" \
        dummy \
        "$request_path" \
        "$rollback_path" \
        "$installer_path" \
        || fail "the legacy update rollback could not be made safe"
}

setup_global_brainstem() {
    echo ""
    echo "Preparing the shared global Brainstem..."

    if [ "$PRESERVE_RUNTIME" = "1" ]; then
        case "$RUNTIME_COMMIT" in
            *[!0-9a-fA-F]*|"") fail "BRAINSTEM_BETA_RUNTIME_COMMIT must be a full 40-character commit SHA" ;;
        esac
        [ "${#RUNTIME_COMMIT}" -eq 40 ] \
            || fail "BRAINSTEM_BETA_RUNTIME_COMMIT must be a full 40-character commit SHA"
        [ -f "$BRAINSTEM_HOME/src/rapp_brainstem/brainstem.py" ] \
            || fail "the preserved Brainstem runtime is missing"
        [ -x "$BRAINSTEM_HOME/venv/bin/python" ] \
            || fail "the preserved Brainstem Python environment is missing"
        local preserved_commit
        preserved_commit=$(git -C "$BRAINSTEM_HOME/src" rev-parse HEAD | tr 'A-F' 'a-f')
        [ "$preserved_commit" = "$(printf '%s' "$RUNTIME_COMMIT" | tr 'A-F' 'a-f')" ] \
            || fail "the preserved Brainstem runtime is at $preserved_commit instead of $RUNTIME_COMMIT"
        echo -e "  ${GREEN}[OK]${NC} Preserved Brainstem runtime at $preserved_commit"
        return
    fi

    if [ -n "$REPO_COMMIT" ] && [ -z "$RELEASE_TAG" ]; then
        local release_version
        release_version=$(tr -d '[:space:]' < "$BETA_SOURCE/beta/VERSION")
        case "$release_version" in
            *[!0-9A-Za-z._-]*|"") fail "the pinned Frontier has an invalid VERSION" ;;
        esac
        RELEASE_TAG="brainstem-beta-v$release_version"
    fi

    local runtime_repo="$KERNEL_REPO_URL"
    local runtime_ref="$KERNEL_REPO_REF"
    if [ -n "$RELEASE_TAG" ]; then
        runtime_repo="$REPO_URL"
        runtime_ref="$RELEASE_TAG"
    fi

    local bootstrap
    bootstrap=$(mktemp "${TMPDIR:-/tmp}/openrappter-kernel-bootstrap-XXXXXX")
    if ! curl -fsSL "$KERNEL_BOOTSTRAP_URL" -o "$bootstrap"; then
        rm -f "$bootstrap"
        fail "the pinned Brainstem installer could not be downloaded"
    fi
    local bootstrap_hash
    bootstrap_hash=$(sha256_file "$bootstrap")
    if [ "$bootstrap_hash" != "$KERNEL_BOOTSTRAP_SHA256" ]; then
        rm -f "$bootstrap"
        fail "the pinned Brainstem installer checksum did not match"
    fi

    local status=0
    BRAINSTEM_HOME="$BRAINSTEM_HOME" \
    BRAINSTEM_BIN="$OPENRAPPTER_HOME/kernel-bin" \
    BRAINSTEM_REPO_URL="$runtime_repo" \
    BRAINSTEM_REPO_REF="$runtime_ref" \
    BRAINSTEM_VERSION_URL="$RUNTIME_VERSION_URL" \
        bash "$bootstrap" --no-launch || status=$?
    rm -f "$bootstrap"
    [ "$status" -eq 0 ] || fail "the global Brainstem installer failed"

    [ -f "$BRAINSTEM_HOME/src/rapp_brainstem/brainstem.py" ] \
        || fail "the global Brainstem runtime was not installed"
    [ -x "$BRAINSTEM_HOME/venv/bin/python" ] \
        || fail "the global Brainstem Python environment was not installed"
    [ ! -e "$BRAINSTEM_HOME/src/solutions" ] \
        || fail "solution bundles leaked into the global Brainstem checkout"
    if [ -n "$REPO_COMMIT" ]; then
        local runtime_commit
        runtime_commit=$(git -C "$BRAINSTEM_HOME/src" rev-parse HEAD | tr 'A-F' 'a-f')
        [ "$runtime_commit" = "$REPO_COMMIT" ] \
            || fail "Brainstem runtime resolved to $runtime_commit instead of $REPO_COMMIT"
    fi
}

node_platform() {
    local os arch
    case "$(uname -s)" in
        Darwin) os="darwin" ;;
        Linux) os="linux" ;;
        *) fail "the beta launcher supports macOS and Linux from install.sh" ;;
    esac
    case "$(uname -m)" in
        arm64|aarch64) arch="arm64" ;;
        x86_64|amd64) arch="x64" ;;
        *) fail "unsupported architecture: $(uname -m)" ;;
    esac
    echo "${os}-${arch}"
}

sha256_file() {
    if command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{print $1}'
    else
        sha256sum "$1" | awk '{print $1}'
    fi
}

install_portable_node() {
    local platform="$1"
    local node_dir="$BETA_HOME/node-v$NODE_VERSION-$platform"
    if [ -x "$node_dir/bin/node" ] \
        && [ "$("$node_dir/bin/node" --version)" = "v$NODE_VERSION" ]; then
        echo -e "  ${GREEN}[OK]${NC} Portable Node.js v$NODE_VERSION ready"
        PORTABLE_NODE_DIR="$node_dir"
        return
    fi

    local cache="$BETA_HOME/cache"
    local archive="node-v$NODE_VERSION-$platform.tar.gz"
    local archive_path="$cache/$archive"
    local sums="$cache/SHASUMS256-v$NODE_VERSION.txt"
    local base_url="https://nodejs.org/dist/v$NODE_VERSION"
    mkdir -p "$cache"
    echo "  Downloading portable Node.js v$NODE_VERSION..."
    curl -fL --progress-bar "$base_url/SHASUMS256.txt" -o "$sums"
    curl -fL --progress-bar "$base_url/$archive" -o "$archive_path"

    local expected actual
    expected=$(awk -v file="$archive" '$2 == file || $2 == "*" file {print $1; exit}' "$sums")
    [ -n "$expected" ] || fail "Node.js checksum entry is missing for $archive"
    actual=$(sha256_file "$archive_path")
    [ "$actual" = "$expected" ] || fail "Node.js archive checksum mismatch"

    local extract_dir="$BETA_HOME/node-extract-$$"
    rm -rf "$extract_dir" "$node_dir" 2>/dev/null || true
    mkdir -p "$extract_dir" "$node_dir"
    tar -xzf "$archive_path" --strip-components=1 -C "$node_dir"
    rm -rf "$extract_dir" 2>/dev/null || true
    [ -x "$node_dir/bin/node" ] || fail "portable Node.js extraction failed"
    echo -e "  ${GREEN}[OK]${NC} Portable Node.js verified"
    PORTABLE_NODE_DIR="$node_dir"
}

install_desktop_dependencies() {
    local node_dir="$1"
    export PATH="$node_dir/bin:$PATH"
    export npm_config_cache="$BETA_HOME/npm-cache"
    (
        cd "$BETA_SOURCE/beta"
        # --ignore-scripts: a package postinstall must not fetch and execute a
        # native binary during the factory install. ffmpeg-static's script
        # downloads an executable from a third-party release with NO checksum or
        # signature and chmods it 0755 — arbitrary native code, in the same
        # product that refuses a sha-mismatched agent.py. Electron's installer is
        # the one script we do want, so it is run explicitly on the next line.
        # This also honours CONSTITUTION.md Article II: capture/media tooling is
        # an opt-in organ, never part of the factory image.
        run_with_heartbeat "Installing Electron and bundled Copilot CLI" \
            "$node_dir/bin/npm" ci --ignore-scripts --no-audit --no-fund
        run_with_heartbeat "Installing Electron runtime" \
            "$node_dir/bin/node" node_modules/electron/install.js
        "$node_dir/bin/npm" run check
        BRAINSTEM_BETA_RUNTIME_DIR="$BRAINSTEM_HOME/src/rapp_brainstem" \
            "$node_dir/bin/npm" test
    )
}

write_launchers() {
    local platform="$1"
    local electron_bin
    if [[ "$platform" == darwin-* ]]; then
        electron_bin="$BETA_SOURCE/beta/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
    else
        electron_bin="$BETA_SOURCE/beta/node_modules/electron/dist/electron"
    fi
    [ -x "$electron_bin" ] || fail "Electron runtime is missing at $electron_bin"

    "$PORTABLE_NODE_DIR/bin/node" -e \
        'const fs=require("node:fs");fs.writeFileSync(process.argv[1],JSON.stringify({repositoryUrl:process.argv[2],updateRef:process.argv[3]},null,2)+"\n",{mode:0o600})' \
        "$BETA_HOME/update-config.json" "$REPO_URL" "$UPDATE_REF"

    local launcher="$BETA_HOME/launch.sh"
    cat > "$launcher" <<EOF
#!/bin/sh
export OPENRAPPTER_HOME="$OPENRAPPTER_HOME"
export OPENRAPPTER_BRAINSTEM_HOME="$BRAINSTEM_HOME"
export BRAINSTEM_HOME="$BRAINSTEM_HOME"
export BRAINSTEM_BETA_HOME="$BETA_HOME"
export BRAINSTEM_BETA_REPO_URL="$REPO_URL"
export BRAINSTEM_BETA_UPDATE_REF="$UPDATE_REF"
export BRAINSTEM_BETA_OWN_PORT="1"
exec "$electron_bin" "$BETA_SOURCE/beta" "\$@"
EOF
    chmod +x "$launcher"

    mkdir -p "$HOME/.local/bin"
    cat > "$HOME/.local/bin/openrappter-app" <<EOF
#!/bin/sh
exec "$launcher" "\$@"
EOF
    chmod +x "$HOME/.local/bin/openrappter-app"
    cat > "$HOME/.local/bin/brainstem-frontier" <<EOF
#!/bin/sh
exec "$HOME/.local/bin/openrappter-app" "\$@"
EOF
    chmod +x "$HOME/.local/bin/brainstem-frontier"
    cat > "$HOME/.local/bin/brainstem-beta" <<EOF
#!/bin/sh
exec "$HOME/.local/bin/brainstem-frontier" "\$@"
EOF
    chmod +x "$HOME/.local/bin/brainstem-beta"

    local surgeon_launcher="$BETA_HOME/surgeon-chat.sh"
    cat > "$surgeon_launcher" <<EOF
#!/bin/sh
export BRAINSTEM_HOME="$BRAINSTEM_HOME"
export BRAINSTEM_BETA_HOME="$BETA_HOME"
export BRAINSTEM_BETA_LAUNCHER="$launcher"
exec "$PORTABLE_NODE_DIR/bin/node" "$BETA_SOURCE/beta/scripts/surgeon-chat.mjs" "\$@"
EOF
    chmod +x "$surgeon_launcher"
    cat > "$HOME/.local/bin/openrappter-surgeon" <<EOF
#!/bin/sh
exec "$surgeon_launcher" "\$@"
EOF
    chmod +x "$HOME/.local/bin/openrappter-surgeon"
    cat > "$HOME/.local/bin/brainstem-surgeon" <<EOF
#!/bin/sh
exec "$HOME/.local/bin/openrappter-surgeon" "\$@"
EOF
    chmod +x "$HOME/.local/bin/brainstem-surgeon"

    local chat_launcher="$BETA_HOME/openrappter-chat.sh"
    cat > "$chat_launcher" <<EOF
#!/bin/sh
export OPENRAPPTER_HOME="$OPENRAPPTER_HOME"
export BRAINSTEM_HOME="$BRAINSTEM_HOME"
export BRAINSTEM_BETA_HOME="$BETA_HOME"
export BRAINSTEM_BETA_LAUNCHER="$launcher"
exec "$PORTABLE_NODE_DIR/bin/node" "$BETA_SOURCE/beta/scripts/openrappter-chat.mjs" "\$@"
EOF
    chmod +x "$chat_launcher"
    cat > "$HOME/.local/bin/openrappter-chat" <<EOF
#!/bin/sh
exec "$chat_launcher" "\$@"
EOF
    chmod +x "$HOME/.local/bin/openrappter-chat"

    local drive_launcher="$BETA_HOME/openrappter-drive.sh"
    cat > "$drive_launcher" <<EOF
#!/bin/sh
export OPENRAPPTER_HOME="$OPENRAPPTER_HOME"
export BRAINSTEM_HOME="$BRAINSTEM_HOME"
export BRAINSTEM_BETA_HOME="$BETA_HOME"
export BRAINSTEM_BETA_LAUNCHER="$launcher"
exec "$PORTABLE_NODE_DIR/bin/node" "$BETA_SOURCE/beta/scripts/brainstem-chat.mjs" "\$@"
EOF
    chmod +x "$drive_launcher"
    cat > "$HOME/.local/bin/openrappter-drive" <<EOF
#!/bin/sh
exec "$drive_launcher" "\$@"
EOF
    chmod +x "$HOME/.local/bin/openrappter-drive"
    cat > "$HOME/.local/bin/brainstem-chat" <<EOF
#!/bin/sh
exec "$HOME/.local/bin/openrappter-drive" "\$@"
EOF
    chmod +x "$HOME/.local/bin/brainstem-chat"

    local walkthrough_launcher="$BETA_HOME/brainstem-walkthrough.sh"
    cat > "$walkthrough_launcher" <<EOF
#!/bin/sh
export BRAINSTEM_HOME="$BRAINSTEM_HOME"
export BRAINSTEM_BETA_HOME="$BETA_HOME"
export BRAINSTEM_BETA_LAUNCHER="$launcher"
exec "$PORTABLE_NODE_DIR/bin/node" "$BETA_SOURCE/beta/scripts/walkthrough-via-chat.mjs" "\$@"
EOF
    chmod +x "$walkthrough_launcher"
    cat > "$HOME/.local/bin/openrappter-walkthrough" <<EOF
#!/bin/sh
exec "$walkthrough_launcher" "\$@"
EOF
    chmod +x "$HOME/.local/bin/openrappter-walkthrough"
    cat > "$HOME/.local/bin/brainstem-walkthrough" <<EOF
#!/bin/sh
exec "$HOME/.local/bin/openrappter-walkthrough" "\$@"
EOF
    chmod +x "$HOME/.local/bin/brainstem-walkthrough"

    local tile_launcher="$BETA_HOME/openrappter-tile.sh"
    cat > "$tile_launcher" <<EOF
#!/bin/sh
: "\${BRAINSTEM_HOME:=$BRAINSTEM_HOME}"
: "\${BRAINSTEM_BETA_HOME:=$BETA_HOME}"
: "\${BRAINSTEM_BETA_SOURCE_DIR:=$BRAINSTEM_RUNTIME_DIR}"
export BRAINSTEM_HOME BRAINSTEM_BETA_HOME BRAINSTEM_BETA_SOURCE_DIR
exec "$PORTABLE_NODE_DIR/bin/node" "$BETA_SOURCE/beta/scripts/openrappter-tile.mjs" "\$@"
EOF
    chmod +x "$tile_launcher"
    cat > "$HOME/.local/bin/openrappter-tile" <<EOF
#!/bin/sh
exec "$tile_launcher" "\$@"
EOF
    chmod +x "$HOME/.local/bin/openrappter-tile"

    local pack_launcher="$BETA_HOME/rappter-pack.sh"
    cat > "$pack_launcher" <<EOF
#!/bin/sh
: "\${OPENRAPPTER_HOME:=$OPENRAPPTER_HOME}"
: "\${BRAINSTEM_HOME:=$BRAINSTEM_HOME}"
: "\${BRAINSTEM_BETA_HOME:=$BETA_HOME}"
export OPENRAPPTER_HOME BRAINSTEM_HOME BRAINSTEM_BETA_HOME
exec "$PORTABLE_NODE_DIR/bin/node" "$BETA_SOURCE/beta/scripts/rappter-pack.mjs" "\$@"
EOF
    chmod +x "$pack_launcher"
    cat > "$HOME/.local/bin/openrappter-pack" <<EOF
#!/bin/sh
exec "$pack_launcher" "\$@"
EOF
    chmod +x "$HOME/.local/bin/openrappter-pack"

    local pack_node_launcher="$BETA_HOME/rappter-pack-node.sh"
    cat > "$pack_node_launcher" <<EOF
#!/bin/sh
: "\${OPENRAPPTER_HOME:=$OPENRAPPTER_HOME}"
: "\${BRAINSTEM_HOME:=$BRAINSTEM_HOME}"
: "\${BRAINSTEM_BETA_HOME:=$BETA_HOME}"
export OPENRAPPTER_HOME BRAINSTEM_HOME BRAINSTEM_BETA_HOME
exec "$PORTABLE_NODE_DIR/bin/node" "$BETA_SOURCE/beta/scripts/rappter-pack-node.mjs"
EOF
    chmod +x "$pack_node_launcher"
    cat > "$HOME/.local/bin/openrappter-pack-node" <<EOF
#!/bin/sh
exec "$pack_node_launcher"
EOF
    chmod +x "$HOME/.local/bin/openrappter-pack-node"

    local hatch_launcher="$BETA_HOME/openrappter-hatch.sh"
    cat > "$hatch_launcher" <<EOF
#!/bin/sh
: "\${OPENRAPPTER_HOME:=$OPENRAPPTER_HOME}"
: "\${BRAINSTEM_HOME:=$BRAINSTEM_HOME}"
: "\${BRAINSTEM_BETA_SOURCE_DIR:=$BRAINSTEM_RUNTIME_DIR}"
: "\${BRAINSTEM_BETA_PYTHON:=$BRAINSTEM_PYTHON}"
: "\${RAPPTER_PACK_CONFIG:=\${OPENRAPPTER_HOME}/pack.json}"
export OPENRAPPTER_HOME BRAINSTEM_HOME BRAINSTEM_BETA_SOURCE_DIR
export BRAINSTEM_BETA_PYTHON RAPPTER_PACK_CONFIG
exec "$PORTABLE_NODE_DIR/bin/node" "$BETA_SOURCE/beta/scripts/openrappter-hatch.mjs" "\$@"
EOF
    chmod +x "$hatch_launcher"
    cat > "$HOME/.local/bin/openrappter-hatch" <<EOF
#!/bin/sh
exec "$hatch_launcher" "\$@"
EOF
    chmod +x "$HOME/.local/bin/openrappter-hatch"

    if [[ "$platform" == darwin-* ]]; then
        local app_dir="$HOME/Applications/OpenRappter.app"
        local legacy_app_dir
        for legacy_app_dir in \
            "$HOME/Applications/RAPP Brainstem Frontier.app" \
            "$HOME/Applications/RAPP Brainstem Beta.app"; do
            if [[ -d "$legacy_app_dir" ]]; then
                rm -rf "$legacy_app_dir"
            fi
        done
        mkdir -p "$app_dir/Contents/MacOS"
        cat > "$app_dir/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>OpenRappter</string>
  <key>CFBundleDisplayName</key><string>OpenRappter</string>
  <key>CFBundleIdentifier</key><string>io.github.kody-w.openrappter</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>OpenRappter</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
</dict></plist>
EOF
        cat > "$app_dir/Contents/MacOS/OpenRappter" <<EOF
#!/bin/sh
exec "$launcher"
EOF
        chmod +x "$app_dir/Contents/MacOS/OpenRappter"
        echo -e "  ${GREEN}[OK]${NC} App installed: $app_dir"
    else
        local applications="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
        mkdir -p "$applications"
        rm -f \
            "$applications/rapp-brainstem-beta.desktop" \
            "$applications/rapp-brainstem-frontier.desktop"
        cat > "$applications/openrappter.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=OpenRappter
Comment=Local-first AI agent application powered by GitHub Copilot
Exec="$launcher"
Terminal=false
Categories=Development;Utility;
StartupNotify=true
EOF
        chmod +x "$applications/openrappter.desktop"
        echo -e "  ${GREEN}[OK]${NC} Desktop entry installed"
    fi

    BETA_LAUNCHER_PATH="$launcher"
}

main() {
    echo ""
    echo -e "${CYAN}OpenRappter Launcher${NC}"
    echo "The full local-first OpenRappter application"
    echo ""

    stage_transition_rollback
    require_command curl
    require_command git
    require_command tar
    validate_source_ref
    git_supports_sparse_checkout || fail "Git 2.25+ is required"

    sync_beta_source
    setup_global_brainstem
    local platform
    platform=$(node_platform)
    install_portable_node "$platform"
    install_desktop_dependencies "$PORTABLE_NODE_DIR"
    write_launchers "$platform"

    echo ""
    echo -e "  ${GREEN}[OK] OpenRappter is installed.${NC}"
    echo "  Brainstem runtime data: $BRAINSTEM_HOME"
    echo "  Start later with: openrappter-app"
    echo ""
    if [ "$NO_LAUNCH" != "1" ]; then
        nohup "$BETA_LAUNCHER_PATH" >"$BETA_HOME/launcher.log" 2>&1 &
        echo "  Launcher started in the background."
    fi
}

main "$@"
