# OpenRappter Style Guide

This is the product identity for the full OpenRappter organism. Brainstem is the
bare twin; OpenRappter is the fully built-out twin. They share the exact
`/chat` wire but not the desktop app's name, icon, state, or dock identity.

OpenRappter is local-first, capable, calm, and visibly alive. Its interface
should feel like a trustworthy workbench for agents rather than a skin over a
chat window.

## 1. Naming hierarchy

| Name | Meaning | Customer-facing use |
|------|---------|---------------------|
| **OpenRappter** | The complete desktop organism | App, dock, menus, installer, self tile |
| **Rappter Surgeon** | GitHub Copilot operating on the whole organism | Builder panel and CLI |
| **Brainstem** | The unchanged local `/chat` runtime component | Architecture and diagnostics |
| **Rappter Pack Sentinel** | The control plane for mixed distributed nodes | Pack inventory and dispatch |
| **RAPP/1** | The protocol and portable artifact substrate | Identity, tiles, eggs, evidence |

Never call the full app "RAPP Brainstem", "Brainstem Frontier", or "Brain
Surgeon". Explain the relationship as **bare twin / fully built-out twin**. The
two products must remain easy to distinguish and able to run side by side.

## 2. The OpenRappter dinosaur

The **OpenRappter dinosaur** is the single fixed product brandmark. **Never redraw,
approximate, replace, rotate, or combine it with the Brainstem brain glyph.**

- Source of truth: `beta/build/icon.svg`, group `id="dino"`.
- Shape begins `M238 614c40-182 157-302 320-302`.
- App tile: rounded dark square, `#07111f → #102b27`.
- Dinosaur: `#58f5d2 → #72b5ff`.
- Eye/cutout: `#07111f`.
- Clear space: at least 12% on all sides.
- Dock requirement: at normal macOS dock size, OpenRappter must remain visually
  distinct from the blue Brainstem brain before reading either label.

The same source generates:

| Asset | Use |
|-------|-----|
| `build/icon.svg` | Canonical vector and shell favicon |
| `build/icon.png` | Runtime window/dock and universal 1024px source |
| `build/icon.icns` | macOS app bundle |
| `build/icon.ico` | Windows shortcut and executable |
| `build/icons/` | Linux, PWA, and multi-size surfaces |
| `build/manifest.webmanifest` | Installed web metadata |

Do not use the Brainstem glyph as an OpenRappter fallback. A missing dinosaur is
a failed package gate, not permission to borrow the bare twin's icon.

## 3. Color system

### Product identity

| Role | Token | Meaning |
|------|-------|---------|
| OpenRappter mint | `#58f5d2` | Product mark, selected product-level actions |
| OpenRappter sky | `#72b5ff` | Dinosaur gradient and secondary identity |
| OpenRappter night | `#07111f` | Icon ground and deep product surface |
| OpenRappter forest | `#102b27` | Icon gradient and quiet raised surface |

### Runtime and actors

| Role | Token | Meaning |
|------|-------|---------|
| Brainstem / action blue | `#58a6ff` | Embedded runtime controls and user action |
| Twin purple | `#7c6bd0` / `#b79cff` | Rapplication twins and contender tiles |
| Success | `#3fb950` | Verified ready/done state only |
| Warning | `#e3b341` | Needs attention or authentication |
| Error | `#ff9a9a` on `#2a1618` | Explicit failed state |

Mint identifies the organism. Blue identifies its Brainstem/action layer.
Purple identifies a twin or race contender. Green, amber, and red are semantic
status colors, never brand decoration.

### Good AI Neighbor identity

One top-level Electron app is one AI estate creature. Its Dock/taskbar name,
badge, window title, in-app estate pill, user data, home, and Herd owner must
agree. One estate may show multiple neighborhoods and worker twins. Sibling
estates may share the dinosaur species mark, but a deterministic Dock badge and
full app name must keep them distinguishable. Only a deliberately detached or
hatched estate receives another Dock creature.

### Surfaces and text

- Ground: `#0d1117`
- Panel: `#0f1013` / `#161b22`
- Raised: `#17181b` / `#1c1e23`
- Border: `#26282d`; strong border `#30363d`
- Primary text: `#e6edf3`
- Secondary text: `#c8c9cc`
- Muted text: `#8b8f98`

## 4. Typography and shape

- UI: `Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
  "Segoe UI", sans-serif`.
- Code, RAPPIDs, ports, and evidence:
  `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`.
- Body 12.5-13px; metadata 10.5-11px; headings 15-16px.
- Use an 8px spacing rhythm.
- Tiles use 9-12px radii; buttons 6-9px; chat bubbles 11px.
- Product language is direct: controls say the exact outcome ("Export tile",
  "Back up now", "Race contenders").

## 5. Core components

### OpenRappter self tile

The installed organism is itself a local content-addressed tile. Its surface
must name its RAPPID and make **Export**, **Import**, and **Back up** visible.
The copy must say that credentials, secrets, logs, recordings, binaries, and
source are excluded.

### Rappter Surgeon

Rappter Surgeon is GitHub Copilot working on the complete organism. It uses the
Copilot mark plus the label **Rappter Surgeon · agent mode**. Never label this
panel Brain Surgeon.

### Herd and Agent Arena

- Herd presents concurrent chats and twins without implying competition.
- Agent Arena/table mode presents comparable tiles and races.
- A race winner is the first completed contender that satisfies the declared
  deliverable. Fast-but-invalid is not a winner.
- Rappter Pack Sentinel uses the same tile grammar for remote Brainstem and
  OpenRappter nodes, regardless of machine.
- Cross-machine Pack transport defaults to pinned SSH. Plain private-LAN HTTP
  requires `allow_insecure_http: true`, and direct LAN HTTP to OpenRappter is
  forbidden.

### Embedded Brainstem

The unchanged bare Brainstem UI is hosted inside the fully built-out OpenRappter
twin. Its `/chat` request and response shape is the only wire; styling and host
controls never fork the kernel. OpenRappter is a byte-preserving proxy, not a
contract-repair adapter: kernel-owned session/idempotency behavior is preserved,
and Pack evidence must say `not-claimed` rather than infer stricter neighborhood
or envelope conformance.

Identity-loss recovery is an explicit operation: use
`openrappter-tile adopt <verified.openrappter.tile>` before the first relaunch
after reinstall. Ordinary import never overwrites a different organism RAPPID.

## 6. Motion and AI operation

- Motion communicates state changes, ownership, or causality.
- When an AI drives the visible app, show bounded cursor/action feedback.
- Do not hide autonomous work behind a spinner when a visible control or tile
  can show what happened.
- Recording and screenshots must omit transient force-mode decoration unless
  that decoration is the subject being proved.

## 7. Accessibility

- All product actions are keyboard reachable and have stable `data-drive`
  handles.
- Color is never the only indication of actor or status.
- The dinosaur has the accessible name "OpenRappter".
- The app remains usable at the minimum supported window size.

## 8. Architecture and release invariants

- The Brainstem kernel and `/chat` contract remain unchanged.
- OpenRappter owns a separate home, bundle ID, worker ports, lifecycle, and
  backup tile so bare and fully built-out twins run side by side.
- The OpenRappter self tile is verified before import and backs up current state
  before replacement.
- Customer-facing source contains no inherited Brainstem Frontier branding.
- Package identity, icons, visible shell, installer shortcuts, and this guide
  are tested together.
- OpenRappter is distributed under **Apache-2.0**; third-party notices remain
  attached to packaged builds.
