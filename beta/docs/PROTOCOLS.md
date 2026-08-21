# The RAPP protocol family, and how RAPP/1 adopts one

Everything the Frontier does that another implementation could also do is a **protocol** with an
id and a version. This is the register, and the rule for how RAPP/1 takes one on.

## The register

| Protocol | Governs | Stage | Specified in |
|---|---|---|---|
| `rapp-tile/1.0` | the file a capability travels in — payloads, footprint, lineage, identity | **provisional** | [RAPPID-TILE-PROTOCOL](RAPPID-TILE-PROTOCOL.md) |
| `rapp-selfassemble/1.0` | what a runtime does with a tile, and what it must refuse | **draft** | [SELF-ASSEMBLE-PROTOCOL](SELF-ASSEMBLE-PROTOCOL.md) |
| `rapp-summon/1.0` | subscribing, deterministic resolution, offline, publishing back | **draft** | [SUMMON-PROTOCOL](SUMMON-PROTOCOL.md) |
| `rapp-autopilot/1.0` | driving the interface without the model — a CLI and an API in one surface | **adopted** | [AUTOPILOT-CLI](AUTOPILOT-CLI.md) |
| `rapp-ui-autosteer/1.0` | driving an embedded application through its own interface | **adopted** | [UI-AUTOSTEER-PROTOCOL](UI-AUTOSTEER-PROTOCOL.md) |
| `rapp-qqdrill/1.0` | running many candidate dimensions in parallel, isolated and bounded | **draft** | [QQDRILL-PROTOCOL](QQDRILL-PROTOCOL.md) |
| `molt-lineage/1.0` | generations, rings, and what may become HEAD | **adopted** | [MOLT-LINEAGE-PROTOCOL](MOLT-LINEAGE-PROTOCOL.md) |
| `ambient-context/1.0` | what the Brainstem simply knows, and where it came from | **adopted** | [AMBIENT-CONTEXT-PROTOCOL](AMBIENT-CONTEXT-PROTOCOL.md) |
| `rar-card/2.0` | the predecessor tile format | **frozen** | [DIMENSION-TILES-V2](DIMENSION-TILES-V2.md) |

## The four stages

| Stage | Means | A runtime may |
|---|---|---|
| **draft** | written down, not implemented anywhere | not claim support |
| **provisional** | implemented somewhere, behind an opt-in | claim support only behind a seal |
| **adopted** | implemented and expected | claim support; others may rely on it |
| **frozen** | superseded; readable forever, never written | read it, never emit it |

**Stages move in one direction.** A protocol never returns to an earlier stage, and a frozen
protocol is never deleted — the same promise `.card` carries, for the same reason: something
published against it still exists on someone's machine.

## How RAPP/1 adopts one — the rolling part

RAPP/1 is the base contract: a kernel, an interpreter, an agent shape. It does not change when a
protocol appears. Instead:

1. **A runtime declares what it supports** — a set of protocol ids and versions, readable without
   running anything.
2. **A tile declares what it needs** — `stands_on` names the protocols and minimum versions its
   payloads require.
3. **Assembly is the intersection.** [`rapp-selfassemble/1.0`](SELF-ASSEMBLE-PROTOCOL.md) checks
   the tile's requirements against the runtime's declaration *before* anything runs, and refuses by
   naming the missing protocol.

That is the whole adoption mechanism, and it is why the update can roll rather than break:

- **An old runtime meets a new tile** and refuses cleanly, naming what it lacks — instead of
  half-running it and failing somewhere unrelated.
- **A new runtime meets an old tile** and assembles it, because the requirement is a *minimum*.
- **Nobody has to upgrade in step.** A protocol reaching *adopted* does not invalidate a runtime
  that has not implemented it; it only means tiles may now rely on it and say so.
- **A provisional protocol is reachable but not assumed**, behind an opt-in seal
  ([ONE-TIME-SEALS](ONE-TIME-SEALS.md)), so it can be used in earnest before it is promised.

## What this rules out

- A protocol that is implemented but unstated, so nothing can check for it.
- A tile that requires something without saying so, and discovers it mid-assembly.
- Removing or renaming a frozen protocol because nothing visible uses it any more.
- A runtime claiming support for a draft.

## Status

**The register is accurate; the mechanism is not built.** No runtime publishes a `supports` set,
`stands_on` is not read, and no assembly checks an intersection. The stage column reflects reality
today, which is why most of it says draft.
