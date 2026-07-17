# iMessage reliability contract

This document is the maintenance contract for the macOS iMessage channel. Code
changes are acceptable only when they preserve these invariants or replace them
with stronger, tested guarantees.

## Boundaries

- **Transport:** `IMessageChannel` reads `chat.db`, applies authorization and
  message-shape policy, and performs Apple Events sends.
- **State:** `IMessageStateStore` owns the cursor, inbound jobs, conversation
  history, outbox chunks, migration, and persistent health.
- **Worker:** `IMessageRuntime` handles commands, inference, retries,
  reconciliation, reconnects, and readiness.
- **Supervisor:** the GUI LaunchAgent owns the gateway when iMessage is enabled.
  An existing system daemon remains as a lease-aware sentinel, resumes after an
  interrupted handoff or sustained GUI-gateway outage, and must never bind the
  same port concurrently.

No boundary communicates through natural-language agent-to-agent prompts.
State transitions and health use typed structures.

## State machines

Inbound:

```text
queued -> processing -> response_ready -> delivering -> completed
   |          |               |              |
   |          +-> retry_wait -+              +-> ambiguous
   |                                         +-> dead_letter
   +-> stale_pending --(/resume)--> queued
```

Outbox:

```text
ready -> preparing -> sending -> confirmed
            |            |
            +-> retry_wait
                         +-> ambiguous
                         +-> dead_letter
```

`sending -> retry_wait` is forbidden. Only a user-issued `/retry` may return an
ambiguous chunk to `ready`.

## Error classification

| Boundary | Safe automatic action |
|---|---|
| Database read/query before ingest | Retry with bounded backoff |
| Model timeout/empty response | Retry up to the model attempt limit |
| Missing model credentials/home | Persist a visible failure reply; degrade readiness |
| Outbox `preparing` failure | Retry indefinitely with capped backoff because send has not started |
| Send invocation or timeout after `sending` | Reconcile; never blindly resend |
| Confirmation query unavailable | Reconcile until grace expires, then ambiguous |
| Removed allowlist target | Dead-letter unsent work; preserve sending work as ambiguous |

## Required fault tests

Every release must cover:

- invalid metadata rolls back without cursor movement
- duplicate GUID ingest
- stale hold and `/resume`
- per-chat ordering and cross-chat progress
- process crash in `processing`, `preparing`, and `sending`
- model timeout and permanent authentication failure
- Unicode chunk boundaries
- partial multi-chunk ambiguity
- send persistence despite an invocation error
- confirmation query failure past grace
- removed allowlist target
- corrupt legacy migration input
- cursor beyond a replaced Messages database
- startup reconnect and readiness/liveness separation
- exclusive process lock
- launchd plist validity and private permissions

## Release gates

1. No unauthorized message reaches persistence, inference, or delivery.
2. Every accepted GUID has a durable terminal record.
3. No tested crash boundary creates a duplicate reply.
4. A model failure cannot stop cursor progress.
5. Per-chat replies are ordered.
6. Recoverable dependencies are retried within 60 seconds.
7. `/livez` remains available while `/readyz` explains degradation.
8. Database and log paths remain private.
9. A live nonce canary completes through an allowlisted phone.
10. The deployed runtime, launchd entry, lock owner, and repository release are
    recorded before publication.

Gateway ownership uses a dedicated SQLite `BEGIN EXCLUSIVE` transaction, which
is released by the kernel on process death. `gateway.pid` remains advisory for
the installer and is never the ownership primitive.
