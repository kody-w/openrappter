# Binding native federation evidence API

The Workspace Manager exporter emits deterministic **source manifests and
request envelopes only**. It has no destination store path, filesystem writer,
native-store writer, root creation, hidden provider fallback or automatic
workspace-registration authority. Original native shapes and private details
remain in its selected manifest. Core admission receives bounded opaque
metadata and explicitly named SHA-256 evidence references.

## Owner-facing public operation

Use the existing `rapp-work.stdio/1` owner/local interface:

```json
{
  "id": "estate-<stable digest of the exact root-bound request>",
  "method": "estate.record",
  "params": {
    "root": "<exact existing full canonical body-stream RAPPID>",
    "evidence": {
      "origin": "explicit-operator-evidence",
      "observedUtc": "2026-09-13T20:00:00.000Z",
      "historical": true,
      "pointers": [{
        "id": "manager-workspace",
        "provider": "local",
        "title": "Selected local workspace",
        "nativeShape": "Original manager/native shapes retained in the private manifest",
        "locator": "local://workspace/<opaque-handle>",
        "provenance": {
          "source": "rapp-workspace-manager",
          "manifestSha256": "<64 lowercase hex>",
          "recordSha256": "<64 lowercase hex>",
          "providerUnion": ["copilot", "claude"],
          "mappingState": "mapped",
          "evidenceSha256": ["<64 lowercase hex>"]
        }
      }]
    }
  }
}
```

`origin:"sanitized-fixture"` is reserved for explicit synthetic evidence.
All evidence is historical, never a declaration of live ownership or native
authority. Provider union entries are metadata, not model selectors, tool
permissions, shared memory or a merge of provider identities.

The exporter always supplies `root` explicitly, resolved from the existing
canonical `identity.body_stream` where that identity binding applies. No UUID,
`agentId`, scope label, tail, filename or display-name alias is acceptable.
This API is **not** exposed as an AI-client self-grant/MCP administration tool.
The trusted owner host must independently bind its profile and signer.

## Closed shapes

`contracts/estate-evidence.schema.json` and `src/estate-contract.ts` define the
contract. Missing/unknown fields refuse; the exporter must not strip unsupported
fields, relabel a provider or fall back to another operation after refusal.

- Native provider labels remain `copilot`, `claude`, `hermes`, `scout`, `grokbot`.
  Their metadata adapters remain separate and pointer-only.
- `local` is an estate-metadata label, **not** another AI provider. It accepts
  only `local://workspace/<one opaque component>` and requires provenance.
  The component is 1–180 ASCII letters/digits/dot/underscore/hyphen, never `.`
  or `..`. It is not a host path.
- Existing native pointers retain their five original fields. Optional
  provenance has the exact six fields in the example. Local pointers require
  it; legacy native pointers can omit it.
- `providerUnion` is an unchanged unique array of at most six declared
  local/native labels. An empty union is allowed rather than inventing a native
  association. `evidenceSha256` contains at most sixteen unique SHA-256 digests.
  Manifest/record/evidence SHA-256 values are **not** canonical frame hashes or
  authorization tokens.
- Titles are bounded to 120 characters, native-shape descriptions to 240.
  IDs are canonical lowercase labels of at most 100 characters.
- Candidate provenance requires `mappingState:"mapped"`. Grok candidates also
  require `native://grokbot/workspace/…`; app/application roots refuse.
- A record contains at most 32 unique pointers and optionally 32 unique
  observations. No duplicate source locator or candidate/observation ID is
  allowed within the record. The exporter sends **one pointer or observation
  per envelope**, even though the existing discovery operation permits a
  bounded complete observation.

## Unresolved and app-only observations

Record these separately, never as candidate pointers:

```json
{
  "origin": "explicit-operator-evidence",
  "observedUtc": "2026-09-13T20:00:00.000Z",
  "historical": true,
  "pointers": [],
  "observations": [{
    "id": "grok-app-only",
    "provider": "grokbot",
    "title": "Grok application observation",
    "nativeShape": "Application present; no verified workspace mapping",
    "provenance": {
      "source": "rapp-workspace-manager",
      "manifestSha256": "<64 lowercase hex>",
      "recordSha256": "<64 lowercase hex>",
      "providerUnion": ["grokbot"],
      "mappingState": "app-only",
      "evidenceSha256": ["<64 lowercase hex>"]
    }
  }]
}
```

Observation mapping states are only `unresolved` or `app-only`. There is **no**
locator, workspace-root, private content or executable field. Observations may
inform a public explanation of missing mapping; they never enter
`pointer.register`. A historical app-root claim cannot bypass current candidate
validation merely because its frame bytes were signed. Its original bytes stay
retained, but unsupported activation refuses.

## Receipts, interruption and resume

Success returns the same request `id` and:

```text
root, scope:"local-estate", receipt:<exact original source reference>,
sourceWave, evidenceHash, duplicate, historical:true,
candidates, observations, createdWorlds:0, nativeWrites:0, next
```

`receipt` includes original GUID, internal scope, stream, sequence, UTC, particle
and frame hashes. `sourceWave === receipt.frame_hash`. `evidenceHash` is the
core's canonical `rapp/1:particle` digest of the admitted evidence object; it is
distinct from the exporter's SHA-256 references.

One accepted request appends one `discovery.recorded` occurrence to the exact
root's `local-estate` source stream. No root-central copy, native read/write,
model call or workspace/world creation occurs.

Freeze manifest bytes, record order, provenance and `observedUtc` across retries.
Derive the request ID deterministically from the complete root-bound request
(excluding the ID itself), using a bounded lowercase label. After interruption,
resend identical evidence under that ID. The original source receipt is returned
with `duplicate:true`; no frame or inference is replayed. Any changed payload,
including its timestamp, under the same ID refuses `idempotency-conflict`.
A materially changed manifest/request is a new publication, not an overwrite.

Advance a manifest-local cursor only after validating the returned request ID,
exact root, source scope, receipt and source wave. Keep any acknowledgement/
resume metadata outside the destination authority. A lost response requires an
identical retry, never a new ID or direct inspection/mutation of destination
files by the manager.

**Recording is not registration.** Only a later exact reviewed organization
proposal plus explicit human confirmation may create an internal pointer
container. A second container for the same native/local source identity refuses.
Full original manifests are not imported or flattened into Work workspaces.
Unknown canonical forms/closures remain unavailable; this evidence API is not
Egg transfer, full-estate adoption or a replacement for the observed migration
release gate.

## Verification

`test/estate-federation.test.mjs` tests real owner stdio across restarts, one
record per envelope, exact source receipts, stable retries, changed-request
refusal, preserved union provenance, explicit review, duplicate registration
refusal, app-only/unresolved isolation, private-field/path rejection and full
body-stream identity. Production authority/private manifests/native profiles
are not used by these fixtures.
