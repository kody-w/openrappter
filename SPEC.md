# openrappter — canonical entry

**spec_id:** `openrappter-runtime/1.0`
**repo:** `kody-w/openrappter`
**layer:** runtime
**raw_url:** `https://raw.githubusercontent.com/kody-w/openrappter/main/SPEC.md`

openrappter is a **substrate-distro**: a consumer-facing machine AI that runs the RAPP
`/chat` tool-calling loop locally, in two interchangeable runtimes (TypeScript and Python),
and hot-loads single-file `*_agent.py` cartridges.

This document is the canonical material for `protocol:kody-w/openrappter/openrappter-runtime/1.0`.
It states what openrappter conforms to, what it does not, and how to check either without
trusting this file.

---

## 1. Declared parity tier: `core`

Per `rapp-runtime-parity/1.0` §4.

`core` asserts the request/response envelope, the tool-call loop semantics, the `agent_logs`
shape, and the agent ABI — and MAY omit optional capabilities and MAY have narrower error
surfacing.

**We declare `core`, not `full`, deliberately.** §4 makes tier monotonic and says a runtime
that fails its declared tier is in drift. Declaring `core` truthfully is worth more than
claiming `full` and drifting. The one `full`-only vector — `voice-sentinel-split` — we do
in fact implement (§3 below); we hold at `core` because the loop-semantics vectors are not
yet measured end-to-end against a live model on every release.

### What the tier claim is measured against

PARITY §5 says the golden corpus **SHOULD** ship at `rapp_brainstem/parity_vectors/`,
mirrored into `rapp-map`. Both locations return `404` as of 2026-08-03, and §5 marks the
corpus **PLANNED — not yet committed**. §6's `parity_harness.py` is PLANNED too. There is
nothing to fetch and nothing in the estate that executes the vectors.

So we wrote a candidate corpus and harness rather than leave the tier claim unfalsifiable:

- `parity_vectors/` — 14 vectors, one per class required by §5.3, to the §5.1 schema and
  content-addressed per §5. They carry nothing openrappter-specific and can be offered
  upstream unchanged. Corpus sha256 is in `parity_vectors/CORPUS.json`.
- `parity_harness.py` — runs them against the Python runtime over real HTTP with a scripted
  model injected at the model-call seam, as §5.2 requires.
- `python/tests/test_parity_corpus.py` — runs the corpus in the test suite, so this is a
  gate on every change rather than a one-off report.

**Result on first run: 9/14.** The five failures were normative violations, since fixed:
a 5-round tool loop where §2.2 freezes 3 and names looping 5 times as non-conformant; no
`system_context()` concatenation at all; JSON error blobs where §2.3 fixes the `agent_logs`
strings; and the wrong `400` body. A sixth — tool result messages missing the required
`name` key — was found by tightening the harness after the first run. It is now 14/14 full,
13/13 core.

**This measures the Python runtime only.** The TypeScript runtime is not yet covered by the
harness and is known to diverge: its tool loop defaults to 10 rounds (`Assistant.ts`),
against a cap §2.2 freezes at 3. Our two runtimes therefore do not currently agree on
loop semantics, which fails parity inside this product before the estate is involved. That
is stated here rather than left for someone to discover.

---

## 2. The `/chat` envelope

`POST /chat` → `200` with the six keys PARITY §2.4 freezes:

```json
{
  "response":        "string — final assistant content",
  "session_id":      "string",
  "agent_logs":      "string — newline-joined log lines, \"\" if no tools ran",
  "voice_mode":      false,
  "model":           "string — the model that actually answered",
  "requested_model": "string — what was asked for"
}
```

Additional keys — `schema`, `status`, `content`, `sessionId`, `voice_response` — are extra
axes. PARITY §3 says extra axes are free and are not drift; only absence is drift.

**There is no `assistant_response` key** (KERNEL §2.2). Both runtimes are built from one
shared envelope builder, and a cross-runtime test diffs their output on identical input so
the two substrates cannot silently disagree again.

`agent_logs` is `"[<name>] <result>"` per call, joined by `"\n"` in execution order
(PARITY §2.3); the error form is `"[<name>] ERROR: <e>"`, and an unknown tool yields
`"Agent '<name>' not found."`.

---

## 3. The voice seam

When a reply carries the `|||VOICE|||` sentinel, `response` is the text before it and
`voice_response` the text after; `voice_mode` reports whether this reply actually carries a
spoken projection. The raw sentinel never reaches the caller.

openrappter generalises this to `|||TAG|||` sense projections (`rapp-sense/1.0`) — `VOICE`,
`HOLO`, and others — parsed by one shared parser. The envelope behaviour for `VOICE`
matches PARITY §2.4 exactly, which is what the spec requires of an optional capability.

---

## 4. Agent discovery

Per `rapp-kernel/1.0` §2.3:

- agents load from the `agents/` tree by the `*_agent.py` pattern, fresh per request
- `basic_agent.py` is excluded
- **`experimental_agents/` and `disabled_agents/` are reserved and are never auto-loaded**
- other subdirectories are the user's to organise, and are walked

Both runtimes honour all four rules. openrappter additionally accepts `.js` factory agents;
that is an extra capability and does not alter the frozen pattern.

The ABI-4 import shim (`utils.azure_file_storage` → local storage) is present, so an
unmodified brainstem or CommunityRAPP agent runs here as-is.

---

## 5. Network trust boundary

Per `rapp-network-trust/1.0`:

- **both** runtimes default to loopback (`bind: 'loopback'`; `OPENRAPPTER_BRAINSTEM_HOST`
  defaults to `127.0.0.1`)
- cross-origin reads are refused with `403` on `/chat`, `/agents/import` and `/health` —
  the connection is accepted and the read refused, which is what lets an opaque probe
  resolve without becoming a data path

### Discoverability (the burrowed pattern)

`burrow.js` probes `127.0.0.1` on `7071, 7081, 7082, 7083`. openrappter's gateway is on
`18790`, so the detector could not see it and reported `unburrowed` — the exact failure that
pattern exists to prevent.

openrappter now starts a **presence beacon** on the first *free* probed port. It serves
`/health` only, binds loopback only, holds no secret, proxies nothing, and refuses
cross-origin reads. It never displaces anything already listening — `7071` is the grail
parent and `7081+` are its twins — and if every probed port is occupied it stays quiet,
because something else already answers there.

---

## 6. Liveness is three states

Following `burrow.js`, which is the canonical implementation:

| state | meaning |
|---|---|
| `awake` | it answered. Observed. |
| `asleep` | it refused, fast. Observed, normal, never an error. |
| `blocked` | we were not allowed to look. **Nothing was learned** — never rendered as asleep. |

`certain: false` on a block *and* on a timeout: loopback refuses in ~3ms and a live
brainstem answers in ~236ms, so an expired deadline is a missing verdict rather than an
observed absence.

---

## 7. How to check any of this

```bash
# the envelope, live
curl -s -X POST http://127.0.0.1:18790/chat \
  -H 'Content-Type: application/json' -d '{"message":"hi"}'

# the anatomy of a running organism, machine-readable
curl -s http://127.0.0.1:18790/anatomy.json

# the conformance suites
cd typescript && npx vitest run src/gateway/__tests__/
```

---

## 8. Known gaps

Stated here rather than discovered later:

- The loop-semantics vectors (`round-cap-3`, `bad-arguments-fallback`,
  `history-role-filter`, `system-context-injection`, `finish-reason-agnostic-trigger`,
  `single-tool-then-answer`, `empty-input-400`) are specified but not yet run end-to-end
  against a live model on every release. This is why the declared tier is `core`.
- The golden vector corpus does not exist upstream, so the tier is measured against §5.2's
  named cases rather than against content-addressed fixtures.
