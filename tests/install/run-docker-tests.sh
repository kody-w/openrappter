#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# Run Docker-based install smoke tests
# Usage: bash tests/install/run-docker-tests.sh
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PASS=0
FAIL=0
TESTS=("smoke" "nonroot" "git-method")

# Build npm tarball for smoke test (local install)
echo "Building npm tarball for smoke test..."
TARBALL=""
pushd "$REPO_ROOT/typescript" >/dev/null
npm run build >/dev/null 2>&1
# npm pack outputs the tarball filename as its last line
TARBALL="$(npm pack 2>&1 | tail -1)"
popd >/dev/null
echo "Tarball: $TARBALL"

for test_name in "${TESTS[@]}"; do
    test_dir="$SCRIPT_DIR/docker/$test_name"
    if [[ ! -f "$test_dir/Dockerfile" ]]; then
        echo "SKIP: $test_name (no Dockerfile)"
        continue
    fi

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "TEST: $test_name"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    # Copy install.sh into the Docker context
    cp "$REPO_ROOT/install.sh" "$test_dir/install.sh"

    # Copy tarball for smoke test
    if [[ "$test_name" == "smoke" && -n "$TARBALL" ]]; then
        cp "$REPO_ROOT/typescript/$TARBALL" "$test_dir/"
    fi

    if docker build --no-cache -t "openrappter-test-${test_name}" "$test_dir"; then
        echo "✓ PASS: $test_name"
        ((PASS++))
    else
        echo "✗ FAIL: $test_name"
        ((FAIL++))
    fi

    # Clean up copied files
    rm -f "$test_dir/install.sh"
    rm -f "$test_dir"/openrappter-*.tgz
done

# Clean up tarball
rm -f "$REPO_ROOT/typescript/$TARBALL"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Results: $PASS passed, $FAIL failed"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [[ "$FAIL" -gt 0 ]]; then
    exit 1
fi
