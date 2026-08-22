# Twins — RAPP canon compliance (crawled the spine)

> Source of truth: the RAPP **spine** (`kody-w/rapp-spine`, `rapp-spine/1.1`) —
> the situational router over the ~33 load-bearing protocols. Crawled
> 2026-08-18 to keep the twin/herd/rapplication work on-canon and catch drift
> before P1. Re-crawl before each twin PR: `python crawl.py --collisions` and
> `python crawl.py --plan "<situation>"`.

## The fleet topology we implement

The spine describes two distinct fleet topologies that must not be conflated:

- **(A) External coordination:** one coordinator manages many Brainstem workers.
  This is the Frontier herd of twins.
- **(B) Distributed single runtime:** one operator owns one runtime distributed
  across several estates. This is not the Frontier topology.

A herd where Brainstem and Rappter Surgeon drive several twin workers implements
topology A.

The Good AI Neighbor contract adds the device-level boundary: every top-level
coordinator is its own Electron estate and Dock creature. An estate may host
multiple neighborhoods and herd any resident twin it owns. Separate estates
collaborate over attributed `/chat`; they never merge mutable ownership merely
because they share a device.

## The rules we must not drift from (with citations)

| # | Canon rule (spec) | What it means for twins |
|---|---|---|
| 1 | **Chat is the only wire** — `POST /chat` is the *only* sanctioned channel for capability (`CONSTITUTION` Art. XXV; `rapp-kernel-boundary/1.0` §2). | A twin is driven **only** over its worker's `/chat`. We never invent a route. |
| 2 | **Canonical fleet wire = `rapp-fleet-chat/1.0`** — one coordinator → many workers via **signed twin-chat events over `/chat`**. The legacy injected `POST /api/agent/<name>` is a **known unauthenticated fleet-wide RCE** and is deprecated. | When the Brainstem drives a twin fleet, it uses signed twin-chat over each twin's `/chat`. We **never** add an `/api/agent`-style route. |
| 3 | **No new privileged route** — a *new capability* MUST NOT introduce a new privileged route; privileged routes are **loopback-only or local-token** (`rapp-kernel-boundary/1.0` §3–§5). | Twins are ordinary Brainstem workers bound to **127.0.0.1** on their own port; the kernel is unchanged; no new route is added anywhere. |
| 4 | **The single shippable unit is the cartridge `rapp-cart/1.0`** — "if it's an `agent.py` or an `.egg`: insert → boot → run → eject; everything else (ports, twins, registry) stays under the hood." | Hatching a rapplication = inserting its cartridge (the store's `singleton_url` `agent.py` + optional `egg_url` `.egg`). Ports/twins stay under the hood — exactly the user-invisible model we agreed. |
| 5 | **Static-API discovery = `rapp-static-api/1.0`** (MIT); the RAPP Store is a static API. `RAPP_Hub` is **archived** — the live path is **RAR + RAPP_Store**. | The store client does read-only GETs against `RAPP_Store/index.json`. We use the store, never the archived hub. |
| 6 | **RAPPID = `rapp/1` §6**: mint-once (§6.2), tail **not** derived from owner/slug/name; **read every legacy form, emit only canonical `rappid:@owner/slug:64hex`, join on the hash, never rewrite identity in place.** | `BetaRouteManager.packageAgent` mints via a UUID anchor (`Hb("rapp/1:rappid", uuidBytes)`) — mint-once, not name-derived → §6.2-compliant. Twins inherit this unchanged. |
| 7 | **Per-repo license, never assume MIT** — the cluster mixes MIT, Apache-2.0, BSD-style, source-available ARR (`kody-w/RAPP`, `rappterbox`), and PolyForm-NC + trademarked marks (`rapp-moment`). | The store client now surfaces each entry's `license`. Live proof: the 22 rapplications span MIT (9), Apache-2.0 (6), BSD-style (5), none (2). A twin/consumer honors the entry's own terms. |
| 8 | **Ports**: `~/.brainstem` binds `127.0.0.1:7071`; project-local uses `:7072+`; the three 7071 installers can't coexist. | Twin workers take their own allocated loopback ports (`allocatePort`), never fighting `:7071`. |
| 9 | **Sealing / secrets**: private data rides sealed; secrets are never read into chat/logs (`rapp-sealed/1.0`; kernel boundary §1). Gated (`access: private`) store entries need a read-scoped token. | The store client surfaces gating as an auth-needed error (never a silent miss). Deploy twins keep the agreed boundary: silent up to the one user-owned auth step (PAC device login), Copilot Studio **Draft-only**, no secrets in chat/logs. |

## Verified against our current code

- **Store client (`rapp-store.mjs`)** — read-only GETs on a `rapp-static-api/1.0`
  surface; sha256-verifies every download before it can run; honors gating;
  surfaces `license`, `egg_url`, and the specialized `ui_url`. ✓
- **Twins as isolated loopback workers on their own ports** — matches the kernel
  trust boundary (loopback-only) and the port-collision rule. ✓
- **Kernel unchanged; twins driven over `/chat`; no new privileged route.** ✓
- **RAPPID mint-once via UUID anchor** (`route-manager.mjs` `packageAgent`). ✓

## Copilot Studio deploy twin (P2) — conformance

The CS-deploy twin composes the bundled `RappCopilotStudioFactoryBeta` +
`CopilotStudioDeployBeta` agents (unchanged, Draft-only markers) into an
isolated worker and drives them over **/chat** (no new route) — the deploy
engine is unchanged; only WHERE it runs (a twin) and WHO drives it (an async
twin loop, not the visible Brainstem). It stays **Draft-only**, surfaces the one
user-owned **PAC device-login** step and pauses there, and never reads/echoes a
client secret. Same invariants as every twin: loopback-only, cartridge unit,
mint-once RAPPID, honor license.

## Tracked drift (open, low-urgency — do not silently re-home)

1. **RAPP/1 pin lag.** `beta/electron/rapp-protocol.mjs` pins
   `SOURCE_COMMIT = d2cd5abe…` ("§3: rappid is mint-once"). The canonical
   `rapp/1 §6` authority pin (per `rapp-map/RAPP1_AUTHORITY.json`, via the spine)
   is `6723c7add2…` — **ahead by exactly 1 commit** ("Estate drift steamroll
   2026-07-16"). The beta already carries the mint-once fix, so behavior is
   §6.2-conformant; only the pin lags. Bumping `SOURCE_COMMIT` requires
   re-validating `tests/rapp-protocol.test.mjs` conformance vectors → its own
   follow-up, not the twins PR.
2. **Kernel `0.0.0.0` bind (upstream, not ours).** `rapp-kernel-boundary/1.0` §0
   flags the grail's own `app.run(host="0.0.0.0")` as an open RCE pending R1.
   Our workers are launched loopback-only by the launcher; we neither rely on
   nor widen that bind. Purely upstream; noted so we never lean on `0.0.0.0`.

## Re-crawl checklist (before each twin PR)

```bash
git clone --depth 1 https://github.com/kody-w/rapp-spine    # or refresh
python crawl.py --collisions                                  # did a new collision land?
python crawl.py --plan "drive my local brainstems as one fleet"
python crawl.py "package one capability for a non-technical user"   # → rapp-cart/1.0
# then re-check the table above still holds.
```
