# Herd and Agent Arena dimension tiles

> **Scope.** This document specifies the shipped herd/arena view-mode toggle and the on-disk tile
> record. The current surface model is [TILE-MANAGEMENT-UX.md](TILE-MANAGEMENT-UX.md), where the
> herd, the arena and the binder are separate places rather than renderings of one list. Where the
> two disagree, that document wins.

The herd has two presentation modes. **Herd mode** is the default, unchanged
Frontier presentation. **Agent Arena** lets a user move a live Brainstem
conversation into the herd as a dimension tile, retain its exact history, start
another conversation, and later restore or compare either result. Agent Arena
is where parked conversations compete side by side. The implementation is
confined to the Frontier shell and frame bridge; it does not modify the
Brainstem kernel or the RAPP/1 chat envelope.

## Mode boundary

**Herd mode is the default.** In herd mode, Frontier adds no tile DOM, CSS,
listeners, active IPC operations, or frame-bridge source. A herd-mode identity
test proves that the composed frame source is byte-identical to its input.
Returning to herd mode removes all Agent Arena resources immediately but does
not delete stored tiles.

The view mode can be changed through:

- the checkable **Agent Arena** item in the native View or three-dot menu;
- the exact, trimmed composer controls `agent arena` and `herd`;
- `RAPP_VIEW_MODE=arena|herd`, with unknown values falling back to `herd`;
- `settings.json`:

  ```json
  {
    "viewMode": {
      "mode": "herd",
      "layout": "ring",
      "customLayoutPath": null
    }
  }
  ```

The feature has not shipped, so superseded setting, environment, command, and
IPC names have no compatibility aliases.

## Dimension tile record

A dimension tile is a persisted conversation plus the route and model metadata
needed to restore it:

```json
{
  "schema": "rapp-dimension-tile/1.0",
  "id": "tile-…",
  "title": "first user line, at most 60 characters",
  "createdAt": "…",
  "parkedAt": "…",
  "route": {
    "url": "http://127.0.0.1:PORT",
    "rappid": "…",
    "compositionHash": "…",
    "model": "auto"
  },
  "turns": [
    {
      "role": "user|assistant",
      "text": "…",
      "html": "sanitized…",
      "at": "…"
    }
  ],
  "history": [
    {
      "role": "user|assistant",
      "content": "…"
    }
  ],
  "status": "parked | racing | primary | folded",
  "arena": {
    "seat": 2,
    "faceUp": true
  }
}
```

Records are atomic, mode-0600 JSON files under
`~/.brainstem/beta-launcher/tiles/<id>.json`. The store caps each tile at 200
turns and 256 KiB. It validates identifiers, schema, size, roles, status, route,
timestamps, and placement metadata every time it reads or writes a record.

`turns` are captured from the Brainstem frame and sanitized with
`sanitizeMarkdownFragment`. `history` is the observed
`conversation_history` plus the corresponding reply. This distinction preserves
both safe rendering and exact continuation semantics.

## Operations

| Operation | Input | Result |
|---|---|---|
| **Park** | Select the Brainstem grab control or drag it into the herd. | Capture the transcript and observed wire history, persist the tile, then invoke the kernel's own **Clear** control. An accepted pending request remains attached to the tile and completes when its reply arrives. |
| **Wake** | Drag a tile to Brainstem, swipe right, press **Wake**, or use the keyboard action. | Verify the tile belongs to the active RAPPID and composition, render its transcript, and prefix its stored history onto the next chat request. The current conversation is parked first. |
| **Fold** | Swipe left or press **Fold**. | Keep the file, set `status: "folded"`, move it to the discard group, and provide a ten-second undo interval. |
| **Race** | Press **Race** on a tile whose last user turn is a question. | Create one pending contender for the same question. Selecting a winner makes it primary and folds only the paired rival. |
| **Arrange** | Select **Reorder**, **Spread**, **Distribute**, or **Open one**. | Apply deterministic view arrangement and animation over the same persisted records. |

All operations are available through visible controls and UI Driver v2 handles.
The primary handles are `@brainstem.grab`, `@herd.tile[<id>]`,
`@herd.tile[<id>].wake`, `@herd.tile[<id>].fold`, and
`@herd.tile[<id>].race`.

## Frame bridge and IPC

`composeDimensionTilesFrameBridgeSource` returns the checkpoint source unchanged
in herd mode. In Agent Arena, `installArenaFrameBridge`:

1. observes accepted `/chat` and `/chat/stream` requests;
2. binds response slots to request IDs;
3. captures sanitized transcript turns and canonical wire history;
4. preserves accepted requests across the internal Clear operation;
5. reconciles delayed completions by request ID;
6. restores a selected transcript and prefixes its history on continuation;
7. detaches the active tile after a user-initiated Clear.

Shell operations use `beta:tiles-*` IPC channels. Frame messages use
`rapp-beta:tile-*`. The mode switch uses `beta:set-view-mode` and
`rapp-beta:set-view-mode`.

## Agent Arena layouts

Layouts change presentation only. They do not change the tile schema,
conversation history, actions, or route validation.

| `viewMode.layout` | Label | Arrangement |
|---|---|---|
| `table` | Table | Oval positions and a discard group |
| `row` | Rows | Five positions and a discard row |
| `focus` | Focus | One active position above five secondary positions |
| `grid` | Grid | Two horizontal rows |
| `stack` | Stack | Two closed groups with a spread row |
| `custom` | Custom… | Validated local JSON |

A custom layout may define `name`, `surfaceColor`, `seatPositions`, `tileSize`,
`arrangePattern`, and `faceDownRule`. The loader accepts only local JSON up to
64 KiB, rejects unknown fields and remote assets, and bounds every numeric
position and size.

## RAR interoperability

Human-facing Frontier records are dimension tiles. The public RAR protocol keeps
the `.card` extension, `rar-card/2.0` schema ID, and `card` SDK verb. RAR calls
its deterministic seven-word key a seven-word key; Frontier documentation uses
**seven-word key**. These protocol names do not change the Agent Arena storage
directory, feature schema, identifiers, or Agent Arena terminology.

See [DIMENSION-TILES-V2.md](DIMENSION-TILES-V2.md) for the portable RAR file
contract and offline interchange path.

## Proof

`beta/tests/e2e/dimension-tiles.e2e.test.mjs` verifies a delayed reply parked
mid-request, a second completed tile, history restoration on the next real chat
request, folding, paired race resolution, manual Clear detachment, herd-mode DOM
identity, persistence in herd mode, and restoration after returning to Agent
Arena.

Unit coverage verifies settings and environment precedence, exact composer
matching, atomic persistence and permissions, caps, invalid-record isolation,
request-ID reconciliation, herd-mode IPC guards, frame sanitization, custom
layout validation, UI handles, gestures, keyboard paths, and herd-mode source
identity.
