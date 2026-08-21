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
- a bounded endpoint identifier and nonce;
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
non-canonical spelling is accepted.

## Profiles and keys

The profiles are intentionally distinct:

| Profile | Accepted mode | Authenticator |
|---|---|---|
| `rappid-card-test/1` | Fixture only | `hmac-sha256-test` with deterministic synthetic fixture keys |
| `rappid-card-production/1` | Production only | `hmac-sha256` with an explicitly injected key provider |

Synthetic fixture identities and keys live only in the fixture module.
Production mode rejects the test profile before key lookup and also rejects
test authenticators. The core never reads environment variables, keychains,
cloud metadata, or ambient credentials. A production host must inject its own
key, manifest, revocation, content, and challenge providers.

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
does not hydrate. Approval is a separate action. Nonces are held in a bounded
replay cache, and audit output is capped at 64 deterministic events.

The continuity challenge binds the manifest hash, nonce, and sorted hashes of
the parts that actually hydrated. A reconnect during hydration can retry the
same verified content lookup once; it does not re-parse, re-authorize, or
weaken the signature boundary.

## Deterministic fixture deck

Both runtimes expose the same 13 fixtures:

| Fixture | Expected result |
|---|---|
| `valid` | Awake |
| `expired` | `expired` |
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
the signed manifests, canonical hashes, exact links, previews, approved runs,
hydrated part descriptors, and audit events. TypeScript and Python tests each
regenerate the full document and require structural equality.

## CLI

The same commands are available from the TypeScript and Python launchers:

```bash
# TypeScript
cd typescript
npm run build:server
node dist/index.js rappid-card fixtures ../rappid-card-deck --format both
node dist/index.js rappid-card simulate valid
node dist/index.js rappid-card simulate valid --approve
node dist/index.js rappid-card inspect ../rappid-card-deck/valid/.rappid-card.json
node dist/index.js rappid-card verify ../rappid-card-deck/valid/.rappid-card.json \
  --link ../rappid-card-deck/valid/rappid-card.link.txt
node dist/index.js rappid-card qr '<exact-rappid-link>' ./rappid-card.svg

# Python
cd python
python -m openrappter.cli rappid-card fixtures ../rappid-card-deck --format both
python -m openrappter.cli rappid-card simulate valid
python -m openrappter.cli rappid-card simulate valid --approve
python -m openrappter.cli rappid-card inspect ../rappid-card-deck/valid/.rappid-card.json
python -m openrappter.cli rappid-card verify ../rappid-card-deck/valid/.rappid-card.json \
  --link ../rappid-card-deck/valid/rappid-card.link.txt
python -m openrappter.cli rappid-card qr '<exact-rappid-link>' ./rappid-card.svg
```

`simulate` stops at preview unless `--approve` is supplied. `inspect` and
`verify` never fetch ambient keys. Production verification accepts only an
explicit `--keys` JSON file mapping key IDs to 32-byte lowercase hex keys.

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

Fixture keys and provider authority stay server-side. The gateway simulation
uses in-memory injected providers; it performs no network request and reads no
credential store.

## Current boundary

The shipped production profile is a provider contract, not a production
pairing deployment. It accepts an explicitly injected HMAC key provider, but
OpenRappter does not yet ship a hardware-backed asymmetric key resolver,
revocation service, remote content transport, or QR camera decoder. The Debug
Card Habitat deliberately remains fixture-only until those deployment
decisions have their own reviewed trust model.
