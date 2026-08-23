# Quantum RAPPIDs

Quantum RAPPIDs are OpenRappter's append-only organisms: one canonical RAPP/1
identity projected through multiple independently verifiable dimensions.

The creature language is product UX. The integrity model is RAPP/1.

The protocol source for this release unit is
[`kody-w/rapp-1` PR #11](https://github.com/kody-w/rapp-1/pull/11), commit
`245738f1db501b6aa395afaff84fb50ae039bb23`. OpenRappter's TypeScript and
Python implementations share the checked-in `tests/quantum-rappid-parity.json`
vectors and must remain byte-identical at their public wire boundary.

## One identity, many dimensions

A Quantum RAPPID can carry:

- memory and engram cursors;
- recorded skills and deterministic agents;
- a sonic identity, MIDI DNA, autocomplete provider, and wake call;
- device links and playback capabilities;
- visual and spatial projections;
- capability and evidence frames.

Adding a dimension does not mint a replacement identity. Growth appends a
verified body frame to the existing RAPPID. A true child or divergent fork gets
a new RAPPID and an explicit parent pointer.

## Lifecycle

The default OpenRappter lifecycle is:

`baby -> hatchling -> raptor`

- **Baby** — a canonical identity with a compact trait/body seed.
- **Hatchling** — multiple verified dimensions and useful local behavior.
- **Raptor** — the grown OpenRappter organism: durable memory, skills,
  self-observation, bounded self-steering, and device habitats.

Lifecycle stage is derived state. It never changes the mint-once RAPPID.
Implementations must not infer capability maturity from file size alone.

## Creature stats

Stats use exact integers underneath the presentation:

| Stat | Derivation |
|---|---|
| **Weight** | Unique verified bytes across accepted frames and content-addressed assets. A `(space, hash)` counts once. |
| **Resident weight** | Verified bytes physically present in this habitat. |
| **Linked weight** | Verified known bytes referenced but not hydrated here. |
| **Frame height** | Contiguous accepted append-only body-frame depth. |
| **Species height** | A versioned presentation curve over frame height. It is not identity or physical fact. |
| **Dimensions** | Distinct verified dimension families carried by the organism. |

Unknown sizes make weight **incomplete**. They are never estimated. Duplicate
assets cannot make an organism heavier.

## Trait-conditioned autocomplete

Autocomplete is a proposal engine over the RAPPID's identity, traits, and
lineage. The first implemented dimension is sound:

1. The RAPPID and stable traits produce a 16-note MIDI DNA prompt.
2. Notes use `NOTE(pitch, delta_onset, duration, velocity)`.
3. Multiple deterministic continuations are generated locally.
4. Continuity with the prompt and standalone musical quality are scored
   separately.
5. The selected continuation remains a proposal until a verified dimension
   frame appends it.

The same contract applies to proposed stats, skills, visual traits, and future
dimensions. Prediction never mutates canonical state. The current local
provider is a deterministic candidate generator and scorer, not a trained
transformer; the provider can be replaced without changing the identity motif.

The representation and evaluation split are informed by:
<https://simedw.com/2026/08/20/midi-autocomplete/>.

## Sonic identity

Each sonic RAPPID may carry:

- `dna-prompt.mid` — the stable identity motif;
- `autocomplete.mid` — prompt plus trait-conditioned continuation;
- `emergence-cry.wav` / `.m4a` — a short original wake sound;
- `wake-call.wav` / `.m4a` — cry plus compact motif;
- a content-addressed sonic profile with exact bytes and hashes.

The wake call is original. OpenRappter borrows the broad creature-companion
convention, never another product's character sound, melody, recording, art, or
trade dress.

## Consent-bound Habitat interface

Habitat reads and proposals require an authenticated gateway connection.
Mutation is a separate boundary: `rappid.grow` and `rappid.attach-skill`
require a single-use approval identifier that an injected approval authority
validates against the exact RAPPID and proposed mutation. If no authority is
configured, mutation fails closed. The model-facing `QuantumRappidAgent`
contains only read and proposal operations.

The marketplace/Habitat visual surface, Show-and-Tell recorder integration,
committed-message chat reveal, and iOS companion are intentionally outside
this protocol/runtime release unit.

## RAPP/1 boundary

RAPP/1 remains the authority for:

- canonical RAPPID identity;
- canonical JSON and content addressing;
- the exact eleven-key frame;
- stream chaining and refusal behavior;
- registered kinds and reconstruction.

OpenRappter does not add a private frame envelope or derive identity from a
session, name, trait, media hash, weight, height, or lifecycle stage.
