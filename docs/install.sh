#!/bin/bash
set -euo pipefail

# OpenRappter Installer for macOS and Linux
# Usage: curl -fsSL https://kody-w.github.io/openrappter/install.sh | bash

BOLD='\033[1m'
ACCENT='\033[38;2;16;185;129m'       # green-bright  #10b981
# shellcheck disable=SC2034
ACCENT_BRIGHT='\033[38;2;52;211;153m' # lighter green #34d399
INFO='\033[38;2;136;146;176m'        # text-secondary #8892b0
SUCCESS='\033[38;2;0;229;204m'       # cyan-bright   #00e5cc
WARN='\033[38;2;255;176;32m'         # amber
ERROR='\033[38;2;230;57;70m'         # coral-mid     #e63946
MUTED='\033[38;2;90;100;128m'        # text-muted    #5a6480
NC='\033[0m' # No Color

DEFAULT_TAGLINE="AI agents powered by your existing GitHub Copilot subscription."

ORIGINAL_PATH="${PATH:-}"

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

run_remote_bash() {
    local url="$1"
    local tmp
    tmp="$(mktempfile)"
    download_file "$url" "$tmp"
    /bin/bash "$tmp"
}

# ── Gum (fancy terminal UI) ────────────────────────────────
GUM_VERSION="${OPENRAPPTER_GUM_VERSION:-0.17.0}"
GUM=""
GUM_STATUS="skipped"
GUM_REASON=""

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
    if [[ -r /dev/tty && -w /dev/tty ]]; then
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

    if ! (cd "$gum_tmpdir" && verify_sha256sum_file "checksums.txt"); then
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
        *) echo "$(uname -m)" ;;
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

INSTALL_STAGE_TOTAL=3
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

    "$@"
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
        if run_with_spinner "$title" bash -c "${cmd_quoted}>${log_quoted} 2>&1"; then
            return 0
        fi
    else
        if "$@" >"$log" 2>&1; then
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
    ui_kv "Install directory" "$INSTALL_DIR"
    ui_kv "Node.js minimum" "v${MIN_NODE}+"
    ui_kv "Python" "optional (3.${MIN_PYTHON_MINOR}+)"
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
MIN_NODE=18
MIN_PYTHON_MINOR=10
BIN_NAME="openrappter"

print_usage() {
    cat <<EOF
OpenRappter installer (macOS + Linux)

Usage:
  curl -fsSL https://kody-w.github.io/openrappter/install.sh | bash
  curl -fsSL https://kody-w.github.io/openrappter/install.sh | bash -s -- [options]

Options:
  --dir <path>                       Install directory (default: ~/.openrappter)
  --dry-run                          Print what would happen (no changes)
  --verbose                          Print debug output
  --gum                              Force gum UI if possible
  --no-gum                           Disable gum UI
  --help, -h                         Show this help

Environment variables:
  OPENRAPPTER_HOME=...              Install directory (default: ~/.openrappter)
  OPENRAPPTER_DRY_RUN=1             Dry run mode
  OPENRAPPTER_VERBOSE=1             Verbose output
  OPENRAPPTER_USE_GUM=auto|1|0      Default: auto (try gum on interactive TTY)

Examples:
  curl -fsSL https://kody-w.github.io/openrappter/install.sh | bash
  curl -fsSL https://kody-w.github.io/openrappter/install.sh | bash -s -- --verbose
  curl -fsSL https://kody-w.github.io/openrappter/install.sh | bash -s -- --dir ~/my-agents
EOF
}

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
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
            run_quiet_step "Installing Homebrew" run_remote_bash "https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh"

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
    if command -v node &> /dev/null; then
        local node_ver
        node_ver=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
        if [[ "$node_ver" -ge "$MIN_NODE" ]]; then
            ui_success "Node.js v$(node -v | cut -d'v' -f2) found"
            return 0
        else
            ui_info "Node.js $(node -v) found, upgrading to v${MIN_NODE}+"
            return 1
        fi
    else
        ui_info "Node.js not found, installing it now"
        return 1
    fi
}

install_node() {
    if [[ "$OS" == "macos" ]]; then
        if command -v brew &> /dev/null; then
            ui_info "Installing Node.js via Homebrew"
            run_quiet_step "Installing node@${MIN_NODE}" brew install "node@${MIN_NODE}"
            brew link "node@${MIN_NODE}" --overwrite --force 2>/dev/null || true
            ui_success "Node.js installed via Homebrew"
        else
            ui_info "Installing Node.js via nvm"
            install_node_nvm
        fi
    elif [[ "$OS" == "linux" ]]; then
        ui_info "Installing Node.js via NodeSource"
        require_sudo

        if command -v apt-get &> /dev/null; then
            local tmp
            tmp="$(mktempfile)"
            download_file "https://deb.nodesource.com/setup_${MIN_NODE}.x" "$tmp"
            if is_root; then
                run_quiet_step "Configuring NodeSource repository" bash "$tmp"
                run_quiet_step "Installing Node.js" apt-get install -y -qq nodejs
            else
                run_quiet_step "Configuring NodeSource repository" sudo -E bash "$tmp"
                run_quiet_step "Installing Node.js" sudo apt-get install -y -qq nodejs
            fi
        elif command -v dnf &> /dev/null; then
            local tmp
            tmp="$(mktempfile)"
            download_file "https://rpm.nodesource.com/setup_${MIN_NODE}.x" "$tmp"
            if is_root; then
                run_quiet_step "Configuring NodeSource repository" bash "$tmp"
                run_quiet_step "Installing Node.js" dnf install -y -q nodejs
            else
                run_quiet_step "Configuring NodeSource repository" sudo bash "$tmp"
                run_quiet_step "Installing Node.js" sudo dnf install -y -q nodejs
            fi
        elif command -v yum &> /dev/null; then
            local tmp
            tmp="$(mktempfile)"
            download_file "https://rpm.nodesource.com/setup_${MIN_NODE}.x" "$tmp"
            if is_root; then
                run_quiet_step "Configuring NodeSource repository" bash "$tmp"
                run_quiet_step "Installing Node.js" yum install -y -q nodejs
            else
                run_quiet_step "Configuring NodeSource repository" sudo bash "$tmp"
                run_quiet_step "Installing Node.js" sudo yum install -y -q nodejs
            fi
        else
            ui_info "Falling back to nvm"
            install_node_nvm
            return
        fi

        ui_success "Node.js v${MIN_NODE} installed"
    fi
}

install_node_nvm() {
    if [[ ! -d "$HOME/.nvm" ]]; then
        run_quiet_step "Installing nvm" run_remote_bash "https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh"
    fi

    export NVM_DIR="$HOME/.nvm"
    # shellcheck disable=SC1091
    [[ -s "$NVM_DIR/nvm.sh" ]] && . "$NVM_DIR/nvm.sh"

    nvm install "$MIN_NODE" --default
    nvm use "$MIN_NODE"
    ui_success "Node.js $(node --version) installed via nvm"
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
get_python_version() {
    local cmd=""
    if command -v python3 &>/dev/null; then
        cmd="python3"
    elif command -v python &>/dev/null; then
        cmd="python"
    fi

    if [[ -n "$cmd" ]]; then
        $cmd --version 2>&1 | sed 's/Python //' | head -1
    else
        echo "0.0.0"
    fi
}

check_python_meets_min() {
    local ver
    ver="$(get_python_version)"
    local major minor
    major="$(echo "$ver" | cut -d. -f1)"
    minor="$(echo "$ver" | cut -d. -f2)"

    if [[ "$major" -ge 3 ]] 2>/dev/null && [[ "$minor" -ge "$MIN_PYTHON_MINOR" ]] 2>/dev/null; then
        return 0
    fi
    return 1
}

get_python_cmd() {
    if command -v python3 &>/dev/null; then
        echo "python3"
    elif command -v python &>/dev/null; then
        echo "python"
    else
        echo ""
    fi
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
                echo "" >> "$shell_rc"
                echo "# Added by openrappter installer" >> "$shell_rc"
                echo "$path_line" >> "$shell_rc"
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

# ── Launcher Script ────────────────────────────────────────
create_launcher() {
    local bin_dir="$1"
    local launcher="$bin_dir/$BIN_NAME"

    cat > "$launcher" << 'LAUNCHER'
#!/usr/bin/env bash
# openrappter launcher — routes to the installed runtime
set -euo pipefail

OPENRAPPTER_HOME="${OPENRAPPTER_HOME:-$HOME/.openrappter}"

# Source nvm if needed
if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
    export NVM_DIR="$HOME/.nvm"
    . "$NVM_DIR/nvm.sh" 2>/dev/null || true
fi

# TypeScript runtime (primary)
TS_DIR="$OPENRAPPTER_HOME/typescript"
if [[ -f "$TS_DIR/dist/index.js" ]]; then
    exec node "$TS_DIR/dist/index.js" "$@"
fi

# Python runtime (fallback)
PY_DIR="$OPENRAPPTER_HOME/python"
if [[ -f "$PY_DIR/openrappter/cli.py" ]]; then
    if command -v python3 &>/dev/null; then
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
    local ts_pkg="$INSTALL_DIR/typescript/package.json"
    if [[ -f "$ts_pkg" ]]; then
        version="$(node -e "console.log(require('${ts_pkg}').version)" 2>/dev/null || true)"
    fi
    echo "$version"
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

    show_install_plan

    if [[ "$DRY_RUN" == "1" ]]; then
        ui_success "Dry run complete (no changes made)"
        return 0
    fi

    # Check for existing installation
    local is_upgrade=false
    if [[ -d "$INSTALL_DIR/.git" ]]; then
        is_upgrade=true
        ui_info "Existing openrappter installation detected, upgrading"
    fi

    # ── Stage 1: Preparing environment ──
    ui_stage "Preparing environment"

    install_homebrew

    if ! check_node; then
        install_node
    fi

    if ! check_git; then
        install_git
    fi

    # ── Stage 2: Installing openrappter ──
    ui_stage "Installing openrappter"

    # Clone or update repo
    if [[ "$is_upgrade" == "true" ]]; then
        ui_info "Updating existing installation..."
        cd "$INSTALL_DIR"
        if [[ -z "$(git -C "$INSTALL_DIR" status --porcelain 2>/dev/null || true)" ]]; then
            run_quiet_step "Updating repository" git -C "$INSTALL_DIR" pull --rebase || true
        else
            ui_info "Repo has local changes; skipping git pull"
        fi
        ui_success "Updated to latest"
    else
        if [[ -d "$INSTALL_DIR" ]]; then
            ui_warn "$INSTALL_DIR exists but is not a git repo — backing up"
            mv "$INSTALL_DIR" "${INSTALL_DIR}.bak.$(date +%s)"
        fi
        run_quiet_step "Cloning openrappter" git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
        ui_success "Cloned to $INSTALL_DIR"
    fi

    cd "$INSTALL_DIR"

    # TypeScript runtime
    ui_info "Installing TypeScript dependencies"
    cd "$INSTALL_DIR/typescript"

    if [[ -f package.json ]]; then
        run_quiet_step "Installing npm dependencies" npm install --no-fund --no-audit
        ui_success "Dependencies installed"

        run_quiet_step "Building TypeScript" npm run build
        ui_success "TypeScript runtime built"
    else
        ui_error "package.json not found in typescript/ — repo may be incomplete"
    fi

    # Python runtime (optional)
    local has_python=false
    local python_cmd
    python_cmd="$(get_python_cmd)"

    if [[ -n "$python_cmd" ]] && check_python_meets_min; then
        has_python=true
        ui_success "Python $($python_cmd --version 2>&1 | sed 's/Python //') found"

        # Ensure pip is available (some Linux distros ship python3 without pip)
        if ! "$python_cmd" -m pip --version &>/dev/null; then
            ui_info "pip not found, attempting to install"
            if [[ "$OS" == "linux" ]]; then
                if command -v apt-get &>/dev/null; then
                    if is_root; then
                        run_quiet_step "Installing python3-pip" apt-get install -y -qq python3-pip python3-venv 2>/dev/null || true
                    else
                        run_quiet_step "Installing python3-pip" sudo apt-get install -y -qq python3-pip python3-venv 2>/dev/null || true
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
            # Fallback: try ensurepip
            if ! "$python_cmd" -m pip --version &>/dev/null; then
                "$python_cmd" -m ensurepip --default-pip 2>/dev/null || true
            fi
        fi

        # Install Python package if pip is now available
        if "$python_cmd" -m pip --version &>/dev/null; then
            cd "$INSTALL_DIR/python"
            if [[ -f pyproject.toml ]]; then
                if run_quiet_step "Installing Python package" "$python_cmd" -m pip install -e . --quiet; then
                    ui_success "Python runtime installed"
                else
                    ui_warn "Python package install failed — TypeScript runtime still works"
                    has_python=false
                fi
            fi
        else
            ui_warn "pip unavailable — skipping Python runtime (TypeScript works fine alone)"
            has_python=false
        fi
    else
        ui_info "Python 3.${MIN_PYTHON_MINOR}+ not found — skipping (TypeScript works fine alone)"
    fi

    # ── Stage 3: Finalizing setup ──
    ui_stage "Finalizing setup"

    # Create launcher
    local bin_dir
    bin_dir="$(get_bin_dir)"
    create_launcher "$bin_dir"
    ensure_path "$bin_dir"
    ui_success "Created $bin_dir/$BIN_NAME"

    # PATH warning
    warn_shell_path_missing_dir "$bin_dir" "bin dir"

    # Verify
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

    ui_section "What's next"
    ui_kv "Setup wizard" "openrappter onboard"
    ui_kv "Check status" "openrappter --status"
    ui_kv "List agents" "openrappter --list-agents"
    ui_kv "Chat" "openrappter \"hello\""
    ui_kv "Install dir" "$INSTALL_DIR"
    ui_kv "Command" "$bin_dir/$BIN_NAME"
    if [[ "$has_python" == "true" ]]; then
        ui_kv "Python runtime" "also installed"
    fi
    echo ""

    # Auto-run onboard wizard (skip with --no-onboard; requires TTY for interactive prompts)
    if [[ "${OPT_NO_ONBOARD:-false}" != "true" ]] && [[ -n "$OPENRAPPTER_BIN" ]]; then
        if [[ -t 0 ]]; then
            echo ""
            ui_info "Running setup wizard..."
            echo ""
            "$OPENRAPPTER_BIN" onboard
        else
            echo ""
            ui_info "Non-interactive shell detected — skipping setup wizard."
            ui_info "Run 'openrappter onboard' in your terminal to complete setup."
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
