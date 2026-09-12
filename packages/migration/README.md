# Inert migration planning

Migration is an explicit, separate mode. Constructing `LegacyMigration` or
`FileInertLegacyReader` does not discover paths, inspect homes, or read data.
`inventory(explicitRoots)` is the only discovery entry point. The file reader
accepts known JSON/JSONL data files, rejects executable files and symlinks, limits
reads, and detects changes during reading. It never loads modules or runs code.

Inventory output is non-authoritative and review-only. Agent records become
disabled definitions requiring new workspace/tool-policy review. Task completion
claims become draft data, not evidence; memories remain untrusted text.
Executable fields, paths, and inherited authorities are not carried forward.

`plan(inventory, selectedRecordIds, target)` requires an inventory made by that
planner and explicit selections, rereads every selected source, and rejects
hash/timestamp drift. It produces inert JSON import contents, safe `imports/`
destinations, content hashes, and **proposed** events with source hashes and
timestamps. It does not copy, import, execute, archive, or delete anything.
The host's separate import mode must authorize selected data, persist artifacts
and canonical import frames through WorkService, and verify read-back before
reporting a completed import. Sources remain unchanged.

```sh
npm run build --workspace @rapp-work/migration
npm test --workspace @rapp-work/migration
```
