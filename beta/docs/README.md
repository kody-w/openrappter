# Frontier documentation

Grouped by the question each document answers. Everything here is Frontier — exploratory, under
`beta/`, and not linked from the mainline library ([`../FRONTIER-BOUNDARY.md`](../FRONTIER-BOUNDARY.md)).

Start with the charter (`../CONSTITUTION.md`) and the product direction
(`../GOLDEN_PATH.md`); those two govern everything below, and where a document disagrees with
them, they win.

## How a person uses it

| | |
|---|---|
| [TILE-MANAGEMENT-UX.md](TILE-MANAGEMENT-UX.md) | Tiles, and the four surfaces they live on. Pick one up, put it down — the interaction doctrine. |
| [CRYSTALS.md](CRYSTALS.md) | Why a tile's crystal runs backwards: the newest is largest and mastery wears it to a nub. |
| [VOICE.md](VOICE.md) | Narration, chat voice, and the relay that starts fast and finishes well. |
| [CHAT-STREAMING.md](CHAT-STREAMING.md) | Keeping the stream while fixing how it looks and moves. |
| [STYLE-GUIDE.md](STYLE-GUIDE.md) | The visual language. |

## How an AI drives it

| | |
|---|---|
| [AUTOPILOT-CLI.md](AUTOPILOT-CLI.md) | `rapp-autopilot/1.0` — a CLI interface with no command line, and an API, where one command costs a model call. |
| [UI-AUTOSTEER-PROTOCOL.md](UI-AUTOSTEER-PROTOCOL.md) | `rapp-ui-autosteer/1.0` — scan, inject, drive an embedded app through its own interface. |
| [UI-DRIVER-V2.md](UI-DRIVER-V2.md) | The driver underneath: accurate, bounded, quiet. |
| [RECAP-EXPORT.md](RECAP-EXPORT.md) | What an unattended run leaves behind, and how to publish it by hand. |

## The protocol family

| | |
|---|---|
| [PROTOCOLS.md](PROTOCOLS.md) | Every `rapp-*` protocol, its stage, and how RAPP/1 adopts one without anybody upgrading in step. |
| [SELF-ASSEMBLE-PROTOCOL.md](SELF-ASSEMBLE-PROTOCOL.md) | `rapp-selfassemble/1.0` — what a runtime does with a dropped tile, and what it must refuse. |

## What a capability is, and how it travels

| | |
|---|---|
| [RAPPID-TILE-PROTOCOL.md](RAPPID-TILE-PROTOCOL.md) | `rapp-tile/1.0` — the file a capability travels in. |
| [SUMMON-PROTOCOL.md](SUMMON-PROTOCOL.md) | Subscribe once, resolve deterministically, work offline. The one door outward. |
| [ONE-TIME-SEALS.md](ONE-TIME-SEALS.md) | Local-first preferences that need no setting up, and why nothing syncs. |
| [DIMENSION-MINING.md](DIMENSION-MINING.md) | Racing many possible versions at a goal the machine can check. |
| [QQDRILL-PROTOCOL.md](QQDRILL-PROTOCOL.md) | `rapp-qqdrill/1.0` — the parallel execution engine underneath: how many drills run at once, isolated, and under what budget. |
| *(no document)* `../electron/drill-app.mjs` | The application that drives the drill: a store of plain files, scan, checkpoint-before-fold, restore. Run it with `node beta/scripts/rapp-drill.mjs`. |
| *(no document)* `../../docs/beta/` | The published beta page — the same library running in a browser, at kody-w.github.io/openrappter/beta/ |
| [LOCAL-MODEL-PLAYER.md](LOCAL-MODEL-PLAYER.md) | Making the last paid command local too. |
| [CARTRIDGE-PWA.md](CARTRIDGE-PWA.md) | Exporting a rapp as a cartridge that runs in a browser, offline, and merges back when it comes home. |
| [DIMENSION-TILES.md](DIMENSION-TILES.md) | The shipped herd/arena toggle and the on-disk tile record. |
| [DIMENSION-TILES-V2.md](DIMENSION-TILES-V2.md) | **Superseded** by `rapp-tile/1.0`; kept as the reference for the `.card` format the registry still serves. |

## How the kernel stays intact

| | |
|---|---|
| [MOLT-LINEAGE-PROTOCOL.md](MOLT-LINEAGE-PROTOCOL.md) | `molt-lineage/1.0` — generations, rings, and what may become HEAD. |
| [RAPP-LINEAGE-STANDARD.md](RAPP-LINEAGE-STANDARD.md) | The lineage standard in manual-page form. |
| [GIT-FOR-AGENTS.md](GIT-FOR-AGENTS.md) | Keeping a running Brainstem intact while it changes. |
| [DATA-SLOSHING.md](DATA-SLOSHING.md) | Context the Brainstem simply knows, and where it comes from. |
| [AMBIENT-CONTEXT-PROTOCOL.md](AMBIENT-CONTEXT-PROTOCOL.md) | `ambient-context/1.0` — the providers behind that. |
| [LOG-REDACTION.md](LOG-REDACTION.md) | What never reaches a log or an export. |

## Evidence

| | |
|---|---|
| [RUNTIME-PROOFS.md](RUNTIME-PROOFS.md) | What the runtime was observed to do, not what it should do. |
| [testing/](testing/) | Feature matrix, driver flow, and dated live-proof records. |
| [show-mode/](show-mode/), [twins/](twins/) | Show Mode captures and the twin design. |

## Reading the status markers

Several documents describe conforming behaviour for things that are **specified and not yet
built**, and say so in a status block. Trust the marker over the prose: these are specifications
written in the normative present, not claims about shipped code. Where a document makes a claim
the code does not honour and does not say so, that is a bug in the document — the charter's rule
is that behaviour and the text governing it change in the same commit.
