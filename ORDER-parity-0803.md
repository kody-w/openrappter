# ORDER — openrappter is NONCONFORMANT per the spine's own crawler

## 0. How this was found

Kody asked whether I had run the full spine. I had not — I had grepped it for the rappid
question only. So I ran it properly:

```
cd rapp-spine && python3 crawl.py --remote --full --json
```

220/220 nodes visited, graph integrity clean, zero dangling relations. **`passed: false`.**

Under `operational_conformance`, exactly **two** nodes are nonconformant, and one of them
is us:

```
nonconformant_node_ids:
  - protocol:kody-w/openrappter/entry      <-- us
  - protocol:kody-w/leviathan/leviathan/1.0
```

This is the ecosystem's own verdict, produced by its own tooling. Not an opinion.

## 1. Finding A — openrappter publishes no canonical material

```
{"node_id": "protocol:kody-w/openrappter/entry",
 "role": "canonical_material", "target": null,
 "status": "unresolved", "integrity": "not_checkable"}
```

The spine expects every protocol node to resolve to readable canonical material. Ours
resolves to **nothing** — `target: null`. openrappter is in the registry as a protocol and
publishes no spec the spine can read, so it can never be verified, only assumed.

Fix: publish a canonical entry document openrappter actually conforms to, at a stable raw
URL, and make it resolvable from the registry. Read how a *conformant* protocol node does
it before inventing a shape — several in the crawl resolve cleanly; copy one.

## 2. Finding B — `/chat` violates the frozen envelope (I verified this live)

`specs/PARITY.md` §2.4 freezes the response envelope. Its
`envelope_required_keys` are:

```
["response", "session_id", "agent_logs", "voice_mode", "model", "requested_model"]
```

What our daemon actually emits, tested against `:18790` just now:

```
['schema', 'status', 'response', 'content', 'session_id', 'sessionId', 'agent_logs']

OK       response
OK       session_id
OK       agent_logs
MISSING  voice_mode
MISSING  model
MISSING  requested_model
```

Three required keys absent. PARITY §0 is blunt about why this matters: *"If two runtimes
claiming to be RAPP diverge on the wire, then the estate is not one medium — it is N
incompatible products wearing the same name."* Every round tonight Kody asked for brainstem
parity; this is the measurable version of it, and we fail it.

Add the three keys. Keep `schema`/`status`/`content`/`sessionId` — §3 says extra axes are
free and are **not** drift. Only absence is drift.

## 3. Finding C — the voice seam leaks raw into the reply (user-visible)

PARITY §2.4 says the runtime **splits** on the voice marker: `response` = text before,
`voice_response` = text after. Ours does neither — it ships the raw marker inside
`response`:

```
response: "Hey! 👋\n\n|||VOICE|||\nHey, good to see you!"
voice_response: ABSENT

should be ->  response:       "Hey! 👋"
              voice_response: "Hey, good to see you!"
```

**This is not only a spec violation, it is a visible product bug.** Every reply quoted all
night carried `|||VOICE|||` in its text — anyone chatting with openrappter sees that
literal marker. Split it at the seam and emit `voice_response`, with `voice_mode` set
accordingly.

Note `feat/vui-senses-copilot-cli` @ `c7e3f95` (in the second checkout) is titled *"sense
seam (|||TAG|||) + wire Copilot CLI backend"* — the seam is deliberate; the **splitting**
is what never landed. Read that branch before writing; it may already contain the answer.

## 3b. Finding D — openrappter's two runtimes disagree with EACH OTHER

This is the worst of the set, because it fails parity internally before the estate is
even involved. openrappter ships two substrates and they emit different envelopes:

| required key | `python/openrappter/brainstem.py` | TypeScript daemon (serves `:18790`) |
|---|---|---|
| `response` | ✓ | ✓ |
| `session_id` | ✓ | ✓ |
| `agent_logs` | ✓ (correctly `"\n".join(...)`) | ✓ |
| `model` | ✓ | **missing** |
| `voice_mode` | **missing** | **missing** |
| `requested_model` | **missing** | **missing** |

Python is 4/6, TypeScript is 3/6, and neither is 6/6. PARITY exists precisely to stop
this: *"one runtime, many substrates."* We are two substrates of the **same product**
that answer differently — so a caller cannot swap our own Python tier for our own TS tier
and get the same behaviour.

Fix both, to the same envelope, and add a test that **diffs the two runtimes' `/chat`
output against each other** on identical input. That test is the thing that stops this
recurring; without it the two drift again the moment someone touches one side.

## 3c. Finding E — reserved agent directories are not honored (a real bug)

`KERNEL.md` §2.3 freezes discovery: agents load from `agents/` by the `*_agent.py`
pattern, and **`experimental_agents/` and `disabled_agents/` are reserved names a
conforming kernel will never auto-load.**

```
grep -rn "experimental_agents\|disabled_agents" python/ typescript/src/   ->  nothing
```

We honor neither. This is not a spec nicety — it is a functional bug with a plausible
user story: someone moves an agent into `disabled_agents/` to switch it off, and it keeps
running. Given we just shipped drag-and-drop agent loading, "how do I turn one off" is the
very next question a user asks. Exclude both directories from discovery in **both**
runtimes.

## 3d. What already conforms — do not "fix" these

Verified present, leave them alone:

- **ABI-4 import shim.** `brainstem.py` injects `utils.azure_file_storage` → local storage
  (`sys.modules.setdefault`, line ~215), explicitly commented as the kernel shim. This is
  what lets brainstem/CommunityRAPP agents run here unmodified. It is correct.
- **ABI-3 filename pattern.** `glob("*_agent.py")` with `basic_agent.py` excluded. Correct.
- `agent_logs` as a newline-joined string on the Python side. Correct.

Also note `KERNEL.md` §2.2 independently confirms Finding B's envelope and adds one more
rule: **"There is no `assistant_response` key."** Verify we never emit it.

## 3e. THE BURROWED PATTERN — Kody: "same thing applies for openrappter"

Read `~/chat/burrow.js` in full before touching this. It is the canonical implementation
and its header comment is the spec. The rule:

> *something listening → fetch RESOLVES (opaque; 200/403/404 all look alike)*
> *nothing listening → fetch REJECTS (connection refused)*
> **"A 403 is an answer. Silence is not. That distinction is the whole detector."**

**Good news first:** openrappter already behaves correctly as a *probe target*. I measured
it — hostile `Origin` → `403`, foreign `Host` → `403`, on `/chat`, `/agents/import` and
`/health`. It accepts the connection and refuses the read, which is exactly what makes an
opaque probe resolve. It also defaults to loopback in **both** runtimes
(`bind: z.enum(['loopback','all']).default('loopback')`, and
`OPENRAPPTER_BRAINSTEM_HOST` defaulting to `127.0.0.1`). On the network trust boundary we
are **more conformant than the grail**, which `NETWORK_TRUST_BOUNDARY.md` §0 says still
binds `0.0.0.0` today. Do not "fix" any of that.

### Finding F — the detector cannot see us

```js
const DEFAULT_PORTS = [7071, 7081, 7082, 7083];   // burrow.js:53
```

openrappter listens on **18790**. It is not in the list. So a user with openrappter
burrowed on their machine, visiting the hosted chat, is told **`unburrowed`** — which is
precisely the lie burrow.js exists to prevent: *"it would tell someone with a live
brainstem that they have none."*

openrappter must be **discoverable by the burrowed pattern**. Decide and justify the
mechanism — adding 18790 to the probe set is the obvious move but it lives in the `chat`
repo, so consider whether openrappter should instead answer on a brainstem-compatible
port, or advertise its port through an already-probed surface. **Do not modify the grail
installer repo.** State the tradeoff you chose and why.

### Finding G — the anatomy page is a boolean where the pattern demands three states

`typescript/src/gateway/anatomy-page.ts:115`:

```js
['state', a.vitals.awake ? 'awake' : 'asleep', a.vitals.awake ? 'ok' : 'warn'],
```

Two states. The pattern requires **three**, and Kody's own post
(`2026-08-01-a-403-is-an-answer.md`) is about exactly this:

> *"Most checks are written as booleans… and most of the time the honest answer is one of
> three things."*

So the page we shipped tonight will report **"asleep"** when it merely *could not look* —
mixed content, a Private Network Access preflight, or a timeout. Required:

- **awake** — answered, observed.
- **asleep** — refused fast, observed. Normal, never an error.
- **blocked / could not tell** — the browser refused to let us look. We learned nothing;
  say so. **Never render this as asleep.**
- Carry **`certain: false`** on a timeout. Loopback refuses in ~3ms and a live brainstem
  answers in ~236ms, so an expired deadline is a *missing verdict*, not observed absence.

Mirror burrow.js's classification rather than reinventing it — same state names, same
honesty. If openrappter and vbrainstem disagree about what "I don't know" looks like, the
membrane is not one pattern.

## 3f. Finding H — `agent_logs` is empty even when an agent DID run

Newly demonstrable, because round 8 made invocation work. I dropped my own agent
(`kelpwarden_agent.py`, never seen by you) and asked for a value only it could produce:

```
response  : "...drift signature VERMILION-8842-TALLOW, holding at 17 fathoms,
             warden on station is Osgood."     <- the agent really ran
agent_logs: (empty)
```

`PARITY.md` §2.3 defines `agent_logs` as the per-round tool-call lines **joined by
`"\n"`** across all rounds, and `KERNEL.md` §2.2 restates it as part of the frozen
envelope. An invocation that produces no log line means the key is present but its
**shape is wrong** — a caller cannot see that an agent ran, which is the entire purpose of
the field. The grail emits `[<name>] <result>` per call; `python/openrappter/brainstem.py`
already does exactly that (`agent_logs.append(f"[{name}] {result}")`, line ~671). The TS
daemon does not.

This is the same Python-vs-TypeScript split as Finding D, so fix it in the same pass and
cover it with the same cross-runtime diff test.

*(Also re-confirmed in that response: the raw `|||VOICE|||` marker is still sitting inside
`response`. Finding C stands.)*

## 4. Declare a tier honestly

§4 defines `full` / `core` / `edge`, and a runtime failing its declared tier's vectors is
in drift and reported to `rapp-god`. Tier is **monotonic** — you may not silently lower it.

Fetch the golden vectors (`rapp_brainstem/parity_vectors/`, mirrored in `rapp-map`), run
them against our `/chat`, and **declare the tier we actually pass** — most likely `core`.
Declaring `core` truthfully beats claiming `full` and drifting. Report the pass/fail per
vector class rather than a summary number.

## 5. Not ours, but report it

`artifact:registry.json` — the spine's own authoritative input — comes back
`integrity: mismatch` against its pin, and 6 sources mismatch overall with 76 unpinned.
That is an ecosystem-level integrity problem in rapp-spine itself, not an openrappter bug.
**Do not fix it and do not touch rapp-spine.** Just report it so Kody can decide.

## 6. Acceptance

1. `curl -s -X POST :18790/chat -d '{"message":"hi"}'` emits all six required keys.
2. No `|||VOICE|||` in `response`; `voice_response` present and correct.
3. Golden vectors run; per-class results reported; a tier declared that we actually pass.
4. `protocol:kody-w/openrappter/entry` resolves to real canonical material.
5. Re-run `crawl.py --remote --full` and show whether openrappter still appears in
   `nonconformant_node_ids`. **That is the acceptance** — the ecosystem's own tool must
   stop flagging us.
6. Grail untouched. Existing behaviour preserved — additive only.
