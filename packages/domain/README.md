# @rapp-work/domain

Typed application payloads and pure, fail-closed reducers. Dependencies are the
canonical protocol and shared security operation/path contracts. There is no
filesystem, database, provider, runtime discovery or clock in the workspace
reducer. No compatibility snapshots or JSON event log can become authority.

## Source and evidence

`buildDomainPayload(event)` creates exactly:

```text
{ subject, data: event, protocol_revision }
```

Subjects percent-encode IDs and include the owning agent. `validateEvent` and
`validateDomainPayload` enforce exact keys, owner IDs, finite bounded integers,
NFC newly authored text, enum values, operation binding, references, artifact
paths and schedule cadence. Unknown events and substituted subjects/authority
fail rather than producing partial projections.

`eventFrameKind(type)` selects an existing registered kind:

| Application data | RAPP/1 source kind |
| --- | --- |
| Agents, tasks, schedules, pending approvals, memories, artifacts, computer references | `memory.save` |
| Runs, approval decisions, accepted/permitted intents, outcomes/reconciliation | `memory.tool-call` |
| Business-thread messages | `memory.chat-turn` |
| Shared-computer observations in its own history | `body.pulse` |

Agent memory transitions require one linked `body.pulse` evidence occurrence
using the unchanged canonical evidence schema. Intent/permit/outcome evidence
also binds request, accepted intent, permit and prior outcome hashes where
applicable. No application event introduces a new wire kind or hash domain.

## Rebuilding

```ts
const projection = reduceWorkspace({
  agentId, workspaceId,
  body: bodyScan,       // module-owned, full committed VerifiedChain | null
  memory: memoryScan,   // same producer's :work stream
  computer: computerScan, // required when computer receipts are referenced
});
```

The result is a deeply frozen reconstruction of agents, tasks, schedules, runs,
approvals, messages, memories, artifacts, intents, outcomes and their source/
evidence provenance. Null body and memory mean no agent record yet; one missing
history is an error. Copied scan objects and uncommitted extensions are refused.

State-machine invariants include:

- one agent definition; explicit pause/resume/retirement and policy replacement;
- task/run ownership, one active attempt, ordered checkpoints, cancellation,
  explicit retries bounded by the task's maximum of 1–10 attempts;
- single approval decision and consumption bound to exact principal, operation,
  resources and expiry;
- single operation ID, accepted intent, permit reservation and terminal outcome;
- a spent permit without an outcome reconstructs as **unresolved**, never
  replayable work; reconciliation requires an explicit linked outcome/run frame;
- immutable artifact IDs/paths, append-only messages, and inert text memories;
- agent-owned interval/five-field cron schedules with exact due occurrences,
  template-bound fresh tasks, pause/resume/retirement and no duplicate firing.

`buildComputerPayload` and `reduceComputerHistory` model only the one
application-owned Omarchy VM's canonical body observations, lifecycle lease and
valid state transitions. Agent-local references cannot manufacture a VM state;
the referenced receipt must exist in the separately supplied trusted computer
history. Reducers prove recorded integrity, not physical VM availability or
factual accuracy. The broker remains responsible for actual availability and
guest-only enforcement.

Run `npm test --workspace @rapp-work/domain` for replay-from-bytes, every event
mapping, complete lifecycle and adversarial transition tests.
