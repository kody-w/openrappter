#!/usr/bin/env bash
set -euo pipefail
# Run before merging #437. Switching build_type does not delete the last
# successful Pages deployment; pages.yml will take over after merge.
gh api repos/kody-w/openrappter/pages \
  --method PUT \
  --input <(printf '%s\n' '{"build_type":"workflow"}')
