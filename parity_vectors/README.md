# Golden conformance vectors — `rapp-runtime-parity/1.0`

A candidate implementation of the corpus PARITY §5 specifies and marks
**PLANNED**. Neither the corpus nor `parity_harness.py` is committed anywhere in
the estate: `rapp_brainstem/parity_vectors/` and its `rapp-map` mirror are both
404. openrappter declares parity tier `core` in `SPEC.md`, and until something
executed these vectors that declaration was an assertion about ourselves that
nobody — including us — could check.

## What is here

14 vectors, one per class required by §5.3. Thirteen are `core`;
`voice-sentinel-split` is full-only, matching the spec's own tagging.

| # | Vector | Tier |
|---|--------|------|
| 1 | `empty-input-400` | core |
| 2 | `no-agents-passthrough` | core |
| 3 | `single-tool-then-answer` | core |
| 4 | `parallel-tool-calls` | core |
| 5 | `multi-round-tools` | core |
| 6 | `round-cap-3` | core |
| 7 | `bad-arguments-fallback` | core |
| 8 | `agent-not-found` | core |
| 9 | `agent-raises` | core |
| 10 | `history-role-filter` | core |
| 11 | `system-context-injection` | core |
| 12 | `finish-reason-agnostic-trigger` | core |
| 13 | `session-id-minted` | core |
| 14 | `voice-sentinel-split` | full |

`CORPUS.json` carries the per-vector digests and the corpus digest, so a runtime
can attest *exactly which* corpus it passed (§5).

## Offering this upstream

The vector files contain nothing openrappter-specific — no ports, paths, model
names or runtime details — so they can be moved to
`rapp_brainstem/parity_vectors/` unchanged. The harness (`../parity_harness.py`)
is ours and is not part of the corpus.

## Two things the spec leaves open

Both are decisions this corpus had to make in order to exist. Neither is
authoritative; if upstream rules differently, the vectors change, not the rule.

1. **Canonical JSON is not defined.** §5 says vectors are content-addressed by
   "sha256 of their canonical JSON" without saying what canonical means. This
   corpus uses sorted keys, `(',', ':')` separators and UTF-8 — and hashes the
   *parsed* content, so the digest is stable whether the file on disk is
   pretty-printed or minified. The rule is recorded in `CORPUS.json`.

2. **A minted value cannot be asserted exactly.** §5.3.13 requires
   `session-id-minted` to check for a valid UUIDv4, but §6.1 says comparison is
   exact. Expressing that needs an escape, so this corpus uses
   `{"$match": "uuid4"}`. It is the only construct here that is not literal
   equality.

## Running it

```
python3 parity_harness.py --tier core
python3 parity_harness.py --tier full --report report.json
```

The harness injects a scripted model at the runtime's model-call seam, as §5.2
requires — the runtime runs its real loop over real HTTP and only the model
*data* is scripted.
