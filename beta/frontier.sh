#!/usr/bin/env bash
set -euo pipefail

repo="${RAPP_FRONTIER_REPO:-microsoft/aibast-agents-library}"
case "$repo" in
    *[!A-Za-z0-9_./-]*|*/*/*|/*|*/|"")
        echo "Invalid RAPP_FRONTIER_REPO: $repo" >&2
        exit 2
        ;;
esac

api="${RAPP_FRONTIER_API:-https://api.github.com/repos/$repo}"
git_url="https://github.com/$repo.git"

# The unauthenticated GitHub API is quota-limited per source address (60/hour),
# so a shared office NAT can block every fresh install with an HTTP 403 while
# raw GitHub and git fetches still work. Honor a token when one is present, and
# fall back to `git ls-remote` (not quota-limited the same way) when the API
# refuses or is unreachable.
token="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
auth=()
[ -n "$token" ] && auth=(-H "Authorization: Bearer $token")

api_get() {
    curl -fsSL -H "Accept: application/vnd.github+json" ${auth[@]+"${auth[@]}"} "$1"
}

tags_via_git() {
    git ls-remote --tags --refs "$git_url" 'brainstem-beta-v*' 2>/dev/null \
        | sed -n 's|^[0-9a-fA-F]*[[:space:]]*refs/tags/||p' \
        | sort -V \
        | tail -n 1
}

tag=$(
    api_get "$api/releases?per_page=30" 2>/dev/null \
        | sed -n 's/^[[:space:]]*"tag_name":[[:space:]]*"\(brainstem-beta-v[^"]*\)".*/\1/p' \
        | head -n 1 || true
)
if [ -z "$tag" ]; then
    echo "GitHub API did not answer (rate limit or network); resolving the release tag with git..." >&2
    tag=$(tags_via_git)
fi
[ -n "$tag" ] || {
    echo "No published RAPP Brainstem Frontier release was found in $repo." >&2
    echo "If you are behind a shared network, set GITHUB_TOKEN to a read-only token and retry." >&2
    exit 3
}

commit=$(
    api_get "$api/commits/$tag" 2>/dev/null \
        | sed -n 's/^[[:space:]]*"sha":[[:space:]]*"\([0-9a-fA-F]\{40\}\)".*/\1/p' \
        | head -n 1 \
        | tr 'A-F' 'a-f' || true
)
if [ -z "$commit" ]; then
    # The peeled ref (tag^{}) is the commit behind an annotated tag.
    commit=$(
        git ls-remote "$git_url" "refs/tags/$tag^{}" "refs/tags/$tag" 2>/dev/null \
            | awk -v peeled="refs/tags/$tag^{}" '$2 == peeled { print $1; found = 1; exit } END { }' \
            | tr 'A-F' 'a-f'
    )
    [ -n "$commit" ] || commit=$(
        git ls-remote "$git_url" "refs/tags/$tag" 2>/dev/null | awk '{ print $1; exit }' | tr 'A-F' 'a-f'
    )
fi
case "$commit" in
    *[!0-9a-f]*|"")
        echo "The Frontier release did not resolve to a full commit SHA." >&2
        exit 4
        ;;
esac
[ "${#commit}" -eq 40 ] || {
    echo "The Frontier release did not resolve to a full commit SHA." >&2
    exit 4
}

if [ "${RAPP_FRONTIER_RESOLVE_ONLY:-0}" = "1" ]; then
    printf '%s %s %s\n' "$repo" "$tag" "$commit"
    exit 0
fi

curl -fsSL "https://raw.githubusercontent.com/$repo/$commit/beta/install.sh" \
    | BRAINSTEM_BETA_REPO_URL="https://github.com/$repo.git" \
      BRAINSTEM_BETA_RELEASE_TAG="$tag" \
      BRAINSTEM_BETA_RUNTIME_VERSION_URL="https://raw.githubusercontent.com/$repo/$commit/rapp_brainstem/VERSION" \
      BRAINSTEM_BETA_COMMIT="$commit" bash
