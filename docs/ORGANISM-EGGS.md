# OpenRappter organism eggs

An OpenRappter organism egg is a closed
`openrappter-organism-egg/1.0` profile inside the existing `rapp/1-egg`
container. It is a data/code archive, not a process. Inspecting, previewing, or
importing an egg never executes its prompts, skills, JavaScript, Python, or
agents. Restored agents do not awaken until the normal runtime is deliberately
restarted.

## Share versus backup

| Mode | Intended use | Encryption | History/media |
|---|---|---|---|
| `portable` | Intentional sharing or migration | No; private by default, mode `0600` | Only with explicit flags |
| `sealed-backup` | Full local recovery | scrypt (`N=32768,r=8,p=1`) + AES-256-GCM | Only with explicit flags |

Portable does **not** mean public. Review its inspection report before sharing.
Sealed eggs are portable across macOS, Linux, and Windows with the passphrase.
OpenRappter never persists or logs a passphrase; the CLI accepts it only on
stdin. Windows ACL hardening is best effort and reported truthfully because
POSIX mode bits do not exist there.

```bash
openrappter egg export --mode portable --output ./OpenRappter-share.egg
read -s EGG_PASSPHRASE
printf '%s\n' "$EGG_PASSPHRASE" |
  openrappter egg export --mode sealed-backup \
    --include-history --include-media --passphrase-stdin \
    --output ./OpenRappter-backup.egg
unset EGG_PASSPHRASE
```

Output paths must be new and end in `.egg`; existing files are never
overwritten.

## Inventory contract

The exporter reads named state APIs and managed roots, never copies the home
directory blindly:

- consistent in-memory SQLite serialization after a WAL checkpoint;
- agent files plus immutable generation/lineage records;
- installed skills, catalog pins, and lock records;
- memory, cron/jobs, channel configuration with credential values redacted;
- XPedition/Living Company preferences and drafts;
- Clever Girl contracts/configuration;
- release-ring selection and receipts;
- RAPPID body, traits, and dimensions;
- user-owned custom resources;
- sessions/messages/Flight history only with `--include-history`;
- owned/licensed local sound and byte-exact existing MIDI only with
  `--include-media`;
- deterministic CC0 `organism-theme.mid`, generated locally from the RAPPID.

Credentials, tokens, auth profiles, device/Keychain secrets, private keys,
external mailbox content, logs, caches, downloads, sockets, PIDs, lock files,
`node_modules`, and build output are never exported. GitHub Copilot, channels,
providers, and device-bound connections must be reauthenticated after restore.
Unknown-license sound is excluded with a diagnostic unless the operator uses
`--acknowledge-unknown-license`.

## Format contract

The outer envelope is a standard deterministic RAPP/1 `rapplication` egg. Its
payload identifies the profile and public header. Portable eggs contain
`organism/manifest.json` and byte payloads directly. Sealed eggs contain only
`organism/sealed.bin`; the decrypted bytes are another verified RAPP/1 egg.

The organism manifest records:

- source version, exact source commit/package digest, release ring, platform;
- organism RAPPID and millisecond UTC creation time;
- dimensions, privacy class, exclusions, and reauthentication requirements;
- every path, exact size, SHA-256, MIME, dimension, origin/license/provenance;
- required migrations and a canonical root digest.

ZIP timestamps are fixed to 1980, entries are stored without compression, and
paths are NFC-normalized and byte-sorted. Duplicate, absolute, traversal,
Unicode/case-colliding, deep, device, symlink, non-regular, oversized,
over-count, ZIP64, encrypted-ZIP, and decompression-ratio-unsafe entries are
rejected before extraction. RAPP/1 hashes, SHA-256 file hashes, exact sizes,
root digest, profile, migration list, and AES-GCM authentication must all pass.

Only profile migration `openrappter-organism-egg/1.0` is currently supported.
Future readers must refuse unknown required migrations rather than guessing.

## Inspect, diff, preview, apply

```bash
openrappter egg inspect ./OpenRappter-share.egg
openrappter egg diff ./OpenRappter-share.egg
openrappter egg import ./OpenRappter-share.egg --preview
```

Inspect verifies the public RAPP/1 envelope but never decrypts a sealed payload
unless `--decrypt --passphrase-stdin` is explicit. Preview is read-only and
prints an approval binding over the egg digest, target RAPPID, base-state
digest, complete diff, and restore/clone semantics.

Apply requires all of the following:

1. explicit `--apply` (not `--preview`);
2. explicit `restore` or `clone` semantics;
3. the exact approval binding from the current preview;
4. a passphrase on stdin for the automatic sealed rollback egg.

The importer locks the organism, verifies/decrypts in private memory and a
mode-`0700` staging directory, writes a sealed rollback egg, validates identity
and migrations, applies through the state adapter with fsync/atomic swaps, and
runs health/contract probes. Failure restores the exact captured state and
quarantines the failed egg with a failure record. A restore refuses a foreign
RAPPID; cloning must be chosen explicitly. Organisms are never silently merged.

Quantum RAPPID desktop support begins in `@openrappter/desktop`
`0.1.0-beta.11`. Its XPedition adapter can inspect/export/preview, but semantic
controls cannot approve or apply imports. Apply is guarded by a native,
action-bound human confirmation.

## Recovery drill

Use only a synthetic fixture for release dogfood:

1. export both modes from a synthetic `OPENRAPPTER_HOME`;
2. inspect portable and opaque sealed headers;
3. decrypt and diff the sealed egg;
4. mutate synthetic state;
5. preview, copy the approval binding, and apply;
6. verify byte-exact restored database/files/agent lineage/media;
7. induce a failed health probe and verify rollback plus quarantine.

Do not create a real user backup from a development checkout. Create the first
real backup only from the reviewed, merged, installed release candidate.

## Threat model

An egg may be malicious, oversized, path-confusing, tampered, or contain
hostile code/prompts. Verification treats all content as inert bytes; no
dynamic import, Python execution, model call, hook, prompt, or migration script
is run during inspect/preview. Authenticated encryption protects
confidentiality/integrity at rest, not a weak passphrase or a compromised
machine after decryption. Portable eggs provide integrity, not secrecy.
