# The local model player — the last thing that cost money stops needing a service

The command surface already makes navigation free: only `chat.send` reaches a model
([`AUTOPILOT-CLI.md`](AUTOPILOT-CLI.md)). This is the other half — making that one crossing
local too, so the whole product runs with no service in the loop.

The shape is one this system already uses twice: **a self-made player in an iframe, fed by
static data, driven over a declared bus.**

## Which line this belongs to

**This is an openrappter-line capability. It is deliberately not part of the Microsoft downstream's
out-of-the-box experience**, and that is a product decision rather than a sequencing one.

A managed business deployment already has model access: entitlements, governance, and a model the
organisation has chosen and can reason about. Shipping an on-device fallback into that shape adds a
large download, a second model whose behaviour differs from the sanctioned one, and a governance
surface somebody now has to answer for — in exchange for solving a problem that deployment does not
have. "Batteries included" there means the entitlements the org already holds simply work.

The local player solves a different problem, for the line where nobody is entitled to anything: work
from nothing, on any machine, with no service in the loop. That is what openrappter is for, and it is
where this belongs.

Neither line is a lesser version of the other. They are answering different questions, and a
capability that is essential in one can be dead weight in the other.

## Where the data comes from

[`kody-w/rapp-static-apis`](https://github.com/kody-w/rapp-static-apis) specifies
`rapp-static-api/1.0` — an API built entirely from GitHub raw content with no server. Its
shape is the useful part:

| Artifact | What it is |
|---|---|
| `manifest.json` | the hand-edited source of what the API serves |
| `build.py` | the single build step, idempotent |
| `registry.json` | the generated index-of-indexes, so one fetch finds every sub-API |
| `api/v1/*.json` | versioned endpoint files |
| `llms.txt`, `.well-known/` | discovery surfaces written for agents rather than crawlers |

Two properties carry the design. Content is **append-only and content-addressed**, so a URL
carrying a hash never changes meaning and every version stays a pinnable fallback — "pin a
`sha8`, verify before exec". And there is nothing to run: it is CDN-cached static files, which
is exactly why a device with no network but a warm cache is not degraded
([`SUMMON-PROTOCOL.md`](SUMMON-PROTOCOL.md)).

So the model's **manifest** — which runtime, which weight files, their hashes and sizes —
is a static API entry, summonable by the same chant as anything else.

## The player

An iframe at its own origin loads a small player that pulls the runtime and the weights named
by the manifest, verifies them against their hashes, and exposes the same **AgenticDrive** bus
every other embedded app here exposes: origin-checked on both ends, one message name per
direction, every command answered exactly once with the id it was given
([`UI-AUTOSTEER-PROTOCOL.md`](UI-AUTOSTEER-PROTOCOL.md)).

That means the player is drivable by the machinery that already exists, and the Brainstem
kernel gains nothing: this is a client, and the client is the extension point.

## What gets injected: a data object, never bytecode

The player is fed a **declared, validated data object** — the prompt, the parameters, the
sampling settings, the tools in scope — and the player interprets it. It is never handed
opaque bytecode to execute.

This is a real choice with real consequences, and it goes the same way every other choice here
has gone:

- **You can see it move.** A data object can be logged, diffed and inspected at every hop in
  the pipeline, which is precisely what you want when something comes out wrong three stages
  later. Bytecode tells you nothing on the way past.
- **It can be refused before it runs.** A schema-checked object is validated at the boundary and
  rejected with a reason. Fail-closed is not available for a blob you have already handed to an
  interpreter.
- **It declares itself by construction**, satisfying the injection rule without needing a banner
  bolted onto it.
- **It is hashable in a way that means something.** Canonical JSON hashes to a value that
  corresponds to *intent*, so provenance survives a re-encoding.
- **No arbitrary execution.** The same law the command surface already holds: an injected thing
  that can run anything is not a payload, it is a hole.

## The link carries layers, not just tiles

A model layer is bytes with a hash, which is exactly what the
[quantum-link](SUMMON-PROTOCOL.md) resolves. Nothing about the mechanism cares whether the bytes are
a capability or a tensor, so the same addressing that summons a tile summons **a layer** — and that
is what makes a local model practical rather than aspirational.

- **Deduplication across models.** Fine-tunes overwhelmingly share a base. Content-addressed layers
  mean the shared ones resolve to the same address, so summoning a second model fetches only what
  actually differs from the first.
- **Progressive materialisation.** You do not need the whole model before anything can happen.
  Resolve the layers needed to start, begin, and continue resolving underneath — which is what makes
  it feel instant even the first time.
- **The cache becomes the network.** Once a layer is local, every model that shares it resolves with
  no fetch at all, on a machine with no connection.
- **Verification is free.** The hash is the address, so checking what arrived is the same operation
  as finding it.

This is what "bring layers of the AI down locally, instantly" means concretely: not one enormous
transfer, but a lot of small immutable pieces that mostly turn out to be already here.

### What it does not fix

The first resolution of any given layer is still a real download over a real connection — instant
applies to everything after that, and to everything shared with something already local. Layer-level
dedupe also needs publishers to emit layers as separate addressable objects; a monolithic weight
file is one address and dedupes with nothing. And large layers exceed raw file endpoints, so the
manifest points at release assets or chunked sets.

## What this is honestly not

- **Not a small download.** Weights are hundreds of megabytes at best. A raw file endpoint has
  size limits, so the manifest points at release assets or a chunked content-addressed set — and
  either way the first pull is a real download a person has to consent to, named and sized, as
  Article II requires of any organ.
- **Not available everywhere.** Local inference needs a runtime the machine can actually run
  (WebGPU, or a native runtime alongside). A device that cannot run it still *holds* the weights
  and can carry them elsewhere — [holding is not running](CRYSTALS.md).
- **Not the same answers.** A local model is a different model. Where output is compared across
  runs, the model has to be part of what is recorded, or two runs are not comparable.
- **Offline means after the first pull.** Nothing here conjures weights from nothing; it removes
  the *service*, not the download.

## Why it is worth it

When the model is local, the last dependency on anyone else's uptime, pricing and availability
goes away — and every claim this product makes about working from nothing, on any machine, with
a chant, becomes true of the intelligent part too, not just the navigation around it.

## Status

**Specified, not implemented.** Nothing in the tree pulls a model, and no player exists. The
pieces that do exist: the static-API shape to read the manifest from, the AgenticDrive bus the
player would expose, hash-verify-before-exec as the standing posture, and an organ-consent gate
(`probeMediaOrgan`) that is the right pattern for a large first-run download.
