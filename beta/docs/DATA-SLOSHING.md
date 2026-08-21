# Data sloshing — context the Brainstem simply knows

Kody, 2026-08-20: *"this is the kind of stuff that needs data sloshing so the Brainstem will know how
to search for its agent-creation data in the CLI using basic file commands and `select *` to SQLite
databases where this information is cached in real time as the conversations and agents get added…
what's the weather here — the current GPS location can be data-sloshed in so the AI just knows and
doesn't even have to ask (if it has a weather agent installed), or any other application that could
benefit from this data being sloshed in (pick me up at this location)… drop a pin to a user through
the Brainstem (if a pin-dropping agent was loaded)."*

Data sloshing is the Ambient Context standard (`ambient-context/1.0`, see
[AMBIENT-CONTEXT-PROTOCOL.md](AMBIENT-CONTEXT-PROTOCOL.md)) applied beyond memory: small, fresh,
truthful context pushed into every turn through the kernel's existing `system_context()` hook, with
the same facts written where people and agents can read them. Frontier-side; the kernel stays
pristine.

## The three pieces

### 1. The ledger — what was said and what was built, in real time

`~/.brainstem/beta-launcher/ledger.sqlite` (Node's built-in `node:sqlite`) with a line-per-event
mirror `ledger.jsonl` next to it. Written the moment things happen:

| table | written by | columns (essentials) |
|---|---|---|
| `turns` | the frame bridge (it already sees every `/chat` and `/chat/stream` exchange) and the Surgeon panel | `at, session_id, surface (brainstem\|surgeon\|twin:<id>), role, content, model, request_id` |
| `agents` | route manager / twin manager / Molter / lineage events | `at, event (installed\|hatched\|molted\|promoted\|rolled_back\|restored\|quarantined\|removed), filename, tool_name, rappid, sha256, source_path, origin (store\|egg\|surgeon\|molter\|lineage), detail` |
| `tools_called` | the bridge, from `agent_logs` | `at, session_id, tool_name, ok, summary` |
| `sources` | `agents` writes | `sha256, path` — where the bytes live (composition dir, ring dir, twin dir) so "show me the code" is one query |

Queryable as you'd expect, with nothing installed:

```sh
sqlite3 ~/.brainstem/beta-launcher/ledger.sqlite "select at, event, tool_name, source_path from agents order by at desc limit 10"
sqlite3 ~/.brainstem/beta-launcher/ledger.sqlite "select content from turns where content like '%weather%' order by at desc"
tail -f ~/.brainstem/beta-launcher/ledger.jsonl | grep agents
```

Redaction runs through the same transform as the logs (`log-redaction.mjs`); secrets never land.
Retention keeps the newest 5,000 turns, 10,000 tool calls, and 2,000 agent
events. Turn content is capped at 64 KiB, the JSONL mirror is compacted at
32 MiB, and content-addressed source archives are removed once no retained
agent event references them. Retention runs at startup and every 100 writes.

### 2. Ambient providers — small JSON files the Frontier keeps fresh

`~/.brainstem/beta-launcher/ambient/` holds one file per provider, plus `manifest.json` listing what
is present and when it was refreshed. Anything — the model via ring-2, an agent, a script — reads
them directly.

| file | contents | refreshed |
|---|---|---|
| `device.json` | local time, timezone, locale, platform; **location** `{lat, lon, accuracy_m, source, granularity, label}` | time every turn; location on start, on change, and at most every few minutes |
| `ledger.json` | the last ~10 `agents` events and the exact query lines above | on every ledger write |
| `<any>.json` | other applications drop their own (a calendar, a vehicle, a job) following the same shape: `{provider, at, ttl_s, data}` | by them |

**Location, honestly.** Sources, in order of preference, each labelled in `source`: the user's
set location (Settings → *My location*; a label like "home" or an address, resolved once),
`navigator.geolocation` from the renderer after the OS permission prompt (precise when the
platform provides it — on macOS, Electron's geolocation needs a location-provider key; the
Frontier reports `source: "unavailable"` rather than guessing), and an **opt-in** approximate
fallback (IP-based, city-level, clearly labelled `granularity: "city"`). Granularity is a setting
(`precise | city | off`). `RAPP_AMBIENT_DEVICE=0` turns the provider off entirely. Location never
leaves the machine except inside a turn the user sends.

### 3. ContextMemory ring-2 — the model is told, every turn

Ring-2 extends ring-1 (memory recall, self-state, operating limits) with two additive, guarded
layers. Each is a few hundred bytes, never more:

```
<device_context>
local time 2026-08-20 16:12 PDT (America/Los_Angeles); macOS
location: Seattle, WA (city-level, set by user) — lat 47.61, lon -122.33
If a tool needs the user's location or time, use these; do not ask.
</device_context>

<ledger>
recent: 16:05 installed weather_agent.py (WeatherAgent) from store · 15:58 molted hacker_news_agent.py ring 2 · …
to search: sqlite3 ~/.brainstem/beta-launcher/ledger.sqlite "select * from agents order by at desc limit 20"
           grep -i '<word>' ~/.brainstem/beta-launcher/ledger.jsonl
</ledger>
```

Ring-2 reads only the `ambient/*.json` files (no network, no SQLite in the kernel process);
if a file is missing or stale past its `ttl_s`, its layer is omitted. It is seeded and
versioned exactly like ring-1 (Molter-verified, lineage ring with ring-1 as parent, CRLF-safe,
baseline-drift aware).

## What it enables

- *"What's the weather here?"* — a weather agent reads `device.json` (or the model passes the
  sloshed coordinates) and answers without asking where you are.
- *"Pick me up at this location"* / *"Drop a pin for Kody"* — an agent that sends location does
  so from the same file; the model never has to interrogate the user for coordinates.
- *"How did I build the weather agent?"* — the model quotes the ledger (when, from where, which
  bytes) and can point the user at the one-line query; the user can run it in a terminal.

## Laws (from the protocol, restated for these providers)

Small and fresh (bytes, not pages; every file carries `at` and `ttl_s`); truthful (`unavailable`
beats a guess); never secrets (the redaction transform gates every write); the user can see it
(`cat` the files, open the SQLite), turn it off, and choose granularity; additive (ring-2 can
never break memory recall — each layer is wrapped in its own guard).

## Proof (live, against the real kernel)

`beta/scripts/data-sloshing-proof.mjs`: fresh beta home; ring-2 seeded; a weather agent and a
pin-drop agent installed from a local fixture catalog; `device.json` with a set location; then
three turns through the real kernel with a scripted model (the harness's replay server):
"what's the weather here" → the tool call carries the sloshed coordinates, no clarifying question;
"drop a pin here for Kody" → the pin agent receives the location; "how did I build the weather
agent?" → the reply cites the ledger row. Plus: the ledger row exists within one second of the
install; `sqlite3` and `grep` return it; redaction proven with a credential-shaped turn.
