#!/usr/bin/env bash
set -euo pipefail
# Run only after pages.yml has merged and its constitution job is green.
gh api repos/kody-w/openrappter/pages \
  --method PUT \
  --input <(printf '%s\n' '{"build_type":"workflow"}')
