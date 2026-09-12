# Work service

`WorkService` is the command/projection boundary. It requires three production
ports: `WorkspaceHistoryPort`, `CanonicalPort`, and `WorkAuthorizationPort`.
The composition root binds these narrow structural contracts to the public
`@rapp-work/workspace-store`, `@rapp-work/rapp1`, and `@rapp-work/security` APIs.
There is no default store, authority implementation, or permissive adapter.

`commit(capability, command, effect, {signal})`:

1. checks read authority, locks the workspace, reads committed storage, and scans;
2. authorizes the exact command, resources, content digest, and current heads;
3. finds persistent idempotency in verified history, rejecting key/content reuse;
4. durably appends a body intent with head CAS, reads it back, and scans it;
5. releases the short storage lock, obtains an intent-bound permit and invokes the effect once;
6. reacquires the lock, verifies extension of the intent's basis, and appends an
   acknowledged terminal outcome and hash-linked receipt evidence;
7. reads back/scans every append before returning a committed proof.

The journal adapter must provide a cross-process exclusive lock, durable
all-stream CAS, and committed reads. The canonical adapter must use the actual
RAPP/1 verifier, including owner, frame, chain, commit, and evidence checks.
Frame ordering must preserve each stream's order; streams may be grouped.
No lock is held while waiting for a model, guest or human decision. Other
commands can commit approval/cancellation evidence meanwhile. A competing retry
sees the durable pending intent and cannot execute the effect a second time.
The service does not interpret an index, a log, or a caller's verification flag
as evidence. It independently checks work-event linkage and receipt digests.

`read` reconstructs both complete and unresolved commands. `project` invokes a
domain reducer **only** on complete verified triples. Domain adapters should
also match the authorized operation to an event family; a tool response must
not redefine agents or grant policy.

An intent without a proved terminal/evidence pair is unresolved. Exceptions
from effects are ambiguous, not inferred failures. A restart does not replay
such work. Loss of a final acknowledgement can be resolved by a later verified
read of an already complete triple, never by executing again. Cancellation
before an effect is recorded as an acknowledged no-effect terminal outcome.
Cancellation after dispatch requires an explicit effect acknowledgement.

Tests use a strict hash-chain test fixture to inject crashes and corruption;
that fixture is not exported and is not a replacement for RAPP/1 conformance.

```sh
npm run build --workspace @rapp-work/work-service
npm test --workspace @rapp-work/work-service
```
