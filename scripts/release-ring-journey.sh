#!/usr/bin/env bash
set -euo pipefail

dry_run=false
fixtures=""
channel_version=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) dry_run=true; shift ;;
    --fixtures) fixtures="$2"; shift 2 ;;
    --channel-version) channel_version="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$channel_version" ]] || { echo "--channel-version is required" >&2; exit 2; }

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
npm_version="$(node -p "require('$root/typescript/package.json').version")"
pypi_version="$(python3 -c 'import tomllib,sys; print(tomllib.load(open(sys.argv[1],"rb"))["project"]["version"])' "$root/python/pyproject.toml")"
runtime_version="$(PYTHONPATH="$root/python" python3 -c 'from openrappter import __version__; print(__version__)')"
release_tag="v$channel_version"
source_commit="$(git -C "$root" rev-parse HEAD)"

emit() { printf '%s\n' "$*"; }
emit "PACKAGE_IDENTITIES npm=$npm_version pypi=$pypi_version runtime=$runtime_version channel=$channel_version tag=$release_tag"
emit "gh workflow run build-candidate.yml -R kody-w/openrappter -f source_commit=$source_commit -f channel_version=$channel_version -f release_tag=$release_tag -f candidate_kind=release"
emit "gh workflow run observe-main.yml -R kody-w/openrappter-release-train -f candidate_kind=release -f candidate_id=$release_tag"

for ring in nightly alpha canary beta stable; do
  if [[ -n "$fixtures" ]]; then
    index="$fixtures/$ring-index.json"
    head="$fixtures/$ring-head.json"
  else
    index="$root/.journey-$ring-index.json"
    head="$root/.journey-$ring-head.json"
    gh api "repos/kody-w/openrappter-release-train/contents/request-index/$ring.json" --jq .content | base64 --decode > "$index"
    gh api "repos/kody-w/openrappter-release-train/contents/heads/$ring.json" --jq .content | base64 --decode > "$head"
  fi
  sequence="$(jq -er '.entries[-1].sequence' "$index")"
  request_id="$(jq -er '.entries[-1].request_id' "$index")"
  request_path="$(jq -er '.entries[-1].path' "$index")"
  request_commit="$(jq -er '.request_commit' "$index")"
  printf -v padded '%020d' "$sequence"
  ack=".ring/applied/$padded-$request_id.json"
  target_repo="kody-w/openrappter"
  if [[ "$ring" != stable ]]; then target_repo="kody-w/openrappter-$ring"; fi
  emit "APPLY $ring sequence=$sequence ack=$ack"
  emit "gh workflow run apply-promotion.yml -R $target_repo -F request_sequence=$sequence"
  if [[ "$ring" == stable ]]; then
    emit "WAIT_AND_MERGE checked deterministic stable PR ring/stable-${request_id:0:16}"
  fi
  emit "gh workflow run finalize-promotion.yml -R kody-w/openrappter-release-train -f request_commit=$request_commit -f request_path=$request_path"
  finalized="$(jq -er '.sequence' "$head")"
  [[ "$sequence" -eq $((finalized + 1)) ]] || { echo "$ring fixture sequence gap" >&2; exit 1; }
done

emit "gh api repos/kody-w/openrappter/pages --method PUT --input pages-workflow.json"
emit "VERIFY curl -fsSL https://kody-w.github.io/openrappter/install.sh | bash -s -- --ring beta --dry-run"

if [[ "$dry_run" == false ]]; then
  echo "Journey plan generated. Execute each emitted command only after the previous workflow is green." >&2
fi
