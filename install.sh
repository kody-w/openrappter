#!/bin/bash
set -euo pipefail

# OpenRappter Installer for macOS and Linux
# Usage: curl -fsSL https://kody-w.github.io/openrappter/install.sh | bash

# Prevent sharp from trying to download global libvips (causes build failures in CI/Docker)
export SHARP_IGNORE_GLOBAL_LIBVIPS=1

BOLD='\033[1m'
ACCENT='\033[38;2;16;185;129m'       # green-bright  #10b981
# shellcheck disable=SC2034
ACCENT_BRIGHT='\033[38;2;52;211;153m' # lighter green #34d399
INFO='\033[38;2;136;146;176m'        # text-secondary #8892b0
SUCCESS='\033[38;2;0;229;204m'       # cyan-bright   #00e5cc
# The numeral accent in menus. It was referenced by the install-method chooser
# and never defined, so under `set -euo pipefail` every interactive install
# printed an unbound-variable error at the exact moment a person was choosing
# how to install. Its own name rather than reusing SUCCESS, so that a menu
# number does not read as a success signal.
CYAN='\033[38;2;0;229;204m'          # cyan-bright   #00e5cc
WARN='\033[38;2;255;176;32m'         # amber
ERROR='\033[38;2;230;57;70m'         # coral-mid     #e63946
MUTED='\033[38;2;90;100;128m'        # text-muted    #5a6480
NC='\033[0m' # No Color

DEFAULT_TAGLINE="AI agents powered by your existing GitHub Copilot subscription."

ORIGINAL_PATH="${PATH:-}"
RESOLVED_RING_VERSION=""
RESOLVED_RING_ARTIFACT=""
RESOLVED_RING_SHA256=""
RESOLVED_RING_COMMIT=""
RESOLVED_RING_STATUS=""
RESOLVED_RING_REASON=""
RESOLVED_RING_PROVENANCE=""

TMPFILES=()
cleanup_tmpfiles() {
    local f
    for f in "${TMPFILES[@]:-}"; do
        rm -rf "$f" 2>/dev/null || true
    done
}
trap cleanup_tmpfiles EXIT

mktempfile() {
    local f
    f="$(mktemp)"
    TMPFILES+=("$f")
    echo "$f"
}

DOWNLOADER=""
detect_downloader() {
    if command -v curl &> /dev/null; then
        DOWNLOADER="curl"
        return 0
    fi
    if command -v wget &> /dev/null; then
        DOWNLOADER="wget"
        return 0
    fi
    ui_error "Missing downloader (curl or wget required)"
    exit 1
}

download_file() {
    local url="$1"
    local output="$2"
    if [[ -z "$DOWNLOADER" ]]; then
        detect_downloader
    fi
    if [[ "$DOWNLOADER" == "curl" ]]; then
        curl -fsSL --proto '=https' --tlsv1.2 --retry 3 --retry-delay 1 --retry-connrefused -o "$output" "$url"
        return
    fi
    wget -q --https-only --secure-protocol=TLSv1_2 --tries=3 --timeout=20 -O "$output" "$url"
}

# Third-party bootstrap scripts, pinned to an immutable revision and hashed.
# rapp-local-install/1.0 sections 3.1 (pin or refuse) and 3.2 (never execute an
# unverified remote script). Refresh deliberately, after reading the diff:
#
#   commit="$(gh api repos/Homebrew/install/commits/HEAD --jq .sha)"
#   curl -sS "https://raw.githubusercontent.com/Homebrew/install/$commit/install.sh" | shasum -a 256
#
# A tag is NOT a pin - tags move. Homebrew is pinned by commit; nvm publishes
# immutable release tags but is hash-verified regardless, because the tag being
# immutable is a promise rather than something we can check.
HOMEBREW_INSTALL_COMMIT="609e8f75a42bcad1ce90acaf4e15fc89aebaf026"
HOMEBREW_INSTALL_SHA256="12479a24be3f5307eecac7cde670fad7118640f031229e964f544b1367b52a41"
NVM_INSTALL_REF="v0.40.1"
NVM_INSTALL_SHA256="abdb525ee9f5b48b34d8ed9fc67c6013fb0f659712e401ecd88ab989b3af8f53"

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{print $1}'
    else
        return 1
    fi
}

# Download a script, verify it against an expected SHA-256, and only then run it.
# Fails closed on every path, including the one where no hashing tool exists -
# an unverifiable script is not a script we run.
run_verified_remote_bash() {
    local url="$1" expected="$2" label="${3:-remote script}"
    case "$url" in
        https://*) ;;
        *) ui_error "Refusing non-HTTPS download for $label: $url"; return 1 ;;
    esac

    local tmp actual
    tmp="$(mktempfile)"
    if ! download_file "$url" "$tmp"; then
        ui_error "Could not download $label - refusing to continue"
        return 1
    fi
    if ! actual="$(sha256_of "$tmp")" || [[ -z "$actual" ]]; then
        ui_error "No SHA-256 tool available - refusing to run unverified $label"
        return 1
    fi
    if [[ "$actual" != "$expected" ]]; then
        ui_error "$label checksum mismatch (expected $expected, got $actual)"
        ui_error "Upstream changed. Review the diff, then update the pin in install.sh."
        return 1
    fi
    /bin/bash "$tmp"
}

# ── Retry wrapper for network operations ────────────────────
retry() {
    local max_attempts="$1"
    local delay="$2"
    shift 2
    local attempt=1
    while true; do
        if "$@"; then
            return 0
        fi
        if [[ "$attempt" -ge "$max_attempts" ]]; then
            return 1
        fi
        ui_info "Retrying ($attempt/$max_attempts) in ${delay}s..."
        sleep "$delay"
        ((attempt++))
        delay=$((delay * 2 > 30 ? 30 : delay * 2))
    done
}

# ── Gum (fancy terminal UI) ────────────────────────────────
GUM_VERSION="${OPENRAPPTER_GUM_VERSION:-0.17.0}"
GUM=""
GUM_STATUS="skipped"
GUM_REASON=""

has_controlling_tty() {
    { : </dev/tty; } 2>/dev/null && { : >/dev/tty; } 2>/dev/null
}

gum_is_tty() {
    if [[ -n "${NO_COLOR:-}" ]]; then
        return 1
    fi
    if [[ "${TERM:-dumb}" == "dumb" ]]; then
        return 1
    fi
    if [[ -t 2 || -t 1 ]]; then
        return 0
    fi
    if has_controlling_tty; then
        return 0
    fi
    return 1
}

gum_detect_os() {
    case "$(uname -s 2>/dev/null || true)" in
        Darwin) echo "Darwin" ;;
        Linux) echo "Linux" ;;
        *) echo "unsupported" ;;
    esac
}

gum_detect_arch() {
    case "$(uname -m 2>/dev/null || true)" in
        x86_64|amd64) echo "x86_64" ;;
        arm64|aarch64) echo "arm64" ;;
        i386|i686) echo "i386" ;;
        armv7l|armv7) echo "armv7" ;;
        armv6l|armv6) echo "armv6" ;;
        *) echo "unknown" ;;
    esac
}

verify_sha256sum_file() {
    local checksums="$1"
    local target="$2"
    # `--ignore-missing` is required here: the checksums file lists every
    # platform's asset and only one was downloaded. But GNU sha256sum exits 0
    # when that leaves it nothing to verify at all, so an asset simply absent
    # from the list reads as a pass — anyone able to serve the release could
    # omit the line rather than forge a hash. macOS `shasum` exits 1 in that
    # case, so the safe behaviour depended on which tool happened to be
    # installed, and sha256sum is preferred below.
    #
    # Require the file we actually downloaded to be named before believing any
    # verdict. Exact match on the final field, allowing the `*` binary-mode
    # marker some tools emit.
    if ! awk -v t="$target" '
        { name = $NF; sub(/^\*/, "", name); if (name == t) found = 1 }
        END { exit found ? 0 : 1 }
    ' "$checksums" 2>/dev/null; then
        return 1
    fi
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum --ignore-missing -c "$checksums" >/dev/null 2>&1
        return $?
    fi
    if command -v shasum >/dev/null 2>&1; then
        shasum -a 256 --ignore-missing -c "$checksums" >/dev/null 2>&1
        return $?
    fi
    return 1
}

bootstrap_gum_temp() {
    GUM=""
    GUM_STATUS="skipped"
    GUM_REASON=""

    case "$OPENRAPPTER_USE_GUM" in
        0|false|False|FALSE|off|OFF|no|NO)
            GUM_REASON="disabled via OPENRAPPTER_USE_GUM"
            return 1
            ;;
    esac

    if ! gum_is_tty; then
        GUM_REASON="not a TTY"
        return 1
    fi

    if command -v gum >/dev/null 2>&1; then
        GUM="gum"
        GUM_STATUS="found"
        GUM_REASON="already installed"
        return 0
    fi

    if [[ "$OPENRAPPTER_USE_GUM" != "1" && "$OPENRAPPTER_USE_GUM" != "true" && "$OPENRAPPTER_USE_GUM" != "TRUE" ]]; then
        if [[ "$OPENRAPPTER_USE_GUM" != "auto" ]]; then
            GUM_REASON="invalid OPENRAPPTER_USE_GUM value: $OPENRAPPTER_USE_GUM"
            return 1
        fi
    fi

    if ! command -v tar >/dev/null 2>&1; then
        GUM_REASON="tar not found"
        return 1
    fi

    local os arch asset base gum_tmpdir gum_path
    os="$(gum_detect_os)"
    arch="$(gum_detect_arch)"
    if [[ "$os" == "unsupported" || "$arch" == "unknown" ]]; then
        GUM_REASON="unsupported os/arch ($os/$arch)"
        return 1
    fi

    asset="gum_${GUM_VERSION}_${os}_${arch}.tar.gz"
    base="https://github.com/charmbracelet/gum/releases/download/v${GUM_VERSION}"

    gum_tmpdir="$(mktemp -d)"
    TMPFILES+=("$gum_tmpdir")

    if ! download_file "${base}/${asset}" "$gum_tmpdir/$asset"; then
        GUM_REASON="download failed"
        return 1
    fi

    if ! download_file "${base}/checksums.txt" "$gum_tmpdir/checksums.txt"; then
        GUM_REASON="checksum unavailable or failed"
        return 1
    fi

    if ! (cd "$gum_tmpdir" && verify_sha256sum_file "checksums.txt" "$asset"); then
        GUM_REASON="checksum unavailable or failed"
        return 1
    fi

    if ! tar -xzf "$gum_tmpdir/$asset" -C "$gum_tmpdir" >/dev/null 2>&1; then
        GUM_REASON="extract failed"
        return 1
    fi

    gum_path="$(find "$gum_tmpdir" -type f -name gum 2>/dev/null | head -n1 || true)"
    if [[ -z "$gum_path" ]]; then
        GUM_REASON="gum binary missing after extract"
        return 1
    fi

    chmod +x "$gum_path" >/dev/null 2>&1 || true
    if [[ ! -x "$gum_path" ]]; then
        GUM_REASON="gum binary is not executable"
        return 1
    fi

    GUM="$gum_path"
    GUM_STATUS="installed"
    GUM_REASON="temp, verified"
    return 0
}

print_gum_status() {
    case "$GUM_STATUS" in
        found)
            ui_success "gum available (${GUM_REASON})"
            ;;
        installed)
            ui_success "gum bootstrapped (${GUM_REASON}, v${GUM_VERSION})"
            ;;
        *)
            if [[ -n "$GUM_REASON" ]]; then
                ui_info "gum skipped (${GUM_REASON})"
            fi
            ;;
    esac
}

# ── UI Functions ────────────────────────────────────────────
print_installer_banner() {
    if [[ -n "$GUM" ]]; then
        local title tagline hint card
        title="$("$GUM" style --foreground "#10b981" --bold "🦖 OpenRappter Installer")"
        tagline="$("$GUM" style --foreground "#8892b0" "$TAGLINE")"
        hint="$("$GUM" style --foreground "#5a6480" "modern installer mode")"
        card="$(printf '%s\n%s\n%s' "$title" "$tagline" "$hint")"
        "$GUM" style --border rounded --border-foreground "#10b981" --padding "1 2" "$card"
        echo ""
        return
    fi

    echo -e "${ACCENT}${BOLD}"
    echo "  🦖 OpenRappter Installer"
    echo -e "${NC}${INFO}  ${TAGLINE}${NC}"
    echo ""
}

detect_os_or_die() {
    OS="unknown"
    if [[ "$OSTYPE" == "darwin"* ]]; then
        OS="macos"
    elif [[ "$OSTYPE" == "linux-gnu"* ]] || [[ -n "${WSL_DISTRO_NAME:-}" ]]; then
        OS="linux"
    fi

    if [[ "$OS" == "unknown" ]]; then
        ui_error "Unsupported operating system"
        echo "This installer supports macOS and Linux (including WSL)."
        exit 1
    fi

    ui_success "Detected: $OS"
}

detect_arch() {
    case "$(uname -m 2>/dev/null || true)" in
        x86_64|amd64) echo "x64" ;;
        arm64|aarch64) echo "arm64" ;;
        *) uname -m ;;
    esac
}

ui_info() {
    local msg="$*"
    if [[ -n "$GUM" ]]; then
        "$GUM" log --level info "$msg"
    else
        echo -e "${MUTED}·${NC} ${msg}"
    fi
}

ui_warn() {
    local msg="$*"
    if [[ -n "$GUM" ]]; then
        "$GUM" log --level warn "$msg"
    else
        echo -e "${WARN}!${NC} ${msg}"
    fi
}

ui_success() {
    local msg="$*"
    if [[ -n "$GUM" ]]; then
        local mark
        mark="$("$GUM" style --foreground "#00e5cc" --bold "✓")"
        echo "${mark} ${msg}"
    else
        echo -e "${SUCCESS}✓${NC} ${msg}"
    fi
}

ui_error() {
    local msg="$*"
    if [[ -n "$GUM" ]]; then
        "$GUM" log --level error "$msg"
    else
        echo -e "${ERROR}✗${NC} ${msg}"
    fi
}

INSTALL_STAGE_TOTAL=4
INSTALL_STAGE_CURRENT=0

ui_section() {
    local title="$1"
    if [[ -n "$GUM" ]]; then
        "$GUM" style --bold --foreground "#10b981" --padding "1 0" "$title"
    else
        echo ""
        echo -e "${ACCENT}${BOLD}${title}${NC}"
    fi
}

ui_stage() {
    local title="$1"
    INSTALL_STAGE_CURRENT=$((INSTALL_STAGE_CURRENT + 1))
    ui_section "[${INSTALL_STAGE_CURRENT}/${INSTALL_STAGE_TOTAL}] ${title}"
}

# Set expectations before the first long step.
#
# The most common "it's broken" report is someone hitting Ctrl-C during a
# perfectly healthy `pip install`. Saying up front how long this takes, and
# that a spinner means progress, costs one line and prevents that.
ui_patience_notice() {
    [[ "$DRY_RUN" == "1" ]] && return 0
    echo ""
    echo -e "${MUTED}This part downloads and builds things, so it can take 1-5 minutes.${NC}"
    echo -e "${MUTED}A spinner with a running clock means it is working — please don't quit.${NC}"
    echo -e "${MUTED}Nothing is stuck unless the clock stops.${NC}"
    echo ""
}

ui_kv() {
    local key="$1"
    local value="$2"
    if [[ -n "$GUM" ]]; then
        local key_part value_part
        key_part="$("$GUM" style --foreground "#5a6480" --width 20 "$key")"
        value_part="$("$GUM" style --bold "$value")"
        "$GUM" join --horizontal "$key_part" "$value_part"
    else
        echo -e "${MUTED}${key}:${NC} ${value}"
    fi
}

ui_panel() {
    local content="$1"
    if [[ -n "$GUM" ]]; then
        "$GUM" style --border rounded --border-foreground "#5a6480" --padding "0 1" "$content"
    else
        echo "$content"
    fi
}

ui_celebrate() {
    local msg="$1"
    if [[ -n "$GUM" ]]; then
        "$GUM" style --bold --foreground "#00e5cc" "$msg"
    else
        echo -e "${SUCCESS}${BOLD}${msg}${NC}"
    fi
}

# Numpad-friendly menu: type a number to choose (no arrow keys needed)
# Usage: ui_choose "Header text" "Option A" "Option B" ...
# Returns: selected option text on stdout
# Supports gum as visual upgrade, falls back to pure bash numpad input
ui_choose() {
    local header="$1"
    shift
    local options=("$@")
    local count=${#options[@]}

    if [[ "$count" -eq 0 ]]; then
        return 1
    fi

    # Single option — auto-select
    if [[ "$count" -eq 1 ]]; then
        echo "${options[0]}"
        return 0
    fi

    # Display header and numbered options
    echo "" >&2
    echo -e "${ACCENT}${BOLD}${header}${NC}" >&2
    echo "" >&2
    for i in "${!options[@]}"; do
        local num=$((i + 1))
        echo -e "  ${CYAN}${BOLD}${num}${NC}  ${options[$i]}" >&2
    done
    echo "" >&2

    # Read numpad input
    while true; do
        echo -n -e "${MUTED}Enter number [1-${count}]:${NC} " >&2
        local input=""
        if { read -r input </dev/tty; } 2>/dev/null; then
            :
        elif ! read -r input; then
            echo -e "${WARN}  No interactive input available${NC}" >&2
            return 1
        fi
        # Strip whitespace
        input="${input// /}"
        if [[ "$input" =~ ^[0-9]+$ ]] && (( input >= 1 && input <= count )); then
            echo "${options[$((input - 1))]}"
            return 0
        fi
        echo -e "${WARN}  Please enter a number between 1 and ${count}${NC}" >&2
    done
}

is_shell_function() {
    local name="${1:-}"
    [[ -n "$name" ]] && declare -F "$name" >/dev/null 2>&1
}

run_with_spinner() {
    local title="$1"
    shift

    if [[ -n "$GUM" ]] && gum_is_tty && ! is_shell_function "${1:-}"; then
        "$GUM" spin --spinner dot --title "$title" -- "$@"
        return $?
    fi

    # No gum. A shell function must run in this shell to keep the state it
    # sets, so it cannot be backgrounded — but it can still be announced.
    if is_shell_function "${1:-}"; then
        printf '%b·%b %s ...\n' "$MUTED" "$NC" "$title"
        "$@"
        return $?
    fi

    # In verbose mode the user asked to see the output, so let it through and
    # just bracket it with a timed line rather than hiding it behind a spinner.
    if [[ "${VERBOSE:-0}" == "1" ]]; then
        printf '%b·%b %s ...\n' "$MUTED" "$NC" "$title"
        local start=$SECONDS rc=0
        "$@" || rc=$?
        if (( rc == 0 )); then
            printf '%b✓%b %s %b(%ds)%b\n' "$SUCCESS" "$NC" "$title" "$MUTED" "$((SECONDS - start))" "$NC"
        fi
        return $rc
    fi

    local log
    log="$(mktempfile)"
    run_with_progress "$title" "$log" "$@"
}

# ── Progress for long, silent steps ──────────────────────────────────────
#
# Most people install without gum, and the old fallback ran the command with no
# output at all. `pip install` and `npm install -g` can sit silent for minutes,
# which looks exactly like a hang — so people hit Ctrl-C and report it broken.
#
# This shows a live spinner with elapsed time, and after a while says out loud
# that slow is expected. Everything degrades: no TTY prints plain progress
# lines, so piped and CI output stays readable.

SPINNER_FRAMES='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'

# Steps that genuinely take minutes, so the copy can say so up front.
step_is_slow() {
    case "$1" in
        *pip*|*Python*|*python*|*venv*|*npm*|*node*|*Node*|*download*|*Download*|*build*|*Build*|*Xcode*|*brew*)
            return 0 ;;
        *) return 1 ;;
    esac
}

# Reassurance shown while a slow step runs, so silence reads as normal.
spinner_reassurance() {
    local elapsed="$1" title="$2"
    if (( elapsed >= 180 )); then
        printf 'still working — large downloads can take several minutes'
    elif (( elapsed >= 60 )); then
        if step_is_slow "$title"; then
            printf 'this one is slow by nature — safe to leave running'
        else
            printf 'still going'
        fi
    elif (( elapsed >= 20 )); then
        printf 'working'
    fi
}

# Run a command with a live progress indicator. Returns the command's status.
run_with_progress() {
    local title="$1" log="$2"
    shift 2

    if ! gum_is_tty || [[ ! -t 1 && ! -t 2 ]]; then
        # Not a terminal: no cursor tricks, just say what is happening. A
        # heartbeat keeps CI logs from looking stalled too.
        printf '%b·%b %s ... ' "$MUTED" "$NC" "$title"
        local start_plain=$SECONDS
        "$@" >"$log" 2>&1 &
        local pid_plain=$!
        local ticks=0
        while kill -0 "$pid_plain" 2>/dev/null; do
            sleep 1
            ticks=$((ticks + 1))
            # A heartbeat every 30s, so a piped or CI log never looks stalled
            # without drowning it in noise.
            if (( ticks % 30 == 0 )); then
                printf '[%ds] ' "$((SECONDS - start_plain))"
            fi
        done
        wait "$pid_plain"
        local status_plain=$?
        if (( status_plain == 0 )); then
            printf 'done (%ds)\n' "$((SECONDS - start_plain))"
        else
            printf 'failed (%ds)\n' "$((SECONDS - start_plain))"
        fi
        return $status_plain
    fi

    "$@" >"$log" 2>&1 &
    local pid=$!
    local start=$SECONDS
    local frame=0

    # Never leave the cursor hidden if the user interrupts.
    printf '\033[?25l'
    trap 'printf "\033[?25h\n"; exit 130' INT TERM

    while kill -0 "$pid" 2>/dev/null; do
        local elapsed=$((SECONDS - start))
        local char="${SPINNER_FRAMES:frame%10:1}"
        local note
        note="$(spinner_reassurance "$elapsed" "$title")"

        if (( elapsed >= 10 )); then
            printf '\r\033[K%b%s%b %s %b(%ds%s)%b' \
                "$ACCENT" "$char" "$NC" "$title" \
                "$MUTED" "$elapsed" "${note:+ · $note}" "$NC"
        else
            printf '\r\033[K%b%s%b %s' "$ACCENT" "$char" "$NC" "$title"
        fi

        frame=$((frame + 1))
        sleep 0.1
    done

    wait "$pid"
    local status=$?
    local total=$((SECONDS - start))

    trap - INT TERM
    printf '\033[?25h'
    printf '\r\033[K'

    if (( status == 0 )); then
        if (( total >= 5 )); then
            printf '%b✓%b %s %b(%ds)%b\n' "$SUCCESS" "$NC" "$title" "$MUTED" "$total" "$NC"
        else
            printf '%b✓%b %s\n' "$SUCCESS" "$NC" "$title"
        fi
    else
        printf '%b✗%b %s %b(%ds)%b\n' "$ERROR" "$NC" "$title" "$MUTED" "$total" "$NC"
    fi

    return $status
}

run_quiet_step() {
    local title="$1"
    shift

    if [[ "$VERBOSE" == "1" ]]; then
        run_with_spinner "$title" "$@"
        return $?
    fi

    local log
    log="$(mktempfile)"

    if [[ -n "$GUM" ]] && gum_is_tty && ! is_shell_function "${1:-}"; then
        local cmd_quoted=""
        local log_quoted=""
        printf -v cmd_quoted '%q ' "$@"
        printf -v log_quoted '%q' "$log"
        if "$GUM" spin --spinner dot --title "$title" -- bash -c "${cmd_quoted}>${log_quoted} 2>&1"; then
            return 0
        fi
    elif is_shell_function "${1:-}"; then
        # A shell function cannot be backgrounded into a subshell without
        # losing the state it sets, so it runs inline — announced, not silent.
        printf '%b·%b %s ...\n' "$MUTED" "$NC" "$title"
        if "$@" >"$log" 2>&1; then
            ui_success "$title"
            return 0
        fi
    else
        # run_with_progress prints its own ✓/✗ line with timing.
        if run_with_progress "$title" "$log" "$@"; then
            return 0
        fi
    fi

    ui_error "${title} failed — re-run with --verbose for details"
    if [[ -s "$log" ]]; then
        tail -n 80 "$log" >&2 || true
    fi
    return 1
}

show_install_plan() {
    ui_section "Install plan"
    ui_kv "OS" "$OS"
    ui_kv "Method" "${INSTALL_METHOD:-auto}"
    # Surface the ring here so a dry run can preview which train car it would
    # install from; the npm stage is never reached under --dry-run.
    if [[ "$INSTALL_METHOD" != "git" ]]; then
        local plan_ring plan_spec
        if plan_ring="$(effective_channel)" && plan_spec="$(resolve_pkg_spec)"; then
            ui_kv "Release ring" "${plan_ring}"
            ui_kv "Package" "${plan_spec}"
        fi
    fi
    if [[ "$INSTALL_METHOD" == "git" ]]; then
        ui_kv "Install directory" "$INSTALL_DIR"
    fi
    ui_kv "Node.js minimum" "v${MIN_NODE}+"
    ui_kv "Python" "optional (3.${MIN_PYTHON_MINOR}+)"
    if [[ "${OPT_NO_COPILOT:-false}" == "true" ]]; then
        ui_kv "Copilot" "skipped (--no-copilot)"
    fi
    if [[ "$DRY_RUN" == "1" ]]; then
        ui_kv "Dry run" "yes"
    fi
}

show_footer_links() {
    local docs_url="https://kody-w.github.io/openrappter"
    if [[ -n "$GUM" ]]; then
        local content
        content="$(printf '%s\n%s' "Need help?" "Docs: ${docs_url}")"
        ui_panel "$content"
    else
        echo ""
        echo -e "Docs: ${INFO}${docs_url}${NC}"
    fi
}

# ── Taglines ────────────────────────────────────────────────
TAGLINES=()
TAGLINES+=("Your terminal just evolved — type something and let the raptor handle the busywork.")
TAGLINES+=("Welcome to the command line: where agents compile and confidence segfaults.")
TAGLINES+=("I run on caffeine, JSON5, and the audacity of \"it worked on my machine.\"")
TAGLINES+=("Gateway online — please keep hands, feet, and appendages inside the shell at all times.")
TAGLINES+=("I speak fluent bash, mild sarcasm, and aggressive tab-completion energy.")
TAGLINES+=("One CLI to rule them all, and one more restart because you changed the port.")
TAGLINES+=("If it works, it's automation; if it breaks, it's a \"learning opportunity.\"")
TAGLINES+=("Your .env is showing; don't worry, I'll pretend I didn't see it.")
TAGLINES+=("I'll do the boring stuff while you dramatically stare at the logs like it's cinema.")
TAGLINES+=("Type the command with confidence — nature will provide the stack trace if needed.")
TAGLINES+=("I can grep it, git blame it, and gently roast it — pick your coping mechanism.")
TAGLINES+=("Hot reload for config, cold sweat for deploys.")
TAGLINES+=("I'm the assistant your terminal demanded, not the one your sleep schedule requested.")
TAGLINES+=("Automation with claws: minimal fuss, maximal pinch.")
TAGLINES+=("I'm basically a Swiss Army knife, but with more opinions and fewer sharp edges.")
TAGLINES+=("Your task has been queued; your dignity has been deprecated.")
TAGLINES+=("I can't fix your code taste, but I can fix your build and your backlog.")
TAGLINES+=("I'm not magic — I'm just extremely persistent with retries and coping strategies.")
TAGLINES+=("It's not \"failing,\" it's \"discovering new ways to configure the same thing wrong.\"")
TAGLINES+=("I read logs so you can keep pretending you don't have to.")
TAGLINES+=("I'll refactor your busywork like it owes me money.")
TAGLINES+=("I'm like tmux: confusing at first, then suddenly you can't live without me.")
TAGLINES+=("If you can describe it, I can probably automate it — or at least make it funnier.")
TAGLINES+=("Your config is valid, your assumptions are not.")
TAGLINES+=("Less clicking, more shipping, fewer \"where did that file go\" moments.")
TAGLINES+=("AI agents powered by your existing GitHub Copilot subscription.")
TAGLINES+=("No extra API keys. No new accounts. No additional monthly bills.")
TAGLINES+=("Your data stays local. Your agents stay loyal. 🦖")
TAGLINES+=("Dual runtime. Single file agents. Zero API keys.")
TAGLINES+=("Data sloshing: because your agents deserve context, not just commands.")
TAGLINES+=("Who needs API keys when you have GitHub Copilot?")
TAGLINES+=("Shell yeah — I'm here to automate the toil and leave you the glory.")
TAGLINES+=("The raptor has entered the chat. Your workflow will never be the same.")
TAGLINES+=("Local-first AI that actually remembers things. Revolutionary, we know.")
TAGLINES+=("pip install was so last season. curl | bash is the new hotness.")
TAGLINES+=("npm install -g openrappter — because you deserve nice things.")
TAGLINES+=("One command to install, zero commands to regret.")
TAGLINES+=("I'm not saying I'm better than your last framework, but… actually yes, I am.")
TAGLINES+=("Installing globally because commitment issues are for other packages.")
TAGLINES+=("Your PATH is about to get a lot more interesting.")
TAGLINES+=("Build tools? I'll handle those. You just sit there and look productive.")
TAGLINES+=("Gateway restart? More like gateway glow-up.")
TAGLINES+=("I auto-detect your install method. I'm basically psychic, but for shells.")
TAGLINES+=("npm or git? Why not both? (But npm is faster, just saying.)")
TAGLINES+=("The installer that installs installers. Wait, no — just the one you need.")
TAGLINES+=("Conflict resolution: not just for diplomats anymore.")
TAGLINES+=("Doctor's orders: your config needs a checkup after every upgrade.")

HOLIDAY_NEW_YEAR="New Year's Day: New year, new config — same old EADDRINUSE, but this time we resolve it like grown-ups."
HOLIDAY_LUNAR_NEW_YEAR="Lunar New Year: May your builds be lucky, your branches prosperous, and your merge conflicts chased away with fireworks."
HOLIDAY_CHRISTMAS="Christmas: Ho ho ho — Santa's little raptor-sistant is here to ship joy, roll back chaos, and stash the keys safely."
HOLIDAY_EID="Eid al-Fitr: Celebration mode: queues cleared, tasks completed, and good vibes committed to main with clean history."
HOLIDAY_DIWALI="Diwali: Let the logs sparkle and the bugs flee — today we light up the terminal and ship with pride."
HOLIDAY_EASTER="Easter: I found your missing environment variable — consider it a tiny CLI egg hunt with fewer jellybeans."
HOLIDAY_HANUKKAH="Hanukkah: Eight nights, eight retries, zero shame — may your gateway stay lit and your deployments stay peaceful."
HOLIDAY_HALLOWEEN="Halloween: Spooky season: beware haunted dependencies, cursed caches, and the ghost of node_modules past."
HOLIDAY_THANKSGIVING="Thanksgiving: Grateful for stable ports, working DNS, and an agent that reads the logs so nobody has to."
HOLIDAY_VALENTINES="Valentine's Day: Roses are typed, violets are piped — I'll automate the chores so you can spend time with humans."

append_holiday_taglines() {
    local today
    local month_day
    today="$(date -u +%Y-%m-%d 2>/dev/null || date +%Y-%m-%d)"
    month_day="$(date -u +%m-%d 2>/dev/null || date +%m-%d)"

    case "$month_day" in
        "01-01") TAGLINES+=("$HOLIDAY_NEW_YEAR") ;;
        "02-14") TAGLINES+=("$HOLIDAY_VALENTINES") ;;
        "10-31") TAGLINES+=("$HOLIDAY_HALLOWEEN") ;;
        "12-25") TAGLINES+=("$HOLIDAY_CHRISTMAS") ;;
    esac

    case "$today" in
        "2025-01-29"|"2026-02-17"|"2027-02-06") TAGLINES+=("$HOLIDAY_LUNAR_NEW_YEAR") ;;
        "2025-03-30"|"2025-03-31"|"2026-03-20"|"2027-03-10") TAGLINES+=("$HOLIDAY_EID") ;;
        "2025-10-20"|"2026-11-08"|"2027-10-28") TAGLINES+=("$HOLIDAY_DIWALI") ;;
        "2025-04-20"|"2026-04-05"|"2027-03-28") TAGLINES+=("$HOLIDAY_EASTER") ;;
        "2025-11-27"|"2026-11-26"|"2027-11-25") TAGLINES+=("$HOLIDAY_THANKSGIVING") ;;
        "2025-12-15"|"2025-12-16"|"2025-12-17"|"2025-12-18"|"2025-12-19"|"2025-12-20"|"2025-12-21"|"2025-12-22"|"2026-12-05"|"2026-12-06"|"2026-12-07"|"2026-12-08"|"2026-12-09"|"2026-12-10"|"2026-12-11"|"2026-12-12"|"2027-12-25"|"2027-12-26"|"2027-12-27"|"2027-12-28"|"2027-12-29"|"2027-12-30"|"2027-12-31"|"2028-01-01") TAGLINES+=("$HOLIDAY_HANUKKAH") ;;
    esac
}

pick_tagline() {
    append_holiday_taglines
    local count=${#TAGLINES[@]}
    if [[ "$count" -eq 0 ]]; then
        echo "$DEFAULT_TAGLINE"
        return
    fi
    if [[ -n "${OPENRAPPTER_TAGLINE_INDEX:-}" ]]; then
        if [[ "${OPENRAPPTER_TAGLINE_INDEX}" =~ ^[0-9]+$ ]]; then
            local idx=$((OPENRAPPTER_TAGLINE_INDEX % count))
            echo "${TAGLINES[$idx]}"
            return
        fi
    fi
    local idx=$((RANDOM % count))
    echo "${TAGLINES[$idx]}"
}

TAGLINE=$(pick_tagline)

# ── Configuration ───────────────────────────────────────────
DRY_RUN=${OPENRAPPTER_DRY_RUN:-0}
VERBOSE="${OPENRAPPTER_VERBOSE:-0}"
OPENRAPPTER_USE_GUM="${OPENRAPPTER_USE_GUM:-auto}"
HELP=0

REPO_URL="https://github.com/kody-w/openrappter.git"
INSTALL_DIR="${OPENRAPPTER_HOME:-$HOME/.openrappter}"
MIN_NODE=20
MIN_PYTHON_MINOR=10
BIN_NAME="openrappter"
# Retained for installer compatibility assertions and downstream sourcing.
# shellcheck disable=SC2034
NPM_PACKAGE="openrappter"

# Install method: "npm", "git", or "" (auto-detect/prompt)
INSTALL_METHOD="${OPENRAPPTER_INSTALL_METHOD:-}"
OPT_NO_PROMPT="${OPENRAPPTER_NO_PROMPT:-false}"
OPT_SET_NPM_PREFIX=false

# ── Release rings ──────────────────────────────────────────
# Train order, least-stable first. Each ring owns one npm dist-tag; only
# `stable` owns `latest`, so a prerelease can never be served to a plain
# `npm install openrappter`.
RING_ORDER="stable beta canary alpha nightly"
CHANNEL="${OPENRAPPTER_RING:-${OPENRAPPTER_CHANNEL:-}}"
CHANNEL_FILE="${INSTALL_DIR}/ring"
LEGACY_CHANNEL_FILE="${INSTALL_DIR}/channel"
OPT_ALLOW_DOWNGRADE="${OPENRAPPTER_ALLOW_DOWNGRADE:-false}"

# OPENRAPPTER_BETA predates rings and used to resolve a `beta` dist-tag that
# nothing ever published, so it silently failed. Keep it working as an alias.
if [[ -z "$CHANNEL" && "${OPENRAPPTER_BETA:-0}" == "1" ]]; then
    CHANNEL="beta"
fi

# A ring maps to one repository only. The branch path is merely where the
# current pointer is fetched; release identity comes exclusively from the
# validated 40-hex commit, exact version, artifact URL, and SHA-256 inside it.
ring_repository() {
    case "$1" in
        stable)  printf 'kody-w/openrappter\n' ;;
        beta)    printf 'kody-w/openrappter-beta\n' ;;
        canary)  printf 'kody-w/openrappter-canary\n' ;;
        alpha)   printf 'kody-w/openrappter-alpha\n' ;;
        nightly) printf 'kody-w/openrappter-nightly\n' ;;
        *) return 1 ;;
    esac
}

is_valid_ring() {
    local candidate="$1" ring
    for ring in $RING_ORDER; do
        [[ "$ring" == "$candidate" ]] && return 0
    done
    return 1
}

# Ring precedence: --channel/env > previously installed channel > stable.
# Prints the ring; returns 1 if the requested ring is invalid. It must not
# call `exit` — callers invoke it inside $( ), where exit would only kill the
# subshell and leave the caller building a malformed package spec.
effective_channel() {
    if [[ -n "$CHANNEL" ]]; then
        is_valid_ring "$CHANNEL" || return 1
        printf '%s\n' "$CHANNEL"
        return 0
    fi
    local setting saved
    for setting in "$CHANNEL_FILE" "$LEGACY_CHANNEL_FILE"; do
        [[ -r "$setting" ]] || continue
        saved="$(tr -d '[:space:]' < "$setting" 2>/dev/null || true)"
        if [[ -n "$saved" ]] && is_valid_ring "$saved"; then
            printf '%s\n' "$saved"
            return 0
        fi
        if [[ -n "$saved" ]]; then
            ui_error "Persisted release ring is invalid: $saved"
            return 1
        fi
    done
    printf 'stable\n'
}

# Validate a local manifest with Node, which is already a prerequisite before
# either install method runs. Output is tab-separated:
# version, artifact URL, SHA-256, source commit, status, reason.
parse_candidate_bundle_url() {
    local value="$1"
    [[ "$value" != *$'\n'* && "$value" != *$'\r'* && "$value" != *$'\t'* && "$value" != *"?"* && "$value" != *"#"* && "$value" != *"@"* && "$value" != *"%"* && "$value" != *"\\"* ]] || return 1
    local pattern='^https://raw\.githubusercontent\.com/kody-w/openrappter/([0-9a-f]{40})/candidates/([0-9a-f]{40})/(snapshot|release)/([A-Za-z0-9][A-Za-z0-9._-]{0,127})/([0-9a-f]{64})\.tar\.gz$'
    [[ "$value" =~ $pattern ]] || return 1
    [[ "${BASH_REMATCH[4]}" != "." && "${BASH_REMATCH[4]}" != ".." ]] || return 1
    printf '%s|%s|%s|%s|%s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}" "${BASH_REMATCH[4]}" "${BASH_REMATCH[5]}"
}

validate_ring_manifest_file() {
    local file="$1" expected_ring="$2"
    node - "$file" "$expected_ring" <<'NODE'
const fs = require('node:fs');
const [file, expected] = process.argv.slice(2);
const rings = ['nightly', 'alpha', 'canary', 'beta', 'stable'];
const closed = (v, keys, label) => {
  if (!v || typeof v !== 'object' || Array.isArray(v) ||
      JSON.stringify(Object.keys(v).sort()) !== JSON.stringify(keys)) {
    throw new Error(`${label} is not closed`);
  }
};
const parseCandidate=(value)=>{
  const u=new URL(value);
  if(!/^[\x20-\x7e]+$/.test(value)||!value.startsWith('https://raw.githubusercontent.com/')||u.protocol!=='https:'||u.hostname!=='raw.githubusercontent.com'||u.username||u.password||u.port||u.search||u.hash||/[^\x20-\x7e]|%|\\/.test(u.pathname))throw Error('candidate URL rejected');
  const p=u.pathname.replace(/^\//,'').split('/');
  if(p.length!==8||p[0]!=='kody-w'||p[1]!=='openrappter'||p[3]!=='candidates'||!/^[0-9a-f]{40}$/.test(p[2])||!/^[0-9a-f]{40}$/.test(p[4])||!['snapshot','release'].includes(p[5])||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(p[6])||p[6]==='.'||p[6]==='..'||!/^[0-9a-f]{64}\.tar\.gz$/.test(p[7]))throw Error('candidate URL rejected');
  return {ref:p[2],source:p[4],kind:p[5],id:p[6],sha:p[7].slice(0,64)};
};
try {
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  const top=Object.keys(m).sort().join(',');
  const current='artifact,channel_version,intended_release_tag,predecessor,promoted_at,promotion_id,reason,receipt,ring,schema,source,status,version';
  const legacy='artifact,predecessor,promoted_at,promotion_id,reason,receipt,ring,schema,source,status,version';
  if(top!==current&&top!==legacy)throw new Error('manifest is not closed');
  closed(m.source, ['commit','repository','tag'], 'source');
  closed(m.artifact, ['install_url','provenance','sha256','url'], 'artifact');
  if (m.schema !== 'openrappter-ring/v1' || m.ring !== expected) throw new Error('wrong schema or ring');
  if (m.source.repository !== 'kody-w/openrappter' || !/^[0-9a-f]{40}$/.test(m.source.commit)) throw new Error('unauthorized source');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(m.version)) throw new Error('bad version');
  if (!/^[0-9a-f]{64}$/.test(m.artifact.sha256)) throw new Error('bad SHA-256');
  if (!/^[0-9a-f]{64}$/.test(m.promotion_id)) throw new Error('missing authority promotion id');
  if (m.intended_release_tag!=null&&!/^v[0-9][0-9A-Za-z.+-]*$/.test(m.intended_release_tag))throw new Error('bad intended release tag');
  for (const u of [m.artifact.url, m.artifact.install_url].filter(Boolean)) {
    const parsed = new URL(u);
    if (parsed.protocol !== 'https:' || !['github.com','registry.npmjs.org','raw.githubusercontent.com'].includes(parsed.hostname)) throw new Error('unauthorized URL');
  }
  if (!['published','unpublished','disabled'].includes(m.status)) throw new Error('bad status');
  if (new Date(m.promoted_at) > new Date(Date.now() + 300000)) throw new Error('future manifest');
  if (m.status === 'published' && !m.artifact.install_url) throw new Error('published manifest has no install URL');
  const npmUrl = `https://registry.npmjs.org/openrappter/-/openrappter-${m.version}.tgz`;
  const releasePrefix = m.source.tag ? `https://github.com/kody-w/openrappter/releases/download/${m.source.tag}/` : '';
  if (m.status === 'published') {
    const npm = m.artifact.provenance === 'npm-registry-download-sha256' && m.artifact.url === npmUrl && m.artifact.install_url === npmUrl;
    const release = m.artifact.provenance === 'github-release-download-sha256' && releasePrefix && m.artifact.url.startsWith(releasePrefix) && m.artifact.install_url === m.artifact.url;
    let candidate=false;
    if(m.artifact.provenance==='github-candidate-bundle-sha256'&&m.artifact.install_url===m.artifact.url){try{const c=parseCandidate(m.artifact.url);candidate=c.source===m.source.commit&&c.sha===m.artifact.sha256;}catch{}}
    if (!npm && !release && !candidate) throw new Error('artifact is not bound to canonical package/version');
  }
  const fields = [m.version, m.artifact.url, m.artifact.sha256, m.source.commit, m.status, m.reason || '', m.promotion_id, m.artifact.provenance];
  process.stdout.write(fields.map((v) => Buffer.from(String(v)).toString('base64')).join('|'));
} catch (error) {
  console.error(`ring manifest rejected: ${error.message}`);
  process.exit(1);
}
NODE
}

resolve_ring_manifest() {
    local ring="$1" repo head receipt manifest encoded authority_ref head_info
    repo="$(ring_repository "$ring")" || return 2
    authority_ref="${OPENRAPPTER_AUTHORITY_REF:-main}"
    if [[ "$authority_ref" != "main" && ! "$authority_ref" =~ ^[0-9a-f]{40}$ ]]; then
        ui_error "OPENRAPPTER_AUTHORITY_REF must be main or an immutable 40-hex commit"
        return 2
    fi
    head="$(mktempfile)"
    download_file "https://raw.githubusercontent.com/kody-w/openrappter-release-train/${authority_ref}/heads/${ring}.json" "$head" ||
        { ui_error "Could not reach ${ring} authority head"; return 1; }
    head_info="$(node - "$head" "$ring" "$repo" <<'NODE'
const fs=require('node:fs'),[file,ring,repo]=process.argv.slice(2),h=JSON.parse(fs.readFileSync(file));
const keys=['authority_commit','promotion_id','receipt_path','receipt_sha256','ring','schema','sequence','target_manifest_commit','target_manifest_sha256','target_repository'];
if(JSON.stringify(Object.keys(h).sort())!==JSON.stringify(keys)||h.schema!=='openrappter-ring-head/v1'||h.ring!==ring||!Number.isSafeInteger(h.sequence)||h.sequence<1||h.target_repository!==repo||!/^[0-9a-f]{40}$/.test(h.authority_commit)||!/^[0-9a-f]{40}$/.test(h.target_manifest_commit)||!/^[0-9a-f]{64}$/.test(h.promotion_id)||!/^[0-9a-f]{64}$/.test(h.receipt_sha256)||!/^[0-9a-f]{64}$/.test(h.target_manifest_sha256)||h.receipt_path!==`receipts/${ring}/${h.promotion_id}.json`)process.exit(1);
process.stdout.write([h.authority_commit,h.receipt_path,h.receipt_sha256,h.target_manifest_commit,h.target_manifest_sha256,h.promotion_id,String(h.sequence)].map(v=>Buffer.from(v).toString('base64')).join('|'));
NODE
    )" || { ui_error "Authority head rejected"; return 1; }
    IFS='|' read -r _ac _rp _rsha _tc _msha _pid _seq <<< "$head_info"
    local authority_commit receipt_path receipt_sha target_commit manifest_sha promotion_id sequence
    authority_commit="$(printf '%s' "$_ac"|base64 --decode)"
    receipt_path="$(printf '%s' "$_rp"|base64 --decode)"
    receipt_sha="$(printf '%s' "$_rsha"|base64 --decode)"
    target_commit="$(printf '%s' "$_tc"|base64 --decode)"
    manifest_sha="$(printf '%s' "$_msha"|base64 --decode)"
    promotion_id="$(printf '%s' "$_pid"|base64 --decode)"
    sequence="$(printf '%s' "$_seq"|base64 --decode)"
    receipt="$(mktempfile)"
    download_file "https://raw.githubusercontent.com/kody-w/openrappter-release-train/${authority_commit}/${receipt_path}" "$receipt" ||
        { ui_error "Immutable authority receipt unreachable"; return 1; }
    manifest="$(mktempfile)"
    download_file "https://raw.githubusercontent.com/${repo}/${target_commit}/.ring/manifest.json" "$manifest" ||
        { ui_error "Immutable authority target manifest unreachable"; return 1; }
    encoded="$(validate_ring_manifest_file "$manifest" "$ring")" || return 1
    IFS='|' read -r _rv _ra _rs _rc _rst _rr _rpid _rprov <<< "$encoded"
    RESOLVED_RING_VERSION="$(printf '%s' "$_rv" | base64 --decode)"
    RESOLVED_RING_ARTIFACT="$(printf '%s' "$_ra" | base64 --decode)"
    RESOLVED_RING_SHA256="$(printf '%s' "$_rs" | base64 --decode)"
    RESOLVED_RING_COMMIT="$(printf '%s' "$_rc" | base64 --decode)"
    RESOLVED_RING_STATUS="$(printf '%s' "$_rst" | base64 --decode)"
    RESOLVED_RING_REASON="$(printf '%s' "$_rr" | base64 --decode)"
    RESOLVED_RING_PROVENANCE="$(printf '%s' "$_rprov" | base64 --decode)"
    local manifest_promotion_id
    manifest_promotion_id="$(printf '%s' "$_rpid" | base64 --decode)"
    [[ "$manifest_promotion_id" == "$promotion_id" ]] ||
        { ui_error "Authority head promotion id differs from immutable manifest"; return 1; }
    if ! node - "$manifest" "$receipt" "$ring" "$repo" "$receipt_sha" "$manifest_sha" "$promotion_id" "$target_commit" "$sequence" <<'NODE'
const fs=require('node:fs'),crypto=require('node:crypto');
const [mf,rf,ring,repo,receiptSha,manifestSha,promotionId,targetCommit,sequence]=process.argv.slice(2);
const [m,r]=[mf,rf].map(f=>JSON.parse(fs.readFileSync(f)));
const canon=v=>Array.isArray(v)?v.map(canon):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canon(v[k])])):v;
const digest=v=>crypto.createHash('sha256').update(JSON.stringify(canon(v))).digest('hex');
if(digest(r)!==receiptSha||digest(m)!==manifestSha||r.target_manifest_sha256!==manifestSha)throw Error('authority digest mismatch');
if(r.schema!=='openrappter-promotion-receipt/v1'||r.target_repository!==repo||r.target_ring!==ring||r.promotion_id!==promotionId||m.promotion_id!==promotionId||r.target_manifest_commit!==targetCommit||(r.sequence!==undefined&&r.sequence!==Number(sequence)))throw Error('authority target mismatch');
const a=m.artifact,s=m.source;
if(r.source_repository!==s.repository||r.source_commit!==s.commit||r.source_tag!==s.tag||r.version!==m.version||r.artifact_url!==a.url||r.install_url!==a.install_url||r.artifact_sha256!==a.sha256||r.artifact_provenance!==a.provenance)throw Error('authority identity mismatch');
NODE
    then
        ui_error "Immutable authority receipt does not authorize manifest"
        return 1
    fi
    local sequences_file
    sequences_file="${INSTALL_DIR}/ring-head-sequences.json"
    mkdir -p "$INSTALL_DIR"
    node - "$sequences_file" "$ring" "$sequence" <<'NODE'
const fs=require('node:fs'),path=require('node:path'),[file,ring,raw]=process.argv.slice(2),sequence=Number(raw);
let state={};if(fs.existsSync(file))state=JSON.parse(fs.readFileSync(file));
const previous=state[ring]??0;if(sequence<previous)throw Error('authority head sequence rollback');
if(sequence>previous){state[ring]=sequence;const tmp=`${file}.${process.pid}.new`;fs.writeFileSync(tmp,JSON.stringify(state,null,2)+'\n',{mode:0o600});fs.renameSync(tmp,file);}
NODE
    if [[ "$RESOLVED_RING_STATUS" != "published" ]]; then
        ui_error "${ring} is ${RESOLVED_RING_STATUS}: ${RESOLVED_RING_REASON}"
        return 1
    fi
    if [[ -n "${OPENRAPPTER_VERSION:-}" && "$OPENRAPPTER_VERSION" != "$RESOLVED_RING_VERSION" ]]; then
        ui_error "OPENRAPPTER_VERSION must equal the ring's exact version ${RESOLVED_RING_VERSION}"
        return 1
    fi
}

resolve_pkg_spec() {
    local ring
    if ! ring="$(effective_channel)"; then
        ui_error "Unknown release ring: ${CHANNEL:-<empty>}"
        ui_error "Valid rings: ${RING_ORDER// /, }"
        return 2
    fi
    resolve_ring_manifest "$ring" || return 1
    printf '%s\n' "$RESOLVED_RING_ARTIFACT"
}

# Remember the validated ring in the same setting read by the CLI and UI.
persist_channel() {
    local ring
    ring="$(effective_channel)"
    [[ "${DRY_RUN:-0}" == "1" ]] && return 0
    mkdir -p "$INSTALL_DIR" 2>/dev/null || return 0
    printf '%s\n' "$ring" > "$CHANNEL_FILE" 2>/dev/null || true
}

print_usage() {
    cat <<EOF
OpenRappter installer (macOS + Linux)

Usage:
  curl -fsSL https://kody-w.github.io/openrappter/install.sh | bash
  curl -fsSL https://kody-w.github.io/openrappter/install.sh | bash -s -- [options]

Options:
  --method npm|git                   Install method (default: npm)
  --ring <ring>                      Release ring: stable|beta|canary|alpha|nightly
                                     Resolves a closed manifest to exact bytes.
                                     --channel remains a deprecated alias.
  --allow-downgrade                 Permit an explicitly selected older version
  --dir <path>                       Install directory for git method (default: ~/.openrappter)
  --dry-run                          Print what would happen (no changes)
  --verbose                          Print debug output
  --no-prompt                        Non-interactive mode (CI/automation)
  --set-npm-prefix                   Force npm prefix fix (Linux EACCES workaround)
  --gum                              Force gum UI if possible
  --no-gum                           Disable gum UI
  --no-copilot                       Skip Copilot setup entirely
  --no-onboard                       Skip onboard wizard
  --help, -h                         Show this help

Environment variables:
  OPENRAPPTER_HOME=...              Install directory (default: ~/.openrappter)
  OPENRAPPTER_INSTALL_METHOD=npm|git Install method override
  OPENRAPPTER_RING=beta             Release ring (preferred environment selector)
  OPENRAPPTER_CHANNEL=beta          Deprecated alias for OPENRAPPTER_RING
  OPENRAPPTER_ALLOW_DOWNGRADE=true  Permit an older exact manifest version
  OPENRAPPTER_AUTHORITY_REF=<40hex> Audit/test an authority head at an immutable revision
  OPENRAPPTER_BETA=1                Deprecated alias for OPENRAPPTER_CHANNEL=beta
  OPENRAPPTER_NO_PROMPT=true        Non-interactive mode
  OPENRAPPTER_DRY_RUN=1             Dry run mode
  OPENRAPPTER_VERBOSE=1             Verbose output
  OPENRAPPTER_USE_GUM=auto|1|0      Default: auto (try gum on interactive TTY)
  SHARP_IGNORE_GLOBAL_LIBVIPS=1     Skip global libvips download (set automatically)

Examples:
  curl -fsSL https://kody-w.github.io/openrappter/install.sh | bash
  curl -fsSL https://kody-w.github.io/openrappter/install.sh | bash -s -- --method npm
  curl -fsSL https://kody-w.github.io/openrappter/install.sh | bash -s -- --method git --verbose
  curl -fsSL https://kody-w.github.io/openrappter/install.sh | bash -s -- --no-prompt --no-copilot
EOF
}

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --method)
                INSTALL_METHOD="$2"
                shift 2
                ;;
            --channel|--ring)
                CHANNEL="${2:-}"
                if ! is_valid_ring "$CHANNEL"; then
                    ui_error "Unknown release ring: ${CHANNEL:-<empty>}"
                    ui_error "Valid rings: ${RING_ORDER// /, }"
                    exit 2
                fi
                shift 2
                ;;
            --allow-downgrade)
                OPT_ALLOW_DOWNGRADE=true
                shift
                ;;
            --no-prompt)
                OPT_NO_PROMPT=true
                shift
                ;;
            --set-npm-prefix)
                OPT_SET_NPM_PREFIX=true
                shift
                ;;
            --dry-run)
                DRY_RUN=1
                shift
                ;;
            --verbose)
                VERBOSE=1
                shift
                ;;
            --gum)
                OPENRAPPTER_USE_GUM=1
                shift
                ;;
            --no-gum)
                OPENRAPPTER_USE_GUM=0
                shift
                ;;
            --no-onboard)
                OPT_NO_ONBOARD=true
                shift
                ;;
            --no-copilot)
                OPT_NO_COPILOT=true
                shift
                ;;
            --dir)
                INSTALL_DIR="$2"
                shift 2
                ;;
            --help|-h)
                HELP=1
                shift
                ;;
            *)
                shift
                ;;
        esac
    done
}

configure_verbose() {
    if [[ "$VERBOSE" != "1" ]]; then
        return 0
    fi
    set -x
}

# ── OS & Tooling ────────────────────────────────────────────
is_root() {
    [[ "$(id -u)" -eq 0 ]]
}

maybe_sudo() {
    if is_root; then
        if [[ "${1:-}" == "-E" ]]; then
            shift
        fi
        "$@"
    else
        sudo "$@"
    fi
}

require_sudo() {
    if [[ "$OS" != "linux" ]]; then
        return 0
    fi
    if is_root; then
        return 0
    fi
    if command -v sudo &> /dev/null; then
        if ! sudo -n true >/dev/null 2>&1; then
            ui_info "Administrator privileges required; enter your password"
            sudo -v
        fi
        return 0
    fi
    ui_error "sudo is required for system installs on Linux"
    echo "  Install sudo or re-run as root."
    exit 1
}

refresh_shell_command_cache() {
    hash -r 2>/dev/null || true
}

# ── Homebrew (macOS) ────────────────────────────────────────
install_homebrew() {
    if [[ "$OS" == "macos" ]]; then
        if ! command -v brew &> /dev/null; then
            ui_info "Homebrew not found, installing"
            run_quiet_step "Installing Homebrew" run_verified_remote_bash "https://raw.githubusercontent.com/Homebrew/install/${HOMEBREW_INSTALL_COMMIT}/install.sh" "$HOMEBREW_INSTALL_SHA256" "Homebrew installer"

            if [[ -f "/opt/homebrew/bin/brew" ]]; then
                eval "$(/opt/homebrew/bin/brew shellenv)"
            elif [[ -f "/usr/local/bin/brew" ]]; then
                eval "$(/usr/local/bin/brew shellenv)"
            fi
            ui_success "Homebrew installed"
        else
            ui_success "Homebrew already installed"
        fi
    fi
}

# ── Node.js ─────────────────────────────────────────────────
get_node_major() {
    if command -v node &>/dev/null; then
        node --version 2>/dev/null | sed 's/^v//' | cut -d. -f1
    else
        echo "0"
    fi
}

check_node() {
    # Try to find node on PATH first
    if command -v node &>/dev/null; then
        local node_ver
        node_ver=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
        if [[ "$node_ver" -ge "$MIN_NODE" ]]; then
            ui_success "Node.js v$(node -v | cut -d'v' -f2) found"
            return 0
        else
            ui_info "Node.js $(node -v) found but need v${MIN_NODE}+"
        fi
    fi

    # Node not found or too old — try sourcing version managers
    # (they may have installed node but not sourced into this shell)
    source_nvm_if_present
    source_fnm_if_present

    # Check common install locations not yet on PATH
    local extra_paths=(
        "$HOME/.local/bin"
        "/usr/local/bin"
        "/opt/homebrew/bin"
        "$HOME/.volta/bin"
    )
    # mise shims
    local mise_data="${MISE_DATA_DIR:-$HOME/.local/share/mise}"
    if [[ -d "$mise_data/shims" ]]; then
        extra_paths+=("$mise_data/shims")
    fi
    for p in "${extra_paths[@]}"; do
        if [[ -x "$p/node" ]] && ! command -v node &>/dev/null; then
            export PATH="$p:$PATH"
        fi
    done

    refresh_shell_command_cache

    if command -v node &>/dev/null; then
        local node_ver
        node_ver=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
        if [[ "$node_ver" -ge "$MIN_NODE" ]]; then
            ui_success "Node.js v$(node -v | cut -d'v' -f2) found (via PATH discovery)"
            return 0
        else
            ui_info "Node.js $(node -v) found but need v${MIN_NODE}+ — upgrading"
            return 1
        fi
    fi

    ui_info "Node.js not found, installing it now"
    return 1
}

install_node() {
    # ── Strategy: try multiple approaches in order of preference ──
    # 1. Existing version managers (nvm, fnm, volta, mise, asdf)
    # 2. Platform package manager (Homebrew / NodeSource)
    # 3. Fresh nvm install
    # 4. Direct Node.js tarball download (last resort, no root needed)

    # Source any existing version manager environments first
    source_nvm_if_present
    source_fnm_if_present

    # 1. Try existing version managers
    if try_version_managers; then
        return 0
    fi

    # 2. Try platform package manager
    if [[ "$OS" == "macos" ]]; then
        if command -v brew &>/dev/null; then
            ui_info "Installing Node.js via Homebrew"
            if run_quiet_step "Installing node@${MIN_NODE}" brew install "node@${MIN_NODE}"; then
                brew link "node@${MIN_NODE}" --overwrite --force 2>/dev/null || true
                refresh_shell_command_cache
                if verify_node_version; then
                    ui_success "Node.js $(node --version) installed via Homebrew"
                    return 0
                fi
            fi
            ui_info "Homebrew install didn't produce a usable Node — trying next method"
        fi
    elif [[ "$OS" == "linux" ]]; then
        local nodesource_ok=false
        if command -v apt-get &>/dev/null; then
            ui_info "Installing Node.js via NodeSource (apt)"
            require_sudo
            local tmp
            tmp="$(mktempfile)"
            if download_file "https://deb.nodesource.com/setup_${MIN_NODE}.x" "$tmp" 2>/dev/null; then
                if is_root; then
                    run_quiet_step "Configuring NodeSource repository" bash "$tmp" && \
                    run_quiet_step "Installing Node.js" apt-get install -y -qq nodejs && nodesource_ok=true
                else
                    run_quiet_step "Configuring NodeSource repository" sudo -E bash "$tmp" && \
                    run_quiet_step "Installing Node.js" sudo apt-get install -y -qq nodejs && nodesource_ok=true
                fi
            fi
        elif command -v dnf &>/dev/null; then
            ui_info "Installing Node.js via NodeSource (dnf)"
            require_sudo
            local tmp
            tmp="$(mktempfile)"
            if download_file "https://rpm.nodesource.com/setup_${MIN_NODE}.x" "$tmp" 2>/dev/null; then
                if is_root; then
                    run_quiet_step "Configuring NodeSource repository" bash "$tmp" && \
                    run_quiet_step "Installing Node.js" dnf install -y -q nodejs && nodesource_ok=true
                else
                    run_quiet_step "Configuring NodeSource repository" sudo bash "$tmp" && \
                    run_quiet_step "Installing Node.js" sudo dnf install -y -q nodejs && nodesource_ok=true
                fi
            fi
        elif command -v yum &>/dev/null; then
            ui_info "Installing Node.js via NodeSource (yum)"
            require_sudo
            local tmp
            tmp="$(mktempfile)"
            if download_file "https://rpm.nodesource.com/setup_${MIN_NODE}.x" "$tmp" 2>/dev/null; then
                if is_root; then
                    run_quiet_step "Configuring NodeSource repository" bash "$tmp" && \
                    run_quiet_step "Installing Node.js" yum install -y -q nodejs && nodesource_ok=true
                else
                    run_quiet_step "Configuring NodeSource repository" sudo bash "$tmp" && \
                    run_quiet_step "Installing Node.js" sudo yum install -y -q nodejs && nodesource_ok=true
                fi
            fi
        fi

        if [[ "$nodesource_ok" == "true" ]]; then
            refresh_shell_command_cache
            if verify_node_version; then
                ui_success "Node.js $(node --version) installed via NodeSource"
                return 0
            fi
        fi
        ui_info "NodeSource install didn't succeed — trying next method"
    fi

    # 3. Try fresh nvm install
    ui_info "Trying Node.js installation via nvm (fresh install)"
    if install_node_nvm 2>/dev/null; then
        refresh_shell_command_cache
        if verify_node_version; then
            return 0
        fi
    fi
    ui_info "nvm install didn't succeed — trying direct download"

    # 4. Last resort: direct tarball download (no root needed)
    if install_node_tarball; then
        return 0
    fi

    # All methods failed — give a helpful error
    ui_error "Could not install Node.js v${MIN_NODE}+"
    echo ""
    echo "  Detected node: $(command -v node 2>/dev/null || echo 'not found')"
    echo "  Node version:  $(node --version 2>/dev/null || echo 'unknown')"
    echo "  PATH: $PATH"
    echo ""
    echo "  Manual install options:"
    echo "    https://nodejs.org/en/download"
    echo "    nvm install ${MIN_NODE}"
    echo "    brew install node@${MIN_NODE}"
    echo "    fnm install ${MIN_NODE}"
    echo "    volta install node@${MIN_NODE}"
    exit 1
}

install_node_nvm() {
    if [[ ! -d "$HOME/.nvm" ]]; then
        run_quiet_step "Installing nvm" run_verified_remote_bash "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_INSTALL_REF}/install.sh" "$NVM_INSTALL_SHA256" "nvm installer"
    fi

    export NVM_DIR="$HOME/.nvm"
    # shellcheck disable=SC1091
    [[ -s "$NVM_DIR/nvm.sh" ]] && . "$NVM_DIR/nvm.sh"

    nvm install "$MIN_NODE" --default
    nvm use "$MIN_NODE"
    ui_success "Node.js $(node --version) installed via nvm"
}

# ── Node.js verification ────────────────────────────────────
verify_node_version() {
    refresh_shell_command_cache
    if ! command -v node &>/dev/null; then
        return 1
    fi
    local ver
    ver="$(node --version 2>/dev/null | sed 's/^v//' | cut -d. -f1)"
    if [[ "$ver" -ge "$MIN_NODE" ]] 2>/dev/null; then
        return 0
    fi
    return 1
}

# ── Version Manager Detection ───────────────────────────────
source_nvm_if_present() {
    if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
        export NVM_DIR="$HOME/.nvm"
        # shellcheck disable=SC1091
        . "$NVM_DIR/nvm.sh" 2>/dev/null || true
    fi
}

source_fnm_if_present() {
    if command -v fnm &>/dev/null; then
        eval "$(fnm env 2>/dev/null)" || true
    fi
}

try_version_managers() {
    # Try nvm
    if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
        ui_info "Found nvm — trying to install Node.js v${MIN_NODE}"
        source_nvm_if_present
        if nvm install "$MIN_NODE" --default 2>/dev/null && nvm use "$MIN_NODE" 2>/dev/null; then
            refresh_shell_command_cache
            if verify_node_version; then
                ui_success "Node.js $(node --version) activated via nvm"
                return 0
            fi
        fi
        ui_info "nvm install didn't produce a usable Node — trying next method"
    fi

    # Try fnm
    if command -v fnm &>/dev/null; then
        ui_info "Found fnm — trying to install Node.js v${MIN_NODE}"
        if fnm install "$MIN_NODE" 2>/dev/null && fnm use "$MIN_NODE" 2>/dev/null && fnm default "$MIN_NODE" 2>/dev/null; then
            source_fnm_if_present
            refresh_shell_command_cache
            if verify_node_version; then
                ui_success "Node.js $(node --version) activated via fnm"
                return 0
            fi
        fi
        ui_info "fnm install didn't produce a usable Node — trying next method"
    fi

    # Try volta
    if command -v volta &>/dev/null; then
        ui_info "Found volta — trying to install Node.js v${MIN_NODE}"
        if volta install "node@${MIN_NODE}" 2>/dev/null; then
            refresh_shell_command_cache
            if verify_node_version; then
                ui_success "Node.js $(node --version) activated via volta"
                return 0
            fi
        fi
        ui_info "volta install didn't produce a usable Node — trying next method"
    fi

    # Try mise (formerly rtx)
    if command -v mise &>/dev/null; then
        ui_info "Found mise — trying to install Node.js v${MIN_NODE}"
        if mise install "node@${MIN_NODE}" 2>/dev/null && mise use --global "node@${MIN_NODE}" 2>/dev/null; then
            eval "$(mise env 2>/dev/null)" || true
            refresh_shell_command_cache
            if verify_node_version; then
                ui_success "Node.js $(node --version) activated via mise"
                return 0
            fi
        fi
        ui_info "mise install didn't produce a usable Node — trying next method"
    fi

    # Try asdf
    if command -v asdf &>/dev/null; then
        ui_info "Found asdf — trying to install Node.js v${MIN_NODE}"
        if asdf plugin add nodejs 2>/dev/null; then true; fi
        if asdf install nodejs "$MIN_NODE" 2>/dev/null && asdf global nodejs "$MIN_NODE" 2>/dev/null; then
            refresh_shell_command_cache
            if verify_node_version; then
                ui_success "Node.js $(node --version) activated via asdf"
                return 0
            fi
        fi
        ui_info "asdf install didn't produce a usable Node — trying next method"
    fi

    return 1
}

# ── Direct Node.js tarball download (last-resort fallback) ──
NODE_TARBALL_VERSION="${OPENRAPPTER_NODE_VERSION:-22.14.0}"

install_node_tarball() {
    local node_ver="$NODE_TARBALL_VERSION"
    local os_name arch_name
    os_name="$(uname -s | tr '[:upper:]' '[:lower:]')"
    arch_name="$(uname -m)"

    case "$arch_name" in
        x86_64|amd64) arch_name="x64" ;;
        aarch64)      arch_name="arm64" ;;
    esac

    local tarball="node-v${node_ver}-${os_name}-${arch_name}.tar.xz"
    local url="https://nodejs.org/dist/v${node_ver}/${tarball}"
    local node_dir="$INSTALL_DIR/tools/node-v${node_ver}"

    ui_info "Downloading Node.js v${node_ver} tarball directly (fallback)..."

    local tmp_tar
    tmp_tar="$(mktempfile)"

    # Try .tar.xz first, fall back to .tar.gz
    local use_xz=true
    if ! command -v xz &>/dev/null; then
        use_xz=false
    fi
    if [[ "$use_xz" == "true" ]]; then
        if ! download_file "$url" "$tmp_tar" 2>/dev/null; then
            use_xz=false
        fi
    fi
    if [[ "$use_xz" == "false" ]]; then
        tarball="node-v${node_ver}-${os_name}-${arch_name}.tar.gz"
        url="https://nodejs.org/dist/v${node_ver}/${tarball}"
        if ! download_file "$url" "$tmp_tar"; then
            ui_error "Failed to download Node.js tarball"
            return 1
        fi
    fi

    # Verify SHA-256 — FAIL CLOSED on every path (rapp-local-install/1.0 §3.3).
    #
    # This block used to fail OPEN three separate ways, each proceeding to
    # install an unverified Node.js runtime:
    #   1. checksum manifest could not be downloaded  -> warn, continue
    #   2. tarball absent from the manifest            -> silently continue
    #   3. neither sha256sum nor shasum on the machine -> actual_sha empty,
    #      the != comparison never fired, silently continue
    #
    # The third is the one that hides: an empty computed hash compared against
    # a real expected hash is not a match and must never be treated as "skip".
    # A check that degrades to a no-op and reports success is worse than no
    # check, because it also removes the suspicion that would make someone look.
    local shasums_tmp
    shasums_tmp="$(mktempfile)"
    if ! download_file "https://nodejs.org/dist/v${node_ver}/SHASUMS256.txt" "$shasums_tmp" 2>/dev/null; then
        ui_error "Could not download Node.js checksums — refusing to install unverified runtime"
        return 1
    fi

    local expected_sha actual_sha=""
    expected_sha="$(grep "$tarball" "$shasums_tmp" | awk '{print $1}' | head -1)"
    if [[ -z "$expected_sha" ]]; then
        ui_error "Node.js checksums do not list $tarball — refusing to install"
        return 1
    fi

    if command -v sha256sum &>/dev/null; then
        actual_sha="$(sha256sum "$tmp_tar" | awk '{print $1}')"
    elif command -v shasum &>/dev/null; then
        actual_sha="$(shasum -a 256 "$tmp_tar" | awk '{print $1}')"
    else
        ui_error "No SHA-256 tool available (sha256sum/shasum) — refusing to install unverified runtime"
        return 1
    fi

    if [[ -z "$actual_sha" ]]; then
        ui_error "Could not compute a SHA-256 for $tarball — refusing to install"
        return 1
    fi
    if [[ "$actual_sha" != "$expected_sha" ]]; then
        ui_error "Node.js checksum mismatch (expected $expected_sha, got $actual_sha)"
        return 1
    fi
    ui_success "Node.js checksum verified"

    mkdir -p "$node_dir"
    if [[ "$use_xz" == "true" ]]; then
        if ! tar -xJf "$tmp_tar" -C "$node_dir" --strip-components=1 2>/dev/null; then
            ui_error "Failed to extract Node.js tarball (.tar.xz)"
            return 1
        fi
    else
        if ! tar -xzf "$tmp_tar" -C "$node_dir" --strip-components=1 2>/dev/null; then
            ui_error "Failed to extract Node.js tarball (.tar.gz)"
            return 1
        fi
    fi

    export PATH="$node_dir/bin:$PATH"
    refresh_shell_command_cache

    if verify_node_version; then
        ui_success "Node.js $(node --version) installed via direct download to $node_dir"
        return 0
    fi

    ui_error "Node.js tarball extracted but node binary not working"
    return 1
}

# ── npm prefix fix (Linux EACCES) ───────────────────────────
fix_npm_prefix_if_needed() {
    if [[ "$OS" != "linux" ]]; then
        return 0
    fi
    if is_root; then
        return 0
    fi

    local npm_prefix
    npm_prefix="$(npm config get prefix 2>/dev/null || true)"

    if [[ -n "$npm_prefix" && ! -w "$npm_prefix" ]]; then
        local new_prefix="$HOME/.npm-global"
        ui_info "npm prefix $npm_prefix is not writable — switching to $new_prefix"
        mkdir -p "$new_prefix"
        npm config set prefix "$new_prefix" 2>/dev/null || true
        ensure_path "$new_prefix/bin"
    fi
}

# ── Installation Method Detection ───────────────────────────
detect_existing_install() {
    # Check for npm global install
    local npm_bin=""
    npm_bin="$(npm list -g --depth=0 openrappter 2>/dev/null || true)"
    if [[ "$npm_bin" == *"openrappter"* ]]; then
        echo "npm"
        return 0
    fi

    # Check for git clone install
    if [[ -d "$INSTALL_DIR/.git" ]]; then
        echo "git"
        return 0
    fi

    echo "none"
}

choose_install_method() {
    # Already set via --method flag or env var
    if [[ -n "$INSTALL_METHOD" ]]; then
        case "$INSTALL_METHOD" in
            npm|git) return 0 ;;
            *)
                ui_error "Invalid install method: $INSTALL_METHOD (use 'npm' or 'git')"
                exit 1
                ;;
        esac
    fi

    local existing
    existing="$(detect_existing_install)"

    # No existing install — default to git (npm publish paused)
    if [[ "$existing" == "none" ]]; then
        INSTALL_METHOD="git"
        return 0
    fi

    # Existing install found — match it (or prompt)
    if [[ "$OPT_NO_PROMPT" == "true" ]]; then
        INSTALL_METHOD="$existing"
        ui_info "Existing $existing install detected, upgrading via $existing (--no-prompt)"
        return 0
    fi

    if [[ -n "$GUM" ]] && gum_is_tty; then
        ui_info "Existing $existing install detected"
        local choice
        choice="$(ui_choose "Install method:" "npm" "git")" || true
        case "$choice" in
            npm) INSTALL_METHOD="npm" ;;
            git) INSTALL_METHOD="git" ;;
            *) INSTALL_METHOD="$existing" ;;
        esac
    else
        # No TTY, default to matching existing
        INSTALL_METHOD="$existing"
        ui_info "Existing $existing install detected, upgrading in-place"
    fi
}

# ── Build Tools (Linux native modules) ─────────────────────
ensure_build_tools() {
    if [[ "$OS" != "linux" ]]; then
        return 0
    fi

    # Check if gcc and make are available
    if command -v gcc &>/dev/null && command -v make &>/dev/null; then
        return 0
    fi

    ui_info "Installing build tools for native modules"
    require_sudo

    if command -v apt-get &>/dev/null; then
        if is_root; then
            run_quiet_step "Installing build-essential" apt-get install -y -qq build-essential
        else
            run_quiet_step "Installing build-essential" sudo apt-get install -y -qq build-essential
        fi
    elif command -v dnf &>/dev/null; then
        if is_root; then
            # shellcheck disable=SC2046
            run_quiet_step "Installing Development Tools" dnf groupinstall -y -q "Development Tools"
        else
            # shellcheck disable=SC2046
            run_quiet_step "Installing Development Tools" sudo dnf groupinstall -y -q "Development Tools"
        fi
    elif command -v yum &>/dev/null; then
        if is_root; then
            # shellcheck disable=SC2046
            run_quiet_step "Installing Development Tools" yum groupinstall -y -q "Development Tools"
        else
            # shellcheck disable=SC2046
            run_quiet_step "Installing Development Tools" sudo yum groupinstall -y -q "Development Tools"
        fi
    elif command -v apk &>/dev/null; then
        if is_root; then
            run_quiet_step "Installing build-base" apk add --no-cache build-base
        else
            run_quiet_step "Installing build-base" sudo apk add --no-cache build-base
        fi
    else
        ui_warn "Could not detect package manager for build tools — native modules may fail"
        return 0
    fi

    ui_success "Build tools installed"
}

# ── npm Global Install ─────────────────────────────────────
compare_semver() {
    node - "$1" "$2" <<'NODE'
const parse = (value) => {
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!m) throw new Error(`invalid SemVer: ${value}`);
  const pre = m[4]?.split('.') ?? null;
  if (pre?.some((id) => /^\d+$/.test(id) && /^0\d+/.test(id))) throw new Error(`invalid SemVer: ${value}`);
  return { core: m.slice(1, 4).map(Number), pre };
};
const a = parse(process.argv[2]);
const b = parse(process.argv[3]);
let result = 0;
for (let i = 0; i < 3 && result === 0; i++) {
  if (a.core[i] !== b.core[i]) result = a.core[i] < b.core[i] ? -1 : 1;
}
if (result === 0 && (a.pre !== null || b.pre !== null)) {
  if (a.pre === null) result = 1;
  else if (b.pre === null) result = -1;
  else for (let i = 0; i < Math.max(a.pre.length, b.pre.length) && result === 0; i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === undefined) result = -1;
    else if (y === undefined) result = 1;
    else if (x !== y) {
      const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
      if (xn && yn) result = BigInt(x) < BigInt(y) ? -1 : 1;
      else if (xn !== yn) result = xn ? -1 : 1;
      else result = x < y ? -1 : 1;
    }
  }
}
process.stdout.write(String(result));
NODE
}

install_via_npm() {
    ui_info "Installing openrappter via npm (global)"

    # Determine version spec.
    # Precedence: explicit version > ring/channel dist-tag > stable (latest).
    local pkg_spec ring artifact actual current_version
    resolve_pkg_spec >/dev/null || exit 2
    ring="$(effective_channel)"
    ui_info "Release ring: ${ring} → ${RESOLVED_RING_VERSION} @ ${RESOLVED_RING_COMMIT}"

    current_version="$(npm list -g openrappter --depth=0 --json 2>/dev/null |
        node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).dependencies?.openrappter?.version||"")}catch{}})' || true)"
    if [[ -n "$current_version" && "$OPT_ALLOW_DOWNGRADE" != "true" ]]; then
        if [[ "$(compare_semver "$RESOLVED_RING_VERSION" "$current_version")" == "-1" ]]; then
            ui_error "Refusing downgrade ${current_version} → ${RESOLVED_RING_VERSION}; pass --allow-downgrade"
            exit 2
        fi
    fi

    artifact="$(mktempfile)"
    download_file "$RESOLVED_RING_ARTIFACT" "$artifact" ||
        { ui_error "Could not download exact ${ring} artifact"; exit 1; }
    actual="$(sha256_of "$artifact")" ||
        { ui_error "No SHA-256 tool available"; exit 1; }
    if [[ "$actual" != "$RESOLVED_RING_SHA256" ]]; then
        ui_error "Artifact checksum mismatch (expected ${RESOLVED_RING_SHA256}, got ${actual})"
        exit 1
    fi
    if [[ "$RESOLVED_RING_PROVENANCE" == "github-candidate-bundle-sha256" ]]; then
        local candidate_dir
        candidate_dir="${INSTALL_DIR}/.candidate-${RESOLVED_RING_SHA256}"
        rm -rf "$candidate_dir"
        mkdir -p "$candidate_dir"
        tar -xzf "$artifact" -C "$candidate_dir"
        (cd "$candidate_dir" && sha256sum -c SHA256SUMS)
        local candidate_packages=()
        while IFS= read -r package; do candidate_packages+=("$package"); done < <(
            find "$candidate_dir" -maxdepth 1 -type f -name 'openrappter-*.tgz' | sort
        )
        [[ "${#candidate_packages[@]}" -eq 1 ]] ||
            { ui_error "Candidate bundle must contain exactly one npm tarball"; exit 1; }
        pkg_spec="${candidate_packages[0]}"
    else
        pkg_spec="$artifact"
    fi

    # Fix npm prefix if needed (Linux EACCES)
    if [[ "$OPT_SET_NPM_PREFIX" == "true" ]]; then
        fix_npm_prefix_if_needed
    else
        fix_npm_prefix_if_needed
    fi

    # Attempt install
    if retry 3 2 run_quiet_step "Installing $pkg_spec" npm install -g "$pkg_spec" --no-fund --no-audit; then
        ui_success "npm install succeeded"
    else
        # Retry with build tools if it looks like a gyp error
        ui_warn "npm install failed — checking if build tools are needed"
        ensure_build_tools
        if retry 2 3 run_quiet_step "Retrying $pkg_spec" npm install -g "$pkg_spec" --no-fund --no-audit; then
            ui_success "npm install succeeded (after build tools)"
        else
            ui_error "npm install of verified ${ring} artifact failed after retries"
            echo "  Or use git method: curl ... | bash -s -- --method git"
            exit 1
        fi
    fi

    persist_channel
    refresh_shell_command_cache

    # Verify binary is on PATH
    if command -v openrappter &>/dev/null; then
        ui_success "openrappter binary found on PATH"
    else
        # Check npm global bin directory
        local npm_bin_dir
        npm_bin_dir="$(npm config get prefix 2>/dev/null)/bin"
        if [[ -x "$npm_bin_dir/openrappter" ]]; then
            ensure_path "$npm_bin_dir"
            ui_success "openrappter binary found at $npm_bin_dir/openrappter"
        else
            ui_warn "openrappter binary not found on PATH — you may need to restart your shell"
        fi
    fi
}

# ── npm Conflict Resolution ────────────────────────────────
resolve_npm_conflicts() {
    local bin_dir
    bin_dir="$(get_bin_dir)"

    # Remove stale launcher script from a previous git install
    # (npm creates its own symlink via package.json "bin")
    if [[ "$INSTALL_METHOD" == "npm" && -f "$bin_dir/$BIN_NAME" ]]; then
        # Check if it's our handwritten launcher (not an npm symlink)
        if grep -q "openrappter launcher" "$bin_dir/$BIN_NAME" 2>/dev/null; then
            local backup
            backup="${bin_dir}/${BIN_NAME}.git-backup.$(date +%s)"
            mv "$bin_dir/$BIN_NAME" "$backup"
            ui_info "Backed up old git launcher to $backup"
        fi
    fi

    # Remove dangling npm symlinks
    if [[ "$INSTALL_METHOD" == "git" ]]; then
        local npm_bin_dir
        npm_bin_dir="$(npm config get prefix 2>/dev/null)/bin" || true
        if [[ -n "$npm_bin_dir" && -L "$npm_bin_dir/openrappter" && ! -e "$npm_bin_dir/openrappter" ]]; then
            rm -f "$npm_bin_dir/openrappter"
            ui_info "Removed dangling npm symlink at $npm_bin_dir/openrappter"
        fi
    fi
}

# ── Gateway Daemon Restart ─────────────────────────────────
detect_and_restart_gateway() {
    local pid_file="$HOME/.openrappter/gateway.pid"
    if [[ ! -f "$pid_file" ]]; then
        return 0
    fi

    local pid
    pid="$(cat "$pid_file" 2>/dev/null || true)"
    if [[ -z "$pid" ]]; then
        return 0
    fi

    # Check if process is still alive
    if ! kill -0 "$pid" 2>/dev/null; then
        rm -f "$pid_file"
        return 0
    fi

    ui_info "Gateway daemon running (PID $pid)"

    if [[ "$OPT_NO_PROMPT" == "true" ]]; then
        ui_info "Restarting gateway (--no-prompt)"
        kill "$pid" 2>/dev/null || true
        sleep 1
        # The gateway will auto-start on next openrappter invocation
        rm -f "$pid_file"
        ui_success "Gateway stopped (will auto-start on next use)"
        return 0
    fi

    if [[ -n "$GUM" ]] && gum_is_tty; then
        local choice
        choice="$(ui_choose "Restart gateway daemon?" "Yes (recommended)" "No")" || true
        if [[ "$choice" == "Yes (recommended)" ]]; then
            kill "$pid" 2>/dev/null || true
            sleep 1
            rm -f "$pid_file"
            ui_success "Gateway stopped (will auto-start on next use)"
        else
            ui_info "Gateway left running (you may want to restart it manually)"
        fi
    else
        ui_info "Restart the gateway manually if needed: kill $pid"
    fi
}

# ── Doctor/Migration ────────────────────────────────────────
run_doctor_if_available() {
    local bin
    bin="$(resolve_openrappter_bin 2>/dev/null || true)"
    if [[ -z "$bin" ]]; then
        return 0
    fi

    # Best-effort doctor run (non-fatal)
    if "$bin" doctor --json >/dev/null 2>&1; then
        ui_success "Doctor check passed"
    else
        ui_info "Doctor check skipped (not available or non-fatal issue)"
    fi
}

# ── Git ─────────────────────────────────────────────────────
check_git() {
    if command -v git &> /dev/null; then
        ui_success "Git already installed"
        return 0
    fi
    ui_info "Git not found, installing it now"
    return 1
}

install_git() {
    if [[ "$OS" == "macos" ]]; then
        run_quiet_step "Installing Git" brew install git
    elif [[ "$OS" == "linux" ]]; then
        require_sudo
        if command -v apt-get &> /dev/null; then
            if is_root; then
                run_quiet_step "Updating package index" apt-get update -qq
                run_quiet_step "Installing Git" apt-get install -y -qq git
            else
                run_quiet_step "Updating package index" sudo apt-get update -qq
                run_quiet_step "Installing Git" sudo apt-get install -y -qq git
            fi
        elif command -v dnf &> /dev/null; then
            if is_root; then
                run_quiet_step "Installing Git" dnf install -y -q git
            else
                run_quiet_step "Installing Git" sudo dnf install -y -q git
            fi
        elif command -v yum &> /dev/null; then
            if is_root; then
                run_quiet_step "Installing Git" yum install -y -q git
            else
                run_quiet_step "Installing Git" sudo yum install -y -q git
            fi
        else
            ui_error "Could not detect package manager for Git"
            exit 1
        fi
    fi
    ui_success "Git installed"
}

# ── Python (optional) ──────────────────────────────────────
python_cmd_meets_min() {
    local cmd="$1"
    local ver major minor

    command -v "$cmd" &>/dev/null || return 1
    ver="$("$cmd" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || true)"
    major="${ver%%.*}"
    minor="${ver#*.}"

    [[ "$major" -ge 3 ]] 2>/dev/null && [[ "$minor" -ge "$MIN_PYTHON_MINOR" ]] 2>/dev/null
}

get_python_cmd() {
    local cmd
    # Check generic shims first, then versioned binaries commonly installed by
    # Homebrew/pyenv when the system python3 is older than our minimum.
    for cmd in python3 python3.14 python3.13 python3.12 python3.11 python3.10 python; do
        if python_cmd_meets_min "$cmd"; then
            echo "$cmd"
            return 0
        fi
    done
    echo ""
}

get_python_version() {
    local cmd
    cmd="$(get_python_cmd)"
    if [[ -n "$cmd" ]]; then
        "$cmd" --version 2>&1 | sed 's/Python //' | head -1
    else
        echo "0.0.0"
    fi
}

check_python_meets_min() {
    [[ -n "$(get_python_cmd)" ]]
}

# ── PATH Management ────────────────────────────────────────
get_bin_dir() {
    if [[ -d "/usr/local/bin" ]] && [[ -w "/usr/local/bin" ]]; then
        echo "/usr/local/bin"
    else
        local user_bin="$HOME/.local/bin"
        mkdir -p "$user_bin"
        echo "$user_bin"
    fi
}

ensure_path() {
    local bin_dir="$1"
    if [[ ":$PATH:" != *":$bin_dir:"* ]]; then
        local shell_rc=""
        case "$(basename "${SHELL:-/bin/bash}")" in
            zsh)  shell_rc="$HOME/.zshrc" ;;
            bash)
                if [[ -f "$HOME/.bash_profile" ]]; then
                    shell_rc="$HOME/.bash_profile"
                else
                    shell_rc="$HOME/.bashrc"
                fi
                ;;
            fish) shell_rc="$HOME/.config/fish/config.fish" ;;
            *)    shell_rc="$HOME/.profile" ;;
        esac

        if [[ -n "$shell_rc" ]]; then
            local path_line="export PATH=\"$bin_dir:\$PATH\""
            if [[ "$(basename "${SHELL:-/bin/bash}")" == "fish" ]]; then
                path_line="set -gx PATH $bin_dir \$PATH"
            fi

            if ! grep -qF "$bin_dir" "$shell_rc" 2>/dev/null; then
                {
                    echo ""
                    echo "# Added by openrappter installer"
                    echo "$path_line"
                } >> "$shell_rc"
                ui_warn "Added $bin_dir to PATH in $shell_rc"
            fi
        fi

        export PATH="$bin_dir:$PATH"
    fi
}

path_has_dir() {
    local path="$1"
    local dir="${2%/}"
    if [[ -z "$dir" ]]; then
        return 1
    fi
    case ":${path}:" in
        *":${dir}:"*) return 0 ;;
        *) return 1 ;;
    esac
}

warn_shell_path_missing_dir() {
    local dir="${1%/}"
    local label="$2"
    if [[ -z "$dir" ]]; then
        return 0
    fi
    if path_has_dir "$ORIGINAL_PATH" "$dir"; then
        return 0
    fi

    echo ""
    ui_warn "PATH missing ${label}: ${dir}"
    echo "  This can make openrappter show as \"command not found\" in new terminals."
    echo "  Fix (zsh: ~/.zshrc, bash: ~/.bashrc):"
    echo "    export PATH=\"${dir}:\$PATH\""
}

# Determine which shell rc file was (or would be) modified
get_shell_rc_file() {
    case "$(basename "${SHELL:-/bin/bash}")" in
        zsh)  echo "$HOME/.zshrc" ;;
        bash)
            if [[ -f "$HOME/.bash_profile" ]]; then
                echo "$HOME/.bash_profile"
            else
                echo "$HOME/.bashrc"
            fi
            ;;
        fish) echo "$HOME/.config/fish/config.fish" ;;
        *)    echo "$HOME/.profile" ;;
    esac
}

# Returns true if openrappter will NOT be found in a new shell (needs PATH activation)
needs_path_activation() {
    local bin_dir="${1%/}"
    [[ -n "$bin_dir" ]] && ! path_has_dir "$ORIGINAL_PATH" "$bin_dir"
}

# ── Launcher Script ────────────────────────────────────────
create_launcher() {
    local bin_dir="$1"
    local launcher="$bin_dir/$BIN_NAME"

    cat > "$launcher" << 'LAUNCHER'
#!/usr/bin/env bash
# openrappter launcher — routes to the installed runtime
set -euo pipefail

OPENRAPPTER_HOME="${OPENRAPPTER_HOME:-$HOME/.openrappter}"

# ── Ensure Node.js is discoverable ──
# 1. Bundled Node.js (direct tarball install)
if [[ -d "$OPENRAPPTER_HOME/tools" ]]; then
    for node_dir in "$OPENRAPPTER_HOME"/tools/node-v*/bin; do
        if [[ -x "$node_dir/node" ]]; then
            export PATH="$node_dir:$PATH"
            break
        fi
    done
fi

# 2. Source nvm if needed
if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
    export NVM_DIR="$HOME/.nvm"
    . "$NVM_DIR/nvm.sh" 2>/dev/null || true
fi

# 3. Source fnm if available
if command -v fnm &>/dev/null; then
    eval "$(fnm env 2>/dev/null)" || true
fi

# 4. Check common paths
for _p in "$HOME/.volta/bin" "$HOME/.local/bin" "/opt/homebrew/bin"; do
    if [[ -x "$_p/node" ]] && ! command -v node &>/dev/null; then
        export PATH="$_p:$PATH"
    fi
done

# TypeScript runtime (primary)
TS_DIR="$OPENRAPPTER_HOME/typescript"
if [[ -f "$TS_DIR/dist/index.js" ]]; then
    # Load env vars (GITHUB_TOKEN etc.)
    if [[ -f "$OPENRAPPTER_HOME/.env" ]]; then
        set -a
        # shellcheck disable=SC1091
        . "$OPENRAPPTER_HOME/.env" 2>/dev/null || true
        set +a
    fi
    if ! command -v node &>/dev/null; then
        echo "Error: Node.js not found. Install Node.js 20+ and try again."
        echo "  https://nodejs.org/en/download"
        exit 1
    fi
    exec node "$TS_DIR/dist/index.js" "$@"
fi

# Python runtime (fallback)
PY_DIR="$OPENRAPPTER_HOME/python"
if [[ -f "$PY_DIR/openrappter/cli.py" ]]; then
    VENV_PYTHON="$OPENRAPPTER_HOME/.venv/bin/python"
    if [[ -x "$VENV_PYTHON" ]]; then
        exec "$VENV_PYTHON" -m openrappter.cli "$@"
    elif command -v python3 &>/dev/null; then
        exec python3 -m openrappter.cli "$@"
    elif command -v python &>/dev/null; then
        exec python -m openrappter.cli "$@"
    fi
fi

echo "Error: openrappter is not properly installed."
echo "Run: curl -fsSL https://kody-w.github.io/openrappter/install.sh | bash"
exit 1
LAUNCHER

    chmod +x "$launcher"
}

# ── Resolve Binary ──────────────────────────────────────────
resolve_openrappter_bin() {
    refresh_shell_command_cache
    local resolved=""
    resolved="$(type -P openrappter 2>/dev/null || true)"
    if [[ -n "$resolved" && -x "$resolved" ]]; then
        echo "$resolved"
        return 0
    fi

    local bin_dir
    bin_dir="$(get_bin_dir)"
    if [[ -x "${bin_dir}/openrappter" ]]; then
        echo "${bin_dir}/openrappter"
        return 0
    fi

    echo ""
    return 1
}

resolve_openrappter_version() {
    local version=""

    # Try openrappter --version first (works for both npm and git installs)
    local bin
    bin="$(resolve_openrappter_bin 2>/dev/null || true)"
    if [[ -n "$bin" ]]; then
        version="$("$bin" --version 2>/dev/null || true)"
    fi

    # Fall back to package.json (git install)
    if [[ -z "$version" ]]; then
        local ts_pkg="$INSTALL_DIR/typescript/package.json"
        if [[ -f "$ts_pkg" ]]; then
            version="$(node -e "console.log(require('${ts_pkg}').version)" 2>/dev/null || true)"
        fi
    fi

    # Fall back to npm list (npm install)
    if [[ -z "$version" ]]; then
        version="$(npm list -g openrappter --depth=0 2>/dev/null | grep openrappter | sed 's/.*@//' || true)"
    fi

    echo "$version"
}

# ── GitHub CLI (gh) ────────────────────────────────────────
install_gh_cli() {
    if command -v gh &>/dev/null; then
        ui_success "GitHub CLI (gh) already installed"
        return 0
    fi

    ui_info "Installing GitHub CLI (gh) for Copilot authentication"

    if [[ "$OS" == "macos" ]]; then
        if command -v brew &>/dev/null; then
            run_quiet_step "Installing gh" brew install gh
        else
            ui_warn "Homebrew not available — install gh manually: https://cli.github.com"
            return 1
        fi
    elif [[ "$OS" == "linux" ]]; then
        require_sudo
        if command -v apt-get &>/dev/null; then
            # Official GitHub APT repo
            local keyring="/usr/share/keyrings/githubcli-archive-keyring.gpg"
            if [[ ! -f "$keyring" ]]; then
                local tmp_key
                tmp_key="$(mktempfile)"
                download_file "https://cli.github.com/packages/githubcli-archive-keyring.gpg" "$tmp_key"
                if is_root; then
                    install -m 0644 "$tmp_key" "$keyring" 2>/dev/null || cp "$tmp_key" "$keyring"
                else
                    sudo install -m 0644 "$tmp_key" "$keyring" 2>/dev/null || sudo cp "$tmp_key" "$keyring"
                fi
            fi
            local list_file="/etc/apt/sources.list.d/github-cli.list"
            local arch
            arch="$(dpkg --print-architecture 2>/dev/null || echo amd64)"
            local entry="deb [arch=${arch} signed-by=${keyring}] https://cli.github.com/packages stable main"
            if is_root; then
                echo "$entry" > "$list_file"
                run_quiet_step "Updating package index" apt-get update -qq
                run_quiet_step "Installing gh" apt-get install -y -qq gh
            else
                echo "$entry" | sudo tee "$list_file" >/dev/null
                run_quiet_step "Updating package index" sudo apt-get update -qq
                run_quiet_step "Installing gh" sudo apt-get install -y -qq gh
            fi
        elif command -v dnf &>/dev/null; then
            if is_root; then
                run_quiet_step "Installing gh" dnf install -y -q 'dnf-command(config-manager)' && dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo && dnf install -y -q gh
            else
                run_quiet_step "Installing gh" sudo dnf install -y -q 'dnf-command(config-manager)' && sudo dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo && sudo dnf install -y -q gh
            fi
        elif command -v yum &>/dev/null; then
            if is_root; then
                run_quiet_step "Installing gh" yum-config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo && yum install -y -q gh
            else
                run_quiet_step "Installing gh" sudo yum-config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo && sudo yum install -y -q gh
            fi
        else
            ui_warn "Could not auto-install gh — install manually: https://cli.github.com"
            return 1
        fi
    fi

    refresh_shell_command_cache
    if command -v gh &>/dev/null; then
        ui_success "GitHub CLI installed ($(gh --version | head -1))"
        return 0
    fi

    ui_warn "gh installation may need a new shell — continuing anyway"
    return 1
}

# ── GitHub Copilot setup (device code OAuth — no gh CLI required) ──────────

# Minimal JSON field extractor (no jq needed)
parse_json_field() {
    local json="$1" field="$2"
    # Handle both quoted string and numeric values; strip trailing }, ], whitespace
    echo "$json" | sed 's/,/\n/g' | grep "\"${field}\"" | sed 's/.*"'"${field}"'"\s*:\s*//' | sed 's/^"//' | sed 's/".*$//' | sed 's/[[:space:]}]*$//' | head -1
}

copilot_device_code_login() {
    # 1. Request device code
    local response
    response="$(curl -sS -X POST "https://github.com/login/device/code" \
        -H "Accept: application/json" \
        -H "Content-Type: application/x-www-form-urlencoded" \
        -d "client_id=Iv1.b507a08c87ecfe98&scope=read:user")"

    local user_code device_code verification_uri interval expires_in
    user_code="$(parse_json_field "$response" "user_code")"
    device_code="$(parse_json_field "$response" "device_code")"
    verification_uri="$(parse_json_field "$response" "verification_uri")"
    interval="$(parse_json_field "$response" "interval")"
    expires_in="$(parse_json_field "$response" "expires_in")"

    if [[ -z "$user_code" || -z "$device_code" ]]; then
        ui_error "Failed to get device code from GitHub" >&2
        return 1
    fi

    # Default interval/expiry if parsing failed
    interval="${interval:-5}"
    expires_in="${expires_in:-900}"

    # 2. Display code to user (stderr so subshell capture doesn't swallow it)
    echo "" >&2
    if [[ -n "$GUM" ]]; then
        local code_display
        code_display="$(printf 'Enter code: %s\nURL: %s' "$user_code" "$verification_uri")"
        "$GUM" style --border rounded --border-foreground "#10b981" --padding "1 2" --foreground "#00e5cc" --bold "$code_display" >&2
    else
        echo -e "${SUCCESS}${BOLD}  Enter this code:  ${user_code}${NC}" >&2
        echo -e "${INFO}  Open: ${verification_uri}${NC}" >&2
    fi
    echo "" >&2

    # 3. Try to open browser
    if [[ "$(uname -s)" == "Darwin" ]]; then
        open "$verification_uri" 2>/dev/null || true
    elif command -v xdg-open &>/dev/null; then
        xdg-open "$verification_uri" 2>/dev/null || true
    fi

    ui_info "Waiting for GitHub authorization..." >&2

    # 4. Poll for token
    local deadline=$((SECONDS + expires_in))
    local wait_secs="$interval"

    while [[ $SECONDS -lt $deadline ]]; do
        sleep "$wait_secs"

        local token_response
        token_response="$(curl -sS -X POST "https://github.com/login/oauth/access_token" \
            -H "Accept: application/json" \
            -H "Content-Type: application/x-www-form-urlencoded" \
            -d "client_id=Iv1.b507a08c87ecfe98&device_code=${device_code}&grant_type=urn:ietf:params:oauth:grant-type:device_code")"

        local access_token error_field
        access_token="$(parse_json_field "$token_response" "access_token")"
        error_field="$(parse_json_field "$token_response" "error")"

        if [[ -n "$access_token" && "$access_token" != "null" ]]; then
            echo "$access_token"
            return 0
        fi

        case "$error_field" in
            authorization_pending)
                # Still waiting — continue polling
                ;;
            slow_down)
                wait_secs=$((wait_secs + 2))
                ;;
            access_denied)
                ui_error "GitHub login was cancelled" >&2
                return 1
                ;;
            expired_token)
                ui_error "Device code expired — please try again" >&2
                return 1
                ;;
            *)
                if [[ -n "$error_field" ]]; then
                    ui_error "GitHub device flow error: $error_field" >&2
                    return 1
                fi
                ;;
        esac
    done

    ui_error "Device code expired — please try again" >&2
    return 1
}

copilot_validate_token() {
    local token="$1"
    local response http_code
    response="$(curl -sS -w "\n%{http_code}" \
        "https://api.github.com/copilot_internal/v2/token" \
        -H "Accept: application/json" \
        -H "Authorization: Bearer $token")"
    http_code="${response##*$'\n'}"
    [[ "$http_code" == "200" ]]
}

save_github_token_to_env() {
    local github_token="$1"
    local token_source="$2"
    local env_file="$INSTALL_DIR/.env"
    mkdir -p "$INSTALL_DIR"

    # Update or create .env
    if [[ -f "$env_file" ]]; then
        # Remove old token lines if present
        if grep -qE "^(GITHUB_TOKEN|COPILOT_GITHUB_TOKEN)=" "$env_file" 2>/dev/null; then
            local tmp_env
            tmp_env="$(mktempfile)"
            grep -vE "^(GITHUB_TOKEN|COPILOT_GITHUB_TOKEN)=" "$env_file" > "$tmp_env"
            mv "$tmp_env" "$env_file"
        fi
    else
        echo "# openrappter environment — managed by installer" > "$env_file"
        echo "" >> "$env_file"
    fi
    # Save as COPILOT_GITHUB_TOKEN — checked first by resolveGithubToken(),
    # won't be overridden by gh CLI's GITHUB_TOKEN in the environment
    echo "COPILOT_GITHUB_TOKEN=\"${github_token}\"" >> "$env_file"
    ui_success "GitHub token saved (from $token_source)"
}

setup_copilot_sdk() {
    # Skip if --no-copilot flag set
    if [[ "${OPT_NO_COPILOT:-false}" == "true" ]]; then
        ui_info "Copilot setup skipped (--no-copilot)"
        return 0
    fi

    ui_info "Setting up GitHub Copilot (direct API integration)"

    local github_token=""
    local token_source=""

    # 1. Check env vars
    if [[ -n "${COPILOT_GITHUB_TOKEN:-}" ]]; then
        github_token="$COPILOT_GITHUB_TOKEN"
        token_source="COPILOT_GITHUB_TOKEN env"
    elif [[ -n "${GH_TOKEN:-}" ]]; then
        github_token="$GH_TOKEN"
        token_source="GH_TOKEN env"
    elif [[ -n "${GITHUB_TOKEN:-}" ]]; then
        github_token="$GITHUB_TOKEN"
        token_source="GITHUB_TOKEN env"
    fi

    # 2. Try gh auth token (if gh available — nice-to-have, not required)
    if [[ -z "$github_token" ]] && command -v gh &>/dev/null; then
        local gh_token
        gh_token="$(gh auth token 2>/dev/null || true)"
        if [[ -n "$gh_token" ]]; then
            github_token="$gh_token"
            token_source="gh CLI"
        fi
    fi

    # 3. If still no token and interactive TTY — run device code OAuth
    if [[ -z "$github_token" ]] && gum_is_tty; then
        ui_info "No GitHub token found — starting device code login"
        local dc_token
        dc_token="$(copilot_device_code_login)" || true
        if [[ -n "$dc_token" ]]; then
            github_token="$dc_token"
            token_source="device code OAuth"
        fi
    fi

    # 4. Non-interactive with no token — print instructions
    if [[ -z "$github_token" ]]; then
        ui_info "No GitHub token found — run 'openrappter onboard' to configure"
        return 0
    fi

    # 5. Validate token against Copilot API
    if copilot_validate_token "$github_token"; then
        ui_success "Copilot token validated"
        save_github_token_to_env "$github_token" "$token_source"
        return 0
    fi

    # Token failed validation — if it came from gh CLI or env, try device code instead
    ui_warn "Token from ${token_source} does not have Copilot API access"
    if gum_is_tty; then
        ui_info "Starting Copilot device code login to get a valid token..."
        local dc_token
        dc_token="$(copilot_device_code_login)" || true
        if [[ -n "$dc_token" ]]; then
            if copilot_validate_token "$dc_token"; then
                ui_success "Copilot token validated"
                save_github_token_to_env "$dc_token" "device code OAuth"
                return 0
            fi
        fi
        ui_warn "Could not obtain a valid Copilot token — run 'openrappter onboard' to retry"
    else
        ui_warn "Non-interactive shell — run 'openrappter onboard' to authenticate for Copilot"
    fi
}

# ── Install via Git (extracted from original main) ─────────
install_via_git() {
    local is_upgrade=false ring
    ring="$(effective_channel)" || exit 2
    resolve_ring_manifest "$ring" || exit 2
    if [[ -d "$INSTALL_DIR/.git" ]]; then
        is_upgrade=true
    fi

    # Git is required for this method
    if ! check_git; then
        install_git
    fi

    # Clone or update the canonical repo, then detach at the exact manifest
    # commit. `main` is never installed as a release identity.
    if [[ "$is_upgrade" == "true" ]]; then
        ui_info "Fetching exact ${ring} source ${RESOLVED_RING_COMMIT}..."
        [[ -z "$(git -C "$INSTALL_DIR" status --porcelain --untracked-files=no 2>/dev/null || true)" ]] ||
            { ui_error "Repo has tracked local changes; refusing exact checkout"; exit 1; }
        run_quiet_step "Fetching source commit" git -C "$INSTALL_DIR" fetch --depth 1 origin "$RESOLVED_RING_COMMIT"
    else
        if [[ -d "$INSTALL_DIR" ]]; then
            ui_warn "$INSTALL_DIR exists but is not a git repo — backing up"
            mv "$INSTALL_DIR" "${INSTALL_DIR}.bak.$(date +%s)"
        fi
        run_quiet_step "Cloning openrappter" git clone --no-checkout --filter=blob:none "$REPO_URL" "$INSTALL_DIR"
        run_quiet_step "Fetching source commit" git -C "$INSTALL_DIR" fetch --depth 1 origin "$RESOLVED_RING_COMMIT"
        ui_success "Cloned to $INSTALL_DIR"
    fi
    run_quiet_step "Checking out exact source" git -C "$INSTALL_DIR" checkout --detach "$RESOLVED_RING_COMMIT"
    [[ "$(git -C "$INSTALL_DIR" rev-parse HEAD)" == "$RESOLVED_RING_COMMIT" ]] ||
        { ui_error "Exact source checkout verification failed"; exit 1; }

    cd "$INSTALL_DIR"

    # Fix npm prefix if needed (Linux EACCES)
    fix_npm_prefix_if_needed

    # TypeScript runtime
    ui_info "Installing TypeScript dependencies"
    cd "$INSTALL_DIR/typescript"

    # Clean stale build artifacts (prevents old compiled files from lingering after upgrades)
    if [[ -d dist ]]; then
        rm -rf dist
        ui_info "Cleaned stale dist/ directory"
    fi

    if [[ -f package.json ]]; then
        if ! retry 3 2 run_quiet_step "Installing npm dependencies" npm install --no-fund --no-audit; then
            ui_error "npm install failed after retries"
            echo "  This is often caused by network issues. Try again or check your connection."
            echo "  You can also try: cd $INSTALL_DIR/typescript && npm install"
            exit 1
        fi
        ui_success "Dependencies installed"

        if ! run_quiet_step "Building TypeScript" npm run build; then
            ui_error "TypeScript build failed"
            echo "  Node version: $(node --version 2>/dev/null || echo 'unknown')"
            echo "  npm version:  $(npm --version 2>/dev/null || echo 'unknown')"
            echo "  Try: cd $INSTALL_DIR/typescript && npm run build"
            exit 1
        fi
        ui_success "TypeScript runtime built"
    else
        ui_error "package.json not found in typescript/ — repo may be incomplete"
    fi

    # Python runtime (optional)
    local python_cmd
    python_cmd="$(get_python_cmd)"

    if [[ -n "$python_cmd" ]] && check_python_meets_min; then
        HAS_PYTHON=true
        ui_success "Python $($python_cmd --version 2>&1 | sed 's/Python //') found"

        local venv_dir="$INSTALL_DIR/.venv"
        local venv_python="$venv_dir/bin/python"

        # Rebuild stale or incompatible environments without modifying the
        # externally managed system/Homebrew interpreter (PEP 668).
        if [[ -x "$venv_python" ]] && ! python_cmd_meets_min "$venv_python"; then
            mv "$venv_dir" "${venv_dir}.bak.$(date +%s)"
        fi

        if [[ ! -x "$venv_python" ]]; then
            if ! run_quiet_step "Creating Python virtual environment" "$python_cmd" -m venv "$venv_dir"; then
                # Debian-family installations may split venv support into a
                # separate package. Attempt that once, then retry creation.
                ui_info "Python venv support unavailable, attempting to install it"
                if [[ "$OS" == "linux" ]]; then
                    if command -v apt-get &>/dev/null; then
                        if is_root; then
                            run_quiet_step "Installing python3-venv" apt-get install -y -qq python3-venv 2>/dev/null || true
                        else
                            run_quiet_step "Installing python3-venv" sudo apt-get install -y -qq python3-venv 2>/dev/null || true
                        fi
                    elif command -v dnf &>/dev/null; then
                        if is_root; then
                            run_quiet_step "Installing python3-pip" dnf install -y -q python3-pip 2>/dev/null || true
                        else
                            run_quiet_step "Installing python3-pip" sudo dnf install -y -q python3-pip 2>/dev/null || true
                        fi
                    elif command -v yum &>/dev/null; then
                        if is_root; then
                            run_quiet_step "Installing python3-pip" yum install -y -q python3-pip 2>/dev/null || true
                        else
                            run_quiet_step "Installing python3-pip" sudo yum install -y -q python3-pip 2>/dev/null || true
                        fi
                    elif command -v apk &>/dev/null; then
                        if is_root; then
                            run_quiet_step "Installing py3-pip" apk add --no-cache py3-pip 2>/dev/null || true
                        else
                            run_quiet_step "Installing py3-pip" sudo apk add --no-cache py3-pip 2>/dev/null || true
                        fi
                    fi
                fi

                if ! run_quiet_step "Creating Python virtual environment" "$python_cmd" -m venv "$venv_dir"; then
                    ui_warn "Python virtual environment creation failed — TypeScript runtime still works"
                    HAS_PYTHON=false
                fi
            fi
        fi

        if [[ "$HAS_PYTHON" == "true" ]]; then
            cd "$INSTALL_DIR/python"
            if [[ -f pyproject.toml ]]; then
                if run_quiet_step "Installing Python package" "$venv_python" -m pip install -e . --quiet; then
                    ui_success "Python runtime installed in $venv_dir"
                else
                    ui_warn "Python package install failed — TypeScript runtime still works"
                    HAS_PYTHON=false
                fi
            fi
        fi
    else
        ui_info "Python 3.${MIN_PYTHON_MINOR}+ not found — skipping (TypeScript works fine alone)"
    fi

    # Create launcher (only for git method — npm uses package.json bin)
    local bin_dir
    bin_dir="$(get_bin_dir)"
    create_launcher "$bin_dir"
    ensure_path "$bin_dir"
    ui_success "Created $bin_dir/$BIN_NAME"

    # PATH warning
    warn_shell_path_missing_dir "$bin_dir" "bin dir"
}

# ── Main ────────────────────────────────────────────────────
main() {
    if [[ "$HELP" == "1" ]]; then
        print_usage
        return 0
    fi

    bootstrap_gum_temp || true
    print_installer_banner
    print_gum_status
    detect_os_or_die

    # ── Stage 1: Preparing environment ──
    ui_stage "Preparing environment"

    install_homebrew

    if ! check_node; then
        install_node
    fi

    # Ensure build tools are available on Linux (for native modules like better-sqlite3)
    ensure_build_tools

    # ── Stage 2: Choose install method ──
    ui_stage "Choosing install method"

    choose_install_method

    show_install_plan

    if [[ "$DRY_RUN" == "1" ]]; then
        ui_success "Dry run complete (no changes made)"
        return 0
    fi

    # Check for existing installation (for upgrade messaging)
    local is_upgrade=false
    local existing_method
    existing_method="$(detect_existing_install)"
    if [[ "$existing_method" != "none" ]]; then
        is_upgrade=true
    fi

    # Resolve conflicts when switching methods
    resolve_npm_conflicts

    # Global flag for Python availability (set by install_via_git)
    HAS_PYTHON=false

    # ── Stage 3: Install openrappter ──
    ui_stage "Installing openrappter"
    ui_patience_notice

    if [[ "$INSTALL_METHOD" == "npm" ]]; then
        install_via_npm
    else
        install_via_git
    fi

    # ── Copilot SDK (for git method; npm method has .env in home dir) ──
    if [[ "$INSTALL_METHOD" == "git" ]]; then
        local env_file="$INSTALL_DIR/.env"
        if [[ -f "$env_file" ]]; then
            ui_info "Clearing old .env for fresh setup"
            rm -f "$env_file"
        fi
        setup_copilot_sdk
    else
        # For npm method, store .env in ~/.openrappter/
        mkdir -p "$HOME/.openrappter"
        INSTALL_DIR="$HOME/.openrappter"
        setup_copilot_sdk
    fi

    # ── Stage 4: Finalizing setup ──
    ui_stage "Finalizing setup"

    # Gateway restart on upgrades
    if [[ "$is_upgrade" == "true" ]]; then
        detect_and_restart_gateway
    fi

    # Doctor/migration check on upgrades
    if [[ "$is_upgrade" == "true" ]]; then
        run_doctor_if_available
    fi

    # Verify binary
    local OPENRAPPTER_BIN=""
    OPENRAPPTER_BIN="$(resolve_openrappter_bin || true)"

    if [[ -n "$OPENRAPPTER_BIN" ]]; then
        "$OPENRAPPTER_BIN" --status 2>/dev/null || true
    fi

    local installed_version
    installed_version=$(resolve_openrappter_version)

    echo ""
    if [[ -n "$installed_version" ]]; then
        ui_celebrate "🦖 openrappter installed successfully (v${installed_version})!"
    else
        ui_celebrate "🦖 openrappter installed successfully!"
    fi

    if [[ "$is_upgrade" == "true" ]]; then
        local update_messages=(
            "Leveled up! New agents unlocked. You're welcome."
            "Fresh code, same raptor. Miss me?"
            "Back and better. Did you even notice I was gone?"
            "Update complete. I learned some new tricks while I was out."
            "Upgraded! Now with 23% more data sloshing."
            "I've evolved. Try to keep up. 🦖"
            "New version, who dis? Oh right, still me but shinier."
            "Patched, polished, and ready to execute. Let's go."
            "The raptor has molted. Harder shell, sharper claws."
            "Update done! Check the changelog or just trust me, it's good."
            "I went away and came back smarter. You should try it sometime."
            "Update complete. The bugs feared me, so they left."
            "New version installed. Old version sends its regards."
            "Back online. The changelog is long but our friendship is longer."
            "Molting complete. Please don't look at my soft shell phase."
            "Version bump! Same chaos energy, fewer crashes (probably)."
        )
        local update_message
        update_message="${update_messages[RANDOM % ${#update_messages[@]}]}"
        echo -e "${MUTED}${update_message}${NC}"
    else
        local completion_messages=(
            "Ahh nice, I like it here. Got any snacks?"
            "Home sweet home. Don't worry, I won't rearrange the furniture."
            "I'm in. Let's cause some responsible chaos."
            "Installation complete. Your productivity is about to get weird."
            "Settled in. Time to automate your life whether you're ready or not."
            "Finally unpacked. Now point me at your problems."
            "*cracks claws* Alright, what are we building?"
            "The raptor has landed. Your terminal will never be the same."
            "All done! I promise to only judge your code a little bit."
            "Local-first, baby. Your data stays right here. 🦖"
        )
        local completion_message
        completion_message="${completion_messages[RANDOM % ${#completion_messages[@]}]}"
        echo -e "${MUTED}${completion_message}${NC}"
    fi
    echo ""

    # Determine if the user needs to activate PATH in their shell
    local needs_activation=false
    local shell_rc
    local bin_dir
    shell_rc="$(get_shell_rc_file)"
    bin_dir="$(get_bin_dir)"
    if needs_path_activation "$bin_dir"; then
        needs_activation=true
    fi

    ui_section "What's next"

    # Show prominent activation step FIRST if needed
    if [[ "$needs_activation" == "true" ]]; then
        echo ""
        if [[ -n "$GUM" ]]; then
            local activate_msg
            activate_msg="$(printf 'To start using openrappter, run:\n\n  source %s\n\nOr open a new terminal.' "$shell_rc")"
            "$GUM" style --border rounded --border-foreground "#FFB020" --foreground "#FFB020" --bold --padding "1 2" "$activate_msg"
        else
            echo ""
            echo -e "${WARN}${BOLD}  ╭──────────────────────────────────────────────╮${NC}"
            echo -e "${WARN}${BOLD}  │  To start using openrappter, run:            │${NC}"
            echo -e "${WARN}${BOLD}  │                                              │${NC}"
            echo -e "${WARN}${BOLD}  │    source ${shell_rc}${NC}"
            echo -e "${WARN}${BOLD}  │                                              │${NC}"
            echo -e "${WARN}${BOLD}  │  Or open a new terminal.                     │${NC}"
            echo -e "${WARN}${BOLD}  ╰──────────────────────────────────────────────╯${NC}"
        fi
        echo ""
    fi

    ui_kv "Setup wizard" "openrappter onboard"
    ui_kv "Check status" "openrappter --status"
    ui_kv "List agents" "openrappter --list-agents"
    ui_kv "Chat" "openrappter \"hello\""
    if [[ "$INSTALL_METHOD" == "git" ]]; then
        ui_kv "Install dir" "$INSTALL_DIR"
        ui_kv "Command" "$bin_dir/$BIN_NAME"
        ui_kv "Update" "cd $INSTALL_DIR && git pull && cd typescript && npm run build"
    else
        ui_kv "Method" "npm global"
        ui_kv "Update" "npm update -g openrappter"
    fi
    if [[ "$HAS_PYTHON" == "true" ]]; then
        ui_kv "Python runtime" "also installed"
    fi
    echo ""

    # Auto-run onboard wizard (skip with --no-onboard; requires TTY for interactive prompts)
    # Note: `curl | bash` redirects stdin from the pipe, so -t 0 is false even in a terminal.
    # We check /dev/tty instead and redirect stdin from it so the wizard can prompt the user.
    if [[ "${OPT_NO_ONBOARD:-false}" != "true" ]] && [[ -n "$OPENRAPPTER_BIN" ]]; then
        if has_controlling_tty; then
            echo ""
            ui_info "Running setup wizard..."
            echo ""
            "$OPENRAPPTER_BIN" onboard </dev/tty
        else
            echo ""
            ui_info "Non-interactive shell detected — skipping setup wizard."
            ui_info "Run 'openrappter onboard' in your terminal to complete setup."
        fi
    fi

    # Repeat the activation reminder AFTER onboard (so user sees it last)
    if [[ "$needs_activation" == "true" ]]; then
        echo ""
        if [[ -n "$GUM" ]]; then
            "$GUM" style --foreground "#FFB020" --bold "⚠ Remember: source ${shell_rc}  (or open a new terminal)"
        else
            echo -e "${WARN}${BOLD}⚠ Remember: source ${shell_rc}  (or open a new terminal)${NC}"
        fi
    fi

    show_footer_links
}

# Run main unless sourced (for testing)
if [[ "${OPENRAPPTER_INSTALL_SH_NO_RUN:-0}" != "1" ]]; then
    parse_args "$@"
    configure_verbose
    main
fi
