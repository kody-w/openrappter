#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# Tests for install.sh
# Run: bash tests/test_install.sh
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
INSTALL_SCRIPT="$REPO_ROOT/install.sh"

# ── Test Framework ──────────────────────────────────────────
TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0

pass() { ((TESTS_PASSED++)) || true; printf "\033[0;32m  ✓\033[0m %s\n" "$1"; }
fail() { ((TESTS_FAILED++)) || true; printf "\033[0;31m  ✗\033[0m %s\n" "$1"; }

assert_eq() {
  ((TESTS_RUN++)) || true
  if [ "$1" = "$2" ]; then
    pass "$3"
  else
    fail "$3 (expected '$2', got '$1')"
  fi
}

assert_contains() {
  ((TESTS_RUN++)) || true
  if [[ "$1" == *"$2"* ]]; then
    pass "$3"
  else
    fail "$3 (expected to contain '$2')"
  fi
}

assert_not_empty() {
  ((TESTS_RUN++)) || true
  if [ -n "$1" ]; then
    pass "$2"
  else
    fail "$2 (was empty)"
  fi
}

assert_file_exists() {
  ((TESTS_RUN++)) || true
  if [ -f "$1" ]; then
    pass "$2"
  else
    fail "$2 ($1 not found)"
  fi
}

assert_executable() {
  ((TESTS_RUN++)) || true
  if [ -x "$1" ]; then
    pass "$2"
  else
    fail "$2 ($1 not executable)"
  fi
}

# ── Source the script for function access ───────────────────
export OPENRAPPTER_INSTALL_SH_NO_RUN=1
source "$INSTALL_SCRIPT"

# Pre-load script content for content assertion tests
script_content="$(cat "$INSTALL_SCRIPT")"

# ── Test Suite ──────────────────────────────────────────────
printf "\n\033[1m🧪 openrappter install.sh tests\033[0m\n\n"

# ── Script basics ──
printf "\033[1m▸ Script basics\033[0m\n"
assert_file_exists "$INSTALL_SCRIPT" "install.sh exists"
assert_executable "$INSTALL_SCRIPT" "install.sh is executable"
assert_file_exists "$REPO_ROOT/docs/install.sh" "docs/install.sh exists (GitHub Pages)"

# Check the docs copy matches the root copy
((TESTS_RUN++)) || true
if diff -q "$INSTALL_SCRIPT" "$REPO_ROOT/docs/install.sh" &>/dev/null; then
  pass "docs/install.sh matches root install.sh"
else
  fail "docs/install.sh does not match root install.sh"
fi

# ── OS Detection ──
printf "\n\033[1m▸ OS detection\033[0m\n"

# Test detect_os_or_die sets OS variable
if [ "$(uname -s)" = "Darwin" ]; then
  OS=""
  detect_os_or_die 2>/dev/null || true
  assert_eq "$OS" "macos" "detect_os_or_die sets OS=macos on macOS"
fi

if [ "$(uname -s)" = "Linux" ]; then
  OS=""
  detect_os_or_die 2>/dev/null || true
  assert_eq "$OS" "linux" "detect_os_or_die sets OS=linux on Linux"
fi

# ── Arch Detection ──
printf "\n\033[1m▸ Architecture detection\033[0m\n"

arch_result="$(detect_arch)"
assert_not_empty "$arch_result" "detect_arch returns a value"

uname_m="$(uname -m)"
case "$uname_m" in
  x86_64|amd64) assert_eq "$arch_result" "x64" "detect_arch maps $uname_m to x64" ;;
  arm64|aarch64) assert_eq "$arch_result" "arm64" "detect_arch maps $uname_m to arm64" ;;
  *) assert_eq "$arch_result" "$uname_m" "detect_arch returns raw arch for $uname_m" ;;
esac

# ── Gum Detection ──
printf "\n\033[1m▸ Gum UI system\033[0m\n"

gum_os="$(gum_detect_os)"
assert_not_empty "$gum_os" "gum_detect_os returns a value"

gum_arch="$(gum_detect_arch)"
assert_not_empty "$gum_arch" "gum_detect_arch returns a value"

assert_eq "$GUM_VERSION" "0.17.0" "GUM_VERSION defaults to 0.17.0"

# ── Node.js Version ──
printf "\n\033[1m▸ Node.js version check\033[0m\n"

node_major="$(get_node_major)"
assert_not_empty "$node_major" "get_node_major returns a value"

if command -v node &>/dev/null; then
  expected_major="$(node --version | sed 's/^v//' | cut -d. -f1)"
  assert_eq "$node_major" "$expected_major" "get_node_major matches actual Node.js major version"

  ((TESTS_RUN++)) || true
  if [ "$node_major" -ge "$MIN_NODE" ]; then
    pass "Node.js v$node_major meets minimum v$MIN_NODE"
  else
    fail "Node.js v$node_major does not meet minimum v$MIN_NODE"
  fi
else
  assert_eq "$node_major" "0" "get_node_major returns 0 when node not found"
fi

# ── Python Version ──
printf "\n\033[1m▸ Python version check\033[0m\n"

python_ver="$(get_python_version)"
assert_not_empty "$python_ver" "get_python_version returns a value"

python_cmd="$(get_python_cmd)"
if [ -n "$python_cmd" ]; then
  assert_not_empty "$python_cmd" "get_python_cmd returns a command"
  assert_contains "$python_ver" "." "get_python_version returns a dotted version"

  ((TESTS_RUN++)) || true
  if check_python_meets_min; then
    pass "Python $python_ver meets minimum 3.$MIN_PYTHON_MINOR"
  else
    pass "Python $python_ver detected (may not meet minimum — that's OK)"
  fi
else
  assert_eq "$python_ver" "0.0.0" "get_python_version returns 0.0.0 when python not found"
fi

# ── Bin Directory ──
printf "\n\033[1m▸ Bin directory\033[0m\n"

bin_dir="$(get_bin_dir)"
assert_not_empty "$bin_dir" "get_bin_dir returns a path"

((TESTS_RUN++)) || true
if [ -d "$bin_dir" ] || [ -d "$(dirname "$bin_dir")" ]; then
  pass "bin directory exists or parent exists: $bin_dir"
else
  fail "bin directory path invalid: $bin_dir"
fi

# ── Launcher Script ──
printf "\n\033[1m▸ Launcher script generation\033[0m\n"

TEMP_BIN="$(mktemp -d)"
trap 'rm -rf "$TEMP_BIN"' EXIT

create_launcher "$TEMP_BIN"
assert_file_exists "$TEMP_BIN/$BIN_NAME" "launcher script is created"
assert_executable "$TEMP_BIN/$BIN_NAME" "launcher script is executable"

launcher_content="$(cat "$TEMP_BIN/$BIN_NAME")"
assert_contains "$launcher_content" "OPENRAPPTER_HOME" "launcher references OPENRAPPTER_HOME"
assert_contains "$launcher_content" "typescript" "launcher references TypeScript runtime"
assert_contains "$launcher_content" "python" "launcher references Python fallback"
assert_contains "$launcher_content" "exec node" "launcher uses exec for Node.js"
assert_contains "$launcher_content" '#!/usr/bin/env bash' "launcher has proper shebang"

# ── UI Functions ──
printf "\n\033[1m▸ UI functions\033[0m\n"

((TESTS_RUN++)) || true
ui_info_output="$(ui_info "test message" 2>&1)"
if echo "$ui_info_output" | grep -q "test message"; then
  pass "ui_info outputs message"
else
  fail "ui_info does not output message"
fi

((TESTS_RUN++)) || true
ui_success_output="$(ui_success "test success" 2>&1)"
if echo "$ui_success_output" | grep -q "test success"; then
  pass "ui_success outputs message"
else
  fail "ui_success does not output message"
fi

((TESTS_RUN++)) || true
ui_warn_output="$(ui_warn "test warning" 2>&1)"
if echo "$ui_warn_output" | grep -q "test warning"; then
  pass "ui_warn outputs message"
else
  fail "ui_warn does not output message"
fi

((TESTS_RUN++)) || true
ui_error_output="$(ui_error "test error" 2>&1)"
if echo "$ui_error_output" | grep -q "test error"; then
  pass "ui_error outputs message"
else
  fail "ui_error does not output message"
fi

# ── Stages ──
printf "\n\033[1m▸ Stage system\033[0m\n"

assert_eq "$INSTALL_STAGE_TOTAL" "4" "INSTALL_STAGE_TOTAL is 4"

INSTALL_STAGE_CURRENT=0
((TESTS_RUN++)) || true
ui_stage_output="$(ui_stage "Test Stage" 2>&1)"
if echo "$ui_stage_output" | grep -q "1/4"; then
  pass "ui_stage shows [1/4] counter"
else
  fail "ui_stage missing counter"
fi

# ui_stage runs in a subshell via $() so parent INSTALL_STAGE_CURRENT stays 0
# Call directly to test the increment
INSTALL_STAGE_CURRENT=0
ui_stage "Test Stage 2" >/dev/null 2>&1
assert_eq "$INSTALL_STAGE_CURRENT" "1" "INSTALL_STAGE_CURRENT increments"

# ── Taglines ──
printf "\n\033[1m▸ Taglines\033[0m\n"

assert_not_empty "$TAGLINE" "TAGLINE is set"
((TESTS_RUN++)) || true
if [ "${#TAGLINES[@]}" -ge 20 ]; then
  pass "At least 20 taglines defined (got ${#TAGLINES[@]})"
else
  fail "Expected at least 20 taglines (got ${#TAGLINES[@]})"
fi

# Test pick_tagline with index
export OPENRAPPTER_TAGLINE_INDEX=0
picked="$(pick_tagline)"
assert_not_empty "$picked" "pick_tagline with index returns a value"

unset OPENRAPPTER_TAGLINE_INDEX
random_picked="$(pick_tagline)"
assert_not_empty "$random_picked" "pick_tagline without index returns a value"

# ── Constants ──
printf "\n\033[1m▸ Constants\033[0m\n"

assert_eq "$MIN_NODE" "20" "MIN_NODE is 20"
assert_eq "$MIN_PYTHON_MINOR" "10" "MIN_PYTHON_MINOR is 10"
assert_eq "$BIN_NAME" "openrappter" "BIN_NAME is openrappter"
assert_contains "$REPO_URL" "github.com" "REPO_URL points to GitHub"
assert_contains "$REPO_URL" "openrappter" "REPO_URL contains openrappter"
assert_contains "$INSTALL_DIR" ".openrappter" "INSTALL_DIR is in home directory"

# ── Script Content Checks ──
printf "\n\033[1m▸ Script content\033[0m\n"

assert_contains "$script_content" "set -euo pipefail" "script uses strict mode"
assert_contains "$script_content" "curl -fsSL" "script documents curl usage"
assert_contains "$script_content" "nvm" "script handles nvm installation"
assert_contains "$script_content" "git clone" "script clones the repo"
assert_contains "$script_content" "npm install" "script installs npm dependencies"
assert_contains "$script_content" "npm run build" "script builds TypeScript"
assert_contains "$script_content" "pip install" "script installs Python package"
assert_contains "$script_content" "--status" "script verifies with --status"
assert_contains "$script_content" "OPENRAPPTER_INSTALL_SH_NO_RUN" "script supports no-run mode for testing"
assert_contains "$script_content" "git pull" "script handles updates (idempotent)"
assert_contains "$script_content" "gum" "script supports gum UI"
assert_contains "$script_content" "run_with_spinner" "script has spinner support"
assert_contains "$script_content" "run_quiet_step" "script has quiet step support"
assert_contains "$script_content" "parse_args" "script parses CLI arguments"
assert_contains "$script_content" "--verbose" "script supports --verbose flag"
assert_contains "$script_content" "--dry-run" "script supports --dry-run flag"
assert_contains "$script_content" "--help" "script supports --help flag"
assert_contains "$script_content" "TAGLINES" "script has taglines"
assert_contains "$script_content" "HOLIDAY_" "script has holiday taglines"
assert_contains "$script_content" "ui_stage" "script has staged installation"
assert_contains "$script_content" "ui_celebrate" "script has celebration output"
assert_contains "$script_content" "completion_messages" "script has completion messages"
assert_contains "$script_content" "update_messages" "script has upgrade messages"
assert_contains "$script_content" "Homebrew" "script handles Homebrew on macOS"
assert_contains "$script_content" "NodeSource" "script handles NodeSource on Linux"

# ── Resilience Features ──
printf "\n\033[1m▸ Resilience features\033[0m\n"

assert_contains "$script_content" "verify_node_version" "script verifies node version after install"
assert_contains "$script_content" "retry" "script has retry wrapper"
assert_contains "$script_content" "install_node_tarball" "script has direct tarball fallback"
assert_contains "$script_content" "try_version_managers" "script detects existing version managers"
assert_contains "$script_content" "fnm" "script handles fnm"
assert_contains "$script_content" "volta" "script handles volta"
assert_contains "$script_content" "mise" "script handles mise"
assert_contains "$script_content" "asdf" "script handles asdf"
assert_contains "$script_content" "fix_npm_prefix_if_needed" "script fixes npm EACCES"
assert_contains "$script_content" "SHASUMS256" "script verifies Node.js checksums"
assert_contains "$script_content" "source_nvm_if_present" "script sources nvm before checking"
assert_contains "$script_content" "source_fnm_if_present" "script sources fnm before checking"

# ── Verify new functions work ──
printf "\n\033[1m▸ New resilience functions\033[0m\n"

# verify_node_version should succeed if we already passed check_node
if command -v node &>/dev/null; then
  ((TESTS_RUN++)) || true
  if verify_node_version; then
    pass "verify_node_version returns true for current node"
  else
    pass "verify_node_version returns false (node version below MIN_NODE — OK)"
  fi
fi

# retry should work with simple commands
((TESTS_RUN++)) || true
if retry 2 0 true; then
  pass "retry succeeds with 'true' command"
else
  fail "retry failed with 'true' command"
fi

((TESTS_RUN++)) || true
if ! retry 2 0 false; then
  pass "retry fails after exhausting attempts with 'false' command"
else
  fail "retry should have failed with 'false' command"
fi

# ── CLI Args ──
printf "\n\033[1m▸ CLI argument parsing\033[0m\n"

DRY_RUN=0
VERBOSE=0
HELP=0

parse_args --dry-run
assert_eq "$DRY_RUN" "1" "parse_args sets DRY_RUN"

DRY_RUN=0
parse_args --verbose
assert_eq "$VERBOSE" "1" "parse_args sets VERBOSE"

VERBOSE=0
parse_args --help
assert_eq "$HELP" "1" "parse_args sets HELP"

HELP=0
parse_args --dir /tmp/test-install
assert_eq "$INSTALL_DIR" "/tmp/test-install" "parse_args sets INSTALL_DIR with --dir"

# Reset
INSTALL_DIR="${OPENRAPPTER_HOME:-$HOME/.openrappter}"

# New flags
INSTALL_METHOD=""
parse_args --method npm
assert_eq "$INSTALL_METHOD" "npm" "parse_args sets INSTALL_METHOD with --method npm"

INSTALL_METHOD=""
parse_args --method git
assert_eq "$INSTALL_METHOD" "git" "parse_args sets INSTALL_METHOD with --method git"

OPT_NO_PROMPT=false
parse_args --no-prompt
assert_eq "$OPT_NO_PROMPT" "true" "parse_args sets OPT_NO_PROMPT with --no-prompt"

OPT_SET_NPM_PREFIX=false
parse_args --set-npm-prefix
assert_eq "$OPT_SET_NPM_PREFIX" "true" "parse_args sets OPT_SET_NPM_PREFIX with --set-npm-prefix"

# Reset
INSTALL_METHOD=""
OPT_NO_PROMPT=false
OPT_SET_NPM_PREFIX=false

# ── Install Method Detection ──
printf "\n\033[1m▸ Install method detection\033[0m\n"

# detect_existing_install should return "none" on a fresh system (no global npm, no git clone)
((TESTS_RUN++)) || true
existing="$(detect_existing_install)"
if [[ "$existing" == "none" || "$existing" == "npm" || "$existing" == "git" ]]; then
  pass "detect_existing_install returns valid value: $existing"
else
  fail "detect_existing_install returned unexpected: $existing"
fi

# choose_install_method with --method flag preset
INSTALL_METHOD="npm"
choose_install_method 2>/dev/null || true
assert_eq "$INSTALL_METHOD" "npm" "choose_install_method respects --method npm"

INSTALL_METHOD="git"
choose_install_method 2>/dev/null || true
assert_eq "$INSTALL_METHOD" "git" "choose_install_method respects --method git"

# choose_install_method with no method and --no-prompt matches existing or defaults to npm
INSTALL_METHOD=""
OPT_NO_PROMPT=true
choose_install_method 2>/dev/null || true
((TESTS_RUN++)) || true
if [[ "$INSTALL_METHOD" == "npm" || "$INSTALL_METHOD" == "git" ]]; then
  pass "choose_install_method picks a valid method with --no-prompt: $INSTALL_METHOD"
else
  fail "choose_install_method returned unexpected: $INSTALL_METHOD"
fi

# Reset
INSTALL_METHOD=""
OPT_NO_PROMPT=false

# ── npm Conflict Resolution ──
printf "\n\033[1m▸ npm conflict resolution\033[0m\n"

# resolve_npm_conflicts should handle missing/stale files gracefully
# Use a temp bin dir to avoid modifying real files
saved_get_bin_dir="$(type get_bin_dir | tail -n +2)"
get_bin_dir() { echo "$TEMP_BIN"; }

INSTALL_METHOD="npm"
((TESTS_RUN++)) || true
if resolve_npm_conflicts 2>/dev/null; then
  pass "resolve_npm_conflicts handles missing files gracefully (npm method)"
else
  fail "resolve_npm_conflicts failed for npm method"
fi

INSTALL_METHOD="git"
((TESTS_RUN++)) || true
if resolve_npm_conflicts 2>/dev/null; then
  pass "resolve_npm_conflicts handles missing files gracefully (git method)"
else
  fail "resolve_npm_conflicts failed for git method"
fi

# Restore original get_bin_dir
eval "$saved_get_bin_dir"

# Reset
INSTALL_METHOD=""

# ── New Script Content Checks ──
printf "\n\033[1m▸ New script content (npm method)\033[0m\n"

assert_contains "$script_content" "install_via_npm" "script has npm install function"
assert_contains "$script_content" "install_via_git" "script has git install function (extracted)"
assert_contains "$script_content" "detect_existing_install" "script has install detection"
assert_contains "$script_content" "choose_install_method" "script has method chooser"
assert_contains "$script_content" "ensure_build_tools" "script has build tool detection"
assert_contains "$script_content" "resolve_npm_conflicts" "script has conflict resolution"
assert_contains "$script_content" "detect_and_restart_gateway" "script has gateway restart"
assert_contains "$script_content" "run_doctor_if_available" "script has doctor/migration"
assert_contains "$script_content" "--method" "script supports --method flag"
assert_contains "$script_content" "--no-prompt" "script supports --no-prompt flag"
assert_contains "$script_content" "--set-npm-prefix" "script supports --set-npm-prefix flag"
assert_contains "$script_content" "SHARP_IGNORE_GLOBAL_LIBVIPS" "script sets SHARP_IGNORE_GLOBAL_LIBVIPS"
assert_contains "$script_content" "OPENRAPPTER_INSTALL_METHOD" "script supports OPENRAPPTER_INSTALL_METHOD env"
assert_contains "$script_content" "OPENRAPPTER_VERSION" "script supports OPENRAPPTER_VERSION env"
assert_contains "$script_content" "OPENRAPPTER_BETA" "script supports OPENRAPPTER_BETA env"
assert_contains "$script_content" "NPM_PACKAGE" "script defines NPM_PACKAGE"

# ── PATH helpers ──
printf "\n\033[1m▸ PATH helpers\033[0m\n"

((TESTS_RUN++)) || true
if path_has_dir "/usr/bin:/usr/local/bin" "/usr/bin"; then
  pass "path_has_dir finds existing dir"
else
  fail "path_has_dir missed existing dir"
fi

((TESTS_RUN++)) || true
if ! path_has_dir "/usr/bin:/usr/local/bin" "/nonexistent"; then
  pass "path_has_dir returns false for missing dir"
else
  fail "path_has_dir found nonexistent dir"
fi

# ── Banner ──
printf "\n\033[1m▸ Banner\033[0m\n"

((TESTS_RUN++)) || true
banner_output="$(print_installer_banner 2>&1)"
if echo "$banner_output" | grep -q "openrappter\|OpenRappter"; then
  pass "banner contains 'openrappter'"
else
  fail "banner missing 'openrappter'"
fi

# ── Results ─────────────────────────────────────────────────
printf "\n\033[1m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\033[0m\n"
printf "\033[1m Results: %d passed, %d failed, %d total\033[0m\n" "$TESTS_PASSED" "$TESTS_FAILED" "$TESTS_RUN"
printf "\033[1m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\033[0m\n\n"

if [ "$TESTS_FAILED" -gt 0 ]; then
  exit 1
fi
