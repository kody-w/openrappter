#!/usr/bin/env bash
# Contract tests for quickstart.sh and the flagship README entry.
set -u
set -o pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
QUICKSTART="$ROOT/quickstart.sh"
README="$ROOT/README.md"
WORK="$ROOT/tests/.live-organ-transplant-quickstart-$$"

trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK"

PASS=0
FAIL=0

pass() {
  PASS=$((PASS + 1))
  printf '  \033[32mok\033[0m   %s\n' "$1"
}

fail() {
  FAIL=$((FAIL + 1))
  printf '  \033[31mFAIL\033[0m %s\n' "$1"
  if [ -n "${2:-}" ]; then
    printf '       %s\n' "$2"
  fi
}

assert_eq() {
  local actual="$1"
  local expected="$2"
  local label="$3"

  if [ "$actual" = "$expected" ]; then
    pass "$label"
  else
    fail "$label" "expected '$expected', got '$actual'"
  fi
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local label="$3"

  if [[ "$haystack" == *"$needle"* ]]; then
    pass "$label"
  else
    fail "$label" "expected to find: $needle"
  fi
}

write_mocks() {
  local fixture="$1"

  cat >"$fixture/bin/node" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "--version" ]; then
  printf '%s\n' "${MOCK_NODE_VERSION:-v20.9.0}"
  exit "${MOCK_NODE_STATUS:-0}"
fi
exit 0
EOF

  cat >"$fixture/bin/python3" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "--version" ]; then
  printf 'Python %s\n' "${MOCK_PYTHON_VERSION:-3.10.0}"
  exit "${MOCK_PYTHON_STATUS:-0}"
fi
exit 0
EOF

  cat >"$fixture/bin/uname" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "${MOCK_UNAME:-Linux}"
EOF

  cat >"$fixture/bin/npm" <<'EOF'
#!/usr/bin/env bash
{
  printf 'npm'
  for argument in "$@"; do
    printf ' <%s>' "$argument"
  done
  printf '\n'
} >>"$MOCK_CALL_LOG"

case "${1:-}" in
  ls)
    exit "${MOCK_NPM_LS_STATUS:-0}"
    ;;
  ci)
    exit "${MOCK_NPM_CI_STATUS:-0}"
    ;;
  run)
    if [ "${2:-}" = "demo:transplant" ]; then
      exit "${MOCK_DEMO_STATUS:-0}"
    fi
    ;;
esac
exit 0
EOF

  cat >"$fixture/bin/npx" <<'EOF'
#!/usr/bin/env bash
{
  printf 'npx'
  for argument in "$@"; do
    printf ' <%s>' "$argument"
  done
  printf '\n'
} >>"$MOCK_CALL_LOG"
exit "${MOCK_NPX_STATUS:-0}"
EOF

  chmod +x "$fixture/bin/node" "$fixture/bin/python3" "$fixture/bin/uname" \
    "$fixture/bin/npm" "$fixture/bin/npx"
}

new_fixture() {
  local name="$1"

  FIXTURE="$WORK/$name"
  CALL_LOG="$FIXTURE/calls.log"
  mkdir -p "$FIXTURE/bin" "$FIXTURE/typescript"
  cp "$QUICKSTART" "$FIXTURE/quickstart.sh"
  : >"$CALL_LOG"
  write_mocks "$FIXTURE"

  NODE_VERSION="v20.9.0"
  NODE_STATUS=0
  PYTHON_VERSION="3.10.0"
  PYTHON_STATUS=0
  UNAME_VALUE="Linux"
  NPM_LS_STATUS=0
  NPM_CI_STATUS=0
  DEMO_STATUS=0
  NPX_STATUS=0
}

run_fixture() {
  RUN_OUTPUT="$(
    cd "$FIXTURE" &&
      env \
        PATH="$FIXTURE/bin:/usr/bin:/bin" \
        MOCK_CALL_LOG="$CALL_LOG" \
        MOCK_NODE_VERSION="$NODE_VERSION" \
        MOCK_NODE_STATUS="$NODE_STATUS" \
        MOCK_PYTHON_VERSION="$PYTHON_VERSION" \
        MOCK_PYTHON_STATUS="$PYTHON_STATUS" \
        MOCK_UNAME="$UNAME_VALUE" \
        MOCK_NPM_LS_STATUS="$NPM_LS_STATUS" \
        MOCK_NPM_CI_STATUS="$NPM_CI_STATUS" \
        MOCK_DEMO_STATUS="$DEMO_STATUS" \
        MOCK_NPX_STATUS="$NPX_STATUS" \
        ./quickstart.sh "$@" 2>&1
  )"
  RUN_STATUS=$?
  RUN_CALLS="$(cat "$CALL_LOG")"
}

printf '\nLive Organ Transplant quickstart contracts\n\n'

if bash -n "$QUICKSTART"; then
  pass "quickstart.sh parses"
else
  fail "quickstart.sh parses"
fi

quickstart_source="$(cat "$QUICKSTART")"
readme_source="$(cat "$README")"

assert_contains "$quickstart_source" 'npm ci --no-audit --no-fund' \
  "launcher pins the lock-strict install command"
assert_contains "$quickstart_source" 'npm run demo:transplant --silent' \
  "launcher pins the canonical transplant command"
assert_contains "$readme_source" '[![Node.js 20.9+]' \
  "README advertises the package engine minimum"

fresh_clone_command='```bash
git clone https://github.com/kody-w/openrappter.git
cd openrappter
./quickstart.sh --demo live-organ-transplant
```'
security_warning="> **Security warning:** Python agents are executable code that run as the logged-in OS user. They have that user's filesystem, network, environment, and subprocess authority. They are not sandboxed. Subprocess crash isolation is not a security boundary. Preservation is file-only and cannot undo external side effects."
platform_copy='> **Platforms:** The initial demo supports macOS, Linux, and WSL. Native Windows is deferred.'

assert_contains "$readme_source" "$fresh_clone_command" \
  "README pins the exact three-line fresh-clone command"
assert_contains "$readme_source" "$security_warning" \
  "README pins the complete executable-code warning"
assert_contains "$readme_source" "$platform_copy" \
  "README pins supported platforms and Windows deferral"
assert_contains "$readme_source" 'registers a Python-backed `ChecksumAgent`' \
  "README names the Python-backed agent outcome"
assert_contains "$readme_source" 'host PID change, invokes it' \
  "README states host PID continuity"
assert_contains "$readme_source" 'rejects a broken candidate before commit' \
  "README states pre-commit rejection"
assert_contains "$readme_source" 'proves the previous generation still works' \
  "README states preservation proof"
assert_contains "$readme_source" 'emits a verified receipt' \
  "README states receipt verification"

transplant_heading_line="$(grep -nF '## See a Live Organ Transplant' "$README" | cut -d: -f1)"
install_heading_line="$(grep -nF '## Install in One Line' "$README" | cut -d: -f1)"
if [ -n "$transplant_heading_line" ] &&
  [ -n "$install_heading_line" ] &&
  [ "$transplant_heading_line" -lt "$install_heading_line" ]; then
  pass "flagship outcome appears before generic installation"
else
  fail "flagship outcome appears before generic installation"
fi

new_fixture "no-args"
run_fixture
assert_eq "$RUN_STATUS" "0" "no-arg tour succeeds"
assert_eq "$RUN_CALLS" $'npm <install> <--silent>\nnpx <tsx> <examples/quickstart.ts>' \
  "no-arg tour keeps its install and terminal-tour commands"

new_fixture "dependencies-absent"
run_fixture --demo live-organ-transplant
assert_eq "$RUN_STATUS" "0" "transplant succeeds when dependencies are absent"
assert_eq "$RUN_CALLS" $'npm <ci> <--no-audit> <--no-fund>\nnpm <run> <demo:transplant> <--silent>' \
  "absent dependencies trigger npm ci before the canonical demo"

new_fixture "dependencies-ready"
mkdir -p "$FIXTURE/typescript/node_modules"
run_fixture --demo live-organ-transplant
assert_eq "$RUN_STATUS" "0" "transplant succeeds when dependencies are ready"
assert_eq "$RUN_CALLS" $'npm <ls> <--depth=0> <--ignore-scripts>\nnpm <run> <demo:transplant> <--silent>' \
  "ready dependencies skip npm ci"

new_fixture "dependencies-not-ready"
mkdir -p "$FIXTURE/typescript/node_modules"
NPM_LS_STATUS=1
run_fixture --demo live-organ-transplant
assert_eq "$RUN_STATUS" "0" "transplant repairs dependencies that are not ready"
assert_eq "$RUN_CALLS" $'npm <ls> <--depth=0> <--ignore-scripts>\nnpm <ci> <--no-audit> <--no-fund>\nnpm <run> <demo:transplant> <--silent>' \
  "not-ready dependencies trigger lock-strict npm ci"

new_fixture "exit-status"
mkdir -p "$FIXTURE/typescript/node_modules"
DEMO_STATUS=37
run_fixture --demo live-organ-transplant
assert_eq "$RUN_STATUS" "37" "canonical demo exit status propagates"

new_fixture "node-old-major"
NODE_VERSION="v19.99.99"
run_fixture
assert_eq "$RUN_STATUS" "1" "Node 19 is rejected despite a high minor version"
assert_contains "$RUN_OUTPUT" 'Node.js 20.9.0 or newer is required' \
  "old Node major has a clear error"
assert_eq "$RUN_CALLS" "" "old Node is rejected before dependency commands"

new_fixture "node-old-minor"
NODE_VERSION="v20.8.99"
run_fixture
assert_eq "$RUN_STATUS" "1" "Node 20.8 is rejected"
assert_contains "$RUN_OUTPUT" 'found v20.8.99' \
  "old Node minor is reported"

new_fixture "node-new-major"
mkdir -p "$FIXTURE/typescript/node_modules"
NODE_VERSION="v21.0.0"
run_fixture --demo live-organ-transplant
assert_eq "$RUN_STATUS" "0" "a newer Node major is accepted"

new_fixture "node-malformed"
NODE_VERSION="v20.x.0"
run_fixture
assert_eq "$RUN_STATUS" "1" "a malformed Node version is rejected"
assert_contains "$RUN_OUTPUT" 'expected vMAJOR.MINOR.PATCH' \
  "malformed Node version has a parse error"

new_fixture "python-old"
PYTHON_VERSION="3.9.99"
run_fixture --demo live-organ-transplant
assert_eq "$RUN_STATUS" "1" "Python 3.9 is rejected for transplant"
assert_contains "$RUN_OUTPUT" 'requires Python 3.10 or newer' \
  "old Python has a clear error"
assert_eq "$RUN_CALLS" "" "old Python is rejected before install or build"

new_fixture "unsupported-platform"
UNAME_VALUE="MINGW64_NT"
run_fixture --demo live-organ-transplant
assert_eq "$RUN_STATUS" "1" "native Windows shell is rejected"
assert_contains "$RUN_OUTPUT" 'supports macOS, Linux, and WSL; native Windows is deferred' \
  "unsupported platform error names supported targets"
assert_eq "$RUN_CALLS" "" "unsupported platform is rejected before install or build"

new_fixture "unknown-demo"
run_fixture --demo something-else
assert_eq "$RUN_STATUS" "2" "unknown demo fails"
assert_contains "$RUN_OUTPUT" 'Unknown demo: something-else' \
  "unknown demo error names the value"
assert_contains "$RUN_OUTPUT" 'Usage: ./quickstart.sh [--demo live-organ-transplant]' \
  "unknown demo prints usage"
assert_eq "$RUN_CALLS" "" "unknown demo does not run package commands"

new_fixture "unknown-flag"
run_fixture --wat
assert_eq "$RUN_STATUS" "2" "unknown flag fails"
assert_contains "$RUN_OUTPUT" 'Unknown argument or flag: --wat' \
  "unknown flag error names the flag"

new_fixture "missing-demo"
run_fixture --demo
assert_eq "$RUN_STATUS" "2" "missing demo name fails"
assert_contains "$RUN_OUTPUT" '--demo requires a demo name' \
  "missing demo name has a clear error"

printf '\n%d passed, %d failed\n\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
