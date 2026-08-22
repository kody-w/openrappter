#!/usr/bin/env bash
# Contract tests for quickstart.sh and the flagship README entry.
set -u
set -o pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
QUICKSTART="$ROOT/quickstart.sh"
README="$ROOT/README.md"
PACKAGE_JSON="$ROOT/typescript/package.json"
REAL_NODE="$(command -v node)"
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
  ci)
    if [ "$#" -ne 3 ] ||
      [ "${2:-}" != "--no-audit" ] ||
      [ "${3:-}" != "--no-fund" ]; then
      printf 'unexpected npm ci arguments\n' >&2
      exit 64
    fi
    if [ "${MOCK_NPM_CI_STATUS:-0}" -ne 0 ]; then
      exit "$MOCK_NPM_CI_STATUS"
    fi
    rm -rf node_modules
    mkdir -p node_modules
    printf 'added locked dependencies\n'
    exit 0
    ;;
  install)
    if [ "$#" -ne 2 ] || [ "${2:-}" != "--silent" ]; then
      printf 'unexpected legacy npm install arguments\n' >&2
      exit 64
    fi
    exit 0
    ;;
  run)
    if [ "$#" -ne 3 ] ||
      [ "${2:-}" != "demo:transplant" ] ||
      [ "${3:-}" != "--silent" ]; then
      printf 'unexpected npm run command\n' >&2
      exit 64
    fi
    package_script="$(
      "$MOCK_REAL_NODE" -e \
        'const fs=require("node:fs");const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(p.scripts?.["demo:transplant"] ?? "");' \
        "$MOCK_PACKAGE_JSON"
    )" || exit 64
    if [ "$package_script" != "$MOCK_EXPECTED_PACKAGE_SCRIPT" ]; then
      printf 'demo:transplant package script is missing or changed\n' >&2
      exit 64
    fi
    if [ "${MOCK_DEMO_STATUS:-0}" -ne 0 ]; then
      exit "$MOCK_DEMO_STATUS"
    fi
    cat <<TRANSCRIPT
[1/6] DONOR VERIFIED — checksum_agent.py matches its pinned SHA-256 source.
[2/6] THEATER ONLINE — authenticated loopback GatewayServer listening on 127.0.0.1:43117.
[3/6] TRANSPLANT ACCEPTED — ChecksumAgent is live through the production PythonAgent bridge.
[4/6] FIRST PULSE — sha256("openrappter-live-organ-transplant") = ab3db6c3d9a297c36792a96bb5d1c14e4de1b2d340467a1e35c6bae02095d033.
[5/6] REJECTION TEST — the invalid candidate was refused before commit; the held PythonAgent produced ab3db6c3d9a297c36792a96bb5d1c14e4de1b2d340467a1e35c6bae02095d033.
[6/6] FLIGHT SEALED — 16 events persisted under trace transplant-offline-test.
AUTHORITY NOTICE: Python executes as the logged-in OS user with filesystem/network/environment/subprocess authority. The subprocess is NOT a sandbox. File preservation cannot undo external side effects.
OPENRAPPTER_TRANSPLANT_RESULT={"schema":"openrappter-live-organ-transplant-result/1.0","status":"success","scenario":{"evidenceDirectory":"$MOCK_EVIDENCE_DIRECTORY"},"flightRecorder":{"traceId":"transplant-offline-test","database":{"path":"$MOCK_EVIDENCE_DIRECTORY/flight-recorder.db"},"export":{"path":"$MOCK_EVIDENCE_DIRECTORY/flight-recorder.export.json"}}}
TRANSCRIPT
    exit 0
    ;;
  *)
    printf 'unexpected npm subcommand: %s\n' "${1:-missing}" >&2
    exit 64
    ;;
esac
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
  cp "$PACKAGE_JSON" "$FIXTURE/typescript/package.json"
  : >"$CALL_LOG"
  write_mocks "$FIXTURE"

  NODE_VERSION="v20.9.0"
  NODE_STATUS=0
  PYTHON_VERSION="3.10.0"
  PYTHON_STATUS=0
  UNAME_VALUE="Linux"
  NPM_CI_STATUS=0
  DEMO_STATUS=0
  NPX_STATUS=0
  EVIDENCE_DIRECTORY="$FIXTURE/evidence/live-organ-transplant-test"
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
        MOCK_NPM_CI_STATUS="$NPM_CI_STATUS" \
        MOCK_DEMO_STATUS="$DEMO_STATUS" \
        MOCK_NPX_STATUS="$NPX_STATUS" \
        MOCK_REAL_NODE="$REAL_NODE" \
        MOCK_PACKAGE_JSON="$FIXTURE/typescript/package.json" \
        MOCK_EXPECTED_PACKAGE_SCRIPT="$PACKAGE_DEMO_SCRIPT" \
        MOCK_EVIDENCE_DIRECTORY="$EVIDENCE_DIRECTORY" \
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
PACKAGE_DEMO_SCRIPT=""

if [ -n "$REAL_NODE" ] &&
  PACKAGE_DEMO_SCRIPT="$(
    "$REAL_NODE" -e \
      'const fs=require("node:fs");const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(p.scripts?.["demo:transplant"] ?? "");' \
      "$PACKAGE_JSON"
  )"; then
  assert_eq "$PACKAGE_DEMO_SCRIPT" "node dist/demo/live-organ-transplant.js" \
    "typescript/package.json defines the canonical demo:transplant script"
else
  fail "typescript/package.json defines the canonical demo:transplant script"
fi

assert_contains "$quickstart_source" 'npm ci --no-audit --no-fund' \
  "launcher pins the lock-strict install command"
assert_contains "$quickstart_source" 'npm run demo:transplant --silent' \
  "launcher pins the canonical transplant command"
if [[ "$quickstart_source" != *"npm ls"* ]]; then
  pass "launcher has no dependency-readiness shortcut"
else
  fail "launcher has no dependency-readiness shortcut"
fi
assert_contains "$readme_source" '[![Node.js 20.9+]' \
  "README advertises the package engine minimum"
scoped_data_copy='**No extra API keys. No new accounts. No additional monthly bills. Memory and config stay local; prompts and context follow your configured model/provider.**'
assert_contains "$readme_source" "$scoped_data_copy" \
  "README pins the mode-scoped data promise"
if [[ "$readme_source" != *"Your data stays local."* ]]; then
  pass "README does not make the absolute local-data claim"
else
  fail "README does not make the absolute local-data claim"
fi

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
assert_contains "$readme_source" \
  '![Live Organ Transplant walkthrough](docs/assets/live-organ-transplant-walkthrough.gif)' \
  "README embeds the flagship visual walkthrough"
if [ -s "$ROOT/docs/assets/live-organ-transplant-walkthrough.gif" ]; then
  pass "flagship visual walkthrough exists and is non-empty"
else
  fail "flagship visual walkthrough exists and is non-empty"
fi
assert_contains "$readme_source" \
  'Upgrade a running agent without restarting its TypeScript host.' \
  "README leads with the running-agent benefit"
assert_contains "$readme_source" 'rejects that candidate before commit' \
  "README states pre-commit rejection"
assert_contains "$readme_source" 'last-known-good capability to answer again' \
  "README states the last-known-good capability proof"
assert_contains "$readme_source" 'The host PID stays the same' \
  "README states host PID continuity"
assert_contains "$readme_source" 'run leaves a verifiable receipt' \
  "README states receipt verification"
assert_contains "$readme_source" \
  'lockfile-exact demo with a SHA-256-pinned donor' \
  "README scopes deterministic behavior to locked inputs"
assert_contains "$readme_source" \
  'Node.js 20.9.0 or newer and Python 3.10 or newer must already' \
  "README states installed runtime prerequisites"
assert_contains "$readme_source" \
  'Installing Node or Python is outside that timing' \
  "README excludes prerequisite installation from runtime timing"
assert_contains "$readme_source" '[1/6] DONOR VERIFIED' \
  "README includes the six-beat transcript"
assert_contains "$readme_source" '[6/6] FLIGHT SEALED' \
  "README transcript ends with persisted Flight proof"
# shellcheck disable=SC2088
# This is the literal Markdown path shown to users, not a shell-expanded path.
assert_contains "$readme_source" \
  '~/.openrappter/demo-runs/live-organ-transplant/<timestamp>-<nonce>/' \
  "README identifies the default evidence directory"
for artifact in receipt.txt receipt.json transcript.txt flight-recorder.db \
  flight-recorder.export.json runtime-pid.json; do
  assert_contains "$readme_source" "\`$artifact\`" \
    "README identifies $artifact"
done

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

for milestone in \
  '[1/6] DONOR VERIFIED' \
  '[2/6] THEATER ONLINE' \
  '[3/6] TRANSPLANT ACCEPTED' \
  '[4/6] FIRST PULSE' \
  '[5/6] REJECTION TEST' \
  '[6/6] FLIGHT SEALED'; do
  assert_contains "$RUN_OUTPUT" "$milestone" \
    "success output contains $milestone"
done
authority_notice='AUTHORITY NOTICE: Python executes as the logged-in OS user with filesystem/network/environment/subprocess authority. The subprocess is NOT a sandbox. File preservation cannot undo external side effects.'
assert_contains "$RUN_OUTPUT" "$authority_notice" \
  "success output contains the runtime authority warning"
assert_contains "$RUN_OUTPUT" 'OPENRAPPTER_TRANSPLANT_RESULT=' \
  "success output contains the canonical receipt record"
assert_contains "$RUN_OUTPUT" \
  "\"evidenceDirectory\":\"$EVIDENCE_DIRECTORY\"" \
  "success output exposes the inspectable receipt directory"
assert_contains "$RUN_OUTPUT" 'flight-recorder.db' \
  "success output identifies the Flight database"
assert_contains "$RUN_OUTPUT" 'flight-recorder.export.json' \
  "success output identifies the Flight export"

new_fixture "dependencies-populated-valid"
mkdir -p "$FIXTURE/typescript/node_modules/.bin"
printf '{"lockfileVersion":3}\n' \
  >"$FIXTURE/typescript/node_modules/.package-lock.json"
printf '#!/usr/bin/env bash\nexit 0\n' \
  >"$FIXTURE/typescript/node_modules/.bin/tsx"
chmod +x "$FIXTURE/typescript/node_modules/.bin/tsx"
run_fixture --demo live-organ-transplant
assert_eq "$RUN_STATUS" "0" \
  "transplant succeeds with a populated valid dependency tree"
assert_eq "$RUN_CALLS" $'npm <ci> <--no-audit> <--no-fund>\nnpm <run> <demo:transplant> <--silent>' \
  "populated valid dependencies are still reconstructed with npm ci"

new_fixture "install-exit-status"
NPM_CI_STATUS=23
run_fixture --demo live-organ-transplant
assert_eq "$RUN_STATUS" "23" "lockfile install exit status propagates"
assert_eq "$RUN_CALLS" 'npm <ci> <--no-audit> <--no-fund>' \
  "failed npm ci prevents the demo command"

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
