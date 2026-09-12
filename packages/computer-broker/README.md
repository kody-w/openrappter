# Computer broker

`ComputerBroker` owns one host-configured Tart/Omarchy identity. Configuration
requires an OCI image **digest**, an exact Ed25519 host-key pin, finite limits,
and a separate host-owned computer history. Agent operations cannot select a
different VM, image, SSH key, or host command.

Mandatory ports are `WorkServicePort`, `ComputerLeaseStorePort`,
`TartControlPort`, `ScopedGuestPort`, and `WorkspaceArtifactsPort`. The host
composition root must bind actual Tart and pinned SSH/guest-helper adapters.
The production adapters are `apps/host/src/computer-drivers.ts` and
`local-computer.ts`; setup is documented in
[local production setup](../../docs/LOCAL_PRODUCTION.md). They verify a local
template's configuration and raw disk hash before cloning, retain host-owned
provenance and never download an image.
The Tart port exposes only fixed lifecycle/address operations, not a shell.
The guest port must verify the pinned key **before sending work**, enforce its
scoped permit, deny symlink escapes, and bound output/transfers. This package
has no host-shell API or fallback. Its separate `guest-helper` executable runs
only in Linux, inside the VM; it invokes Bubblewrap with fixed isolation
arguments, an explicit workspace mount and the authorized argv. A read-only
request changes the mount to read-only.

`acquire` yields a process-local opaque lease only after the durable acquisition
receipt is verified. `FileComputerLeaseStore` provides private, fsynced,
cross-process-exclusive lease files with no automatic expiry/orphan stealing.
Copied IDs do not recreate a lease. Expiry blocks new work but not orderly
release; unacknowledged operations quarantine the lease.

`provision`, `start`, `stop`, `execute`, `upload`, `download`, and `release` all
commit through the computer's WorkService history. Existing VMs must have the
expected source provenance, Omarchy identity, and no host mounts. Execution
uses argument arrays and a guest workspace root. Transfers accept workspace
artifact IDs and relative guest paths, never arbitrary host filenames.
Acknowledgements are checked for key, workspace, intent, path, size, and hash.

`computerToolOutcome(receipt)` links a verified computer receipt into an agent
tool outcome without recursively acquiring the agent workspace's lock.
`reconcile` can reread an already completed operation after acknowledgement
loss; it never replays guest work. Orphan leases require explicit host recovery
outside normal startup, after reviewing canonical history and guest state.

```sh
npm run build --workspace @rapp-work/computer-broker
npm test --workspace @rapp-work/computer-broker
```
