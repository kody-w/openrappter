# ORDER — correct the registry entry, and stop prose from deciding conformance

**Repo: `kody-w/rapp-spine`.** Kody explicitly chose "correct it AND fix the string-match
flaw." This is his repo, so pushing is fine. **The grail installer stays untouched, and do
not touch `microsoft/*`.**

## 0. Why this is legitimate and not self-certification

openrappter is flagged `nonconformant` by the spine's own crawler. Round 9 proved the
crawler **never fetches our daemon** — the verdict comes entirely from
`generate_crawl.py::classify_protocol()`, which concatenates five *prose* fields and
substring-matches them.

The annotation predates the parity work. Since it was written we have closed seven real
findings and verified them live: the full six-key envelope on both runtimes, the voice
seam split, `agent_logs` in the frozen shape, reserved-dir exclusion, three-state burrow
detection, a published `SPEC.md` (HTTP 200), and a declared `core` tier.

So the registry text is **factually stale**, and correcting it is a factual correction.
**Be precise about what it buys:** the honest result is `not_assessed`, **not**
`conformant`. The classifier cannot award conformance to anything. Do not describe this
change, in the commit message or anywhere else, as openrappter "becoming conformant."

## 1. Job A — correct entry[3]

```
spec_id:      "(none; consumer RAPP substrate-distro, parity target incomplete)"
           -> "openrappter-runtime/1.0"

raw_url:      (absent)
           -> "https://raw.githubusercontent.com/kody-w/openrappter/main/SPEC.md"
              (verified live, HTTP 200, 6663 bytes, "# openrappter — canonical entry")

when_to_use:  remove the "currently incomplete" phrasing; describe what it IS.
```

Note the real smell: `spec_id` was carrying a sentence, not an identifier.

## 2. Job B — conformance must be declared and evidenced, never inferred from prose

`classify_protocol()` today:

```python
text = " ".join(str(entry.get(k,"")) for k in
                ("spec_id","purpose","role","when_to_use","entry_point")).lower()
nonconformant = any(p in text for p in
    ("non-conformant","nonconformant","parity target incomplete",
     "known phase-1 rce","unauthenticated"))
conformance = "nonconformant" if nonconformant else "not_assessed"
```

I ran it over all **59** protocol entries. **Be honest in the report: there are currently
zero accidental false positives** — only openrappter and leviathan are flagged, and
leviathan's flag is real. The defect is structural, not presently firing:

1. **Prose decides verdicts.** An entry that *warns against* `unauthenticated` routes is
   classified identically to one that *has* one. Guidance and hazard are indistinguishable.
2. **Silent flips.** Rewording a description or fixing a typo changes a conformance
   verdict with no review and no diff anyone would read as a verdict change.
3. **Unfalsifiable upward.** Nothing can ever be `conformant` — only `nonconformant` or
   `not_assessed`. A project that does the work has no way to show it.
4. **`spec_id` is being used as a comment field**, which is how #1 bit us.

### The fix

Make conformance an **explicit, evidenced field** on the registry entry:

```json
"conformance": {
  "state": "nonconformant" | "not_assessed" | "conformant",
  "evidence": "<url or spec citation>",
  "assessed": "<ISO date>"
}
```

- `classify_protocol()` reads that field. **It stops reading prose for conformance.**
- Absent field → `not_assessed`. That is the honest default.
- `conformant` **MUST** require an `evidence` pointer; refuse to emit it bare.
- **Preserve leviathan's flag** — set it explicitly to `nonconformant` with
  `NETWORK_TRUST_BOUNDARY.md` §6 (the unauthenticated `/api/agent` route) as its
  evidence. That flag is real and must not be lost in the migration. Losing a true
  positive while fixing false-positive *potential* would be a bad trade.
- Set openrappter to `not_assessed`. **Do not set it `conformant`** — we have not been
  assessed by anyone but ourselves.
- Lifecycle detection (`unpublished`/`deprecated`) may keep its prose matching; that is a
  weaker claim and out of scope. Say so rather than silently changing it.
- If you keep phrase-matching as a migration fallback, it **MUST** emit a warning naming
  the entry and phrase, so an inferred verdict is never silent.

## 3. Non-negotiables

- Run `tests/test_spine.py` and whatever `.github/workflows/verify.yml` runs. Green before push.
- Re-run `python3 crawl.py --remote --full` and confirm the graph still walks **220/220**
  nodes with clean integrity. The node count must not change.
- Do not touch the grail installer repo. Do not touch `microsoft/*`.
- Do not weaken the ability to flag genuine nonconformance — that is the whole value of
  the field.
- The commit message must state plainly that this removes prose-driven verdicts and that
  openrappter moves to `not_assessed`, not `conformant`.

## 4. Acceptance

1. `crawl.py --remote --full` → `nonconformant_node_ids` no longer contains
   `protocol:kody-w/openrappter/entry`; **still contains leviathan.**
2. openrappter's node reports `status: resolved`, `conformance: not_assessed`.
3. A test proving prose can no longer flip a verdict: add an entry whose `when_to_use`
   contains the word "unauthenticated" as guidance and assert it is **not** flagged.
4. 220/220 nodes, integrity unchanged.
5. rapp-spine's own tests green.
