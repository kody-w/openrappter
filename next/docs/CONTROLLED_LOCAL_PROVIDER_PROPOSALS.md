# Controlled-local provider proposal acceptance

This is an **opt-in, two-phase local acceptance harness** for an already bound
real provider, trusted RAPP Work AI endpoint, distinct passive subscriber, and
existing private iMessage binding. It is not part of `npm --prefix next run
check`, does not bootstrap credentials or TCC, does not confirm work, and never
calls a channel send operation.

The fixture and deterministic test proofs establish the core semantics. This
harness exists to collect local evidence only when the operator already has all
real bindings. Missing provider credentials, provider/subscriber capabilities,
TCC authorization, or exact contact binding fail the run. The harness does not
replace missing inputs with fixture values and writes no passing receipt.

## Configuration contract

Validate the configuration against
`contracts/controlled-local-provider-proposal.schema.json`. Credential fields
are **environment variable names**, never values. Every command is an absolute
executable path launched without a shell.

```json
{
  "schema": "rapp-work.controlled-local-provider-proposal/1",
  "mode": "controlled-local",
  "fixture": false,
  "allowLiveSend": false,
  "canonicalStore": "/absolute/path/to/isolated-canonical-store",
  "evidenceDirectory": "/absolute/path/outside-the-canonical-store/evidence",
  "root": "rappid:@owner/bot:<64 hex>",
  "scope": "root",
  "requestId": "controlled-local-proposal",
  "request": "Create one bounded reviewed outcome.",
  "endpoint": {
    "command": "/absolute/path/to/trusted-endpoint-launcher",
    "args": ["--mcp", "--root", "<same exact RAPPID>"],
    "cwd": "/absolute/trusted/working-directory",
    "environment": ["ENDPOINT_SIGNER_BINDING"]
  },
  "provider": {
    "name": "Operator-selected provider",
    "provider": "operator-selected-provider",
    "capabilityEnv": "RAPP_WORK_REAL_PROVIDER_CAPABILITY",
    "credentialEnv": ["REAL_PROVIDER_CREDENTIAL"],
    "adapter": {
      "command": "/absolute/path/to/provider-draft-adapter",
      "args": [],
      "cwd": "/absolute/trusted/working-directory",
      "environment": []
    }
  },
  "subscriber": {
    "capabilityEnv": "RAPP_WORK_PASSIVE_SUBSCRIBER_CAPABILITY"
  },
  "privateChannel": {
    "bindingWave": "<exact canonical channel.bound wave>",
    "probe": {
      "command": "/absolute/path/to/non-sending-channel-probe",
      "args": [],
      "cwd": "/absolute/trusted/working-directory",
      "environment": []
    }
  }
}
```

The provider capability must contain `projection.read` and `proposal.publish`.
The distinct subscriber capability must contain `projection.read` and
`projection.subscribe`. The endpoint launcher is the operator-owned production
binding of `AiEndpoint`; the harness does not load root keys or infer a live
store.

## Provider adapter contract

The harness sends one public JSON request on stdin:

```json
{
  "schema": "rapp-work.controlled-local-provider-request/1",
  "mode": "proposal-only",
  "root": "<exact root>",
  "scope": "root",
  "request": "<operator-selected thought>",
  "context": { "schema": "rapp-work.proposal-context/1" },
  "allowLiveEffects": false
}
```

The adapter uses only its explicitly forwarded credential environment and
returns one JSON object:

```json
{
  "schema": "rapp-work.controlled-local-provider-draft/1",
  "fixture": false,
  "provider": "operator-selected-provider",
  "model": "operator-observed-model",
  "credentialBinding": "environment",
  "liveEffectsPerformed": false,
  "draft": {
    "summary": "Public review summary",
    "tradeoffs": ["Material tradeoff"],
    "questions": [],
    "actions": [],
    "resolves": []
  }
}
```

The core revalidates the Draft, context revision, grant scope, action vocabulary,
references, rate and byte bounds. A provider adapter cannot publish
`resolves`, confirm the proposal, or apply its actions.

## Private-channel probe contract

The harness sends only an inspect request containing the exact root and
`channel.bound` wave. It sends no message body, delivery ID or approval:

```json
{
  "schema": "rapp-work.controlled-local-private-channel-probe/1",
  "mode": "inspect-only",
  "root": "<exact root>",
  "bindingWave": "<exact channel.bound wave>",
  "allowLiveSend": false
}
```

The operator-supplied probe must inspect the real local TCC/contact binding and
return sanitized evidence:

```json
{
  "schema": "rapp-work.controlled-local-private-channel-evidence/1",
  "fixture": false,
  "root": "<exact root>",
  "bindingWave": "<exact channel.bound wave>",
  "channel": "imessage",
  "tcc": "authorized",
  "contact": "bound",
  "passiveOnly": true,
  "liveSendPerformed": false,
  "observedUtc": "2026-09-14T07:00:00.000Z",
  "evidenceRef": "operator-controlled-local-probe-receipt"
}
```

`tcc:"missing"`, `tcc:"denied"`, `contact:"missing"`, a mismatched root/wave,
or `liveSendPerformed:true` is a hard failure. The harness never calls
`channels.deliver`, `channels.flush`, a transport `send`, or an external-effect
approval.

## Two-phase run

Set the explicit opt-in and all named environment bindings, then run:

```sh
RAPP_WORK_CONTROLLED_LOCAL=1 \
  npm --prefix next run proposal:controlled-local -- \
  --config /absolute/path/to/config.json
```

Phase one:

1. checks opt-in, real-provider credential environment, two distinct RAPP
   capabilities, endpoint bindings, and the non-sending TCC/contact probe;
2. launches separate provider and passive-subscriber MCP connections;
3. reads `rapp_work_context`;
4. asks the configured provider adapter for a structured Draft;
5. publishes it through `rapp_work_propose`;
6. proves `rapp_work_confirm` is unavailable to that client;
7. waits for the passive subscriber to observe `status:"review"`; and
8. writes a 0600 **pending** evidence file outside the canonical store.

The harness stops with `ownerConfirmation.performedByHarness:false`. The owner
reviews the exact Draft and separately runs the owner-only command:

```json
{"id":"owner-confirmation","method":"organization.confirm","params":{"root":"<exact root>","proposalWave":"<exact pending proposal wave>"}}
```

Then start a fresh process and verify reconstruction:

```sh
RAPP_WORK_CONTROLLED_LOCAL=1 \
  npm --prefix next run proposal:controlled-local -- \
  --config /absolute/path/to/config.json \
  --verify /absolute/path/to/pending-evidence.json
```

Phase two accepts only the exact pending wave whose canonical proposal status is
now `applied`, with the same Draft and digest, as observed by a fresh passive
subscription after restart. It reruns the non-sending private-channel probe and
writes a separate result. It still performs zero sends and zero confirmations.

No controlled-local receipt is committed by default. If real credentials,
owner signer custody, TCC, contact binding, or exact owner confirmation are not
available, retain the failure as the result; do not edit a fixture receipt into
a passing claim.
