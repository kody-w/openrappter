# @rapp-work/rapp1

Standalone RAPP/1 rev-14 authority, canonicalization, identity, frames, chain
scanning, detached JWS, and evidence. No application or former runtime imports.
The Apache-2.0 attribution is in `NOTICE`.

## Authority and bytes

`RAPP1_AUTHORITY` is the sole selected, frozen accepted checkpoint:

- commit: `caf6ef276cafa92aa744499af90dc1a28559941a`
- wave: `59629adab4e26d156f3d66ecfb766e08705919ea1d2adc92ba0ad2b17337dfc2`
- particle: `c7549bbd3e133b833930e24e008817ea295734b870f41706455d3f45821aba3a`

`fixtures/rev14-authority.json` is a byte-for-byte extraction of the accepted
fixture, including its normative text. Tests independently recompute its full,
payload, wave-preimage, and normative-text SHA-256 values. Historical words in
those immutable bytes do not introduce runtime dependencies.

`canonicalJson` implements RFC 8785 UTF-16 ordering, UTF-8 strings and ECMAScript
binary64 serialization. `parseJson` additionally refuses duplicate members,
unpaired surrogates, lossy decimal tokens, invalid UTF-8, depth greater than 64,
and inputs/canonical forms greater than 1 MiB. In particular, the normative text
accepts round-tripping decimals such as `0.1`; an older summary sentence inside
the authority payload does not override the normative input-domain profile.
Existing text is never Unicode-normalized. Programmatic inputs are snapshotted
without invoking getters, proxies or `toJSON`.

`hashValue(space, value)` and `hashBytes(space, bytes)` use the exact
`ASCII(space) + LF + content` construction. Keyless `mintIdentity` hashes the
16 UUIDv4 **octets**, not the UUID text or an owner/name. `keyedIdentity` hashes
SPKI DER in the same normative identity domain.

## Frames and trust

```ts
const frame = buildFrame({
  kind: 'memory.save',
  streamId: identity + ':work',
  utc: new Date().toISOString(),
  payload: data,
  head: previousHead, // FrameHead | null, explicitly supplied
});
const result = scanFrameJson(canonicalJson(frame), {
  streamId: identity + ':work',
  head: previousHead,
});
```

Every frame has precisely eleven keys. `prev` links the predecessor particle.
`prev_wave` links its wave only for non-genesis swarm frames. Wave preimages
exclude both `frame_hash` and `sig`. Kinds use the exact accepted registry,
never prefix inference. Times must be calendar-valid fixed-width UTC, sequences
contiguous uint53, and timestamps nondecreasing.

`scanFrameJson` and stored chain strings require already-canonical bytes.
`parseJson` is separately available for semantic I-JSON parsing; a stored frame
is never repaired. `scanChain(values, selectChainTrust(...))` requires an
explicit host-selected genesis and persisted head, rejects forks, truncation,
rollback, duplicate sequences and head substitution. `requireCommittedHead`
also rejects an otherwise valid uncommitted extension. Scan results are
immutable, module-owned objects; `isVerifiedChain` rejects copied lookalikes.
`mergeFrames` uses normative UTC, then wave-hash order.

All results say **integrity-only**, never factual truth, authorship, sandbox
enforcement or promotion-grade verification. Pins/registry records must come
from an authenticated persistence owner, not the presented frames.

## Signatures and evidence

`selectSignaturePolicy` accepts an explicitly trusted registry of keyed
identities and SPKI DER, with revocation/supersession times. It verifies identity
derivation and exact Ed25519/P-256 detached, unencoded JWS headers and inputs.
Swarm frames require signatures; present-but-invalid signatures fail on every
family. `createFrameSigner` supplies signing capability to `buildFrame`.
Generic APIs deliberately refuse re-genesis: this package does not invent an
owner/registry authorization flow for it.

`buildEvidencePayload`, `buildEvidenceFrame`, `validateEvidencePayload` and
`verifyEvidenceLink` preserve the normative `openrappter-evidence/1` token.
References must already be sorted and unique. Occurrence binding requires both
source particle and wave, selected authority, subject, data hash and producer.
Repeated evidence particles are refused; repeated ordinary particles remain
valid. Application event names live inside payloads, not new frame kinds.

## Validation

Run `npm test --workspace @rapp-work/rapp1` or
`npm run typecheck --workspace @rapp-work/rapp1` from the repository root.
Project references build only clean declared prerequisites; no legacy build is
needed. Tests also inspect all four foundational source import graphs.
