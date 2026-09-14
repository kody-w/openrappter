# Binding primitive mapping

Selected authority: **rev-15**, canonical main verified at
`dda32d741c7218f41443a5bd17eebfe0eae82cb7`; head wave
`83ca275f35cca96e43d75c99d338326c1a39b2240eabf57eb7c29ac96cc90818`,
particle `1ac47416e9caf174c4fdc00265ca187c244fb701ae2a7fb7211ba1385a951310`.
Normative text SHA-256:
`348e7d5baa94aaf2ce4c5354f3cb261f389298a04af65e271a686d3b62f7c384`.

| Product concern | Existing RAPP/1 primitive |
|---|---|
| One visible RAPPbot | Full canonical `rappid:@owner/slug:64hex`, mint once from UUID octets or keyed SPKI |
| Root/world definition | Root `body.pulse` genesis particle |
| Internal recursive organization | Inert, scoped data in existing `memory.save` / `memory.tool-call` payloads |
| User and assistant public turns | `memory.chat-turn` |
| Reviewed bounded work and meaningful outcomes | `memory.tool-call`, exact source particle + wave references |
| Continuity and attention | Reconstruction of verified frames; no secondary store |
| Clear / restore | Successor visibility particles; same root and history |
| Corrections / undo | Successor correction particles; original evidence remains |
| Unattended recurring recap | Owner-launched operational scheduler lease plus deterministic root/routine/UTC operation ID; completed work is one source-owned `memory.tool-call`, never lease state |
| Cross-bot public requests and perspectives | Signed `swarm.guidance` / `swarm.echo`, original roots and stream ancestry |
| Read-only transcript projection | Canonical Dream Catcher ordering (UTC then wave), distinct GUID speakers |
| Native AI estate | Inert canonical evidence referencing native handles; no copied native schema/store |
| Dormant bot / observed wave | Canonical particles at rest / transient interpreter projection |
| Egg | Existing rooted canonical bytes; no alternate export representation |
| GODD/DOGG | Existing adopted declared-domain authority, never filename inference or frame filtering |
| Local Hive | Existing signed Private Hive authority/verifier boundary; no invented membership or taxonomy authority |
| Provider-neutral AI clients | Explicit root-signed `memory.save` capability grants/revocations; host/provider labels do not mint visible bots or grant authority |
| Attributed AI public turns / activity | Existing `memory.chat-turn` / `memory.tool-call`; actor is selected by the authenticated canonical grant |
| AI focus/layout/cards/progress hints | Closed payload data in existing `memory.save`, or a bounded optional hint on a public work frame; never executable UI |
| Multi-client view conflicts | Explicit prior canonical view-wave references; multiple unconsumed heads remain visible, not last-writer overwrite |
| Real-time UI projection | Bounded disposable subscriptions with exact canonical root/stream/sequence/wave cursors and replay; no UI database |
| Migration staging/rollback | Owner-signed existing `memory.save` control stream; immutable source chunks, explicit approved closure, no parallel migration database |
| Root migration | Exact original canonical frame files and branch ancestry, atomically published with one authorized successor receipt; never remint/rewrite |
| Estate/native/archive migration | Canonical pointer successor events with unchanged source identity and honest provider/compatibility classification; no native content copy |
| Migration display proof | Real application cursor events consumed by a separate passive process; static replay is an observed test artifact, not UI authority |
| Catch me up | Pure projections of exact canonical cursor ranges, with source wave hashes and state/page digests in existing `rapp/1:particle`; no replay store or execution |
| Optional guest replay | Existing canonical ComputerBroker intent/outcome/evidence and artifact receipts, plus separately selected private capture policy/safety authority; guest pixels recorded, command/diff views reconstructed, absence unavailable |
| Source-owned action exhaust | Existing root-signed memory streams, one exact original internal scope per new stream; no duplicated central journal |
| Global Estate/Librarian/recap/collaboration continuity | References to original source GUID/scope/particle/wave and branches, resolved transiently |
| Multi-source cursors | Exact canonical source head and branch references; causally closed cuts and set-difference replay, not a new global clock/store |
| Historical centralized exhaust | Original immutable root-memory bytes, explicitly `legacy-root-stream`; no transformation or retroactive reassignment |

Application event names live **inside** payloads. They are not new frame kinds,
wire fields, protocol registries, or protocol versions. The frame remains exactly
the canonical eleven keys. A body frame cannot be replayed on a memory or swarm
stream. Each bot's keyed signer must match its full root identity; another
otherwise trusted registry key cannot impersonate it.

The source key is an existing particle digest used only as a disk locator.
The full original root RAPPID plus exact internal scope remains the identity;
no world GUID is derived or reminted for logging. See `SOURCE_OWNERSHIP.md`.

## Deliberate adoption, not compatibility

The old isolated RAPP/1 package has no app imports and implements the wire frozen
by rev-15. Only its low-level functions are adopted. Its old checkpoint labels,
old application evidence helpers, workspace store and security/service layers
are not exported by the new boundary. Independent emitted-frame checking uses
unmodified rev-15 `rapp.py` and `rapp_check.py`, with the reference detached-JWS
callback supplied an explicitly selected fixture registry for signed examples.
The bootstrap verifier checks all sixteen authority frames. Tests and gates fail
on zero artifacts, source drift, invalid signatures, wrong root signers and
noncanonical stored bytes.
