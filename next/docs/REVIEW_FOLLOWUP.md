# Independent review follow-up: `907f743`

The five supplied high-confidence findings were reproduced on the original
`907f743c8dfb52557b5af9cb145bc9b625fbd9ab` behavior. Six deterministic tests
initially failed (the deadline issue has two separate paths). The follow-up
adds eight regressions, including a bounded private-read timeout and retained
head selection. No RAPP/1 wire, rev-15 authority, signer identity, old history or
source/native profile is rewritten.

## 1. Unresolved canonical forks cannot authorize work

The existing RAPP/1 fork condition is applied across **all independently verified
active and retained occurrences**: same `stream_id`, `seq` and `prev`, different
`frame_hash`. Identical shared ancestry is one occurrence, not another fork.
Genesis conflicts are included.

`canonical-forks.ts` composes those verified frame references; it does not
introduce a registry, protocol kind, resolution flag or authoritative branch
directory. Both histories remain byte-identical, and raw repository reopen/
forensic inspection remain available. `egg.at-rest` exposes unresolved fork
references while all transfer/adoption readiness stays false.

Semantic folding, root/AI projection, Catch-up, cursor cuts, selected transcripts
and ordinary/raw successor appends refuse `canonical-fork-unresolved`. Swapping
the selected/retained directories cannot pick a winner. Empty transcripts,
channel recaps and routine-receipt shortcuts are also fenced; absence of a
visible turn does not grant branch authority. This conservatively
fences the affected complete root; an independent other root remains usable.
An unselected retained extension also refuses `canonical-head-unresolved` rather
than silently treating a shorter directory chain as authoritative.

Only byte-identical retained ancestry prefixes are safe alongside an unambiguous
complete source chain. Positive use-case/migration fixtures now exercise that
retention; dedicated adversarial fixtures retain actual conflicting branches
and prove refusal. Nothing in a passing per-directory wire scan grants joint
fork resolution. **No adopted canonical owner-resolution binding is currently
available**, so there is no application override or automatic promotion.

## 2. Internal scope identity is mint-once

Original root-defined scopes and every confirmed internal creation reserve
their IDs permanently within that root. Correction retires the creation; it
does not free the ID for a new world, workspace, task, routine or artifact.
A new scope must use a new ID. Independent roots retain independent namespaces.

The creation-owner map rejects multiple creating occurrences instead of taking
the first matching one. Proposal/application validation rejects reuse, canonical
memory validation checks it before publication, and a retired creator cannot
parent new source work. The regression uses creation at `20:00:00Z`, correction
at `20:00:01Z`, attempted recreation at `20:00:02Z` and a new-source clock at
`20:00:00Z`. Reuse/work refuse, original bytes survive, and restart remains
reconstructible.

## 3. Root capacity is checked before publication

The trusted creation transaction enforces the existing **64-root** ceiling
before making any root directory or genesis. Hidden roots still count.
Whole-root materialization uses the same ceiling. A rejected root 65 leaves
the 64-root file set and root directories unchanged and readable after restart;
an exact existing creation retry remains idempotent.

Body creation does not trigger unnecessary channel-question reconstruction:
it cannot contain a clarification publication. This also avoids read contention
while constructing the bounded catalog; no observer or lock rule is weakened.

## 4. Preflight expiry covers the entire operation

The canonical preflight's original `expiresUtc` is the deadline. Private binding
retrieval is bounded by that same deadline, not a fresh timer after retrieval.
Expiry is rechecked before transport readiness and inside the final attempt
transaction, with a final dispatch guard.

An expired preflight records **deferred / preflight-expired / submitted:false**
for the whole selected batch. No transport call or physical attempt is made,
and only a fresh explicit approval can advance the no-send generation.
Cancellation and non-cooperative-operation fences remain intact.

Tests separately expire during private binding retrieval, after a ready
preflight response, and while a binding read is blocked. The earlier quiet-hours
late-deferral fixture now crosses the quiet boundary *within* its original
30-second preflight, so it proves quiet-hour deferral rather than relying on
an expired approval.

## 5. Clarification settlement uses canonical organization state

`questionPending` now includes the actual `foldState` proposal settlement:
a confirmed `draft.resolves` that supersedes the exact question settles it.
An unconfirmed proposal does not. For marked clarifications, the canonical
organization fold requires the confirmed resolution's genuine CLI user source
and local-owner actor, never an external iMessage input.

The regression confirms a native question's CLI resolution, checks the
`superseded` state and cleared pending notification, then attempts delivery.
It returns `resolved` with no model, transport or canonical mutation, including
after restart. Explicit `conversation.answer` continues to work unchanged.

## Evidence and retained boundaries

`test/review-followup.test.mjs` is the independent regression suite. Its signed
fork proof distinguishes individually conformant chains from an unresolved
joint fork, and its capacity receipt records byte/directory/restart invariance.
All ordinary next, primitive, observed migration/display, replay/source-ownership
and private-channel gates still apply.

Historical receipts and prior `source-owned` / `private-channel` goldens are
not rewritten. Current use-case goldens live under `fixtures/review-907/`.
No old implementation, dependency, private profile, model selection, publication
or live migration changes are part of this follow-up.
