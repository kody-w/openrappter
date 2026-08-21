# git-molt (vendored, pinned)

Source: https://github.com/kody-w/git-molt — branch `fix/local-verdicts-and-frame-path`
at commit ce26a73ed4f9af98fd7ea8ea7db3d720227d1191 (MIT), which is upstream commit 5abf9b9 plus two fixes the
organism proof found:

- a foreign `Molt-Verified` trailer no longer transfers activation authority on
  `frame import` (the verdict is a local ref that never travels);
- frames carry the locus's agent path (`refs/molt/meta/<locus>`).
- imported and locally configured agent paths are validated before persistence
  and again before composition, so absolute/traversal paths cannot escape the
  staging directory.

Both are pending an upstream pull request; once merged, re-pin to the upstream
commit. Used by `beta/scripts/gitmolt-runtime-proof.sh` so the proof runs
offline and deterministically. Override with `GIT_MOLT=/path/to/git-molt`.
