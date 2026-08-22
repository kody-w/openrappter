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

assert_contains "$SKILLS" './quickstart.sh --demo live-organ-transplant' 'skills recommends the flagship command'
assert_contains "$SKILLS" 'without restarting, reject a broken replacement' 'skills tells the flagship benefit story'
assert_contains "$SKILLS" 'macOS, Linux, and WSL; native Windows is deferred' 'skills names flagship platforms'
assert_contains "$SKILLS" 'README.md#see-a-live-organ-transplant' 'skills links to README proof details'
assert_contains "$SKILLS" 'no model/provider calls' 'skills names deterministic demo traffic'
assert_contains "$SKILLS" 'Loopback is not an OS egress boundary' 'skills rejects a no-egress inference'
assert_contains "$SKILLS" 'Model traffic stays on the configured local endpoint' 'skills defines local-model traffic'
assert_contains "$SKILLS" 'Prompts are sent to, and model outputs are returned by' 'skills defines cloud model traffic'
assert_contains "$SKILLS" 'GitHub account with Copilot access and authentication required' 'skills names Copilot account requirement'
assert_contains "$SKILLS" 'lockfile-pinned `@github/copilot`' 'skills names the repository-local Copilot dependency'
assert_contains "$SKILLS" '`npm ci` installs the lockfile-pinned' 'skills installs Copilot from the lockfile'
assert_contains "$SKILLS" 'OPENRAPPTER_COPILOT_CLI' 'skills documents the optional operator override'
assert_contains "$SKILLS" 'COPILOT_CLI_PATH' 'skills documents the CLI path override'
assert_contains "$SKILLS" 'openrappter onboard' 'skills points to current Copilot onboarding'
assert_not_contains "$SKILLS" '| GitHub Copilot CLI |' 'skills removes the ambient Copilot prerequisite'
assert_not_contains "$SKILLS" 'copilot --version' 'skills removes the ambient Copilot version check'
assert_not_contains "$SKILLS" '@githubnext/github-copilot-cli' 'skills removes the obsolete global package'
assert_not_contains "$SKILLS" 'github-copilot-cli auth' 'skills removes obsolete global authentication'
assert_not_contains "$SKILLS" 'npm install -g' 'skills does not recommend a global Copilot install'
assert_not_contains "$SKILLS" 'Quickstart Demo (recommended first step)' 'skills replaces the generic tour as recommended demo'
assert_contains "$SKILLS" '### Generic Quickstart Tour' 'skills retains the generic tour'

assert_contains "$INDEX" 'approval and logging do not sandbox them' 'homepage qualifies shell execution'
assert_not_contains "$INDEX" 'Executes system commands safely with sandboxing.' 'homepage removes the general sandbox claim'
assert_contains "$INDEX" 'id="flagship"' 'homepage exposes the flagship section'
assert_contains "$INDEX" './quickstart.sh --demo live-organ-transplant' 'homepage publishes the flagship command'
assert_contains "$INDEX" 'macOS, Linux, and WSL' 'homepage names flagship platforms'
assert_contains "$INDEX" 'github.com/kody-w/openrappter#see-a-live-organ-transplant' 'homepage links to README proof details'
assert_contains "$INDEX" 'id="trust-matrix"' 'homepage publishes the three-mode matrix'
assert_contains "$INDEX" 'No model/provider calls' 'homepage names deterministic demo traffic'
assert_contains "$INDEX" 'No OS egress claim is made.' 'homepage rejects a demo no-egress inference'
assert_contains "$INDEX" 'Model traffic stays on the configured local endpoint.' 'homepage defines local-model traffic'
assert_contains "$INDEX" 'Prompts are sent to, and model outputs are returned by' 'homepage defines cloud model traffic'
assert_contains "$INDEX" 'GitHub account with Copilot access and authentication required' 'homepage names Copilot account requirement'
assert_contains "$INDEX" 'comparison-check">Apache-2.0</td>' 'homepage comparison names the product license'
assert_contains "$INDEX" 'Apache-2.0 License' 'homepage community card names the product license'
assert_contains "$INDEX" 'under the Apache-2.0 License' 'homepage footer names the product license'
assert_contains "$INDEX" 'GitHub and GitHub Copilot are trademarks of GitHub, Inc.' 'homepage retains trademark qualification'
assert_not_contains "$INDEX" 'No accounts required' 'homepage removes unconditional account copy'
assert_not_contains "$INDEX" 'Nothing leaves your machine. No cloud. No accounts. Truly private.' 'homepage removes unconditional no-cloud copy'
assert_not_contains "$INDEX" 'Your data never leaves.' 'homepage removes unconditional local-only copy'
assert_not_contains "$INDEX" 'No data is sent to any cloud service.' 'homepage removes contradictory FAQ copy'
assert_not_contains "$INDEX" 'nothing ever leaves your device' 'homepage removes absolute local-model copy'
assert_not_contains "$INDEX" '100% local' 'homepage removes absolute comparison copy'
assert_not_contains "$INDEX" 'private by default' 'homepage removes the unconditional footer claim'
assert_not_contains "$INDEX" 'Complete data sovereignty' 'homepage removes unqualified sovereignty copy'
assert_not_contains "$INDEX" 'MIT License' 'homepage removes obsolete product license text'
assert_not_contains "$INDEX" '>MIT</td>' 'homepage carries no stale MIT license cell'

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
