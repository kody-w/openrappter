# rapplication twins in the herd — design

> Status: agreed direction (2026-08-18). P0 (store client), P1 (twin runtime +
> herd tile + hatch tool), and P2 (the Copilot Studio deploy twin) landed and
> verified live up to the user-owned PAC-auth boundary. Scout + Cowork twins
> next. Builds on the multi-chat herd (PR #175).
>
> **On-canon.** Checked against the RAPP spine (`kody-w/rapp-spine`) — see
> [`COMPLIANCE.md`](COMPLIANCE.md). A herd of twins uses one coordinator for
> many Brainstem workers; its canonical wire is
> **`rapp-fleet-chat/1.0`** (signed twin-chat over `/chat`), the shippable unit
> is the cartridge **`rapp-cart/1.0`**, and per Art. XXV **chat is the only
> wire** — twins add **no new route**.

## The idea, in one paragraph

The Brain Surgeon (GitHub Copilot) is the **builder** — it builds and tests
capabilities *on* the Brainstem, and it should stay lean. Long-running
**specialized** jobs (deploy this proven agent to Copilot Studio; push it to the
on-device Scout endpoint; wrap it as a Microsoft Cowork agent) are **not** handed
to the Surgeon — they are handed to a **rapplication twin**: a self-contained
rapplication that **hatches as its own Brainstem worker on its own loopback
port**, runs its specialized loop **autonomously, driven by the Brainstem** (not
the Surgeon), and appears as its own **tile in the herd** beside the Brainstem
chat. The user never has to know this happened — the Brainstem + Brain Surgeon
loop decides what's needed, pulls the right rapplication **from the RAPP Store**,
and hatches it. The user just watches it happen.

```
        ┌──────────────── the herd ────────────────────────────────┐
        │  ▢ Brain Surgeon chat   (builds on the Brainstem)          │
        │  ▢ Brain Surgeon chat   (a second build, in parallel)      │
        │  ◈ Copilot-Studio twin  own port · own loop · deploying →  │   ← NEW tile kind
        │       └ its own chat: self-drives, but anyone can steer     │
        │  ◈ Scout twin           own port · own loop · registering  │
        └───────────────────────────────────────────────────────────┘
                    all beside the one visible Brainstem
```

## Why not just more Brain Surgeon chats

Multi-chat (PR #175) already gives N Copilot chats. But a deploy job is not a
"chat" — it is a long-running, tool-heavy, tenant-touching loop that would
"overshell" the Surgeon and confuse its context. A twin is a **different tile
kind**: its own process/port, its own specialized agents, and an autonomous loop
that *self-drives*. The Surgeon *decides and hands off*; the twin *does the job*.

**A twin still has its own chat.** It is, after all, a real Brainstem worker
speaking `/chat` on its own port — so its tile keeps a composer, and **anyone can
message it at any time**: the person, to steer or correct it mid-flight; the
Brainstem/Surgeon, to hand it work or ask for status. The difference from a
Surgeon chat is not "no chat" — it is *who drives by default*: a twin drives
itself on its loop and only takes messages when someone chooses to steer, whereas
a Surgeon chat only moves when a person prompts it.

## What a rapplication is (grounded in the RAPP Store)

Source of truth: `https://kody-w.github.io/RAPP_Store/index.json`
(schema, `install_protocol`, `rapplications[]`, `senses[]`,
`gated_rapplications_note`). Each rapplication entry carries, verbatim:

```
id, name, version, summary, tagline, category, tags, manifest_name,
singleton_filename, singleton_url, singleton_sha256, singleton_lines,
singleton_bytes, egg_url, egg_note, produced_by, metrics, example_call,
license, spec_post, shipped_in_commit, publisher, ui_url, ui_filename,
quality_tier
```

So a rapplication is, in the user's words, **a twin running independently with a
specialized set of agents *and* a specialized UI for its use case**. Concretely:

- **specialized agent(s)** — a **sha256-pinned single-file `*_agent.py`**
  (`singleton_url`), optionally with pre-populated state **`.egg`** (`egg_url`);
- **its own UI** — a use-case-specific frontend (`ui_url` / `ui_filename`); all
  22 store entries ship one.

That maps 1:1 onto the beta's worker/egg model: fetch the singleton, verify the
hash, compose it into an isolated worker on its own port, seed the egg, run —
**and render the rapplication's own `ui_url` as the twin's tile**, bound to that
worker's port. So a twin tile is not a generic chat log; it is *the
rapplication's own specialized UI* (which includes its steerable chat), running
live against the twin's worker. Where an entry ships no usable UI, the tile falls
back to a plain chat over the worker's `/chat`.

## How it lands on the beta's existing seams

| Vision word | Existing beta mechanism |
|---|---|
| "own port / twin / brainstem loop" | `BetaRouteManager.startWorker(descriptor)` already allocates a loopback port and spawns a `BrainstemProcess` with a composed `AGENTS_PATH` (`route-manager.mjs:806`) |
| "hatch a rapplication" | insert its **`rapp-cart/1.0`** cartridge (the store's `singleton_url` `agent.py` + optional `egg_url` `.egg`): fetch → verify `singleton_sha256` → `packageAgent` (RAPPID + egg, `:486`) → start a **dedicated, non-retired** worker. Ports/twins stay under the hood, per the cartridge contract |
| "driven by the Brainstem, not the Surgeon" | the twin worker's own `/chat` loop drives the job; the Brainstem coordinates the fleet via **`rapp-fleet-chat/1.0`** (signed twin-chat over `/chat`) — never an injected `/api/agent` route (the known RCE); the Surgeon only calls `hatch_rapplication(store_id)` and hands off |
| "clone, diverge, reassimilate" twin story | already described in `GOLDEN_PATH.md` — a twin is a minted child RAPPID + its own snapshot |
| "pull from the store autonomously" | the RAPP Store client (this PR's foundation) + a `hatch_rapplication` Surgeon tool |
| "specialized UI per use case" | the tile renders the rapplication's own `ui_url` (from the store entry) bound to the twin's worker port — its use-case UI, not a generic chat |
| "beside the Brainstem chat" | a new twin-tile kind in the herd (PR #175's grid) — the rapplication's UI + a steerable chat, bound to the twin's own worker port, showing its live loop and accepting human/AI messages |

**Key architectural note:** `startWorker` today lives inside the *single active
composition* model (one live worker; superseded workers are retired). Twins need
**several concurrent, long-lived workers**. So the twin layer adds a parallel
**twin registry** that keeps N twin workers alive independently of the active
route — it reuses `startWorker`/`packageAgent`/port allocation but **not** the
retire-on-activate lifecycle. The kernel is still unchanged; twins are ordinary
Brainstem workers with ordinary `*_agent.py` compositions.

## The autonomy / consent boundary (agreed)

Everything is silent **up to the irreducible user-owned auth moment**, then one
visible step:

- silent: decide need → pull from store → verify hash → hatch twin → build /
  plan / parity on the twin's own loop;
- visible, once: the user-owned auth the job cannot proceed without — e.g. the
  **PAC device-login code** for the target Power Platform environment;
- Copilot Studio stays **Draft-only** (constitution): publish remains the user's
  manual action in the linked UI. Secrets are never read into chat/logs.

A twin that finds a valid existing PAC profile / authenticated Scout endpoint
proceeds fully silently. A twin blocked on auth surfaces exactly the device
prompt and nothing else.

## First twin (agreed): Copilot Studio auto-deploy

Reuses the beta's existing Frontier deploy agents
(`RappCopilotStudioFactoryBeta`, `CopilotStudioDeployBeta`, Draft-only markers)
— but runs them **on the twin's own worker loop** instead of through the Surgeon:

```
hatch cs-deploy twin (own port)
  → twin loop: doctor → plan → build → provision
     → [visible: PAC device login, once, if needed]
     → push (Draft) → parity → finalize
  → emit a Copilot Studio Draft link tile back into the Brainstem/herd
  → user watches; publishing stays their manual action
```

## Phasing

- **P0 — foundation (DONE):** RAPP Store client — fetch `index.json`, expose
  the catalog, resolve an id → its sha256-pinned singleton (+ egg), verify the
  hash on download. Auth-free, unit-tested, verified against the live 22 entries.
- **P1 — twin runtime + tile (DONE):** a twin registry that hatches a rapplication into
  a concurrent long-lived worker on its own port; a twin-tile kind in the herd
  (renders the rapplication's own `ui_url` bound to the worker port; status,
  port, live loop log, **and its own chat composer** so the person or the
  Brainstem/Surgeon can steer it at any time); a `hatch_rapplication(store_id)`
  Surgeon tool; prove the plumbing end-to-end with a benign store rapplication
  (hatch → own port → loop → tile → steer via chat → report), no auth.
- **P2 — the Copilot Studio deploy twin (DONE up to auth boundary):** the
  Factory + Deploy agents run on their OWN twin worker (`hatchLocal`), driven by
  an async deploy loop (`deploy_to_copilot_studio` Surgeon tool) so the main
  chat stays free; it pauses at the one user-owned PAC device-login step and is
  Draft-only. Verified live: the twin ran the Factory doctor on its own port and
  reached "PAC authenticated, ready to deploy". Scout + Cowork twins next.

## Invariants

- `rapp_brainstem/brainstem.py` unchanged; twins are ordinary workers.
- **Chat is the only wire** (Art. XXV): twins are driven only over `/chat`; the
  fleet wire is `rapp-fleet-chat/1.0` (signed twin-chat); **no new route**, never
  an `/api/agent`-style route (the known unauthenticated RCE).
- Twin workers are **loopback-only** on their own `:7072+` ports; privileged
  surfaces stay loopback-or-local-token (`rapp-kernel-boundary/1.0`).
- The shippable unit is the **`rapp-cart/1.0`** cartridge (`agent.py` or `.egg`).
- **RAPPID** is mint-once (`rapp/1` §6.2), not name-derived; read every legacy
  form, emit only canonical, join on the hash, never rewrite identity in place.
- **License**: honor each rapplication's own `license` (MIT / Apache-2.0 /
  BSD-style / ARR / PolyForm-NC all appear in the store) — never assume MIT.
- The Surgeon is not the deploy engine — it decides and hands off.
- Store downloads are sha256-verified before they ever run.
- Autonomous up to user-owned auth; Copilot Studio Draft-only; no secrets in
  chat/logs.
- Gated (`access: private`) rapplications are honored (auth-prompt), not bypassed.
- A twin is self-driving but never a black box: its tile stays chat-interactive
  so the person can steer or stop it at any moment.
- Re-crawl the spine before each twin PR (see `COMPLIANCE.md`).


## The twin tile: multiplayer chat small, full UI on pop-out (final)

The herd twin tile is a **live multiplayer chat/work-log** over the twin's
`/chat` — the Brainstem's autonomous loop, the Brain Surgeon, and the user all
talking to the same rapplication in one transcript as it unfolds (each turn
labeled by who sent it), with a composer to steer. It renders in the host's own
DOM (always reliable) and looks like the Brain Surgeon chat. **⤢ App** pops out
the full, specialized custom rapplication UI (the twin's own `ui_url`
document.write'd into a top-level window — which renders perfectly). Both drive
the same `/chat`; the small view is the lighter always-on surface, the pop-out
is the comprehensive customer UI. (An earlier attempt to inject the custom UI
into the inline tile iframe hit an inconsistent subframe render; the chat-log +
pop-out split is the durable answer.)
