# Binding passive projection contract

`projection.get` returns `rapp-work.projection/1`. The TypeScript contract is
`src/projection.ts`; the machine-readable shape is
`contracts/projection.schema.json`. There is **no UI implementation**.

The projection contains:

- exact full root GUID, name and hidden status;
- selected rev-15 authority, integrity-only classification and explicit
  `factualTruth:false` / `externalAdoption:false`;
- the complete recursive internal scope tree, not a roster of visible child
  bots;
- public user/assistant turns with distinct original root speakers, canonical
  source stream/sequence/UTC/particle/wave and optional reply binding;
- review proposals, resolved/superseded human questions, internal artifacts,
  native pointers, recurring work, progress, outcomes and attention;
- original canonical heads and explicitly unselected preserved branch heads.

Cross-bot turns are included only through verified, signed, scoped request and
response occurrences. Full private peer memory is not merged into the view.
Canonical UTC/wave ordering does not rewrite the original stream order, sequence,
parent particle, wave link or identity. Disagreements and unknowns remain public;
synthesis is always `consensus:false` and `actions:review-required`.

Projection, selection, observer status and Where-were-we are non-authoritative
read-only views. Consuming a projection adds no event and runs no model.
Discarding one view does not dispose another root's observation.

A future one-chat UI may display this contract and forward human intents. It
must not implement its own planner, registry, provider routing, durable message
history, scheduling authority, capability loader, approval policy or deletion.
It must not promote a carried integrity flag or source hash into execution
permission. Mutations remain exact headless commands and canonical successors.
