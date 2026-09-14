# Release gate: Catch me up

The headless API creates a **deterministic replay timeline from verified
canonical frames and exact cursors**. The future UI is a disposable passive
fast-forward player. It does not regenerate a conversation, run a tool, invoke a
model, capture a screen or mutate canonical state to explain past work.

## API and cursors

- Owner/local API: `conversation.catch-up {root, scope?, from?, to?, limit?, guest?}`.
- Natural conversation: “Catch me up” produces a read-only recent timeline,
  without appending the request as a new work turn.
- Provider-neutral MCP/stdio: `rapp_work_catch_up`, requiring the exact root and
  existing `projection.read` capability. Private guest replay additionally
  requires `guest.replay`.

The contract is `rapp-work.catch-up/1` (`contracts/catch-up.schema.json`).
Omitted `from` selects a bounded recent window. Explicit `from:null` starts
before the first canonical memory occurrence. `to` fixes the high-water cursor;
reuse it with `from:next` when paging so new appends do not change the selection.
Every non-null cursor must match this root's exact stream/sequence/UTC/particle/
wave reference. Wrong-root, missing or reversed cursors refuse; no history repair
or guessed replacement is attempted.

State reconstruction uses causal **memory-stream sequence** prefixes. Original
UTC/wave hashes and explicit references remain intact. It does not claim that a
cross-stream timestamp is a global causal clock. Alternative canonical branches
are retained but not silently replayed/merged as the selected history.

## Grades and digests

Each step provides `grade`, separate `workGrade` and `stateGrade`, original
`sourceFrameHashes`, exact cursor/previous cursor, public summary, optional
reconstructed state, `stateDigest` and an explicit reason:

- **recorded:** an original canonical declarative intent is present. For the
  optional guest lane, this grade requires exact approved recorded guest image
  bytes. A normal recorded intent is **not** proof of historical UI pixels.
- **reconstructed:** the returned projection/command/diff visualization is a
  deterministic interpretation of canonical work, not a historical screen
  recording or model-generated explanation.
- **unavailable:** material is absent, unauthorized, redacted, refused, outside
  scope, beyond bounds or not reconstructable. Useful recorded work is retained;
  an unavailable hint/display is never invented.

`stateDigest` hashes the exact returned playback state using canonical
`H("rapp/1:particle", state)`. `selectionDigest` binds root, scope, cursors, source
occurrences and selected guest evidence; `timelineDigest` binds the entire
returned page. An optional guest lane also has `guestDigest`. Unavailable state
has `null`, not a fabricated empty-state digest.

Digest pins must come from the authenticated source/owner, not a self-consistent
imported replay document. `test/catch-up-player.mjs` verifies the caller's pin,
per-step state digests and cursor transitions while fast-forwarding. It has no
model, tool, storage or product-UI role.

Bounds: 16 occurrences/page, 96 KiB/state and 512 KiB/page. Pages can stop early
at the byte bound; `more`/`next` make this explicit. Scope filtering prevents
sibling/private-control payload export. Credential fields and hidden reasoning
metadata never enter the public replay.

## Optional Omarchy guest lane

Guest replay is **off by default**. An explicit request must contain:

```json
{
  "enabled": true,
  "dataClass": "godd",
  "visibility": "private",
  "policyWave": "<existing root-signed private guest policy wave>"
}
```

That option is not permission. The current root-signed policy must have opted in
before the recorded occurrence, target only `omarchy-guest`, classify capture as
GODD/private, and exclude host screen, secrets and keystrokes. Changed/revoked
policy or missing client privilege prevents exposure.

`CanonicalComputerReplay` is a **read-only target-owned boundary** over an
already-selected canonical ComputerBroker snapshot. It verifies original
producer signatures, complete intent/outcome/evidence triples, command and
receipt digests, exact occurrence links, computer identity and workspace owner.
It imports no old broker/runtime code and exposes no execute, capture, keyboard,
VM, filesystem or host-screen operation.

| Evidence available | Replay grade |
|---|---|
| Exact PNG artifact from canonical guest download plus independently host-selected canonical guest-origin/safety approval | `recorded` guest frame |
| Canonical `computer.execute` result | `reconstructed` operation/status/exit-code visualization |
| Canonical bounded aggregate diff receipt | `reconstructed` changed-file/line-count visualization |
| Missing artifact, approval, display, binding, policy, ownership or evidence | `unavailable`; never capture again or fabricate a screen |

Raw command arguments, cwd, stdout/stderr, raw diff content and keystrokes are
excluded—not merely hidden in a UI component. Host captures and executable media
are refused. PNG bytes are bounded to 64 KiB and 2048px dimensions; larger or
unsupported material requires a separately qualified artifact path rather than
silent relaxation.

A carried “guest”/“sanitized” flag or artifact hash is insufficient. The trusted
host must select independently verified canonical capture-origin and exclusion
approvals for the exact bytes. The existing broker reference supports scoped
guest execution/download receipts; it does **not** establish a current live
guest-capture safety binding. Default greenfield hosts therefore return
unavailable rather than adding a capture/host-screen fallback.

The fixture gate uses synthetic canonical broker events and synthetic recorded
PNG bytes. It proves boundaries and grading, **not** that a live Omarchy guest
was captured. No GODD export/adoption, host capture or current profile change is
performed by the gate.

## Release proof and references

`npm --prefix next run catch-up:gate` is mandatory in the full `check` gates.
It verifies deterministic restart, passive fast-forward, all three grades,
source hashes, no model/tool/mutation, default-off private guest handling and
secret/keystroke exclusion. The unmodified reference `rapp.py` independently
checks state/guest/page digests and exact referenced frames; the exact rev-15
checker scans nonzero signed root and ComputerBroker-source frames.

Prior reference evidence `catch-me-up-replay-validation.json` at
`b5cec8af4eac2cb73dabe882dcf50e80f8c5b23d` informed independent digest pins,
immutable public replay, explicit evidence and the distinction between
presentation position and recorded state. No legacy replay implementation is
imported.

The requested reference agent `c58b0c7b-b34b-4d8c-b16d-05aa80409cf8` was contacted
for semantic coordination; its returned result must be reviewed when delivered.
Do not claim that an unavailable/unreturned agent result has been incorporated.

Catch-up is an additional release gate, not a substitute for the required
observed controlled-local estate migration and final integration approval.
