# Virtual RAPPID Debug Card

The Virtual RAPPID Debug Card is a developer simulation surface for exercising
a RAPPID handoff without a real network, device credential, private memory, or
production identity. TypeScript and Python implement the same closed manifest,
fixture deck, state machine, and wire snapshots.

It is a transport and hydration test surface. It does not change the canonical
RAPPID, RAPP/1 body frames, Quantum RAPPID growth APIs, or committed-message
reveal behavior.

## Card and link contract

The conventional card filename is:

```text
.rappid-card.json
```

The schema is [`contracts/rappid-card.schema.json`](../contracts/rappid-card.schema.json).
Every object is closed. A card carries only:

- the canonical RAPPID;
- a canonical HTTPS endpoint, signed policy identifier, and nonce;
- issue/expiry, protocol, and runtime compatibility bounds;
- classification and explicit hydration scopes;
- bounded content-addressed part descriptors;
- challenge and signature metadata.

It cannot carry a secret, credential, plaintext private memory, executable,
command, arbitrary media type, arbitrary part name, or filesystem path.
Hydrated bytes come only from an injected content provider, are size-checked,
and must re-hash to the declared SHA-256 address before they become visible to
the simulator.

The manifest hash is SHA-256 over the deterministic canonical JSON form: keys
sorted, no whitespace, ASCII escapes, and identical number rendering in both
runtimes. The compact non-secret link is exactly:

```text
rappid://link/<rappid>?m=<manifest-hash>&e=<endpoint>&n=<nonce>
```

No other query fields, duplicate fields, fragment, alternate ordering, or
non-canonical spelling is accepted. The endpoint is decoded before policy
checks. Userinfo, query parameters, fragments, percent-encoded path material,
non-HTTPS schemes, and non-canonical origins are refused, so an encoded token
or password cannot hide inside `e=`.

## Profiles and keys

The profiles are intentionally distinct:

| Profile | Accepted mode | Authenticator |
|---|---|---|
| `rappid-card-test/1` | Fixture only | `ed25519-test` with deterministic synthetic fixture keys |
| `rappid-card-production/1` | Production only | `ed25519` with explicitly injected public trust anchors |

Synthetic fixture identities and private keys live only in fixture/vector
generation code. Production mode rejects the test profile and `ed25519-test`
before trust lookup. The core never reads environment variables, keychains,
cloud metadata, or ambient credentials.

Production trust is not a signer-key map or a caller-provided scope set:

1. A local public authority anchor verifies a signed
   `rappid-card-policy/1` document.
2. That policy authority verifies one signed
   `rappid-card-authorization/1` binding the signer key to the exact subject
   RAPPID, scopes, classification ceiling, and endpoint origins.
3. The same authority verifies a signed
   `rappid-card-revocations/1` view.
4. The authorized signer public key verifies the card and the post-hydration
   continuity challenge.

The closed trust document contract is
[`contracts/rappid-card-trust.schema.json`](../contracts/rappid-card-trust.schema.json).
Policy resolution and origin approval happen before the manifest provider is
called, so an unapproved decoded endpoint cannot reach a network-capable
provider.

## State machine

The reducer is pure and the provider effects are outside it:

```text
parse
  -> verify
  -> preview
  -> explicit approve
  -> hydrate permitted content-addressed parts
  -> continuity challenge
  -> awake
```

Any rejected control transitions to `failed` with a stable error code. Preview
does not hydrate. Approval is a separate action. Production requires the
runtime's SQLite state store; policy, authorization, and revocation sequences
are checked for rollback in the same transaction that claims a nonce. The
claim survives process restart. Audit output is capped at 64 deterministic
events.

The continuity challenge binds the manifest hash, nonce, and sorted hashes of
the parts that actually hydrated. A reconnect during hydration can retry the
same verified content lookup once; it does not re-parse, re-authorize, or
weaken the signature boundary.

## Deterministic fixture deck

Both runtimes expose the same 13 fixtures:

| Fixture | Expected result |
|---|---|
| `valid` | Awake |
| `expired` | `card_expired` |
| `revoked` | `revoked` |
| `wrong-hash` | `manifest_hash_mismatch` |
| `unknown-key` | `unknown_key` |
| `incompatible-runtime-protocol` | `incompatible_protocol` |
| `classification-violation` | `classification_violation` |
| `insufficient-scope` | `insufficient_scope` |
| `missing-part` | `missing_part` after explicit approval |
| `challenge-failure` | `challenge_failed` after hydration |
| `reconnect-during-hydration` | Awake after one bounded resume |
| `duplicate-nonce` | `duplicate_nonce` |
| `physical-payload-reproduction` | Awake from the exact QR/deep-link payload |

[`tests/rappid-card-vectors.json`](../tests/rappid-card-vectors.json) contains
the signed manifests, policies, signer authorizations, revocation views,
canonical hashes, exact links, previews, approved runs, hydrated part
descriptors, and audit events. TypeScript and Python each regenerate the full
fixture document and require structural equality.

[`tests/rappid-card-production-vectors.json`](../tests/rappid-card-production-vectors.json)
adds positive `ed25519` production vectors: an accepted view, a higher-sequence
rotation, and a signed lower-sequence rollback probe. Neither runtime has a
built-in production private key.

## CLI

The same commands are available from the TypeScript and Python launchers:

```bash
# TypeScript
cd typescript
npm run build:server
node dist/index.js rappid-card fixtures ../rappid-card-deck --format both
node dist/index.js rappid-card simulate valid
node dist/index.js rappid-card simulate valid --approve
node dist/index.js rappid-card inspect ../rappid-card-deck/valid/.rappid-card.json --fixture
node dist/index.js rappid-card verify ../rappid-card-deck/valid/.rappid-card.json \
  --link ../rappid-card-deck/valid/rappid-card.link.txt --fixture
node dist/index.js rappid-card qr '<exact-rappid-link>' ./rappid-card.svg

# Python
cd python
python -m openrappter.cli rappid-card fixtures ../rappid-card-deck --format both
python -m openrappter.cli rappid-card simulate valid
python -m openrappter.cli rappid-card simulate valid --approve
python -m openrappter.cli rappid-card inspect ../rappid-card-deck/valid/.rappid-card.json --fixture
python -m openrappter.cli rappid-card verify ../rappid-card-deck/valid/.rappid-card.json \
  --link ../rappid-card-deck/valid/rappid-card.link.txt --fixture
python -m openrappter.cli rappid-card qr '<exact-rappid-link>' ./rappid-card.svg
```

`simulate` stops at preview unless `--approve` is supplied. `inspect` and
`verify` never fetch ambient keys. Production verification requires both an
explicit `--trust` JSON bundle (signed policy, authorization, revocation view,
and public authority keys) and a durable `--state` SQLite path.

Fixture export writes each manifest, the exact link sidecar, and a real QR SVG
or PNG generated by the `qrcode` ecosystem libraries. The implementation does
not draw placeholder modules.

## Habitat integration

The **RAPPID Debug Card** page appears beside **Quantum RAPPIDs** in the
OpenRappter UI. It exposes fixture selection, the exact deep link, a scannable
QR, bounded audit events, and visible preview/failure/awake states. Hydration
requires the page's explicit approval button.

The browser calls only authenticated gateway methods:

- `rappid.card.fixtures`
- `rappid.card.preview`
- `rappid.card.simulate`

Fixture private keys and provider authority stay server-side. The gateway
simulation uses signed fixture trust documents and in-memory fixture state; it
performs no network request and reads no credential store. The production API
does not accept that state store.

## Current boundary

The shipped production profile is a verified provider contract, not a
production pairing deployment. It verifies Ed25519 trust documents and keeps
durable replay state, but OpenRappter does not yet ship a hardware-backed
private signer, trust-distribution service, remote content transport, or QR
camera decoder. The Debug Card Habitat deliberately remains fixture-only; a
production host must supply reviewed trust/content/challenge providers.
