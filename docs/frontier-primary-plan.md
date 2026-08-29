# Frontier Primary Application Provenance

## Authority established from deployment

The URL `https://kody-w.github.io/openrappter/beta/` is an installer landing,
not a second browser renderer. Its command executes `beta/install.sh` from
`kody-w/openrappter`. That installer launches the application rooted at
`beta/`.

The maintained application authority is therefore:

- repository: `kody-w/openrappter`;
- application root: `beta/`;
- Electron entrypoint: `beta/electron/bootstrap.mjs`;
- renderer: `beta/ui/`;
- preload and IPC: `beta/electron/preload.cjs` and `beta/electron/main.mjs`;
- package workflow: `.github/workflows/frontier-desktop.yml`.

The public `kody-w/rapp-brainstem` repository is a name/license pointer and
does not contain the runtime source. The installed Brainstem source is selected
by `beta/install.sh`: tagged OpenRappter releases use the same tag's
`rapp_brainstem/`; development installs use the configured upstream kernel and
the pinned, hash-verified bootstrap. It lives separately at
`~/.openrappter/brainstem/src/rapp_brainstem`.

The machine-readable record is
`contracts/frontier-ui-provenance-v1.json`.

## Direct package path

Both `.github/workflows/frontier-desktop.yml` and the desktop portion of
`.github/workflows/release.yml` run Electron Builder from `beta/`. They no
longer build the TypeScript patient host and copy Frontier HTML into it.

`beta/package.json` includes the authoritative `ui/**` and `electron/**` source
directly. `beta/scripts/verify-frontier-package.mjs` compares every reviewed
renderer/entrypoint digest against the extracted `app.asar`; a changed source,
missing package byte, or mirror fails release.

The former `typescript/ui` and `typescript/desktop` application is classified
as the deprecated patient interface. It is not a Frontier mirror, is not the
primary desktop artifact, and may not import, rewrite, or copy `beta/ui`.

## Feature integration rule

New OpenRappter features are modules of the maintained Frontier application:

- renderer modules live under `beta/ui`;
- privileged behavior uses the existing context-isolated `brainstemBeta`
  preload API;
- main-process behavior belongs under `beta/electron`;
- missing IPC reports unavailable instead of creating an alternate gateway or
  renderer host.

The feature modal therefore consumes the existing `brainstemBeta` state,
updater, twin, agent-file, and application IPC seams. It does not install a
second hosted adapter, private RPC transport, or copied Brainstem chat.

## Chat identity

OpenRappter is the application shell and personal organism. The left main
conversation is the installed Brainstem's exact `/chat` wire, including
`user_input`, `session_id`, `conversation_history`, memory, twins, and the tool
loop. The right GitHub Copilot multi-chat surface remains the specialized
Frontier workspace.

## Drift gates

`beta/tests/frontier-provenance.test.mjs` proves:

1. Pages points to the maintained installer;
2. desktop workflows package `beta/` directly;
3. the TypeScript patient host cannot mirror Frontier;
4. alternate host/chat adapters are absent;
5. every authoritative source digest matches the reviewed provenance record.

The package workflow additionally extracts `app.asar` and byte-compares it to
that same record.
