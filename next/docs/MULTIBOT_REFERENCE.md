# Frozen multi-bot semantics: independent greenfield adoption

Reference track is stopped through
**`ef86c6551baa7446648e184f45e8426c5c8185d8`**. The supplied architecture extraction
is `files/greenfield-multibot-architecture-b5cec8a.md`; final source-owned exhaust
evidence is `files/source-owned-exhaust-validation.json`.

The reference reports **271 total frames, of which 6 are signed**, revalidated
without model regeneration. These numbers and its historical test/release
results are reference evidence, not greenfield acceptance. No current-app UI,
host service, storage, executor, lifecycle schema or signing implementation is
imported. Existing historical profiles/bytes are not relabeled.

## Semantic mapping and deliberate boundaries

| Reusable requirement | Greenfield boundary |
|---|---|
| One visible root is its complete original body-stream GUID | Existing root body identity and recursive internal scope tree; no child/Twin/provider/session aliases |
| Requests/replies stay source-owned and signed | Caller `swarm.guidance`, recipient `swarm.echo`, exact independently selected keyed root signers |
| Exact request correlation | Request particle/wave, recipient grant, sender/recipient and once-only echo operation identity are checked |
| New public synthesis references original perspectives | Caller-owned `memory.chat-turn` with exact request/response/source reference, `consensus:false`, `actions:review-required`; no copied peer/private history |
| Preserve disagreements/unknowns | Original peer public turn remains intact; caller-owned synthesis does not union/copy peer dissent |
| Common verified read cut | One trusted repository lock covers the complete root snapshot; no independent torn per-root scans or new snapshot database |
| Cross-stream clocks are not causality | Original per-stream sequence/UTC and exact wave dependencies retained; canonical UTC/wave presentation is not repaired into a new clock |
| Replay is a read, not a new choice | Exact owner receipt replay precedes new-work grant/key/clock checks; no model or append |
| New synthesis is separately authorized computation | Recheck original bilateral grants and both visible roots immediately before observing/computing the caller and again before publishing |
| Whole-world address is not whole-world prompt serialization | Current collaboration deliberately discloses only approved public briefs/question/perspectives; no private-world scan or exhaustive-inspection claim |
| One shared interpreter, independent roots | Verified target-owned adapter boundary and isolated root lifetimes; no replacement external grail or per-bot process |
| Headless entry before UI | Existing owner CLI/stdio and separately authenticated restricted AI MCP/stdio; no UI/HTTP composition |
| Catch-up is a passive reference projection | Original source hashes/cursors, canonical state/page digests, no replay model/tool/capture or mutation |

The reference supports separately published signer bindings for older keyless
roots. Greenfield does **not** fabricate that binding: keyless roots retain their
GUIDs and refuse new signed collaboration until an actual adopted signer path
exists. A root whose private signer is temporarily unavailable can still
reconstruct previously verified owner-visible receipts using its trusted public
registry. This is not permission to mint a substitute.

The reference's `rapp-work/collaboration/1` and lifecycle payload profiles are
not renamed or imported. Greenfield's existing `rapp-work.next/collaboration/1`
and source-owned Work payloads remain its explicit supported application
contract. Both compose existing RAPP/1 kinds without adding envelope keys.
Unsupported old application profiles remain historical/unavailable pointers,
not silently normalized into this schema.

## Verified fixes from the reference comparison

Five new greenfield regressions first reproduced failures:

1. Exact completed receipt replay was incorrectly gated by a now-revoked peer
   grant. It now validates the original request before checking authority for
   **new** work. Changed replay payloads still refuse. No new question can use
   expired/revoked authority, and AI endpoint credential checks are unchanged.
2. Clearing the caller after a committed peer response could start another
   synthesis model call. The new dispatch recheck prevents that call, retains
   the peer's original result and records a bounded caller settlement.
3. A synthesis could cite an exact signed response to the wrong question.
   Reconstruction now requires its original caller, exact request/response
   correlation and preserved source reference.
4. Another signed echo with a different operation ID could masquerade as a
   second reply to one request. The exact original echo operation identity and
   closed response status now bind that occurrence.
5. The interpreter context ceiling counted JavaScript characters rather than
   UTF-8 bytes. It now checks **96,000 UTF-8 bytes before hotload or inference**.

`collaboration.ask` reports `responseStatus` and `synthesisStatus`. A completed
peer response with unavailable/no-longer-authorized synthesis is `status:partial`,
not a whole-exchange success. Immutable owner replay remains
`status:recorded-not-replayed`. An unavailable peer does not trigger synthesis.
Uncertain canonical persistence is never repaired by model replay.

Negated consensus text is retained verbatim, and the independent peer's
disagreements remain visible in its source-owned turn even if synthesis omits
them. Explicit `consensus:false` does not certify the factual truth of arbitrary
model prose; no general semantic/factual verifier is claimed.

## Independent evidence and remaining work

`test/multibot-reference.test.mjs` covers independent request/reply clocks,
unchanged bytes through restart/replay, clock rollback, absent signing keys,
revocation, clear-before-synthesis, wrong correlation, duplicate echo identity,
UTF-8 bounds and verbatim dissent. Existing source-ownership, headless,
canonical, migration/display and Catch-up gates still apply independently.

The root-private agent controller/materialization and remote disclosure/signing
bootstrap must still be bound through actual adopted authority. The reference's
restricted `guid/context/remember/request` example is a responsibility boundary,
not permission to hand an AI this core's owner, signer or repository objects.
Current restricted AI endpoints expose only their existing scoped rights; this
comparison adds no owner administration or silent model/tool expansion.

No reference test count, source checksum, keyed fixture, carried flag or frozen
architecture note establishes complete estate/domain/code-loading/shared-runtime
adoption. Those readiness flags remain false. Approved controlled-local migration
and independent live bindings still block release.
