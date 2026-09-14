# Binding lifecycle invariant: source-owned action exhaust

An occurrence belongs to **the exact internal workspace/world scope where the
work happened**, inside its original root bot. Global Estate, the Workspaces
Librarian, collaboration, private-channel recaps, orientation and Catch-me-up
are reference-based projections. None owns a copied central activity journal.

## Identity and primitive boundary

The source address is the existing full root RAPPID + exact internal scope +
original canonical stream. This root contract does not contain independently
minted child-world GUIDs; a scope label or a digest is **not** one. No new bot,
GUID, alias registry or protocol is created for logging. Imported source RAPPIDs
and native pointer identities remain unchanged; unsupported identities are
honest historical/unavailable pointers, not inferred replacements.

`sourceKey = H("rapp/1:particle", {root, scope})` is a storage locator, not
authority. Root-owned memory stays on `<root>:work`. A non-root scope uses the
existing RAPP/1 memory-stream form `<root>:s-<first 62 sourceKey hex characters>`.
The root's independently selected signer signs each occurrence. The rev-15
eleven-field envelope, kinds, hashes, predecessor links and checker are unchanged.

```
bots/<original-root-tail>/
  body/frames/…                     # original root genesis
  memory/frames/…                   # root-owned work and immutable old history
  swarm/frames/…                    # distinct signed root public exchanges
  branches/<family>-<head>/frames/… # original root-stream alternatives
  scopes/<sourceKey>/
    frames/…                       # this exact source scope only
    branches/<head>/frames/…        # complete unselected source alternatives
```

The repository routes new memory writes using the authorized event scope,
checks the root/scope/stream/path/signature binding, and adds original scope
creation and previous-head references. Unknown parents/scopes, duplicate
operations, changed source paths and cycles refuse before publication. No
aggregate event is additionally emitted.
Internal scope IDs remain reserved after correction. A retired scope cannot be
recreated under that ID or authorize new source parents. Creation-owner and
post-candidate memory checks run before canonical publication.

## Where each operation belongs

| Operation | Authoritative occurrence |
|---|---|
| Public conversation/activity/evidence/attention | The request's permitted scope, not the current UI focus |
| Internal work and tool outcomes | The original execution scope |
| External approval and receipt | The reviewed effect's scope, linked to its original request and approval |
| Recurring work | The reviewed routine's work scope; source evidence is referenced, not copied into a recap |
| Correction/undo | A successor in the original outcome's scope, retaining its original bytes |
| A complete organization review/confirmation | The organizing request's scope; target organs refer to that creation authority |
| Root visibility and channel contact/delivery bookkeeping | Root-owned control work; no child work body is duplicated |
| Public root-to-root collaboration | Original caller/recipient swarm streams and caller-owned synthesis; no peer private memory |
| Declarative aggregate view | Its authorized author's scope, containing only references to original work |

An organization proposal is newly authored public review, not a claim that all
its target scopes executed work. Later execution exhaust belongs to its actual
source. `view.focus:"global-estate"` or `"librarian"` is not a request to move or
copy that exhaust. A root-authorized view may reference both worlds; a
child-scoped capability does not gain sibling access through those surface names.

## References, not materialized activity

`contracts/source-reference.schema.json` binds `guid`, `scope`, `stream_id`,
`seq`, `utc`, `payload_hash`, `frame_hash` and honest `ownership`. Projections,
public turns, attention, progress, history and replay retain these origins.
References do not grant access and cannot change an occurrence's owner.

New iMessage queues use `rapp-work.recap-references/1`: exact source references
plus opaque binding references/public policy, **no copied summary**. Read/delivery
derives transient text from those originals. Missing or changed originals
refuse; no cached recap substitutes for evidence. The host's outgoing transport
may deliver that derived text only under its separately bound permission.
New bindings retain only opaque references/public policy; actual private
contact, Shortcut and credential material stays in the strict runtime sibling.

Collaboration guidance references its original consent brief. A new synthesis
contains only the caller's newly authored public perspective and an exact
`responseRef` to the peer's original signed turn. It does not union/copy peer
dissent or unknowns into caller memory. The public transcript retains separate
attributed speakers, disagreements and source references. Legacy copied
brief/summary records remain readable only as immutable historical records.

`memoryFrames` is an ephemeral list of original frame objects, not another
store. Migration staging and complete branch ancestry can retain byte-identical
transport/forensic copies, but they are never counted as additional active
occurrences or fed to a central activity projection. One active original source
location owns each occurrence.

## Causality, replay and branches

Each stream preserves its original sequence and canonical ancestry. Public
reply, evidence, correction, grant, approval, delivery and view references supply
cross-stream causal edges. Authority-changing controls retain the heads they
observed, so same-UTC publication/rotation/revocation cannot be reordered into
invalid authority. Ready independent occurrences use UTC then wave as a
deterministic tie-break, never as a universal causal clock.
Organization proposals also bind a digest of the exact permitted source
context they read. New descendant evidence makes a parent/root review stale;
unrelated sibling work does not serialize a child-scoped review.

`contracts/source-cursor.schema.json` defines a **causally closed source-head
vector** with the exact root GUID, original root-memory head, opaque source
keys, source heads and retained source branch heads. A root-only closed history
can retain its original scalar frame-head cursor. A vector cannot omit a
selected record's known ancestor, forge a source, duplicate a key, change a
head or substitute a branch.

Pagination, subscription and Catch-me-up advance by the set of previously
unobserved original occurrences—not by a sum of local sequence numbers or a
single global array offset. An independently clocked source arriving later with
an earlier UTC cannot be skipped or displace previously observed work. Pinned
cursors exclude later source streams/branches rather than retroactively adding
them. A retained branch-catalogue change can trigger a passive update, without
inventing an action or selecting that branch for replay. Catch-me-up represents
an otherwise occurrence-free catalogue change as an explicit state-only step
whose previous/current cursors expose the exact change; a terminal page always
sets `next` equal to `to`. The same fork checks run before every cut, so a
conflicting retained occurrence still refuses rather than becoming state-only.

Catch-me-up reconstructs source-derived states and publishes original origins,
source hashes and canonical state/page digests. Client activity evidence and
client evidence/attention references are included in those source hashes.
Branch alternatives are not replayed as selected work. No observation,
orientation, recap, subscription or replay writes a frame or executes a
model/tool.

An actual fork is not merely an unselected presentation hint. Same-stream,
same-sequence, same-predecessor occurrences with different waves are retained
as evidence but fence both interpretations, cursor projections and successors.
There is no active-directory winner or carried resolution flag. Raw forensic
inventory remains readable; actual canonical owner resolution is required.
Positive retention fixtures use exact shared ancestry prefixes, not unresolved
forks to authorize subsequent work. See `REVIEW_FOLLOWUP.md`.

## Historical compatibility and release gate

An immutable old `<root>:work` occurrence whose payload names a child scope is
explicitly `legacy-root-stream`, not retroactively “source-owned.” It is neither
rewritten nor split into new streams. Later authorized work/correction appends
to the proper source stream and references the old original. An incompatible
application archive remains a pointer; passing wire integrity does not grant
semantic compatibility.

`npm --prefix next run source-ownership:gate` is mandatory in `check`. Tests
prove two worlds' unique marker exhaust, zero copied root/recap/peer activity,
source-attributed real-time Global Estate/Librarian transforms, scoped
capabilities, source branches, correction/effect ownership, forged vectors,
independent clocks, immutable legacy classification and frames-only restart.
The proof emits nonzero signed frames, passive event logs and Catch-me-up pages;
the exact checker and independent canonical Python digest checker verify them.

The mandatory observed migration additionally carries complete scoped streams,
a scoped branch and a legacy centralized occurrence through public API-only
migration, preserving original files and native/source inventories. This is
still sanitized fixture evidence, not the approved controlled-local release
gate. Old implementation, live profiles and existing historical receipts remain
untouched.
