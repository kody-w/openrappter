# Rappid dimension tiles — the `.card` file (`rar-card/2.0`)

> **Superseded.** `rar-card/2.0` is superseded by **`rapp-tile/1.0`** — see
> [RAPPID-TILE-PROTOCOL.md](RAPPID-TILE-PROTOCOL.md). Cards stay readable forever and migrate
> losslessly (same seed, same face, same seven-word key); tiles add the footprint a rappid needs to
> stand on (`stands_on`), an explicit primary payload with resources, and lineage. This document
> remains the reference for the card format the registry still serves. The vocabulary shift is
> total: cards on a table became tiles in an arena — see the protocol's *metaphor shift* section.

Direction: tiles must be globally scannable through GitHub raw URLs — a tile
uploaded to the registry can be retrieved for a task from the public repo, as the online form of a
local dimension tile. This is the next version of the registry's card spec: the registry is updated,
the legacy cards are migrated, and the Frontier client proves interchange on-device and off. The file
type must be simple and iconic, as friendly as `agent.py` and `.egg` files — a sleeve you can put an
`agent.py` or an `.egg` into for safekeeping.

**Name.** The human-facing name
is **rappid tile**; the term *dimension tile* is retired with this document — `dimension` survives
only as the local-only conversation field inside a tile. The file extension `.card`, the schema id
`rar-card/2.0`, and the SDK verb `card` are protocol surface and stay as they are.

## The decision: one JSON object, extension `.card`

A card is **one UTF-8 JSON file, one object, newline-terminated, extension `.card`**, schema
`rar-card/2.0`. Not a new container format.

## The offline path

The tile is the **vehicle** for an `agent.py` or a RAPP/1 `.egg`: the face, the deterministic
identity, the integrity proof, the portable payload, and the optional local dimension are one object.
The visual tile is not a screenshot of, or a link to, the real artifact — the `.card` file **is** the
artifact a person keeps.

The acceptance story is the **offline path**:

1. Two devices have no network.
2. One holds a saved tile; the other needs its capability.
3. The tile crosses by any local file transport.
4. The receiver recomputes the seed and face and verifies every payload hash without fetching a
   repository.
5. The receiver unsleeves the exact `agent.py`, or verifies and hatches the exact `.egg`.
6. Any new conversation enters only the receiver's local `dimension`.
7. Publishing later is an explicit export that strips the local dimension.

**Therefore an offline-ready tile carries every required payload inline.** A revision-pinned URL is
a valid compact registry form, but it does not pass the offline path unless the pinned bytes are
already in the local content-addressed cache; a reader never calls a pinned-only tile
"offline ready". This is the acceptance contract; the deliverable unit today is the self-contained,
locally verifiable file.

Why this and not a zip, a Markdown page, or a single-file HTML:

- **RAR's cards are already JSON.** Every entry of `cards/holo_cards.json` is a card face. v2 is a
  superset of v1 — the migration is mechanical and lossless, and v1 readers keep working on the
  `face` block.
- **Everything parses it.** `rapp_sdk.py`, the Frontier, `jq`, a phone that scanned a QR. No
  unpacking step, no base64 envelope around the whole thing, no renderer required to read it.
- **It streams off `raw.githubusercontent.com`** and diffs on GitHub exactly like `agent.py`.
- **"Iconic" is the extension and the face**, which every client renders the same way from the
  same seed; it is not a property of the bytes. "Sealed like an `.egg`" is the hashes inside.
- A zip hides the contents; an HTML card is active content from a stranger; Markdown front matter
  is two parsers. JSON is one.

## The file name: the sleeve says what is inside

A card's file name is **the sleeved artifact's file name plus `.card`**, the way `.tar.gz` stacks:

| Holds | File name |
|---|---|
| `bookfactory_agent.py` | `bookfactory_agent.py.card` |
| `bookfactory.egg` (which may itself hold several agent files) | `bookfactory.egg.card` |
| a face only (no payload; a v1 card in v2 clothing) | `<slug>.card` |

Rules: one **primary** payload per card (`payload[0]`), and its `filename` decides the card's name;
`card pack x_agent.py` writes `x_agent.py.card` beside it; `card unpack x_agent.py.card` restores
`x_agent.py` (and verifies it first); a reader refuses a card whose name and primary payload disagree.
In RAR the migrated cards live at `cards/v2/@publisher/<agent filename>.card`
(e.g. `cards/v2/@aibast-agents-library/account_intelligence_agent.py.card`) and `scan.url` points
at exactly that path.

## What is in a card

```json
{
  "schema": "rar-card/2.0",
  "id": "@kody-w/book_factory",
  "seed": 13467203979104256843,
  "name_seed": 3136112411,
  "seven_word_key": "TWIST MOLD BEQUEST VALOR LEFT ORBIT RUNE",
  "version": "1.2.0",
  "face": { "…every v1 holo-card field, unchanged: name, title, type_line, colors, hp, stats, abilities, rarity, evolution, avatar_svg…" },
  "manifest": { "schema": "…", "name": "@kody-w/book_factory", "display_name": "BookFactory", "description": "…", "author": "…", "tags": [], "category": "creative", "quality_tier": "community" },
  "payload": [
    { "kind": "agent.py", "filename": "bookfactory_agent.py", "sha256_lf_v1": "1224fe87e3cf…", "inline": "…source…" },
    { "kind": "egg", "filename": "bookfactory.egg", "sha256": "…", "url": "https://raw.githubusercontent.com/kody-w/RAR/<rev>/agents/@kody-w/bookfactory.egg" }
  ],
  "state": "dormant",
  "origin": { "kind": "frontier", "brainstem": "rappid:…", "twin": null, "parkedAt": "2026-08-20T18:44:00Z" },
  "dimension": null,
  "scan": { "url": "https://raw.githubusercontent.com/kody-w/RAR/main/cards/v2/@kody-w/bookfactory_agent.py.card", "qr": "<svg…>" },
  "provenance": { "minted_by": "rapp_sdk 2.0 | frontier 0.6.x", "rar_revision": "e47755fa…" },
  "signature": null
}
```

Rules that make it simple:

| Rule | Meaning |
|---|---|
| **The seed is the identity.** | `seed` = `forge_seed(manifest)`; `face` = `resolve_card_from_seed(seed)`; `seven_word_key` = `seed_to_words(seed)`. A reader may recompute all three and must refuse a card whose `face` disagrees with its `seed`. |
| **Payload items are inline OR pinned, always hashed.** | `inline` carries the bytes (UTF-8 text for `agent.py`; base64 for `egg`); `url` is a revision-pinned raw GitHub URL. Either way `sha256_lf_v1` (text) or `sha256` (binary) is mandatory and verified before anything runs. Inline when the card travels or must work offline; pinned when it lives in RAR and compact online resolution is acceptable. |
| **The sleeve holds agents and eggs only.** | `kind` ∈ `agent.py` · `egg`. A card with an empty payload is a face-only card (v1 in v2 clothing). |
| **State is a word.** | `dormant` (in a registry or on disk, no process) · `active` (in a herd: a live twin or a parked conversation). The same card moves between the two without changing identity. |
| **The dimension stays home.** | `dimension` (a conversation: turns, history) is `null` in anything published; it exists only in the local binder copy unless the user exports it explicitly, and then it is its own choice on the export panel. The global RAPPID protocol tracks identity and lineage; it does not require uploading the private dimension. |
| **Scannable means a URL.** | `scan.url` is the card's public raw URL; the QR on the face encodes it (or `rar://@publisher/slug@<seed>` for offline resolution). Retrieve = fetch → verify hashes → recompute the seed → hatch the payload as a twin, or wake the dimension. |
| **Small.** | ≤ 1 MiB with inline payload; larger payloads must be pinned. |

## RAR v2 — what changes in `kody-w/RAR`

1. `spec/rar-card-v2.md` (this contract, in the repo's voice) and `schema/rar-card-2.0.json`.
2. `scripts/migrate_cards_v2.py`: for every v1 entry in `cards/holo_cards.json` write
   `cards/v2/@publisher/<agent filename>.card` with `face` = the v1 entry, `payload` = the registry's agent file
   **pinned** (url + `sha256-lf-v1` from `registry.json`), `state: "dormant"`, `scan.url` set.
   Keep `holo_cards.json` as the v1 index; add `cards/v2/index.json` (id → seed, sha, url).
3. `rapp_sdk.py`: `card pack <agent.py> [--egg …] [--inline]` · `card unpack <x.card>` ·
   `card scan <url|seven-word-key|seed>` (fetch/resolve → verify → print the face and the payload
   hashes) · `card verify <x.card>`. `mint_card` gains `to_v2()`.
4. The site renders v2 cards from `cards/v2/` with the QR; `api.json` gains `cards_v2`.
5. Tests: v1 → v2 → v1 round-trip keeps every face byte; seed recomputation over the whole index;
   a tampered payload hash is refused; a card whose face disagrees with its seed is refused.

## Frontier — what changes here

1. `beta/electron/rar-card.mjs` (already ordered): the JS port of seed/face/seven-word key, plus
   `packCard` / `unpackCard` / `verifyCard` for `rar-card/2.0`.
2. A dimension tile on disk **is** a `.card` (`~/.brainstem/beta-launcher/tiles/<payload filename>.card`, or `<id>.card` for a conversation with no agent) with
   `state: "active"` and a local `dimension`; *Export to RAR* writes the public form (payload
   inline or pinned, `dimension: null`, `state: "dormant"`) and shows those exact bytes first.
3. **Retrieve**: paste a raw URL, a seed, or seven words into the Store picker (or scan a QR from the
   phone companion later): fetch → verify → the card appears dormant in the herd; *◈ Hatch* makes
   it active.
4. **Interchange proof** (local-first): pack a card from a live twin → unpack on a second isolated
   Frontier home → byte-identical payload and face; publish-form round trip through a fixture "RAR"
   served from a local directory (no network) and through the real raw URL when online; a
   tampered hash is refused; the dimension block never appears in the public form.

## Migration of the legacy cards

Every v1 face becomes a v2 card with a pinned payload — nothing is re-minted, so seeds and
seven-word keys do not change; anyone holding seven words still gets the same card. The v1 index stays
until every client reads v2, then it is frozen, never deleted.

## Who does what

RAR changes land as a pull request prepared in a clone of the upstream RAR repository and are merged
by its maintainer. Frontier changes ride the working branch behind the same gates as everything else.
