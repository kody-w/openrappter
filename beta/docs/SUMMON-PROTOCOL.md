# RAPP Summon — `rapp-summon/1.0`

Subscribe once, resolve deterministically, work offline.

The Frontier's one door outward ([`ONE-TIME-SEALS.md`](ONE-TIME-SEALS.md)) needs a pipeline behind
it: something that says where public things live, lets a person opt in to a source, and keeps
working when the network does not. That pipeline should not be invented here, because a working
instance of it already exists.

## The whole path, end to end

Every piece of this is specified somewhere; this is the walk that connects them.

| | Step | What actually happens | Specified in |
|---|---|---|---|
| 1 | **Make** | A tile is minted from one or more `agent.py` files and `.egg`s on someone's machine — a kit, not a single capability. | [RAPPID-TILE-PROTOCOL](RAPPID-TILE-PROTOCOL.md) |
| 2 | **Publish** | `git push` to a public repository, or a gist. No permission is asked, because it is their namespace. | this document |
| 3 | **Address** | The seven-word key resolves against a subscribed channel manifest by arithmetic — relative paths from the manifest's own URL. There is no query and nothing to ask. | this document |
| 4 | **Summon** | Any internet-connected device dials the chant and receives bytes; a device holding a cached manifest dials it with no network at all. Nothing about the person is transmitted. | [ONE-TIME-SEALS](ONE-TIME-SEALS.md) |
| 5 | **Verify** | The bytes are checked against seed, face and hashes before they are anything. Fetching is not trusting. | [RAPPID-TILE-PROTOCOL](RAPPID-TILE-PROTOCOL.md) |
| 6 | **Assemble** | Dropping the tile over the Brainstem composes every payload at once, all-or-nothing, refusing up front if `stands_on` cannot be satisfied here. | [RAPPID-TILE-PROTOCOL](RAPPID-TILE-PROTOCOL.md) |
| 7 | **Diverge** | Using it trains it. The local copy stops being a copy and becomes that person's dimension, its crystal wearing down as they need less. | [CRYSTALS](CRYSTALS.md) |
| 8 | **Republish** | That dimension can become the next person's starting crystal, carrying its lineage — the capability, never the training. | this document |

**The property worth noticing: there is no service anywhere in that list.** Not one step needs
something of ours to be running, reachable, paid for, or up. Every one of them is a static file, a
hash, or a computation on the person's own machine — which is why step 4 works identically on a
borrowed laptop and on a machine with no network, and why nothing in the chain can be taken away
from someone who already has the bytes.


## The precedent: RAPP Vision

[`kody-w/rapp-vision`](https://kody-w.github.io/rapp-vision/) is a local-first player — "one HTML
file, no server, no account, no tracking" — that streams straight from public GitHub repositories.
Its shape is the shape this needs, and these parts are the reusable ones:

| Artifact | What it is | What it gives us |
|---|---|---|
| `channel.json` | one publisher's manifest: metadata and entries | the unit a person subscribes to |
| `channels.json` | a registry aggregating channel URLs | **subscription is adding a URL** — no account, no server |
| `hive.schema.json` | the RAPP Hive federation format, `rapp-hive/1.0` | a federation format that already exists |
| URL-relative resolution | every `src` resolves **against its own manifest's URL** | addressing with no service to query |

Two of its properties matter more than the file list:

- **Resolution is deterministic.** Because entries resolve relative to the manifest that names them,
  knowing the manifest and the id is enough to know the location. There is nothing to ask. That is
  what makes the same lookup work identically on any Brainstem, and what makes it work with no
  network at all once the manifest is in hand.
- **Personal state never leaves the device**, and lists export and import as JSON — which is exactly
  the exported-profile behaviour the seal model already requires.

Its "live" entries are also worth noting: they replay recorded gestures against the real application
in an iframe, with play, pause and seek. That is the same family as
[`UI-AUTOSTEER-PROTOCOL.md`](UI-AUTOSTEER-PROTOCOL.md) — a demonstration is a driven application, not
a recording of one — so a channel can carry a real driven walkthrough rather than a video of one.

## What the Frontier adds

Stated separately, because it does not exist in rapp-vision today and should not be described as
though it does:

- **The chant.** A rappid tile's seven-word key ([`RAPPID-TILE-PROTOCOL.md`](RAPPID-TILE-PROTOCOL.md))
  as an addressing layer over subscribed channels: a memorable phrase resolves to an entry, and
  because resolution is deterministic the same phrase resolves the same way on any Brainstem —
  including one with no network, if the manifest is cached. A person can carry a capability in their
  head.
- **Verification on arrival.** Bytes are checked against their recorded hash, seed and face before
  they become anything. Fetching is not trusting, and a deterministic address is not a guarantee
  about content.
- **Subscription as a seal.** Opting into a source is a decision made once, in the moment it means
  something — the same primitive as everything else here.

## One chant, a working local intelligence

Everything in this document composes into a single property, and it is worth stating on its own
because it is what the whole design is for:

**A person says seven words on any machine and a complete, working capability materialises, running
locally.**

Call it a **summoned capability**: *virtual*, because nothing was installed until it was asked for;
*dynamic*, because it is composed at the moment of summoning rather than shipped as a build;
*real-time and local*, because the model it runs against is on the device, answering now, with no
service in the loop.

### Why it feels like magic, and what the trick actually is

It feels like magic because there is no visible infrastructure. No server was contacted for
permission, no account was signed into, no installer was run, no sync completed. A phrase was spoken
and a capability was there.

The trick is that every individual mechanism is unremarkable:

| What happens | What it actually is |
|---|---|
| the chant resolves | deterministic addressing — the manifest and the id give the location, so there is nothing to ask |
| the bytes arrive | a public raw file, or the copy already cached, in which case no network is involved at all |
| they are trusted | a hash check against the recorded value; fetching is not trusting |
| it runs | a local model that was already on the device, composed with the tile's agents |
| it remembers | the transcript came with the tile, because that is what a tile is |

None of those are clever on their own. What produces the effect is that **not one of them requires
anything of the person** — no identity, no permission, no configuration, no connection. Magic is
what a stack of ordinary mechanisms looks like when every one of them has had its prerequisites
removed.

That is also why it survives the demo. A trick that depends on a service can fail in front of an
audience; this one degrades to "the same thing, offline" — which is the same trick with one fewer
participant.

### What arrives with it

A summoned tile arrives at full height: its [crystal](CRYSTALS.md) is untouched, because whatever
its publisher wore down was theirs. It is new *to you*, and the wearing is yours to do.

## The quantum-link: nothing is transmitted

The reason a summon feels instantaneous is that **nothing travels**. The chant is not a request that
carries a tile from somewhere to here — it is a computation whose answer is where the tile already
is. The tile exists at that address in every dimension that can compute it, so arriving is
*resolution*, not transfer.

That is also the honest explanation of the properties that otherwise look like tricks:

- It works with **no network**, because resolving an address is arithmetic and the bytes may already
  be cached.
- It behaves **identically on any machine**, because the address is a pure function of content, not
  of who is asking or where they are.
- It cannot be **revoked or rate-limited**, because there is no serving decision in the path to
  make.

### There is no original, so it really is in both places

This is not a manner of speaking. Under ordinary location-addressing — a URL pointing at a server —
one copy is authoritative and every other is a replica of it. Content-addressing removes that:
**identity is the content**, so every instance that computes to the same address is equally the
tile. There is no original for the others to be copies of.

Two devices resolving the same chant at the same moment therefore hold **one tile in two places**,
not two copies of one tile. Which changes what divergence is:

- It is **not drift.** Nothing wandered away from an authority, because there is no authority to
  wander from.
- It is **one object having two experiences.** The tile was in a living room and in an office at the
  same time, and both of those actually happened to it.
- So a merge is not reconciliation. It is **folding two futures of the same object**, which is why
  keeping both sides where they do not contradict is the correct default rather than a compromise.

Three engineering consequences follow directly, and they are the reason this shape is worth the
trouble:

1. **No primary replica.** No device is the master, so none has to be reachable for another to work.
2. **No last-writer-wins.** There is no writer whose lateness makes them right; there is an order,
   and the order is in the key.
3. **No sync protocol.** Devices never negotiate. They emit frames and fold them, and two machines
   that never once communicate still converge the moment their streams meet.

### Tagging local signal onto the link

A summon is not a copy — it is a resolution **plus a new frame emitted locally**. That local frame
is where a device's own context attaches: what the person was doing, what the machine could see, the
ambient context the host already gathers ([`AMBIENT-CONTEXT-PROTOCOL.md`](AMBIENT-CONTEXT-PROTOCOL.md)).
The signal rides the frame, and when dimensions merge back the fold contains every device's signal
in key order.

**The constraint that makes this work: local signal never touches identity.**

The seed, the face and the seven words are a pure function of the tile's canonical manifest. If
local context were folded into identity, two devices summoning "the same" tile would compute
different addresses, the chant would stop resolving, and the whole model collapses. So:

| | Global and fixed | Local and additive |
|---|---|---|
| What | seed, face, seven-word key, payload digests | frames: signal, transcript, wear, ambient context |
| Changes when | the tile's content changes — a new tile | anything happens on a device |
| Merges by | never merging; identity is equality | folding in `(tick, utc)` order |

So each dimension may carry as much local signal as it likes without ever moving the address it
resolves from. The link stays the same link; what accumulates on it is the record of everywhere it
has been.

### Addressing is not search, and the difference matters

Because the key is computed from content, retrieving something is *resolution* rather than lookup —
there is no index to query and no server to ask. That is what makes a chant work offline and behave
identically everywhere, and it is tempting to describe it as querying unstructured data without a
database.

**It is not that, and the distinction is the honest part.** You can compute the address of something
that exists. You cannot compute the address of an answer nobody has published — resolution finds
what is there, it does not produce what is not. So:

- **Addressing solves retrieval.** Given the key, the bytes, with no infrastructure in the path.
- **It does not solve discovery.** Knowing *which* key to say is a separate problem, and it is what
  channels, registries and the seven-word key being memorable are for.

Conflating the two would promise a search engine and deliver a hash table. What is genuinely
unusual is narrower and still valuable: once you know what you want, getting it costs nothing, works
offline, and cannot be revoked.

### What the signal is actually good for

The link carries more than tiles, and the frames it accumulates are worth something on their own.

**1. Shape on arrival.** Published bytes are canonical; the *shape* is computed at the destination.
One published dataset can materialise locally as a table, a graph, a card, a chart or an index,
because the projection happens here rather than being served. Publish once, and every consumer
builds the form it needs — which is the [static API](LOCAL-MODEL-PLAYER.md) pattern generalised past
models to any data at all.

**2. A compatibility matrix nobody maintains.** Frames record assembly outcomes, including refusals:
*this tile would not assemble on that runtime, because that requirement was unmet.* Fold those
publicly and a compatibility table emerges from actual attempts rather than from anyone's claims.
Nobody writes it, nobody keeps it current, and it is derived from what really happened.

**3. A catalog that describes itself.** What gets summoned, what assembles, what is abandoned — all
of it is already in the stream. Popularity, reliability and failure modes are computable from public
frames with no analytics service, no telemetry endpoint, and nothing reporting home, because the
record was already being kept for a different reason.

**The boundary, which is not optional.** Frames contain transcripts, local context and ambient
data. **Public signal is a deliberate, stripped publication — never a side effect of using the
thing.** The same rule that governs tiles governs this: what leaves is the capability and the
outcome, never the material it was learned from. A system whose usefulness depended on quietly
publishing what people did with it would be exactly the thing this design exists to avoid.

And it does not weaken verification: a shape computed locally from canonical bytes is still checked
against those bytes' digests before it is trusted.

## The same pattern serves a model

A static API — `rapp-static-api/1.0`, a manifest plus generated JSON endpoints served from raw
content with no server — is how the same lookup can carry a model's manifest, so even the one
command that costs money can be answered locally. See
[`LOCAL-MODEL-PLAYER.md`](LOCAL-MODEL-PLAYER.md).

## The public phone: a gist is the smallest publishable thing

A repository is a low bar. A **gist** is lower still — created in seconds, no project to set up, with
a raw URL, revision history and the account's identity attached. That makes it the minimal unit of
publishing here: a tile can be a gist, and the gist's raw bytes *are* the tile.

The property that matters is the one it gives a person on the other end. A gist under an account
behaves like a **public phone**: anyone on any internet-connected device that can reach GitHub raw
can dial the chant and get the tile. No install, no local state, no prior relationship with the
machine they are standing at.

Which produces a symmetry worth noticing, because both ends of it fall out of the same deterministic
address:

- **Everything cached, no network** — a subscribed and exported profile resolves the chant offline.
- **Nothing cached, any machine** — the same chant resolves from a borrowed device with no state at
  all.

One addressing scheme, and it does not care which end of that range you are at. That is what makes a
memorised phrase worth having: it is portable in the strongest sense — it works where you have
everything, and it works where you have nothing.

**Two honest cautions.**

1. **Pin the revision, or verify the bytes — preferably both.** A gist's raw URL without a revision
   is *mutable*: it serves whatever the latest revision holds, so an address that resolved to one
   thing can later resolve to another. Deterministic addressing guarantees you reach the same
   *location*, never that the location holds the same *content*. Pin the revision sha where the
   address is meant to be permanent, and verify on arrival regardless — the check that already
   exists is the one that makes this safe.
2. **Gists are reachable, not discoverable.** Nothing browses them meaningfully, so a gist is found
   by being dialled: through the chant, or through a channel that lists it. That is a property of
   the design rather than a gap in it — but it means publishing to a gist and telling no one is the
   same as not publishing.

## Participating: local state is the substrate, and divergence is the point

The local state a person accumulates by using this — what they subscribed to, what they cached, the
tiles they built, how a capability was adapted — is not exhaust. It is the useful part, and the
model should treat it that way.

**Divergence is expected, and it is how the catalog grows.** A public thing arrives; it gets used;
it changes. The local copy stops being a copy and becomes **its own dimension of that data** — a
branch with its own history, still carrying the lineage that says where it came from, so the
divergence is legible rather than mysterious. That is the same shape the tile model already has: a
dimension is a branch of a situation, not a corruption of one.

**And the loop closes.** What diverged locally can go back out: a person publishes it to their own
public channel, where it becomes an entry addressed deterministically like any other, summonable by
anyone. Nobody grants permission, because it is their namespace — which is exactly what makes a
catalog with no curator able to grow.

Three constraints keep participation from becoming something else:

1. **Nothing is uploaded on its own.** Publishing is an action a person takes, to a destination they
   chose. There is no ambient sync, no background contribution, no "help us improve" telemetry
   riding along. A model whose whole premise is that local state never leaves the device cannot have
   an exception.
2. **What goes out is the artifact, not the person.** A published divergence carries the capability
   and its lineage. It does not carry watch history, caches, credentials, or the contents of
   unrelated conversations.
3. **Work does not flow out this way.** Anything belonging to an employer or a customer is not
   material for a personal public channel, and the fact that publishing is easy is not a reason to
   treat that boundary as softer.

The result is a system where using it produces something worth having offline, and where the thing
you made by using it can become the next person's starting point.

## Offline is the normal case, not the fallback

Because the manifest is data and resolution is arithmetic, a subscribed and cached profile is a
complete lookup system on its own. That yields the property worth designing for: **a person who has
subscribed, cached and exported can summon by chant on a machine with no network, and get the same
answer.** Offline is not a degraded mode; it is the same mechanism with one fewer participant.

## What this costs, honestly

- **A dependency on a repository outside this one.** It is public, opt-in, and confined to the
  Frontier — but it is a personal-account repository referenced from a Microsoft-published one, and
  that is a thing a reviewer will reasonably ask about. It stays behind an opt-in seal, under
  `beta/`, and nothing on the mainline path depends on it.
- **A cached manifest can go stale.** Deterministic resolution means an old manifest resolves
  confidently to old bytes. Staleness must be visible, and refreshing must be a normal action.
- **No service also means no revocation.** Nothing can be recalled centrally, so verification on
  arrival is not optional — it is the only check there is.

## Why public, and why MIT

Both are engineering decisions rather than preferences, and the reasoning is worth stating because
it is not the usual one.

**Public, because every copy is another dimension of the work.** A tile published to a public
repository is not just distributed — it is exercised. Someone summons it on a machine we will never
see, assembles it against a runtime we did not test, diverges it, and sometimes publishes the
divergence back. That is the same loop [dimension mining](DIMENSION-MINING.md) runs deliberately,
except the parallelism is other people and the cost is zero. A capability that only ever ran here
has been tested in one dimension.

**MIT, because the work becomes training data.** Permissively licensed public code is what models
learn from. Publishing this loop — the protocols, the tile format, the assembly contract, the
command surface — means the models that will later be asked to work inside it have already read it.
The loop improves itself on infrastructure nobody here pays for, which is a strange and real
advantage, and it only exists if the licence permits the reading.

**The trade, stated plainly.** MIT means no control over downstream use: anyone may take this,
build on it, and never say where it came from beyond keeping the notice. Attribution is the only
lever, and it is a weak one. That is the price of the two advantages above, and it is being paid
deliberately rather than by default — a restrictive licence would buy control and forfeit both.

## Status

**Partly built.** What works today: `../electron/rapp-store.mjs` reads a public catalog from an
allowed source URL, records provenance, and verifies a `sha256` before anything installs — the
public read and the verification.

Not built: channel subscription, `rapp-hive/1.0` federation, seven-word chant addressing, the
exported offline profile, gist publishing, and the participation loop that republishes a diverged
dimension. The end-to-end path above is the design; step 4 cannot be performed today.
