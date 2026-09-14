# Binding release gate: observed full-estate migration

**A green core/API is not release acceptance.** The new application must start
with an empty isolated migration profile, populate it only through its public
provider-neutral API, and have a separate passive client display canonical
additions while they occur. Source current profiles remain untouched until
final integration approval.

There are two distinct results:

1. **Sanitized observed fixture gate** — necessary, executable now.
2. **Approved controlled-local estate gate** — mandatory before release; not
   claimed by fixture success. Current live canonical adoption/signer/source
   bindings remain an explicit stop condition.

## Execute the fixture gate

```sh
npm --prefix next run migration:gate
```

The gate is also mandatory in `npm --prefix next run check`, after the existing
core, provider-neutral and canonical checks. It launches:

- **NEW application:** `next/dist/migration-app.js`, not an old host/app;
- **separate passive projection process:** `next/test/migration-consumer.mjs`;
- **isolated browser:** existing Playwright/system Chrome with a new profile
  below the run's project-local evidence directory, never a live browser profile.

The driver prepares only a sanitized **source** tree and evidence outputs.
It never creates/populates destination files. The application alone creates the
empty destination and mutates it in response to public stdio operations.

## Full source selection exercised

`fixtures/migration-estate.json` specifies:

- 2 existing compatible, signed canonical root fixtures, retaining their original
  full GUIDs, one hidden root, complete scopes, memories, artifacts, capability
  references, scoped source streams and both root/source branches;
- 14 selected Workspace Manager pointers: manager, Global Estate, Monorepo,
  Copilot Builder, Microsoft CEO, LLC Autofile, LLC Private, RAPP, RAR,
  ambient-context, AIdeate, herdr, Copilot Harness SDK and RAPP Factory;
- all 5 native providers: Copilot, Claude, Hermes, Scout and Grokbot;
- 2 old/incompatible archives, explicitly historical/unavailable, including
  retention of an original historical root RAPPID.

The compatible fixtures deliberately use the exact supported
`rapp-work.next/root/1` payload contract. This is not a claim that arbitrary
existing legacy Work payloads have become compatible. Unsupported source
profiles remain pointers; they are never reinterpreted or rewritten.

The full fixture has **23 items, 2 root GUIDs, 44 scoped organs, 21 pointers,
4 canonical artifacts and 2 branches**. All requested recursive forms occur:
worlds/workspaces, one Librarian/root, agents, Twins, neighborhoods, factories,
rapplications, tasks, routines, memories, artifacts and evidence. The 10 world
scope occurrences and every selected item are observed in the live display log.
The source fixture now also includes an explicitly historical centralized scope
occurrence; it remains byte-identical and is never relabeled source-owned.
Positive branch retention uses exact original ancestry prefixes. Actual
conflicting same-stream forks are separately preserved in adversarial fixtures
and refuse semantic import/publication until canonical owner resolution; the
active directory is not an implicit resolution rule.

## Public migration API

Requests use the existing provider-neutral stdio framing and exact selected
owner root. The separately supplied migration capability is connection-owned;
it is never a field granting authority in a skill or publication.

| Operation | Effect |
|---|---|
| `rapp_work_migration_read` | Read-only canonical estate/transaction projection |
| `rapp_work_migration_subscribe` | Passive event stream; optional exact current cursor hash |
| `rapp_work_migration_begin` | Bind a signed complete source selection to an empty isolated profile |
| `rapp_work_migration_start_batch` | Select explicit approved item IDs |
| `rapp_work_migration_stage` | Stage one exact canonical file chunk or selected pointer |
| `rapp_work_migration_prepare` | Verify complete closure, application compatibility, signatures, hashes and lineage |
| `rapp_work_migration_commit` | Atomically publish one whole root or append one pointer outcome |
| `rapp_work_migration_rollback` | Abort an incomplete-only batch; retain forensic data, delete no committed root |
| `rapp_work_migration_finish` | Require every selected item and exact counts/forms/provenance; never turn fixture authority into release approval |

The root-scoped generic AI endpoint does not acquire these owner migration
rights merely because its skill is installed. No shell, arbitrary path write,
delete, identity remint or live-adoption override exists on this interface.

## Canonical transaction model

Coordination and staged source bytes live in a signed existing `memory.save`
stream, `<approved-owner-RAPPID>:migration`, under the same canonical frame
repository. This is an internal coordination organ, not a visible extra bot,
database or new Egg format.

Each source chunk is bound to the approved complete file table and SHA-256.
Preparation verifies every file, exact original root, application schema,
signature, sequence, particle/wave predecessor and full branch ancestry.
There is no repair, transformation, filtering or partial-root promotion.

The application materializes verified original frame bytes in an unpublished
canonical tree, appends one signed successor migration receipt to that root's
original memory head, fsyncs, then atomically renames the complete tree into
the active bot catalog. All original source files remain byte-identical.
Pointers append ordinary canonical successor events with original provenance,
classification and source identity in the exact target source scope's stream;
they do not copy native private content or emit a duplicate central activity.
Complete scoped frame/branch directories are part of the approved byte closure.

An aborted unpublished tree is retained as evidence and is not an active bot.
Rollback appends canonical correction/control evidence, never a deletion.
Committed work is not rolled back by an incomplete-only operation. Retry of a
published item returns its original receipt, preserving any history.

## Required observed assertions

The executable gate verifies:

1. Empty destination before application start; zero harness destination writes.
2. Live application and separate passive projection process.
3. Public API calls only, one batch/item/chunk at a time.
4. Cursor/event/display logs containing each root, world scope and pointer.
5. Exact expected counts, GUIDs, hidden state, all form types, classifications,
   provider provenance, lineage, artifacts and no duplicate source identities.
6. Original canonical source file bytes unchanged in the destination prefix,
   plus successor receipts; full branch retention.
7. Incomplete closure refusal and a fixture fault after one unpublished
   canonical file is materialized, followed by public incomplete-batch rollback.
8. Controlled SIGTERM interruption drains filesystem critical sections while
   leaving a batch incomplete. Restart deduplicates its staged chunk and resumes.
   Arbitrary SIGKILL/power-loss stale locks are **not** silently stolen.
9. Both service and display restart; byte-identical reconstructed projection,
   same cursor and idempotent retries with no new imported items.
10. Source file hashes/size/mode/inode/timestamps and directory metadata compare
    before/after. Private native transcript markers never enter the destination.
11. Exact rev-15 checker scans nonzero signed active, control and retained
    unpublished canonical frames. Active and retained counts are distinct.
12. The actual delivered replay is cold-loaded and reloaded offline with zero
    page/resource/network errors, both themes, desktop/mobile widths, keyboard
    controls and repeated playback/reset/seek interactions.
13. Source scope heads/branches and legacy ownership are reconstructed from
    original frames. Global Estate/Librarian/recap/Catch-up may reference these
    streams, never replace them with a copied activity store.

## Evidence

Each run writes below `next/.test-scratch/migration-observed-…/`:

- `release-gate.json`, `result.json`, `browser-verification.json`;
- `events.jsonl`, `passive-display.jsonl`, `public-api-calls.json`, `processes.json`;
- source-before/source-after inventories and the explicit fixture registry;
- `migration-replay.html` and four theme/viewport screenshots;
- separate source and destination trees for independent inspection.

The replay embeds the **actual observed passive-client output**, not a fabricated
animation of expected counts. It performs no runtime fetch/model/store write.
It is a test artifact, not implementation of a full product UI.

The separate mandatory Catch me up gate (`CATCH_ME_UP.md`) verifies pure
frame/cursor replay, provenance grades, source hashes and state digests, including
the optional separately authorized GODD/private Omarchy lane. Neither replay
gate replaces the approved controlled-local migration requirement.
