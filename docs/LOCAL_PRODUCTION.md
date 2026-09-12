# Local production composition

Normal startup uses only `~/Library/Application Support/RAPP Work`. It does not
discover previous application homes or invoke migration. Development desktop
tests can explicitly override the directory with `RAPP_WORK_USER_DATA`.

The application directory contains one owner identity, one `workspaces/` store,
an owner-process lock, provider state and optional computer configuration. The
owner catalog, computer history and each saved agent have different workspaces.
RPC IDs are locators, never capabilities. RAPP/1 integrity/read-back verification
does not attest to a model's factual accuracy.

## GitHub Copilot

Install the official GitHub Copilot CLI **1.0.83 or newer in the 1.x series** at
`/opt/homebrew/bin/copilot`. The app pins `@github/copilot-sdk` 1.0.13 and uses
the documented stdio client against that fixed local binary; it does not
download a runtime or invoke a shell.

Quit RAPP Work before signing in to its dedicated provider profile:

```sh
COPILOT_HOME="$HOME/Library/Application Support/RAPP Work/providers/github-copilot" \
  /opt/homebrew/bin/copilot login
```

Restart RAPP Work, open Settings → Providers, and inspect the explicit runtime,
authentication and model status. Use `copilot-cli` as the connection reference.
Credentials are managed by Copilot CLI and never accepted through an RPC field.
The app does not infer authentication from a filename or manufacture models.

Each completion creates a fresh SDK **empty-mode** session. Configuration
discovery, file hooks, skills, host Git context, cross-session storage,
embeddings and remote sessions are disabled. No real tools or tool handlers
are supplied, all tool sources are excluded, and permission/pre-tool hooks deny
execution. The offered tool set is initialized and read back as empty before
sending a prompt. The model returns JSON final text or tool **proposals**; only
the RAPP Work runtime can authorize and execute those proposals.

The transport checks authentication/catalog status, validates bounded output,
supports cancellation and deletes its own finished session. Unsupported APIs,
missing auth, invalid JSON and isolation-check failures are explicit errors.

Supported API documentation:

- [Node SDK client and session API](https://github.com/github/copilot-sdk/tree/main/nodejs)
- [Copilot CLI authentication](https://docs.github.com/en/copilot/reference/cli-command-reference#copilot-login-options)

## One shared Omarchy computer

No VM is downloaded or automatically discovered. Provision an existing,
reviewed **Omarchy Linux arm64** template in the application's private Tart home.
The stopped template must contain Node.js 22.12+, `/usr/bin/bwrap`, and this
repository's built `packages/computer-broker/dist/guest-helper.js`, installed at
`/usr/local/lib/rapp-work/guest-helper.js`. Its directory must declare ESM with
`{"type":"module"}` in `package.json`. Create `/workspaces` owned by the configured
guest user. Allow that user to log in using the dedicated SSH identity.

Tart's documented local import takes a previously exported `.tvm` file:

```sh
TART_HOME="$HOME/Library/Application Support/RAPP Work/computer/tart" \
  /opt/homebrew/bin/tart import /absolute/path/to/reviewed-image.tvm omarchy-template
```

Create the application/computer directories privately (0700). Put the SSH
private key at `computer/identity` (0600), never in the repository. Obtain the
guest's Ed25519 public host key through a separately trusted provisioning path,
not an unverified first network connection. Clone-time guest key regeneration
must not invalidate this pin.

Create private `computer.json` in the application directory:

```json
{
  "version": 1,
  "distribution": "omarchy",
  "vmName": "work-omarchy",
  "sourceVM": "omarchy-template",
  "image": "ghcr.io/your-organization/omarchy@sha256:<reviewed-image-digest>",
  "sourceConfigurationSha256": "<canonical-hardware-configuration-hash>",
  "sourceDiskSha256": "<raw-sha256-of-the-stopped-template-disk.img>",
  "guestUser": "worker",
  "hostKey": "ssh-ed25519 <trusted-public-key-base64>"
}
```

Replace every placeholder. `image` is the reviewed source's digest, not a tag.
`sourceDiskSha256` independently pins the actual imported disk bytes under
`computer/tart/vms/omarchy-template/disk.img`. Compute the configuration hash by
passing `tart get omarchy-template --format json` to the exported
`vmConfigurationHash` in `apps/host/dist/computer-drivers.js`; it hashes exactly
OS, CPU, Memory, Disk, DiskFormat and Display using canonical JSON.

Restart the app. Work → Local computer → Start clones **only the configured
local label**, verifies its disk and configuration pins, records host-owned
clone provenance, and starts it with no directory/disk mounts, clipboard or
audio sharing. Existing unowned running VMs and changed pins fail closed.

Tart lifecycle commands and `/usr/bin/ssh` use fixed argument vectors,
sanitized environments and no host command shell. SSH uses a pinned host alias,
strict host-key checking, one private identity, no inherited configuration,
proxy commands, forwarding or interactive authentication. The only remote
entry is the fixed guest helper; requested argv and scope travel as JSON on
stdin, never in SSH options or an interpolated remote command.

The helper rejects non-Linux execution and invokes Bubblewrap with new
user/PID/mount namespaces, a cleared environment and only the agent workspace
bound at `/workspace`. Other agents' roots and host files are absent. Read-only
policy uses a read-only bind, not a command-name convention. Execution and output
are bounded. Current production tools are `guest.read` and `guest.execute`;
ungranted transfer operations are not advertised or silently enabled.

Arbitrary guest execution always requires exact owner approval; read-only
operations can run automatically only under an explicitly selected on-risk
policy. Both policies remain bounded by the host limits. An exclusive durable
computer lease and scanned approval-consumption receipt precede guest work.
Computer evidence is linked back to the owning agent's canonical tool outcome.

An unresolved command or orphaned computer lease is **not** automatically
retried, expired away or stolen. Review canonical history and confirm guest
state before explicit offline recovery. Missing persistence means zero
execution. Do not delete a lease merely to make an uncertain action retry.

## Verification boundaries

```sh
npm run typecheck
npm test
npm run build
npm run test:bundle --workspace @rapp-work/host
node scripts/run-acceptance.mjs
node scripts/check-release-constitution.mjs
npm run legacy:absent
```

Filesystem integration tests exercise the real production composition with
injected Copilot/Tart/SSH transports. They are not live provider/VM evidence.
Live Tart smoke is explicitly opt-in and requires an already configured local
image. It must not download or substitute one.
