# Omarchy ARM Qualification Decision

## Decision

RAPP Work does not ship or automatically download an ARM Omarchy image.

Official Omarchy's supported ISO is x86_64. Available ARM ports and prebuilt
images are useful engineering references, but none currently establishes the
authenticated, reproducible, hardened appliance required for serious business
work. RAPP Work therefore keeps its Tart computer broker complete and fails
closed until an independently qualified image is configured.

The UI must say **computer unavailable**, never substitute another Linux image
or describe an unqualified community image as official Omarchy.

## Evidence reviewed

- Official Omarchy `v4.0.3`: `0534987009061cbe2dacdde4ad564092ab698d12`
- Official ISO source: `a23f8d464dcb0616a61bfaa8026e23d0533da209`
  with an x86_64 profile and an ARM support plan rather than an ARM release
- Omarchy Mac source: `09f16de292febfc76225dee11ffa64497fc6f30d`
- Cua ARM compatibility work:
  `dfc19e57fb3e6168fb68af3bd692fe1e83dc1e51`
- Community Tart image manifest:
  `ghcr.io/chrisdoc/tart-omarchy@sha256:fb0b081bb7ef5fcc16c1465ecdc15c9165f635ac8adaffca5f14f51d5aab2c9a`
- Tart `2.37.0`: `9bb2af243480ca4a2c210082e630ae425bd48b31`

The community Tart image was rejected for production because its build uses
unauthenticated HTTP bootstrap inputs, moving branches, permanent passwordless
sudo, generated machine identity/host keys inside the template, an unpinned
builder, and no demonstrated successful reproducible CI build.

## Qualification path

An approved appliance must be built internally from:

1. a retained ARM64 Arch bootstrap image and verified signature/checksum;
2. exact signed ARM package files and repository metadata;
3. reviewed, pinned Omarchy source and an internally maintained ARM adaptation;
4. a dedicated disposable Tart Linux VM with no host mounts or production data;
5. key-only SSH, no root/password login, no permanent passwordless sudo,
   deliberate firewall policy, and no unnecessary Docker/Bluetooth/printing;
6. the RAPP Work guest helper and Node.js 22.12+;
7. cold-boot, SSH reconnect, desktop input/rendering, workspace isolation,
   conformance, export/import, and unique-identity acceptance tests;
8. sanitized shutdown, signed `.tvm` output, input manifest, SBOM, license
   inventory, and pinned SHA-256.

The first qualification attempt is bounded to one disposable VM and two hours.
Any failed signature, missing ARM package, unsafe privilege default, boot/SSH
failure, desktop failure, or export/import failure stops the build rather than
triggering an improvised workaround.

## Product behavior until qualification

- Agent creation, tasks, approvals, evidence, schedules, provider status,
  workspace persistence, and migration remain available.
- Guest tools and computer lifecycle controls remain unavailable.
- Missing computer configuration produces zero Tart, SSH, or tool execution.
- No host-shell fallback exists.
- A future image is enabled only by a private pinned configuration containing
  source identity, disk hash, VM configuration hash, guest user, and trusted
  SSH host key.
