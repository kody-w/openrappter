# RAPPID Calling Card and Debug Card

OpenRappter implements RAPP/1 SPEC §7.10 exactly as finalized in
`kody-w/rapp-1` commit `392f850`.

There is no private card envelope. A `.rappid-card.json` resource is canonical
JSON for one ordinary eleven-key RAPP/1 frame:

```text
spec, kind, stream_id, seq, utc, payload,
payload_hash, frame_hash, prev, prev_wave, sig
```

| Use | Frame kind | Payload profile |
|---|---|---|
| Production | `body.calling-card` | `rappid-card/1` |
| Test/debug | `body.debug-card` | `rappid-card-test/1` |

## Exact payload

The frame payload is closed and uses these snake_case members:

```text
profile
rappid
soul_hash
parent
engram_root
reflex_capability_root
compatibility
classification
requested_scope
expires_utc
revocation_url
endpoint_origin
wake_challenge
inventory
key_id
```

`parent` is `null` or exactly `{rappid,particle}`. Compatibility is exactly
`{protocol,runtime,features}` using sorted versioned tokens. Classification is
one of `public`, `internal`, `confidential`, `restricted`; requested scopes are
sorted lclabel tokens.

Inventory entries are exactly `{part,space,hash,bytes,required}`. The required
core parts are sorted as `engram`, `reflex-capability`, `soul`, all in
`rapp/1:egg`. Their hashes bind `engram_root`,
`reflex_capability_root`, and `soul_hash`.

## Signature and identity

The frame's existing `sig` member is required. It is detached, unencoded JWS:

```text
protected-header .. Ed25519-signature
```

The protected header is canonical JSON with exactly:

```json
{"alg":"EdDSA","b64":false,"crit":["b64"],"kid":"<keyed-rappid>"}
```

Signing input is:

```text
BASE64URL(canonical(header)) + "." + canonical(frame without sig)
```

`payload.key_id` must equal `kid`. The resolved Ed25519 SPKI must hash back to
the key RAPPID tail with `Hb("rapp/1:rappid", SPKI_DER)`. A verifying key is not
issuing authority by itself.

## Compact link and endpoint evidence

The public, non-secret link is:

```text
rappid://link/<percent-encoded-rappid>?m=<payload-particle>&e=<endpoint>&n=<nonce>
```

The exact query order is `m,e,n`. `m` equals both `frame.payload_hash` and
`H("rapp/1:particle", frame.payload)`. `e` is a canonically percent-encoded
HTTPS URL ending `.rappid-card.json`. `n` is 16–64 unpadded base64url
characters.

Endpoints reject userinfo, ports, queries (including empty `?`), fragments
(including empty `#`), spaces/control characters, backslashes, malformed or
non-canonical percent encoding, double encoding, empty/dot segments, and
non-global IP literals. Signed `endpoint_origin` and `revocation_url` origins
must be authority-approved.

Fetch evidence is a 1–8 element array of exact
`{url,resolved_ip}` hops. Every redirect origin must be approved and every
observed IP globally routable. Production fetchers must apply the same checks
to live DNS/socket results before each request and after every redirect.

## Authenticated policy, delegation, and revocation

Runtime behavior comes from signed documents, never caller booleans or sets.

### `rappid-card-runtime-policy/1`

Exact members:

```text
schema, policy_seq, generated_utc, effective_utc, expires_utc,
authority_rappid, signer_key_id, provenance, card_authority,
protocol, runtime, features, profiles, max_classification,
granted_scope, max_registry_age_seconds, sig
```

The policy selects exactly one profile and authenticates protocol/runtime,
feature superset, classification ceiling, granted scopes, card authority,
registry freshness, and its monotonic sequence.

### `rappid-card-authority/1`

Exact members:

```text
schema, registry_seq, generated_utc, effective_utc, expires_utc,
authority_rappid, signer_key_id, provenance, approved_origins,
authorizations, sig
```

Authorization entries are exactly:

```text
issuer_key_id, subject_rappid, role,
not_before_utc, not_after_utc, revoked_utc
```

Role is `subject` or `card-issuer`. Production's positive vector uses explicit
non-synthetic `card-issuer` delegation. Debug profile and policy authorities
must be visibly owned by `synthetic`; production refuses them.

### `rappid-card-revocations/1`

Exact members:

```text
schema, registry_seq, generated_utc, effective_utc, expires_utc,
authority_rappid, signer_key_id, provenance, entries, sig
```

Entries are typed as `manifest-hash`, `key-id`, or `subject-rappid`, with exact
`target_type,target,effective_utc,reason`. Missing, forged, stale,
wrong-provenance, rollback, and same-sequence fork views fail closed.

## Exact verification order

The runtime stops at the first failing step:

1. `parse`
2. `content-address`
3. `schema`
4. `signature`
5. `expiry`
6. `revocation`
7. `compatibility`
8. `classification-scope`
9. `replay-nonce`
10. `hydration`
11. `continuity`

The SQLite backend transactionally commits `hydrating` before part access,
allows only the same connection to resume after restart, refuses other threads
and processes, and commits `awake` before success. It also persists monotonic
sequence/hash floors for runtime policy, authority view, and revocation view.

Continuity is the exact object:

```text
rappid, soul_hash, parent, engram_root,
reflex_capability_root, nonce
```

Both the signed `wake_challenge` and hydrated response must equal
`H("rapp/1:particle", continuity)`.

## Authoritative vectors

OpenRappter vendors byte-identical PR9 artifacts under:

```text
tests/vectors/rapp-1-392f850/rappid-card/
```

- `deck.json`: 49 mandatory named scenarios in exact order.
- `physical.rappid-card.json`: canonical eleven-key debug frame bytes.
- `physical-payload.txt`: exact compact physical URI.
- `PROVENANCE.json`: source commit and SHA-256 attestations.

Both TypeScript and Python consume this deck. The 49 scenario verdicts plus the
separate physical byte/link reproduction assertion are the 50 mandatory card
checks. Drift tests pin all schema tokens, key sets, scenario names, and order.

### Interim protocol-copy patch

`python/openrappter/rappid_card/pr9_reference.py` remains byte-identical to
commit `392f850`. `pr9_interim.py` separately applies deterministic depth-64 /
1 MiB failures, numeric-host-alias refusal, full-string token matching, and
ASCII decoded-secret boundaries. This isolation is temporary: before
publication, re-vendor from the forthcoming RAPP/1 follow-up commit containing
those fixes and delete the interim module.

## CLI

```bash
# Export canonical frames, links, trust documents, and QR artifacts
openrappter rappid-card fixtures ./rappid-card-deck --format both

# Inspect canonical frame bytes and link
openrappter rappid-card inspect \
  ./rappid-card-deck/physical-payload-reproduction/.rappid-card.json \
  --link ./rappid-card-deck/physical-payload-reproduction/rappid-card.link.txt

# Run exact verification with durable state
openrappter rappid-card verify \
  ./rappid-card-deck/physical-payload-reproduction/.rappid-card.json \
  --link ./rappid-card-deck/physical-payload-reproduction/rappid-card.link.txt \
  --scenario physical-payload-reproduction \
  --state ./rappid-card-state.sqlite

# Production awake verification fails closed until live adapters ship
openrappter rappid-card verify ./production.rappid-card.json \
  --link ./production-link.txt \
  --bundle ./production-verification-bundle.json \
  --trust-config ./local-trust.json \
  --state ./production-card-state.sqlite

# Historical evidence can be inspected, but never returns awake
openrappter rappid-card inspect-offline ./production.rappid-card.json \
  --link ./production-link.txt \
  --bundle ./production-verification-bundle.json \
  --trust-config ./local-trust.json \
  --state ./offline-inspection.sqlite

# Run any mandatory negative or positive vector
openrappter rappid-card simulate expired --state ./expired-state.sqlite
```

Production trust roots are independently provisioned in a regular,
non-symlink mode-0600 local file selected by `--trust-config` or
`OPENRAPPTER_RAPPID_CARD_TRUST_CONFIG`:

```json
{
  "schema": "openrappter-rappid-card-trust/1",
  "runtime_policy_authority": "<rappid>",
  "keys": [{"kid":"<rappid>","spki_der_b64":"<base64>"}]
}
```

Verifier bundles may reference the configured authority but cannot add trust
roots. Their closed historical shape carries only:
`runtime_policy_authority`, `runtime_policy`, `authority_view`,
`revocation_view`, `now_utc`, `connection_id`, `fetch_trace`,
`hydrated_parts_b64`, and `continuity`.

No live production transport is currently shipped. `verify --bundle` returns
`unavailable / live-adapter-required`; it never accepts bundle clock,
connection, fetch, hydration, or continuity as live authority. The separate
`inspect-offline` command may report a historical cryptographic/policy verdict
but always emits `awake:false`.

The Habitat remains test-vector-only and requires an explicit button before
running hydration. It visibly reports production verification unavailable
until live trusted-clock, connection, fetch, hydration, and continuity
adapters exist. No production trust or auto-execution authority is added to
the browser.
