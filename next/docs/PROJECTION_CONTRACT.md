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

## Provider-neutral AI-driven extension

`rapp-work.ai-projection/1` is the authenticated provider-neutral projection
contract, described in [AI_PROJECTION_API.md](AI_PROJECTION_API.md). It preserves
the underlying canonical root and adds structured client attribution, public
activity/evidence/attention, explicit multi-head view conflicts and bounded
cursor events. The older owner-facing `projection.get` remains available; it is
not the credentialed multi-client transport.

The UI must subscribe and transform around canonical AI work, rather than turn
these fields into a parallel control plane. A test-only render-model reducer
proves real-time transitions, conflict visibility and restart equivalence.
The UI implementation is still deferred.

## Passive Catch me up / optional guest replay

`rapp_work_catch_up` returns a bounded `rapp-work.catch-up/1` timeline, not a new
UI state authority. Every step retains canonical cursor/source hashes, explicit
recorded/reconstructed/unavailable grades and a deterministic state digest.
The player may fast-forward the returned states but may not regenerate work or
invoke models/tools. See `CATCH_ME_UP.md`.

Optional `rapp-work.omarchy-replay/1` is separately opted-in GODD/private content.
Only exact host-approved canonical guest artifacts are recorded frames; safe
command/diff visualizations are reconstructed; missing display is unavailable.
No host screen, secrets, keystrokes or executable replay is exposed.
