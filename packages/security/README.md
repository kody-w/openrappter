# @rapp-work/security

Opaque principal, capability and single-use execution-permit contracts, backed
by canonical intent/approval receipts. No execution adapter, credential store,
global permission singleton, serialized bearer capability or host-shell path.

## Authentication is not authorization

Construct `SecurityAuthority` with mandatory trusted host callbacks:

- `authenticate(credential)` returns principal claims or rejects;
- `authorize(principal, request)` authorizes exact agent/workspace/task,
  permissions, resources and expiry;
- `executionPolicy(principal, operation)` separately permits the exact guest
  operation and determines whether approval is required.

The optional clock exists for deterministic testing; production defaults to
the host clock and fails closed on regression. Claims must be unexpired.
Principals and capabilities are frozen module-owned handles, not IDs or wire
objects. Each authority rejects another authority's handles. Attenuation can
only narrow scope, permissions, resources and expiry; parent/principal
revocation also invalidates derived capabilities.

`assertCapability` is the entry guard for services. For example, the work
service must require `approval.decide` before appending an approval decision;
an incoming `{ approved: true }` is never authority. The host must not expose
its persistence-owner capabilities or trusted policy/committer callbacks to
renderer/agent code.

## Exact guest operation

`validateOperation` requires the `rapp-work/operation/1` payload, including
operation/principal/agent/workspace/task/run IDs, exact sorted resource set,
JSON parameters and expiry. The operation allowlist contains only guest tools.
Every request explicitly names `computer:omarchy`; there is no host-shell
fallback. `operationHash` is the existing RAPP/1 particle hash of this exact
request, including parameters and resource scope.

## Durable reservation, then one execution

`issuePermit(capability, { request, intent, approvalId, commit })`:

1. Checks authentication, scope, current policy, server-clock expiry and the
   scanned, committed, occurrence-bound write-ahead intent/evidence.
2. Rebuilds any required approval from its canonical request, decision and
   evidence frames; binds exact principal, resources and operation.
3. Refuses previously permitted/terminal operations. Calls the mandatory
   `PermitCommitter` with both expected heads and one exact `intent.permitted`
   payload. This receipt also consumes its approval once.
4. Requires full canonical read-back chains, unchanged basis heads, the exact
   receipt/evidence, no duplicate reservation and canonical approval consumption.
   Rechecks expiry/revocation after the asynchronous commit.
5. Only then mints an opaque `ExecutionPermit`.

The committer is a **trusted persistence-owner contract**: it must use the
workspace store's cross-process compare-and-append, not construct an in-memory
proof or echo flags. Hashes cannot establish fsync by themselves. Missing,
failed or uncertain persistence returns no executable permit.

The broker calls `consumePermit(permit, exactRequest)` synchronously **before**
dispatch. It verifies exact binding, current grants and expiry, then destroys
the handle before returning guest-only claims. Failed dispatch cannot reuse it.
`claimGuestExecution(claims, exactRequest)` transfers those actual, authority-
owned consumed claims once to the composition's guest transport. A copied JSON
claims object, a different operation, a revoked capability or a second transfer
is rejected.
After process loss, the durable reservation prevents reminting/replay; an
uncertain business outcome must be recorded/reconciled, not executed again.
Permits are necessary, not sufficient: the broker must still verify the owned
VM's current lease/availability and enforce mediated guest resources.

Approval and chain results are integrity claims, not proof of human authorship
or factual truth. Their trust anchors come from the authenticated host store.

## Validation

`npm test --workspace @rapp-work/security` covers forged handles, attenuation,
revocation, clock/expiry boundaries, operation substitution, approval evidence,
single consumption, competing CAS reservations and asynchronous commit failure.
The workspace-store package additionally tests the contract against real disk
transactions and reopen/crash behavior.
