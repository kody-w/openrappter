#!/usr/bin/env bash
#
# The installer must never look hung.
#
# `pip install` and `npm install -g` can sit for minutes. The old no-gum path
# ran them with no output at all, which reads as a hang — so people press
# Ctrl-C, usually part-way through a package install, which is the one moment
# that actually leaves a broken tree behind.
#
# These tests source install.sh's helpers and assert that every path prints
# something, on a TTY and off it.
#
#   bash tests/install/progress_test.sh
#
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
INSTALLER="$ROOT/install.sh"

PASS=0
FAIL=0

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS + 1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; printf '      %s\n' "${2:-}"; FAIL=$((FAIL + 1)); }

# Load just the helper definitions.
#
# Sourcing install.sh outright would run the installer, so we extract only the
# functions this test needs plus the colour variables they print with. Cutting
# at a line number would rot; naming the functions keeps it honest.
HELPERS="$(mktemp)"
trap 'rm -f "$HELPERS"' EXIT

python3 - "$INSTALLER" "$HELPERS" <<'EXTRACT'
import re, sys

source, dest = sys.argv[1], sys.argv[2]
text = open(source, encoding="utf-8").read()
lines = text.split("\n")

wanted = {
    "mktempfile", "is_shell_function", "gum_is_tty",
    "run_with_progress", "run_with_spinner", "run_quiet_step",
    "step_is_slow", "spinner_reassurance",
    "ui_info", "ui_warn", "ui_success", "ui_error",
}

out = []
# The colour variables the helpers print with.
for line in lines[:40]:
    if re.match(r"^(BOLD|ACCENT|ACCENT_BRIGHT|INFO|SUCCESS|WARN|ERROR|MUTED|NC)=", line):
        out.append(line)

# Each function runs from its `name() {` to the first column-0 `}`.
i = 0
while i < len(lines):
    match = re.match(r"^([a-zA-Z_][a-zA-Z0-9_]*)\(\)\s*\{", lines[i])
    if match and match.group(1) in wanted:
        block = [lines[i]]
        i += 1
        while i < len(lines):
            block.append(lines[i])
            if lines[i] == "}":
                break
            i += 1
        out.extend(block)
    i += 1

open(dest, "w", encoding="utf-8").write("\n".join(out) + "\n")

missing = wanted - {m.group(1) for m in
                    (re.match(r"^([a-zA-Z_][a-zA-Z0-9_]*)\(\)", l) for l in out) if m}
if missing:
    print(f"WARNING: not extracted: {sorted(missing)}", file=sys.stderr)
EXTRACT

# The helpers expect these; the installer sets them later. Read by the sourced
# helpers rather than by this file, which is what SC2034 sees.
# shellcheck disable=SC2034
VERBOSE=0
# shellcheck disable=SC2034
GUM=""
# shellcheck disable=SC2034
TMPFILES=()
# shellcheck disable=SC1090
source "$HELPERS"

printf '\n\033[1mInstaller progress\033[0m\n\n'

# ── the helpers exist at all ──────────────────────────────────────────────

for fn in run_with_progress run_with_spinner run_quiet_step step_is_slow spinner_reassurance; do
    if declare -F "$fn" >/dev/null; then
        ok "$fn is defined"
    else
        bad "$fn is defined" "missing — the silent path would come back"
    fi
done

# ── nothing is silent ─────────────────────────────────────────────────────

log="$(mktemp)"
out="$(run_with_progress "Installing things" "$log" sleep 0.3 2>&1)"
if [[ -n "$out" ]]; then
    ok "run_with_progress prints something (non-TTY)"
else
    bad "run_with_progress prints something (non-TTY)" "produced no output at all"
fi

if grep -qi "installing things" <<<"$out"; then
    ok "the step title is shown"
else
    bad "the step title is shown" "got: $out"
fi

if grep -qi "done" <<<"$out"; then
    ok "completion is announced"
else
    bad "completion is announced" "got: $out"
fi

# ── failures are visible, and the status survives ────────────────────────

set +e
out="$(run_with_progress "Doomed step" "$log" bash -c 'echo "the real error"; exit 3' 2>&1)"
rc=$?
set -e

if [[ $rc -eq 3 ]]; then
    ok "the command's exit status is preserved"
else
    bad "the command's exit status is preserved" "expected 3, got $rc"
fi

if grep -qi "failed" <<<"$out"; then
    ok "failure is announced"
else
    bad "failure is announced" "got: $out"
fi

if grep -q "the real error" "$log"; then
    ok "the real output is kept for diagnosis"
else
    bad "the real output is kept for diagnosis" "log did not contain the error"
fi

# ── slow steps are recognised, so the copy can reassure ──────────────────

for title in "Installing Python packages" "Creating venv" "npm install -g openrappter" "Downloading node"; do
    if step_is_slow "$title"; then
        ok "recognised as slow: $title"
    else
        bad "recognised as slow: $title" "would not get reassurance copy"
    fi
done

if ! step_is_slow "Checking config"; then
    ok "a fast step is not padded with reassurance"
else
    bad "a fast step is not padded with reassurance" "false positive"
fi

# ── the reassurance escalates with time ──────────────────────────────────

if [[ -z "$(spinner_reassurance 5 'Installing Python packages')" ]]; then
    ok "says nothing in the first few seconds"
else
    bad "says nothing in the first few seconds" "too chatty too early"
fi

if [[ -n "$(spinner_reassurance 30 'Installing Python packages')" ]]; then
    ok "speaks up around 30s"
else
    bad "speaks up around 30s" "still silent when a user starts to worry"
fi

note="$(spinner_reassurance 90 'Installing Python packages')"
if grep -qi "slow by nature\|safe to leave" <<<"$note"; then
    ok "tells the user a slow step is expected"
else
    bad "tells the user a slow step is expected" "got: $note"
fi

note="$(spinner_reassurance 200 'Installing Python packages')"
if grep -qi "still working\|several minutes" <<<"$note"; then
    ok "keeps reassuring past three minutes"
else
    bad "keeps reassuring past three minutes" "got: $note"
fi

# ── piped output stays readable ──────────────────────────────────────────

out="$(run_with_progress "Piped step" "$log" sleep 0.2 2>&1 | cat)"
if [[ -n "$out" ]] && ! grep -q $'\033\[?25l' <<<"$out"; then
    ok "no cursor-hiding escapes when piped"
else
    bad "no cursor-hiding escapes when piped" "terminal control codes leaked into a pipe"
fi

# ── a shell function is announced rather than run silently ───────────────

demo_shell_function() { sleep 0.1; }
out="$(run_with_spinner "Configuring" demo_shell_function 2>&1)"
if [[ -n "$out" ]]; then
    ok "shell-function steps are announced"
else
    bad "shell-function steps are announced" "ran with no output"
fi

# ── the whole installer still parses ─────────────────────────────────────

if bash -n "$INSTALLER" 2>/dev/null; then
    ok "install.sh parses"
else
    bad "install.sh parses" "syntax error"
fi

rm -f "$log"

printf '\n  %d passed, %d failed\n\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]]
