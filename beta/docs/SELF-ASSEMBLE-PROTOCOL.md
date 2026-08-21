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
