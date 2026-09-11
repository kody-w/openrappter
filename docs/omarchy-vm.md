# RAPP Work: local Omarchy VM foundation

RAPP Work uses **one persistent, shared local VM as the agents' computer**.
Agents have separate host-managed workspaces, not separate VMs. This foundation
adds the host supervisor and authenticated gateway API; it does not change the
product UI or RAPP protocol, install Tart, download images, or mount host folders.

**Required integration:** the host must supply its canonical RAPP/1 persistence
owner through `GatewayServerDependencies.vmRappPersistence`. This branch defines
and tests that contract; it does not create a separate VM journal or mint a
private trust root. The current Desktop/CLI entrypoints do not supply that owner.
Until the host integration is wired, a configured VM reports `rapp_not_wired`
and mutations are disabled. Image installation alone does not enable execution.

## First run (operator-controlled)

1. Use native **arm64 Node/Electron on Apple Silicon macOS**. Intel/Rosetta and
   non-macOS runtimes report `unavailable` explicitly. Install
   [Tart](https://tart.run/quick-start/) yourself; the default executable is
   `/opt/homebrew/bin/tart`.
2. Obtain a **trusted, versioned ARM64 Omarchy-compatible Tart OCI image** and
   its publisher-verified **SHA-256 manifest digest**. This repository does not
   publish an Omarchy image or claim that an upstream x86-64 installer is an
   Apple Silicon guest. The registry/version below are placeholders.
3. Provision **once**, pinning the immutable digest, not just a mutable tag:

   ```sh
   tart clone registry.example.org/rapp/omarchy-arm64@sha256:REPLACE_WITH_64_HEX_DIGEST rapp-work-omarchy
   ```

   Tart references use either a tag or a digest; record the corresponding
   release tag/version in the configuration below. Verify the digest through a
   trusted publisher channel before cloning. Tart's
   OCI transfer verifies content digests. Never replace an existing persistent
   VM merely to start an agent. Back it up before an intentional image upgrade.
4. Prepare the guest with DHCP, SSH on port 22, a non-root `rapp` user, and a
   dedicated authorized public key. Keep its private key on the host, mode
   `0600`. Obtain the guest's SSH host key through a trusted console/image
   provisioning channel. Put a pinned entry in a dedicated known-hosts file:

   ```text
   rapp-work-omarchy ssh-ed25519 REPLACE_WITH_VERIFIED_GUEST_HOST_PUBLIC_KEY
   ```

   The alias is the configured VM name, so DHCP changes do not change the trust
   anchor. Do not use unchecked `ssh-keyscan` output, password defaults, agent
   forwarding, or `StrictHostKeyChecking=no`. The guest needs `/bin/sh`,
   `/usr/bin/true`, and `/usr/bin/realpath` (Arch coreutils).
5. Create `<gateway dataDir>/vm/omarchy.json` (normally
   `~/.openrappter/vm/omarchy.json`, or under `OPENRAPPTER_HOME`) as an
   owner-controlled regular file, preferably `0600`:

   ```json
   {
     "schemaVersion": 1,
     "name": "rapp-work-omarchy",
     "tartBinary": "/opt/homebrew/bin/tart",
     "image": {
       "reference": "registry.example.org/rapp/omarchy-arm64:2026.9.1",
       "version": "2026.9.1",
       "sha256": "REPLACE_WITH_64_LOWERCASE_HEX_DIGEST"
     },
     "ssh": {
       "user": "rapp",
       "identityFile": "/Users/YOU/.openrappter/vm/ssh/id_ed25519",
       "knownHostsFile": "/Users/YOU/.openrappter/vm/ssh/known_hosts"
     },
     "workspaces": [
       { "agentId": "researcher", "workspaceId": "project-1" }
     ],
     "allowedExecutables": ["/usr/bin/pwd", "/usr/bin/ls", "/usr/bin/git"]
   }
   ```

   Replace every placeholder; invalid/untagged/unpinned configuration fails
   closed. Absolute credential paths must not contain SSH expansion tokens
   (`%`, `~`), backslashes, or control characters. The config records the
   provisioned image's provenance; it does **not** re-hash a mutable VM disk or
   prove an existing VM name came from that image. Restart the gateway after
   editing configuration.

## Canonical RAPP/1 persistence contract

The source of truth is the existing `src/rapp/authority.ts` selected **rev-14**
authority and `src/rapp/frame.ts` producer/verifiers, not a VM-specific protocol.
The previous `{at,event,message}` log format is removed. Durable VM activity is
represented only by canonical eleven-key RAPP/1 frames:

| Activity | Registered kind | Host-selected stream |
| --- | --- | --- |
| VM requests, states, start/stop/restart outcomes, readiness, exit, shutdown | `body.pulse` | Computer's existing bare RAPPID |
| Workspace materialization request, resolution or failure | `body.pulse` | Same computer biography |
| Agent guest-command request, result, cancellation or failure | `memory.tool-call` | Agent's existing `<rappid>:<instance>` memory stream |

VM-specific facts live inside `payload`, not in a second event envelope. Every
emitted payload names the selected protocol revision/frame/payload hashes.
The canonical builder owns `seq`, particle/wave hashes, `prev`, `prev_wave` and
signature semantics. Operation outcomes refer to their request frame by stream,
particle and wave addresses; these references never replace stream predecessor
links. Workspace resolution can refer to its initiating tool-call frame.
An `operation_frame` identifies the active supervisor operation when an event
was observed; it is not a claim that the operation caused an external exit.

The host supplies this interface from `src/vm/rapp-evidence.ts`:

```ts
interface VmRappPersistence {
  selectStream(
    family: 'body' | 'memory',
    identity: VmWorkspaceIdentity | null,
    signal: AbortSignal,
  ): Promise<RappChainTrustPolicy>;
  readStream(streamId: string, signal: AbortSignal): Promise<readonly string[]>;
  appendFrame(
    canonicalFrame: string,
    expectedHead: Readonly<RappFrameHead>,
    signal: AbortSignal,
  ): Promise<void>;
}
```

Wire the actual owner with
`new GatewayServer(config, { vmRappPersistence: canonicalFrameOwner })`.
Embedders using the supervisor directly share one `VmRappEvidence` instance
with `TartVmSupervisor` and `HostVmWorkspaces`.

The integration must satisfy **all** of these rules:

- Select already-minted identities, independently trusted genesis pins, the
  selected authority, and a durable highest-head checkpoint. Never mint from
  VM/agent/workspace names or learn trust from candidate frame bytes.
- Return complete ordered canonical frame strings, without wrappers. No empty
  chain, untracked head, family mismatch, alternate authority, rollback, fork,
  reparenting, replacement genesis, or silent repair is accepted.
- Compare and append atomically against `expectedHead`. Refuse conflicting
  writers. Identical frame retries are idempotent. Acknowledge only after the
  frame and highest-head checkpoint are durable and readable; preserve existing
  bytes and checkpoints across process restarts.
- Honor cancellation and bounded calls. An ambiguous/late commit is not a
  success. The adapter caps each persistence operation at 2s by default,
  re-reads the stream and runs the canonical frame and trusted-chain scanners
  after every append. A no-op write acknowledgement fails verification.
- Share the same computer stream across gateways controlling that VM; select
  agent memory streams from host identity/workspace bindings, never RPC input
  purporting to supply a stream, authority, genesis or frame.

Requests are durably appended and scanned **before** VM or workspace side
effects. Results/state transitions are appended and scanned before an operation
can report success. Persistence failure quarantines further mutations. A crash
or storage failure between an external action and its outcome leaves a durable
intent with an **unresolved outcome**; the persistence owner must reconcile it
through new verified frames, never replay the command automatically or fabricate
success. Emergency shutdown still releases an owned Tart child even if evidence
storage has failed, and reports that failure instead of claiming verified
cleanup. It never stops an external VM to compensate for missing evidence.

Command arguments/output are not copied to history. The request frame carries a
canonical particle hash of `{agentId,workspaceId,argv,cwd,timeoutMs}` with defaults
resolved. The outcome hashes the command-runner result
`{exitCode,signal,stdout,stderr,timedOut,aborted,truncated}` and carries its exit
metadata. These are evidence of the host's recorded observations, not proof of
authorship or approval. Operator image/SSH configuration remains static input,
not an event/audit log; action frames bind the selected image and workspace policy.
No new approval format is introduced.

## Workspace and execution contract

Only host-configured `(agentId, workspaceId)` pairs are accepted. IDs are 1–64
ASCII letters/digits/underscore/hyphen, beginning with a letter/digit.
On resolution, the host preserves a private directory at
`<dataDir>/workspaces/<agentId>/<workspaceId>`. Symlinked workspace directories
are rejected. No renderer-supplied host paths or mount options are accepted.

The future guest mount point is `/workspaces/<agentId>/<workspaceId>`.
**Mounting/synchronization is not implemented.** An operator can provision that
guest directory for testing, but it is not a copy of the host workspace.
Absent guest directories fail with exit 125; symlink/canonical-path escapes
fail with exit 126, never a fallback to the guest home or host shell.

`vm.exec` accepts only bounded argv arrays whose executable is host-approved,
and an optional strictly relative `cwd` below the registered guest directory.
SSH uses pinned host keys, a dedicated identity, no ambient SSH configuration,
no forwarding/proxy/local commands, and shell-quotes both remote parsing layers.
The guest's **initial working directory** is physically checked. This is **not
per-agent OS sandboxing**: approved guest programs can access resources allowed
to the guest user, and all agents share the computer. A gateway credential is
operator authority over the registered pairs, not proof of an individual agent's
identity. Revisit isolation before enabling writable host mounts.

## Authenticated API and ownership

Desktop already launches this gateway with a private token; no renderer shell
IPC is added. Headless use requires `OPENRAPPTER_TOKEN` (or a gateway configured
with password authentication). Even loopback `auth: none` cannot call VM methods.
HTTP uses the existing `/rpc` JSON-RPC transport with `Authorization: Bearer …`;
WebSocket uses the existing authenticated `connect` handshake.

| Method | Parameters |
| --- | --- |
| `vm.status` | `{}` — derived state, readiness, ownership, image version, verification status and bounded canonical `frames` |
| `vm.start` | `{}` — start once or attach to the existing VM; wait for real SSH readiness |
| `vm.stop` | `{}` — explicit operator stop of the shared VM |
| `vm.restart` | `{}` — serialized stop then start |
| `vm.exec` | `{"agentId":"researcher","workspaceId":"project-1","argv":["/usr/bin/git","status"],"cwd":".","timeoutMs":10000}` |

States: `unavailable`, `stopped`, `starting`, `running`, `stopping`, `error`.
`running` alone does not mean SSH-ready; use `ready`. Typed failures appear in
`status.error.code` or RPC `error.data.vmCode`. Lifecycle methods accept no
configuration overrides. Successful lifecycle and exec results include their
scanned, persisted `evidence` frame. Exec also returns stdout/stderr and
exit/timeout/abort/truncation metadata; it never retries locally. An operation
failure includes `error.data.evidence` when a terminal frame was committed.

Every status/result exposes `verification.status`: `not-wired`, `unverified`,
`pending`, `verified`, or `failed`, with the selected authority, scanned-frame
count and the canonical trust assessment. A nonzero scan is required for a
verified view. These local body/memory frames are unsigned as permitted by
RAPP/1: trust is **integrity-only**, `promotionGrade: false`, not an authenticated
registry, signature, approval or promotion authorization. Future UI views must
display that status and must not turn a pending/failed/unwired state into a
compliance badge. This change does not edit UI code.
The selected local profiles refuse signatures they cannot verify; this contract
does not enable signed/swarm history or silently downgrade it to unsigned trust.

The existing authenticated RPC methods are a local host-control interface, not
new RAPP federation endpoints or replacement wire envelopes. Durable evidence
uses the canonical asynchronous frame path; the RPC DTOs are derived views.

Default bounds: readiness 60s (maximum 120s), management commands 10s (maximum
30s), exec 60s (maximum 300s), four concurrent execs, 64 KiB combined output per
child, and 100 scanned frames in the derived history view (the host retains the
complete append-only streams). Optional config fields are `readyTimeoutMs`,
`commandTimeoutMs`, `execTimeoutMs`, and `pollIntervalMs`.

The runtime owns a foreground `tart run --no-graphics --no-audio --no-clipboard`
child. Repeated calls coalesce; stop/restart/shutdown cancel pending readiness
and exec work. Gateway shutdown sends SIGINT, then bounded SIGKILL if needed,
**only to its owned child handle**. An externally started VM is left running;
an explicit authenticated `vm.stop` can stop it. Disks and workspaces are never
deleted. An abrupt host/process kill cannot perform graceful cleanup; on the
next start, an already-running VM is treated as external, not claimed.

## Development validation

No Tart installation, guest, image download, or SSH service is required:

```sh
cd typescript
mkdir -p .test-scratch
TMPDIR="$PWD/.test-scratch" npm test -- src/vm/__tests__ src/gateway/__tests__/vm-gateway.test.ts src/rapp/frame.test.ts src/rapp/evidence.test.ts
npm run build:server
cd desktop
npm run build && npm test
```

The supervisor uses an injected command runner and clock. Tests exercise native
Tart JSON/argv contracts, lifecycle races, host workspace authorization, SSH
constraints, HTTP/WS authentication, and shutdown ownership with fake processes.
The persistence contract test writes and fsyncs actual canonical frames, scans
them back from disk, independently recomputes both hashes, checks selected
authority/family/lineage/highest-head binding, and requires more than zero scanned
frames. It also tests no-op acknowledgements, write failures, tampering,
rollback, conflicting writers and cleanup when persistence fails. Only the host
ownership/transport and VM commands are faked; the canonical verifiers are real.
