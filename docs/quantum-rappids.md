# Quantum RAPPIDs

Quantum RAPPIDs are OpenRappter's append-only organisms: one canonical RAPP/1
identity projected through multiple independently verifiable dimensions.

The creature language is product UX. The integrity model is RAPP/1.

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

## Habitat UX

The Quantum RAPPID Habitat shows:

- Field Guide and lifecycle stage;
- weight, frame height, species height, dimensions, and trait bars;
- wake-call playback and MIDI continuation;
- append-only growth proposals;
- a self-steer leash: **Observe**, **Propose**, or **Run approved appends**.

There is no hidden full-autonomy mode. A proposal becomes organism state only
after the selected approval policy and RAPP/1 verification pass.

## Show-and-Tell Skill Recorder

Show-and-Tell can promote an approved generated `SKILL.md` into a skill
dimension. The recorder preserves its existing privacy boundary:

- explicit window captures only;
- typed text is not persisted;
- credential-like windows refuse capture;
- raw screenshots and narration stay in the private recorder store;
- only the privacy-scanned skill plus its content hash enters the RAPPID.

## RAPPID Field for iOS

`ios/RappidField` is the native, sound-first companion:

- original Canopy, Current, and Forge paths with no franchise characters,
  sounds, capture mechanics, maps, or trade dress;
- no location, age, account, analytics, camera, or background tracking;
- MIDI DNA byte-identical to the host runtime and a wake call synthesized on
  device;
- exact/incomplete weight, frame height, versioned display height, traits,
  encounters, training, and non-authoritative growth readings;
- synthetic pairing for the prototype, with real host credentials explicitly
  out of scope until a scoped handshake is implemented.

DEBUG builds expose a bounded semantic AI-player interface. Human buttons and
AI commands dispatch the same pure `GameReducer`; each command has a unique id
and monotonic sequence, and the next command cannot be sent until the matching
settled receipt arrives. The interface has no eval, selectors, coordinates,
shell, arbitrary fetch, filesystem, credential injection, or approval bypass,
and Release builds compile it out.

See the [RAPPID Field README](../ios/RappidField/README.md).

## Committed messages

Chat uses a committed-message reveal:

- gateway deltas can remain useful for liveness and reconnects;
- partial language stays in an in-memory response buffer;
- the user sees a stable typing-presence bubble;
- only a final event atomically reveals Markdown;
- cancellation or error discards the uncommitted draft.

This keeps the creature present without asking a reader to chase text that is
still changing.

## RAPP/1 boundary

RAPP/1 remains the authority for:

- canonical RAPPID identity;
- canonical JSON and content addressing;
- the exact eleven-key frame;
- stream chaining and refusal behavior;
- registered kinds and reconstruction.

OpenRappter does not add a private frame envelope or derive identity from a
session, name, trait, media hash, weight, height, or lifecycle stage.
