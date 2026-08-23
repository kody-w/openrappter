# Cartridges — a rapp that runs in a browser, offline, and comes home

A rapplication should not need the Frontier to run. Export it as a **cartridge**, open it in a
bookmarkable web app, and it works — on a phone, on a borrowed laptop, on a plane.

The analogy is the right one: a cartridge holds the whole game. You carry it, you put it in, it
plays. It does not phone anyone for permission first.

## The cartridge is a tile

Nothing new is invented for this. A cartridge **is** a [tile](RAPPID-TILE-PROTOCOL.md) — the
payloads, the footprint, the lineage, the frame key — written to a single file. Export is `tile
pack`; import is verification plus assembly. The Frontier and the browser read the same artifact.

That matters because it makes the round trip trivial rather than a second format to keep in sync.

## Three ways it runs, in falling order of connectivity

| Situation | What happens |
|---|---|
| **Online** | The chant resolves and anything missing streams in from public raw content — [instant transmission](SUMMON-PROTOCOL.md), because nothing is transferred that is already addressed. |
| **Cached** | Previously summoned pieces are already local, so the same resolution completes with no network at all. |
| **Cartridge only** | The file carries what it needs. No lookup, no fetch, no degradation into an error page. |

The design goal is that the third case is **not** a degraded mode. A cartridge that only works
online is not a cartridge, it is a bookmark.

## Two layers, both built on the device

- **The public layer** — what was summoned: the capability as published, identical for everyone who
  resolved the same chant, verifiable against its hashes.
- **The private layer** — what this device accumulated: the frames of actual use, the local signal,
  the wear. It exists only here unless its owner deliberately publishes it.

Both are built and held on the device, and both travel in the cartridge when its owner chooses to
carry them.

## Coming home is a merge, not a restore

Reimporting a cartridge into the Frontier is **not** overwriting anything, and it is not a backup
being restored. The cartridge's frames fold into the tile's stream in key order like any other
dimension ([CRYSTALS](CRYSTALS.md)) — so a rapp used on a phone all week comes home and the desktop
tile simply *knows what happened*, without a conflict to resolve or a version to choose.

"Like nothing happened" is exactly right, and the reason is that as far as the model is concerned
nothing unusual did: one tile was in two places, and now its frames are in one order.

## Sneakernet

Because a cartridge is one verifiable file, handing it to someone on a USB stick is a complete
transfer — capability, provenance and all. It verifies on arrival the same way a summoned tile does,
so trust does not depend on how it travelled. A network is a convenience here, not a prerequisite.

## Summon codes travel too

The seven-word key is small enough to write down, so a person can carry the *ability to fetch*
rather than the bytes: export the codes, and summon them when there is a connection, after which
they are cached and the connection stops mattering. That is the whole point of an address being
computable rather than served.

## What this honestly costs

- **Browser storage is not durable.** A PWA's local data can be evicted, and on iOS it commonly is.
  So the **file is the artifact of record**, and browser storage is a cache in front of it — a
  design that assumed the browser would keep things would lose people's work.
- **No local model in a browser tab, realistically.** The deterministic parts run offline exactly as
  they do in the Frontier; anything that needs the model needs a reachable one. That is the same
  line the command surface already draws, where only `chat.send` crosses.
- **A cartridge is as fresh as its export.** It carries what was true when it was written; coming
  home merges it forward rather than pretending it was current.
- **Installability is the platform's call.** "Add to Home Screen" and background storage behave
  differently across browsers, and the design cannot promise what the platform withholds.

## Status

**Specified, not implemented.** No cartridge export exists, no PWA shell exists, and the browser-side
assembly path is unwritten. What exists to build on: the tile format and its verification, the frame
model that makes reimport a merge rather than a conflict, and deterministic addressing that makes
the online case a resolution rather than a download.
