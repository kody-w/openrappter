# RAPP Brainstem Frontier — Style Guide

The locked-in visual + interaction language for the Frontier launcher. As the
app evolves, new surfaces conform to this; they do not redefine it. If a change
needs to break a rule here, change this doc in the same PR and say why.

Philosophy: **"engine, not experience."** The Frontier is confident, quiet
infrastructure — a developer tool that teaches by doing. Calm dark surfaces, one
brand accent, semantic color used sparingly, and never decoration for its own
sake.

---

## 1. The brandmark

The Brainstem **brain glyph** is the single, fixed identity mark. Kody: *"like
a permanent identity mark — get it right, and keep it the same everywhere."* **Never redraw,
restyle, or approximate it.** It has one canonical source: the glyph the Grail
app already serves as its favicon.

- **Canonical vector:** `viewBox 0 0 512 512`, a single `<path>` beginning
  `M184 0c-30.9 0-56.5 22.7-61.1 52.3…`. Pull it verbatim from the Grail
  brainstem (`curl -s localhost:7071/` → the `<link rel="icon">` line). Do not
  hand-author a lookalike.
- **Inline / favicon treatment:** the glyph in **brand blue `#58a6ff`** on
  transparent.
- **App / dock / tile treatment:** the *same* glyph in **white**, centered on a
  rounded blue tile (tile gradient `#3b82f6 → #2563eb`, `rx = 224/1024`). This is
  the only approved "container" treatment.
- **Clear space:** keep padding ≥ 12% of the tile on every side (the generated
  tile already does).
- **Don't:** recolor the glyph outside {`#58a6ff`, white}, add a drop shadow to
  the glyph, rotate it, add extra folds/eyes/antennae, or place it on a busy
  background.

**Assets** (all regenerated from one source `beta/build/icon.svg`, which embeds
the exact path):

| File | Use |
|------|-----|
| `beta/build/icon.svg` | source of truth (blue tile + white glyph) |
| `beta/build/icon.png` | 1024² universal source for packagers |
| `beta/build/icon.icns` | macOS app bundle |
| `beta/build/icon.ico` | Windows (16–256) |
| `beta/build/icons/16…1024` | desktop + iOS/Android/PWA sizes |
| `beta/build/manifest.webmanifest` | PWA / mobile install |

Rebuild: `rsvg-convert` per size → `iconutil -c icns` → Pillow for `.ico`. Wired
at runtime in `beta/electron/main.mjs` (`appIcon` → window `icon` + `app.dock.setIcon`)
and packaged via `beta/package.json` (`mac`/`win`/`linux` `.icon`). See the
`brainstem-brandmark` estate memory.

---

## 2. Color

Dark-first, GitHub-dark lineage. Use the tokens below; don't introduce new greys.

### Surfaces (back → front)
| Token | Hex | Where |
|-------|-----|-------|
| App ground | `#0d1117` | window background |
| Panel | `#0f1013` / `#161b22` | chat log, tiles |
| Raised | `#17181b` / `#1c1e23` | composer, input, bubbles |
| Border | `#26282d` | default hairline |
| Border strong | `#2a2d33` / `#30363d` | inputs, emphasis |

### Text
| Token | Hex |
|-------|-----|
| Primary | `#e6edf3` / `#e7e8ea` |
| Secondary | `#c8c9cc` / `#d7dae0` |
| Muted | `#8b8f98` / `#9aa0a9` |
| Faint / placeholder | `#6e7681` |

### Accents
| Role | Hex | Notes |
|------|-----|-------|
| **Brand blue** | `#58a6ff` | the brandmark, logo, primary highlight |
| Action blue | `#3d7cf0` → `#356fe0` | the *user's own* chat bubble (gradient), send |
| **Twin purple** | `#7c6bd0` / `#b79cff` | everything RAPPlication-twin: badge `◈`, tile chrome (`#1b1730` bg, `#2f2650` border), assistant bubble left-rule |
| Success green | `#3fb950` / `#5cc271` | "done"/ready status, second signal dot |
| Warning amber | `#e3b341` | "sign in"/needs-auth status |
| Error red | `#ff9a9a` on `#2a1618` | error bubbles |

**Rule:** blue = the Brainstem/you; purple = a twin/rapplication; green/amber/red
are **semantic status only**, never brand accents. One accent per surface.

---

## 3. Typography

- **UI / body:** `Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`.
- **Mono (code, logs, activity lines, ports, RAPPIDs):** `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`.
- **Scale (px):** body 12.5–13; chat 12.5; meta/labels 10.5–11; micro-labels 9.5
  (uppercase, `letter-spacing: .04em`); headings 15–16, `600`.
- Uppercase eyebrow labels (author names, section tags) get letter-spacing;
  running text never does.

---

## 4. Layout, spacing, shape

- **Herd model:** the workspace is a horizontal rail of equal **tiles** —
  Copilot chats and twin tiles side by side ("several agents, one Brainstem").
  Each tile: header (`.hh`) → body → composer, laid out with flex + `gap`.
- **Spacing:** 8-based rhythm (`gap: 8`, padding `9–12`). Let flex/grid `gap` do
  spacing, not per-element margins.
- **Radius:** tiles 9–12; chat bubbles 11 (with a 4px "tail" corner on the
  speaker's side); buttons/pills 6–9; the brandmark tile `rx 224/1024`.
- **Scrollbars:** thin, `#33363c` on transparent. Wide content scrolls inside its
  own container; the app body never scrolls sideways.

---

## 5. Components

- **Chat bubble:** user/you = action-blue gradient, right-aligned, tail bottom-right.
  Assistant = raised panel `#1c1e23`, left-aligned, `1px #2a2d33` border, tail
  bottom-left. Error = red-on-`#2a1618`.
- **Multiplayer twin transcript** (the twin tile small view): a work-log over the
  twin's `/chat`. Monospace **activity lines** (dim, no bubble) for lifecycle
  events; author-attributed **bubbles** for turns. Each turn carries a micro
  uppercase author label (`YOU`, `BRAINSTEM`, `JSON DOCTOR`). Self (`you`) is
  right-aligned/blue; everyone else left-aligned. This is how the Brainstem loop,
  the Brain Surgeon, and the user appear together in one room.
- **Status pill** (`.hst`): tiny uppercase — `working` (blue), `ready`/`done`
  (green), `sign in`/needs-auth (amber).
- **Tile header buttons:** ghost buttons — `1px` border in the tile's accent
  family, transparent-ish fill, brighten on hover. Twin tiles: `⟳ Loop` (starts
  the Brainstem↔twin loop; lit while looping), `⤢ App` (pop out the full custom
  rapplication UI), `×` (close).
- **AI force mode:** when an AI is driving, the visible window's **edges glow**
  and a small tag names the driver. It is **off by default** and never shown
  while capturing screenshots for docs.

---

## 6. Voice

Confident host, never defensive. Active voice; a control says exactly what
happens ("Hatch a RAPPlication", "Message this twin to steer it"). Name things by
what the user recognizes (a *twin*, a *rapplication*, the *herd*), not by
internals. No emoji as section markers in product chrome (the `◈` twin badge and
the brandmark are identity, not decoration). Errors say what happened and the one
next step.

---

## 7. Invariants (design-level echoes of the kernel rules)

- The Grail kernel UI is never forked; a rapplication's custom UI **overrides**
  the default chat by injection, and both drive the same `/chat` ("chat is the
  only wire").
- Twin/rapplication surfaces are always visibly distinct (purple) from the
  Brainstem/you (blue) — a viewer can always tell who is who in a room.
- No customer PII or secrets in any brand asset, screenshot, or shipped surface.
