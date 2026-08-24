# Verified local media ingest

OpenRappter stages large Chat and Show-and-Tell media in private, content-addressed
local storage. The selected bytes stay on the OpenRappter installation; the media
upload path does not send them to an external service.

## Limits

| Policy | Default |
| --- | ---: |
| Small direct Chat attachment | 1 MiB |
| Resumable chunk | 256 KiB decoded (349,528 bytes base64 maximum) |
| Local media maximum | 4 GiB |
| Hard maximum | 8 GiB |
| Per-session staging quota | 8 GiB |
| Global staging quota | 16 GiB |
| Reserved free disk | 1 GiB |
| Partial upload TTL | 24 hours |
| Concurrent uploads | 8 global / 3 per session |
| Container probe | 15 seconds / 256 KiB output |
| Media dimensions and duration | 7680×4320 / 12 hours |

`OPENRAPPTER_MEDIA_MAX_BYTES` may lower or raise the local maximum up to the
8 GiB hard ceiling. `OPENRAPPTER_MEDIA_SESSION_STAGING_BYTES`,
`OPENRAPPTER_MEDIA_GLOBAL_STAGING_BYTES`, and
`OPENRAPPTER_MEDIA_MINIMUM_FREE_BYTES` configure quotas and disk reserve.

## Desktop

The renderer gives the preload a real `File`. Electron
`webUtils.getPathForFile()` performs the path handoff; no bridge method accepts a
renderer path string. The main process opens with no-follow semantics, checks
regular-file/link/identity/sparse-file invariants, streams fixed-size chunks,
hashes incrementally, checks the source again after reading, fsyncs private
staging, validates the container, and atomically finalizes by SHA-256.

## Browser

Authenticated gateway RPC provides:

- `media.upload.start`
- `media.upload.chunk`
- `media.upload.status`
- `media.upload.complete`
- `media.upload.cancel`

The existing handshake authentication, exact-origin checks, and request source
policy protect these methods. The current browser transport is WebSocket JSON,
so chunks use bounded base64 and the handshake's 5 MB frame limit remains in
force. Upload IDs persist locally for resume; the server verifies offset,
per-chunk digest, final size, and final digest.

## Adapter contract

Consumers receive `openrappter-media-asset/1.0`, containing an asset ID,
SHA-256, detected MIME/container kind, size, probe metadata, and truthful local
storage status. Only trusted server/main-process code resolves the descriptor
to `privatePath`.

This typed seam is intended for XPedition and other shells without coupling
ingest to them. Organism eggs carry the descriptor and content through their
own archive policy; media ingest does not depend on egg code.
