# DOGG summons full — `openrappter-dogg-summon/1.0`

> **Status:** shipped OpenRappter extension, RAPP/1-aligned but not part of the
> RAPP/1 rev-5 core standard.

DOGG is the local line on this device. GGOD is the public commons of frames,
tiles, and catalogs. A `summons_full` lets the local OpenRappter estate resolve
a resident neighborhood from public GitHub raw user data without granting the
public source authority over the device.

## Invocation

Rappter Surgeon exposes `summon_dogg_neighborhood`:

```json
{
  "summons_full": "https://raw.githubusercontent.com/OWNER/REPO/FULL_40_HEX_COMMIT/index.json",
  "store_id": "proof-neighborhood",
  "instruction": "optional local first task"
}
```

The catalog must be `rapp-store/1.0`. The catalog URL and every selected
singleton, egg, and UI URL must use `https://raw.githubusercontent.com` with an
immutable 40-character commit—not `main`, a tag, a redirector, or another host.
The existing RAPP Store client then bounds the fetch and verifies payload hashes
before TwinManager can hatch the entry as a resident neighborhood.

## Authority

1. Public bytes are **candidates**, never commands.
2. Fetching is not trusting; a catalog pin proves internal consistency, not
   publisher identity.
3. The local estate decides whether to hatch.
4. Summoning cannot mutate another estate or bypass its lifecycle capability.
5. Local use emits local frames; publication back to GGOD is always explicit.

This preserves the DOGG–GGOD rule: global data can contribute compatible
frames, but authority never reverses into the device.

## RAPP/1 and spine status

The pinned authority checked for this implementation is RAPP/1 rev-5,
`kody-w/rapp-1@6723c7add2aed36bb68992fc71a56b0a4bd5ad81`,
`SPEC.md` SHA-256
`6d06daba65d7c045716f3d6e95db8401ab58e727820e4114466d847f62cae49b`.
RAPP/1 governs canonical JSON, RAPPID, frames, `/chat`, eggs, and trust. It does
not define DOGG summons.

The public `rapp-spine/1.1` scoped route for data-defined Electron estates and
DOGG summon currently lands on `rapp-estate/1.1`, whose canonical material is
declared unresolved. Therefore OpenRappter records this as a target-owned
extension and does **not** claim full spine or RAPP/1 certification.
