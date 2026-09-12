# @rapp-work/workspace-store

Private, per-agent canonical persistence. Depends only on `rapp1`, the scoped
`security` contracts, and Node filesystem primitives.

## Ownership and API

The host creates a `SecurityAuthority`, authenticates its principal, and
authorizes an opaque capability for an exact `agentId`, `workspaceId` and
`workspace:<workspaceId>` resource. Store-wide access uses `taskId: null`.
IDs received over RPC are locators, **not** these capabilities.

```ts
const store = await WorkspaceStore.open({ root: absolutePrivateRoot, security });
const workspace = await store.create(capability, { owner: 'owner', slug: 'agent' });
const before = await workspace.scan();
const after = await workspace.compareAndAppend({
  expectedHeads: before.heads, // body, memory and swarm; null means empty
  frames,                    // already-built canonical RAPP/1 frames
});
```

`store.open(capability)` reuses the existing identity. Identity, principal,
agent, workspace, authority, stream forms, file permissions and current grants
are rechecked on access. Creation mints one canonical keyless identity; an
existing directory with a missing/damaged identity is never automatically
reminted. Display/configuration changes belong in domain frames, not identity
replacement.

The layout is `identity.json`, `manifest.json`, `frames/{body,memory,swarm}`,
`artifacts`, `imports`, plus private lock/transaction control files. The
manifest contains only identity/authority binding and committed chain
genesis/heads, not task/approval/run state.

## Durability and crash behavior

Every read scans **every** committed frame, validates exact canonical bytes,
filenames versus content, ownership, signatures, evidence uniqueness and
trusted heads. Missing/extra files, forks, symlinks, unexpected entries and
previously observed rollback fail closed. Empty streams are explicitly empty,
not fake verified genesis frames. Swarm use requires an explicit trusted
signature registry supplied at store construction.

Batch append:

1. Acquire the cross-process exclusive workspace lock.
2. Recover a known interrupted storage transaction, then fully scan.
3. Compare all three expected heads and validate the **entire** batch.
4. Fsync a journal, publish immutable frames with atomic no-replace writes,
   and fsync their directories.
5. Atomically replace and fsync the manifest: the one batch visibility point.
6. Fully rescan/read back, remove the journal, then return the new projection.

No caller sees a partial batch. An interrupted pre-commit journal can remove
only its hash-verified, not-yet-committed files. A post-commit journal must match
and scan the complete new manifest. Corrupt journals/files are never repaired
or guessed away. `CommitError.commitState` is `not-committed` before the commit
attempt or `unknown` once replacement might have occurred; callers resolve by
scanning, never by automatically repeating a business effect.

Lock ownership uses a private atomic directory and PID/token record. A live
process lock is never age-stolen. Dead processes are reaped under a separate
exclusive guard with inode rechecking. A crash during initial ownership mint,
an orphan staging file, or an interrupted reaper guard fails closed and needs
explicit operator inspection rather than unsafe automatic deletion.

Files are 0600 and directories 0700. Reads use `O_NOFOLLOW` and verify regular
file descriptors, link counts and inode continuity. Writes use private
`O_EXCL|O_NOFOLLOW` staging, fsync, no-replace hard-link publication (or a
checked manifest rename), and directory fsync. All ancestors are checked.
This is a trusted-host/private-POSIX-root boundary, **not** a kernel sandbox
against an arbitrary same-UID process racing/replacing directories or restoring
an entire old backup. Such threats require OS isolation/external checkpoints.
Unsigned local integrity is never claimed to prove authorship or factual truth.

## Artifacts

`workspace.artifact(relativePath, ['read', 'write'])` mints an instance-bound
path capability. `readArtifact`/`writeArtifact` reject copied/foreign handles,
traversal, absolute paths, percent/backslash aliases, symlinks, hard links and
permission changes. Writes are immutable and read back the bytes; their receipt
contains raw SHA-256 and length. Files alone are not domain artifact records:
the work service must commit the corresponding registration/outcome frames.
No method returns host paths, executes code, or probes legacy homes. Imported
attachments remain inert.

## Validation

`npm test --workspace @rapp-work/workspace-store` builds clean prerequisites and
tests real competing processes, process death at five commit cuts, creation
failure, corrupted recovery, capability isolation, path/link attacks, full
scans, signed swarm persistence, and real-store approval/permit CAS integration.
Test files stay under the package's ignored `.test-scratch` tree and are removed.
