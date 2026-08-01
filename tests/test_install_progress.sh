#!/usr/bin/env bash
#
# Progress-UI tests for install.sh.
#
# The bug these guard against is not a crash — it is silence. Long steps like
# `pip install` and `npm install -g` used to produce no output at all when gum
# was absent (which is most installs), so a healthy install looked identical to
# a hang. People hit Ctrl-C and reported it broken.
#
# Run:  bash tests/test_install_progress.sh
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_SH="$ROOT/install.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0

ok()   { printf '  \033[32mok\033[0m   %s\n' "$1"; PASS=$((PASS + 1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; [[ -n "${2:-}" ]] && printf '       %s\n' "$2"; FAIL=$((FAIL + 1)); }

assert_contains() {
    local haystack="$1" needle="$2" label="$3"
    if [[ "$haystack" == *"$needle"* ]]; then
        ok "$label"
    else
        bad "$label" "expected to find: $needle"
    fi
}

assert_not_contains() {
    local haystack="$1" needle="$2" label="$3"
    if [[ "$haystack" != *"$needle"* ]]; then
        ok "$label"
    else
        bad "$label" "should NOT contain: $needle"
    fi
}

# Extract the progress functions and run them against a stub harness, so the
# tests exercise the real code in install.sh rather than a copy of it.
build_harness() {
    local force_tty="$1" out="$WORK/harness.sh"

    python3 - "$INSTALL_SH" "$out" "$force_tty" <<'PY'
import sys, pathlib
src = pathlib.Path(sys.argv[1]).read_text()
start = src.index('SPINNER_FRAMES=')
end = src.index('    return 1', start) + len('    return 1')
block = src[start:end] + '\n}\n'

tty = 'return 0' if sys.argv[3] == 'tty' else 'return 1'
header = """#!/usr/bin/env bash
set -uo pipefail
ACCENT=''; SUCCESS=''; ERROR=''; MUTED=''; NC=''
GUM=""; VERBOSE=0; DRY_RUN=0
gum_is_tty() { %s; }
is_shell_function() { declare -F "$1" >/dev/null 2>&1; }
mktempfile() { mktemp; }
ui_error() { echo "x $*"; }
ui_success() { echo "v $*"; }
""" % tty
pathlib.Path(sys.argv[2]).write_text(header + block + '\n')
PY
    echo "$out"
}

echo ""
echo "install.sh progress UI"
echo ""

# ── the installer itself stays valid ─────────────────────────────────────
if bash -n "$INSTALL_SH" 2>"$WORK/syntax.err"; then
    ok "install.sh parses"
else
    bad "install.sh parses" "$(cat "$WORK/syntax.err")"
fi

# ── a long step must never be silent ─────────────────────────────────────
HARNESS="$(build_harness notty)"

output="$(bash -c "source '$HARNESS'; run_quiet_step 'Installing Python packages' sleep 1" 2>&1)"
assert_contains "$output" "Installing Python packages" "announces the step before running it"
assert_contains "$output" "done" "reports completion"

# The original bug, stated as a test: no output at all.
if [[ -z "${output// /}" ]]; then
    bad "a long step produces output" "produced nothing — this is the original bug"
else
    ok "a long step produces output"
fi

# ── failures stay diagnosable ────────────────────────────────────────────
output="$(bash -c "source '$HARNESS'; run_quiet_step 'Broken step' bash -c 'echo \"pip: no matching distribution\" >&2; exit 1'" 2>&1)"
status=$?
assert_contains "$output" "pip: no matching distribution" "surfaces the real error from the log"
assert_contains "$output" "--verbose" "points at --verbose for more detail"

if bash -c "source '$HARNESS'; run_quiet_step 'Broken step' false" >/dev/null 2>&1; then
    bad "a failing step returns non-zero"
else
    ok "a failing step returns non-zero"
fi

# ── exit status is passed through, not swallowed ─────────────────────────
if bash -c "source '$HARNESS'; run_quiet_step 'Fine' true" >/dev/null 2>&1; then
    ok "a successful step returns zero"
else
    bad "a successful step returns zero"
fi

# ── shell functions still run in-process ─────────────────────────────────
# Backgrounding one would lose the variables it sets, so it must run inline —
# announced rather than silent.
output="$(bash -c "source '$HARNESS'; setter() { SOME_VAR=set; return 0; }; run_quiet_step 'Running a function' setter; echo \"var=\${SOME_VAR:-unset}\"" 2>&1)"
assert_contains "$output" "var=set" "a shell function keeps the state it sets"
assert_contains "$output" "Running a function" "a shell function step is announced"

# ── piped/CI output stays clean ──────────────────────────────────────────
output="$(bash -c "source '$HARNESS'; run_quiet_step 'Installing' sleep 1" 2>&1)"
assert_not_contains "$output" $'\033[?25l' "no cursor-hiding escapes when not a terminal"
assert_not_contains "$output" $'\r' "no carriage returns when not a terminal"

# ── the spinner renders on a terminal ────────────────────────────────────
TTY_HARNESS="$(build_harness tty)"
if command -v script >/dev/null 2>&1; then
    if [[ "$(uname -s)" == "Darwin" ]]; then
        raw="$(script -q /dev/null bash -c "source '$TTY_HARNESS'; run_quiet_step 'Installing Python packages' sleep 2" 2>&1)"
    else
        raw="$(script -qec "bash -c \"source '$TTY_HARNESS'; run_quiet_step 'Installing Python packages' sleep 2\"" /dev/null 2>&1)"
    fi
    assert_contains "$raw" "Installing Python packages" "spinner shows the step title"

    if [[ "$raw" == *"⠋"* || "$raw" == *"⠙"* || "$raw" == *"⠹"* || "$raw" == *"⠸"* ]]; then
        ok "spinner animates"
    else
        bad "spinner animates" "no spinner frames in the output"
    fi

    assert_contains "$raw" "✓" "spinner resolves to a checkmark"
else
    echo "  skip  spinner rendering (no script(1))"
fi

# ── the reassurance copy escalates with elapsed time ─────────────────────
copy_at() {
    bash -c "source '$HARNESS'; spinner_reassurance $1 'Installing Python packages'"
}

[[ -z "$(copy_at 5)" ]] && ok "stays quiet for the first few seconds" || bad "stays quiet for the first few seconds"
[[ -n "$(copy_at 25)" ]] && ok "says something by 25s" || bad "says something by 25s"
assert_contains "$(copy_at 65)" "slow by nature" "explains that pip is slow by nature"
assert_contains "$(copy_at 200)" "several minutes" "sets expectations past three minutes"

# A step with no reason to be slow should not claim it is.
assert_not_contains "$(bash -c "source '$HARNESS'; spinner_reassurance 65 'Creating launcher'")" \
    "slow by nature" "does not call a fast step slow"

# ── slow-step classification ─────────────────────────────────────────────
for title in "Installing Python packages" "Creating Python virtual environment" "npm install -g openrappter" "Downloading gum"; do
    if bash -c "source '$HARNESS'; step_is_slow '$title'"; then
        ok "classified as slow: $title"
    else
        bad "classified as slow: $title"
    fi
done

if bash -c "source '$HARNESS'; step_is_slow 'Creating launcher'"; then
    bad "a fast step is not classified slow"
else
    ok "a fast step is not classified slow"
fi

# ── the up-front warning exists and is wired in ──────────────────────────
if grep -q "ui_patience_notice" "$INSTALL_SH"; then
    ok "ui_patience_notice is defined"
    if grep -A 2 'ui_stage "Installing openrappter"' "$INSTALL_SH" | grep -q "ui_patience_notice"; then
        ok "shown before the install stage"
    else
        bad "shown before the install stage" "define it, but it is never called at the right point"
    fi
else
    bad "ui_patience_notice is defined"
fi

# ── every long-running command goes through the progress path ────────────
# A raw `pip install` or `npm install -g` outside run_quiet_step would be
# silent again, which is exactly the regression this suite exists to catch.
# Only actual invocations count — not taglines, echoes or error messages.
bare=""
while IFS= read -r line; do
    [[ "$line" =~ ^[0-9]+:[[:space:]]*# ]] && continue
    [[ "$line" == *"run_quiet_step"* || "$line" == *"run_with_progress"* ]] && continue
    [[ "$line" == *"retry "* ]] && continue
    # Quoted prose: taglines, echo, ui_* messages.
    [[ "$line" == *"TAGLINES"* ]] && continue
    [[ "$line" =~ ^[0-9]+:[[:space:]]*(echo|printf|ui_[a-z]+)[[:space:]] ]] && continue
    bare+="$line"$'\n'
done < <(grep -nE '^[^#]*(^|[;&|(]|[[:space:]])(pip install|npm install -g|python3? -m venv)[[:space:]]' "$INSTALL_SH" || true)

if [[ -z "$bare" ]]; then
    ok "no long-running command bypasses the progress UI"
else
    bad "no long-running command bypasses the progress UI" "$bare"
fi

echo ""
printf '%d passed, %d failed\n\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
