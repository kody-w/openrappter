#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixtures="$root/.journey-fixtures"
rm -rf "$fixtures"; mkdir -p "$fixtures"
trap 'rm -rf "$fixtures"' EXIT
for i in 0 1 2 3 4; do
  ring=(nightly alpha canary beta stable)
  name="${ring[$i]}"; sequence=2; finalized=1
  id="$(printf '%064x' "$sequence")"
  cat > "$fixtures/$name-index.json" <<JSON
{"request_commit":"$(printf '%040x' "$sequence")","entries":[{"sequence":$sequence,"request_id":"$id","path":"requests/$name/$(printf '%020d' "$sequence")-$id.json"}]}
JSON
  printf '{"sequence":%d}\n' "$finalized" > "$fixtures/$name-head.json"
done
output="$("$root/scripts/release-ring-journey.sh" --dry-run --fixtures "$fixtures" --channel-version 0.1.0-beta.11)"
grep -q 'npm=1.13.0' <<< "$output"
grep -q 'channel=0.1.0-beta.11 tag=v0.1.0-beta.11' <<< "$output"
grep -q '.ring/applied/00000000000000000002-' <<< "$output"
grep -q 'WAIT_AND_MERGE checked deterministic stable PR' <<< "$output"
grep -q -- '--ring beta --dry-run' <<< "$output"
