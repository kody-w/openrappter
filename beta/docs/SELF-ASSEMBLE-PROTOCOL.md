# RAPP Self-Assemble — `rapp-selfassemble/1.0`

What happens when a tile is dropped over a Brainstem. The [tile format](RAPPID-TILE-PROTOCOL.md)
says what a tile *is*; this says what a runtime *does* with one, and what it must refuse.

**A tile is not hatched. It assembles itself**, from parts it declares, into a runtime that has
agreed it can hold them.

## The sequence

1. **Read the footprint.** `stands_on` names what every executable payload needs: the kernel
   contract, the interpreter, the tools, and the protocol versions the tile expects.
2. **Check it against this runtime.** The runtime publishes what it supports
   ([`PROTOCOLS.md`](PROTOCOLS.md)). The check is an intersection, and it happens **before**
   anything is written or run.
3. **Refuse, or proceed.** An unsatisfiable footprint stops here and names both the missing
   requirement and the payload that wanted it. Nothing has been consumed, so refusing costs
   nothing — which is the entire advantage of assembly over hatching.
4. **Compose, in declared order.** Primary first, then each `agent` payload in manifest order,
   deterministically, producing the same composition hash on every machine.
5. **Restore the situation.** The transcript, then the tile's own UI if it carries one.
6. **Report what assembled**, as data: which payloads, in what order, at what composition hash.

## Assembling from a chain of summons

A tile does not have to carry its payloads. It can carry **a chain of chants** — an ordered list of
seven-word keys plus how to compose what they resolve to — and assemble itself by resolving each
link in turn.

That makes a rapplication something you can write down rather than something you have to ship. The
tile is small enough to memorise the important part of, and the bytes arrive by
[resolution](SUMMON-PROTOCOL.md) rather than by being carried.

**The local private layer chooses the chain.** Which links, in which order, with which parameters is
a function of what this device knows — the person's own material, never transmitted. Two people
running the same recipe against different private data assemble different rapplications, and neither
one's data went anywhere.

### The rules a chain needs

1. **Every link is verified, not just the first.** A chain is a sequence of fetches, and each one
   is checked against its recorded hashes before it is composed. A trusted first link does not
   vouch for the rest.
2. **Chains terminate.** A link may itself resolve to a chain, which is what makes this compose —
   and also what makes it capable of looping. Cycles are detected against the set of keys already
   resolved, and depth is bounded, with a refusal that names the cycle rather than a stack overflow.
3. **Availability is the weakest link.** A chain assembles offline only if *every* link is cached.
   Partial availability is a refusal with the missing chant named, never a partial assembly —
   all-or-nothing applies across the chain exactly as it applies across payloads.
4. **The same chain and the same private data assemble the same thing.** Resolution is
   deterministic and composition order is declared, so the composition hash is reproducible. A chain
   that assembled differently on two machines would be a defect, not flexibility.

### The stronger form: a declared shape, filled locally

There are two ways private material can take part, and the second is better.

**Weaker:** private data *chooses the chain* — which links, in what order. The capability then
differs per person, and with it the composition hash, so two people running "the same" recipe do not
have the same thing and reproducibility is gone.

**Stronger, and the one to build:** the rapplication is **statically assembled and identical for
everyone**, and it *declares the shape* of the private data it consumes. The public artifact is the
same bytes for every person who resolves that chant; what differs is only the local material poured
into the declared shape, on device.

That difference buys three things worth having:

1. **Reproducibility survives.** The composition hash is the same everywhere, so a rapplication can
   be verified, compared and cached like any other addressed object. Data does not fork the
   capability.
2. **The shape is a contract, so it is auditable.** A rapplication declares what it consumes before
   it runs. It cannot quietly reach for more, and a reader can see the full extent of what it could
   ever see without running it — which is a far stronger privacy statement than a promise in a
   description.
3. **Import stays on device.** Mapping local material into the declared shape happens locally, so
   the private data is *used* without being *moved* — the capability comes to the data rather than
   the other way round.

So the rule is: **a chain builds the capability; a declared shape feeds it.** Where a choice looks
like it needs private data to select a link, prefer widening the shape so the same artifact handles
both cases, and keep the selection in the data rather than in the build.

### Publishing a chain publishes a bill of materials

This deserves stating on its own, because it is easy to miss and hard to undo.

A chain is a list of what you assembled from. Publishing it does not leak the private data that
*chose* the links — but it does reveal **which links were chosen**, and that is often enough to
infer the shape of the private material behind it. A recipe naming five industry-specific
capabilities says something about who wrote it.

So publishing a chain is a deliberate act with its own consideration, separate from publishing a
capability: the bytes may be public while the *selection* is not.

## The refusals

A conforming runtime refuses, before running anything, when:

- a required protocol version is outside what it supports;
- the interpreter or a named tool is absent;
- any payload fails verification against its recorded hash;
- any required payload is missing, so the kit would be partial;
- the declared order cannot be honoured.

**All-or-nothing.** There is no partial assembly, because a partly-assembled kit looks like a
working one and fails later, somewhere unrelated.

## Disassembly

Dragging a tile out of the primary window disassembles it: composed agents are removed, the UI is
torn down, and the tile is byte-identical to what it was before. **Assembly leaves no residue** —
that is what makes it repeatable, and it is why a tile can move between surfaces all day without
accumulating state.

## Proof obligations

A conforming implementation demonstrates: a tile whose `stands_on` cannot be satisfied refuses and
names the requirement and payload; nothing is written or composed on that path; a kit with one bad
payload assembles none of them; the same tile assembles to the same composition hash on two
machines; and a tile assembled then disassembled leaves the runtime in the state it started in.

## Status

**Specified, not implemented.** `stands_on` is not read or enforced anywhere, so a tile that should
refuse assembles today. The composition and hot-load machinery exists
(`../electron/route-manager.mjs`, `../electron/dimension-tiles.mjs`); the footprint check in front
of it does not, and it is the piece that makes this a protocol rather than a description.
