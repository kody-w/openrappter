#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OPENRAPPTER_HOME="${OPENRAPPTER_HOME:-$HOME/.openrappter}"
RUNTIME_ROOT="$OPENRAPPTER_HOME/runtimes/imessage"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "The OpenRappter iMessage runtime requires macOS." >&2
  exit 1
fi

PYTHON_BIN="${OPENRAPPTER_PYTHON_BOOTSTRAP:-}"
if [[ -z "$PYTHON_BIN" ]]; then
  for candidate in python3.12 python3.11 python3.10; do
    if command -v "$candidate" >/dev/null 2>&1; then
      PYTHON_BIN="$(command -v "$candidate")"
      break
    fi
  done
fi
if [[ -z "$PYTHON_BIN" || ! -x "$PYTHON_BIN" ]]; then
  echo "Python 3.10+ is required. Install python@3.12 with Homebrew." >&2
  exit 1
fi

base_release="$(
  cd "$REPO_ROOT"
  git rev-parse --short=12 HEAD 2>/dev/null || date -u +%Y%m%d%H%M%S
)"
dirty_fingerprint="$(
  cd "$REPO_ROOT"
  {
    git diff -- \
      python/openrappter/brainstem.py \
      python/openrappter/agents/manage_memory_agent.py \
      python/openrappter/agents/context_memory_agent.py \
      python/openrappter/imessage \
      python/tests/test_imessage_core.py \
      python/tests/test_imessage_rpc.py \
      scripts/install-imsg.sh \
      scripts/install-imessage-runtime.sh \
      scripts/install-imessage-service.sh
    git ls-files --others --exclude-standard \
      python/openrappter/imessage \
      python/tests/test_imessage_core.py \
      python/tests/test_imessage_rpc.py \
      scripts/install-imsg.sh \
      scripts/install-imessage-runtime.sh \
      scripts/install-imessage-service.sh \
      | sort \
      | while read -r file; do
          [[ -n "$file" ]] && shasum -a 256 "$file"
        done
  } | shasum -a 256 | awk '{print substr($1,1,12)}'
)"
release_id="$base_release"
if ! (
  cd "$REPO_ROOT"
  git diff --quiet -- \
    python/openrappter/brainstem.py \
    python/openrappter/agents/manage_memory_agent.py \
    python/openrappter/agents/context_memory_agent.py \
    python/openrappter/imessage \
    python/tests/test_imessage_core.py \
    python/tests/test_imessage_rpc.py \
    scripts
); then
  release_id="$base_release-dev-$dirty_fingerprint"
elif [[ -n "$(cd "$REPO_ROOT" && git ls-files --others --exclude-standard python/openrappter/imessage python/tests/test_imessage_core.py python/tests/test_imessage_rpc.py scripts)" ]]; then
  release_id="$base_release-dev-$dirty_fingerprint"
fi
target="$RUNTIME_ROOT/$release_id"

"$SCRIPT_DIR/install-imsg.sh"

if [[ ! -x "$target/bin/python" ]]; then
  "$PYTHON_BIN" -m venv "$target"
  "$target/bin/python" -m pip install --upgrade pip --quiet
  "$target/bin/python" -m pip install "$REPO_ROOT/python" --quiet
fi

"$target/bin/python" - <<'PY'
import openrappter.brainstem
import openrappter.imessage
print("OpenRappter iMessage runtime import verified")
PY

mkdir -p "$RUNTIME_ROOT"
ln -sfn "$target" "$RUNTIME_ROOT/current"

echo "Installed OpenRappter iMessage runtime $release_id"
echo "Python: $RUNTIME_ROOT/current/bin/python"
