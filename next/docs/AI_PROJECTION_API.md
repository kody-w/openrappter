# Core requirement: provider-neutral AI proposals and projection

Any permitted AI host uses the same portable RAPP Work Bot skill and connects
to the **same root RAPPID**. It can read capability-scoped canonical context,
publish a validated structured Draft for owner review, and publish public work
or declarative projection intents. Provider labels are data, never selectors or
privilege. The UI remains an unimplemented, disposable subscriber, never a
state authority.

## Canonical primitive mapping and authority

- Client grants/revocations and view/evidence/attention publications are existing
  `memory.save` frames; public conversation is `memory.chat-turn`; public activity
  is `memory.tool-call`. No RAPP/1 kind, envelope field, database, or protocol is
  added. The existing rev-15 authority/checker remains exact.
- The authenticated root owner issues bounded, scoped client credentials.
  Only a digest is retained in its signed canonical grant; plaintext is returned
  once and held by the AI host, never the skill or conversation.
- Every accepted publication is signed by the root and attributed to the client
  selected by the verified credential/grant, not to a client-supplied identity.
  This is **root-attested capability attribution**, not a claim that a vendor or
  person cryptographically signed the text. Native client-key non-repudiation is
  not invented.
- Provider names are operator-assigned labels, not model selectors or authority.
  No server inference, provider fallback, native-memory import, or memory merge
  occurs through this API. The built-in Copilot adapter remains separate.
- `proposal.publish` permits only a signed, attributed, review-only
  `client.proposal`. The Draft is bound to the exact revision returned by
  `rapp_work_context`, fully validated against the existing action vocabulary
  and scope, and cannot claim an owner answer through `resolves`.
- The restricted endpoint exposes no confirmation method. Only the owner-facing
  `organization.confirm` command can name the exact current proposal wave and
  atomically apply its bounded actions. Proposal publication itself is not
  mutation authority.
- Skill instructions do not grant rights. Exact root GUID, active capability,
  permitted scope and operation rights are checked before reads or publication.
  Issuance/revocation is local owner administration, not an AI/MCP tool.

## Declarative view vocabulary

`rapp-work.view-intent/1` contains only a canonical scope focus, one closed layout
emphasis (`conversation`, `work`, `evidence`, `review`), at most eight canonical
artifact/evidence/activity/attention/routine cards, an optional canonical activity
reference for progress, and an optional already-registered artifact reference for
a screen/preview. It carries no pixels, markup, DOM selectors, coordinates,
HTML/JS/CSS, component names, executable code or arbitrary URLs.

Every reference must exist in the bot's authorized canonical state. A screen
reference is a reference to an existing artifact, not screenshot capture,
arbitrary file access, or a promise that a renderer supports its media type.
Unsupported hints are refused; a useful work publication with an unsupported
optional hint still persists its work and only a bounded refusal diagnostic.

## Causality, conflicts, restart

Publications carry canonical causal references and a per-client idempotency ID.
View parents explicitly acknowledge prior view occurrences. Concurrent views
retain multiple heads and expose a conflict; the UI never silently chooses the
last writer. Consuming other clients' view heads requires explicit `view.resolve`
authority. This does not merge identities, native memory or histories.

All visible state is reconstructed from the same signed original source frames.
New publications live in the authorized event scope's memory stream, not a
copied root activity log. `view.focus` does not change that ownership. A
root-authorized Global Estate/Librarian view can reference multiple worlds;
the surface name does not grant sibling access to a child-scoped client.

Observation/subscription appends nothing. Reconnect cursors bind the root GUID
and a causally closed vector of original source heads/branches; closed root-only
histories retain scalar heads. Replay advances by unseen original occurrences,
so independent source clocks cannot skip work or displace a prior selection.
No model or tool executes. Expired/revoked credentials and invalid cursors refuse.
Backpressure closes a slow subscriber with an explicit resync requirement;
canonical work stays intact and can be read through bounded history pages.

The full bounded stream/MCP setup, skill installation and verification are
documented alongside the implementation in this milestone. There is no product
UI; only a tiny test consumer verifies transformation semantics.

## Interfaces and setup

The owner-facing runtime adds `clients.grant` and `clients.revoke`. These are
**not** exposed by the AI endpoint. A grant selects a canonical attributed
client ID, provider/name labels, one internal scope, a 1–86400 second lifetime
and explicit rights:

`projection.read`, `projection.subscribe`, `conversation.publish`,
`activity.publish`, `evidence.publish`, `attention.publish`,
`proposal.publish`, `view.publish`, `view.resolve`, and the separately opt-in
private `guest.replay`.

Each AI connection receives an exact root GUID and a high-entropy capability
through protected host configuration. Only a capability digest is stored.
Rotation preserves the client ID but invalidates the old credential; a lost
one-time issuance response cannot be recovered from canonical history.

Restricted tool names:

| Tool | Purpose |
|---|---|
| `rapp_work_read` | Scoped deterministic snapshot; optional transcript offset/limit |
| `rapp_work_context` | Bounded canonical planning context plus exact revision; read-only |
| `rapp_work_catch_up` | Deterministic graded canonical timeline; optional private guest replay requires extra authority |
| `rapp_work_artifact` | Already-canonical artifact content, no path/URL access |
| `rapp_work_history` | Bounded replay/history page; credentials/control payloads are redacted |
| `rapp_work_publish` | Public work plus an optional validated declarative hint |
| `rapp_work_propose` | Validated structured Draft bound to an exact context revision; review-only |
| `rapp_work_subscribe` | Disposable cursor-based event resource |
| `rapp_work_unsubscribe` | Close only this connection's subscription |

The packaged CLI accepts `--root`, `--store`, `--mcp` or `--stdio`, and an
explicit test-only `--fixture` bootstrap. `RAPP_WORK_CAPABILITY` is taken from the
host's protected environment, never from tool arguments, clientInfo, the skill,
or a URL. The fixture bootstrap uses public test signers and cannot qualify a
real deployment. A production host supplies its already-bound runtime, registry
and signer custody:

```js
// Inside the operator-owned trusted host, with its existing runtime:
const writer = new BoundedWriter(process.stdout);
const endpoint = new AiEndpoint(runtime.ai, exactRoot, scopedCapability,
  "mcp", message => writer.send(message));
await serveAi(endpoint, process.stdin, writer);
```

The generic skill contains exact demo/setup commands. No root-key reader,
authentication profile discovery, per-client native store or automatic provider
startup is added. The standalone bootstrap does not silently acquire production
root keys. MCP/stdio is implemented; a loopback HTTP/WebSocket listener remains
unimplemented rather than being exposed with weaker authentication.

## Structured proposal contract

`rapp_work_context` requires `projection.read` and returns
`rapp-work.proposal-context/1`: the same bounded canonical context used by the
organization path, the exact authorized scope, and a deterministic revision.
Reading it appends nothing and runs no model.

`rapp_work_propose` requires both `projection.read` and `proposal.publish`. Its
input is `contracts/ai-proposal.schema.json`, whose Draft is defined by
`contracts/draft.schema.json`. The server rejects stale revisions, unknown
fields/actions, scope escape, invalid references, private-reasoning markers,
missing action-to-tradeoff links, vacuous tradeoffs, already-known clarification
dependencies, no-op proposals and external attempts to populate `resolves`.
The accepted root-signed `client.proposal` keeps the authenticated
actor/grant, request digest, context revision, validated Draft and Draft digest.
It is mapped to the existing `memory.chat-turn` frame kind; no RAPP/1 kind or
wire field is added.

The proposal receipt and passive projection explicitly report
`confirmationAuthority:"owner-only"` and `mutationAuthority:"owner-only"`.
Until the owner confirms the exact current wave, the proposal remains
`status:"review"` and creates no scope, artifact, routine, pointer or external
request. A stale or wrong wave refuses. After owner confirmation, restart
reconstructs the proposal as `applied` and the resulting canonical state from
the same frames; no provider call is replayed.

## Accepted publication and event contracts

Machine-readable contracts:
`contracts/ai-publication.schema.json`, `contracts/ai-proposal.schema.json`,
`contracts/draft.schema.json`, `contracts/proposal-context.schema.json` and
`contracts/view-intent.schema.json`.
Original occurrence addresses and reconnect cuts are defined by
`contracts/source-reference.schema.json` and `contracts/source-cursor.schema.json`.
The envelope's optional hint is untrusted input; the latter schema and canonical
state validation define what can actually be accepted.

A publication supplies `kind`, closed `content`, causal wave references,
optional scope, optional `view`, and explicit `viewParents`. The authenticated
method also supplies one stable per-client request ID. Caller `actor`, provider,
role, authority, HTML or executable fields cannot impersonate a client.
Conversation publications are assistant/public-client turns, never fabricated
human approval.

The resulting canonical record retains the root-signed actor/grant reference,
request digest and causes. It never retains a credential or rejected UI code.
Public activity and evidence are attributed observations, not proof of factual
truth or a claim that the core executed the client's tools.

An event has `schema:rapp-work.projection-event/1`, disposable subscription ID,
`type:snapshot|update|resync-required`, exact cursor and previous cursor,
reconstructed snapshot, optional reason and replay flag. The snapshot has
explicit client attribution, scoped artifact metadata, bounded public history,
activity/evidence/attention and a view status:
`none`, `resolved`, `conflict`, or `invalidated`.

Turns/contributions/history retain their original `origin` and source hashes;
authorized `sources` exposes source heads and unselected branches. Source
catalogues are reconstructed references, not a new store. A branch-only update
may report `retained-source-branches-changed`; it never selects/replays the
branch. A signed peer request/echo can report `transcript-changed` even when the
local memory cursor is unchanged. Transcript pages expose explicit total,
offset, limit, truncation, navigation offsets and revision. These are additions
to the unreleased `/1` contracts, not rewrites of historical frames or an
adoption path for older profiles.

Corrections that remove a referenced artifact invalidate its projection hint,
not its recorded work. Pending view heads are bounded; reaching the bound
requires explicit conflict resolution, not silent eviction.

## Transport bounds

| Boundary | Limit |
|---|---|
| Publication | 32 KiB; 60/client/minute derived from canonical frames |
| Connection | 64 KiB input line; 120 requests/minute |
| Snapshot/history page bytes | 256 KiB |
| Visible conversation/contribution window | 16; older work remains pageable |
| History page | At most 16 canonical occurrences |
| View cards / pending heads | 8 / 16 |
| Clients/root / subscriptions/process | 32 / 16 |
| Subscription queue | 8 events / 512 KiB |
| Reconnect replay | 32 occurrences; larger gaps explicitly require resync/history paging |
| Subscription lifetime | Five minutes, and never beyond active credential authority |
| Output queue | 64 messages / 1 MiB, with a two-second drain deadline |
| Canonical polling | 250 ms only for active subscribers; no model compute |

Publication/acknowledgement is separate from a slow subscriber. On overload the
disposable stream terminates with resync, or the bounded pipe closes. The client
reuses its last applied cursor and stable publication ID; canonical work is
neither erased nor replayed as model/tool execution. Revocation fences subsequent
reads/publications and queued data at polling/drain authorization boundaries.
Already transmitted bytes cannot be retracted.

## MCP profile

The adapter implements MCP stdio `2025-11-25`: initialize/version negotiation,
initialized notification, ping, tools/list, tools/call, resources/list,
resources/read, resources/subscribe and resources/unsubscribe. Resource updates
use `notifications/resources/updated`; clients then read bounded event content.
No sampling, roots, shell, owner administration, exact confirmation or external
approvals are advertised. Native stdio uses the same restricted methods and
pushes bounded `event` messages alongside responses.

Official protocol references used:
- https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle
- https://modelcontextprotocol.io/specification/2025-11-25/server/resources

## Portable skill installation

Canonical source: `next/skills/rapp-work-bot/SKILL.md`.
The requested current-host installation is
`~/.copilot/skills/rapp-work-bot/SKILL.md`, byte-identical to that source.
Other hosts can consume that one file in their supported skill/instruction
location; no host-specific behavioral rewrite is needed.

Only this instruction file is installed. No credential, MCP configuration,
provider profile, native memory, live root or Mirror Mode file is changed.
The skill passes the installed RAPP Skills checker as a plain playbook; no
legacy agent wrapper or alternative runtime is generated.

`rapp_work_catch_up` does not append or execute anything. Its recorded/
reconstructed/unavailable grades, source hashes, state digests and optional
GODD/private Omarchy lane are specified in `CATCH_ME_UP.md`. The optional guest
lane is not enabled by `projection.read` or a skill file alone.

The opt-in real-binding acceptance contract is
[CONTROLLED_LOCAL_PROVIDER_PROPOSALS.md](CONTROLLED_LOCAL_PROVIDER_PROPOSALS.md).
It requires real provider credential environment, distinct proposal/subscriber
capabilities, and an inspect-only TCC/contact probe. It writes no passing
evidence when any binding is absent and never performs a live send.
