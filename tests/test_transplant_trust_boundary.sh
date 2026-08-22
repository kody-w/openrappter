#!/usr/bin/env bash
# Literal documentation contract for executable Python agent registration.
# Run: bash tests/test_transplant_trust_boundary.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0
FAIL=0

pass() {
  PASS=$((PASS + 1))
  printf '  ok   %s\n' "$1"
}

fail() {
  FAIL=$((FAIL + 1))
  printf '  FAIL %s\n' "$1"
}

assert_contains() {
  local file="$1" needle="$2" label="$3"
  if grep -Fq -- "$needle" "$file"; then
    pass "$label"
  else
    fail "$label"
  fi
}

assert_not_contains() {
  local file="$1" needle="$2" label="$3"
  if grep -Fq -- "$needle" "$file"; then
    fail "$label"
  else
    pass "$label"
  fi
}

printf '\nOpenRappter transplant trust-boundary docs\n\n'

SKILLS="$ROOT/skills.md"
INDEX="$ROOT/docs/index.html"
DESKTOP="$ROOT/docs/electron-desktop.md"

assert_contains "$SKILLS" 'Node.js >=20.9' 'skills names the supported Node minimum'
assert_contains "$SKILLS" 'inspection launches Python' 'skills discloses executable inspection'
assert_contains "$SKILLS" 'constructs each discovered' 'skills discloses class construction'
assert_contains "$SKILLS" 'Each invocation launches a fresh Python process.' 'skills discloses per-call Python execution'
assert_contains "$SKILLS" 'access the filesystem, network, environment, and subprocesses' 'skills discloses Python OS capabilities'
assert_contains "$SKILLS" 'not a security boundary' 'skills rejects subprocess-as-sandbox framing'
assert_contains "$SKILLS" 'cannot undo side effects' 'skills limits file rollback claims'
assert_contains "$SKILLS" 'dependency installation as a separate supply-chain decision' 'skills warns beside inferred dependency installation'
assert_contains "$SKILLS" 'no supported general execution sandbox is provided' 'skills rejects unsupported sandbox configuration'
assert_not_contains "$SKILLS" 'Node.js 18+' 'skills removes the obsolete Node minimum'
assert_not_contains "$SKILLS" 'Agent-specific settings, workspaces, sandbox options' 'skills removes unsupported sandbox options'

assert_contains "$INDEX" 'approval and logging do not sandbox them' 'homepage qualifies shell execution'
assert_not_contains "$INDEX" 'Executes system commands safely with sandboxing.' 'homepage removes the general sandbox claim'

assert_contains "$DESKTOP" '- `sandbox: true`' 'desktop retains the renderer sandbox setting'
assert_contains "$DESKTOP" 'These settings sandbox only the Electron renderer.' 'desktop scopes the renderer boundary'
assert_contains "$DESKTOP" 'Each invocation launches a fresh' 'desktop discloses per-call Python execution'
assert_contains "$DESKTOP" 'subprocesses as the logged-in OS user' 'desktop discloses Python OS capabilities'
assert_contains "$DESKTOP" 'not a security boundary' 'desktop rejects subprocess-as-sandbox framing'
assert_contains "$DESKTOP" 'not a signature, provenance proof, safety verdict, or execution' 'desktop limits scan and digest claims'

for release in \
  "$ROOT/docs/release-notes-1.10.0-evolution.html" \
  "$ROOT/docs/release-notes-1.11.0-evolution.html"; do
  version="$(basename "$release")"
  assert_contains "$release" 'quarantine it for inspection' "$version preserves the historical prompt"
  assert_contains "$release" 'Current security annotation (August 2026)' "$version adds the current annotation"
  assert_contains "$release" 'not a non-executing sandbox' "$version rejects quarantine-as-containment"
  assert_contains "$release" 'constructs each discovered agent class' "$version discloses class construction"
  assert_contains "$release" 'restoring prior file bytes cannot undo side effects' "$version limits rollback claims"
done

assert_not_contains "$ROOT/docs/release-notes-1.10.0-evolution.html" 'evolve safely' '1.10 removes the unqualified safety claim'
assert_not_contains "$ROOT/docs/release-notes-1.11.0-evolution.html" '.rapp-install.json</code> provenance' '1.11 does not label local metadata as provenance'

printf '\n%d passed, %d failed\n\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
