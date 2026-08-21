# rapp-force-mode/1.0 — an iframe API for AI-drivable rapplication UIs

> Status: **proposed** (draft to contribute to the RAPP Store). Home for now:
> this repo; intended to be published alongside `rapp-store/1.0` so rapplication
> authors can declare their UI "force-mode capable."

## Why

A rapplication is a twin: a specialized agent set **plus its own UI**, both
speaking the twin's `/chat`. In RAPP Brainstem Frontier, that UI is shown in a
herd tile (or popped out) and an AI can drive it **just like the user** — clicks,
typing, an animated cursor — so a person can be fully hands-off and simply chat
with the AI, which then operates the rapplication.

An AI can *always* drive a rapplication UI two ways, with **no cooperation from
the UI**:

1. **The wire.** Anything the UI can do, the AI can do by POSTing to the twin's
   `/chat` directly — the UI is just a frontend over `/chat`.
2. **The iframe headless CLI.** The host runs JS in the UI's frame
   (Electron `frame.executeJavaScript`, the same pattern vBrainstem/vtwin use
   headlessly) to read the DOM and dispatch clicks/typing — a UI-agnostic driver.

`rapp-force-mode/1.0` is the **optional** third way: a UI can *opt in* to expose
**named, semantic actions** so the AI drives *intent* ("run the pipeline with
this source") instead of guessing selectors. It never replaces (1) or (2); it
makes driving robust and self-describing for UIs that want it.

## The contract

The host marks every rapplication frame it controls:

```js
window.__rappForceModeCapable = true;                       // set by the host
document.documentElement.setAttribute("data-rapp-force-mode", "ready");
```

A **force-mode-capable** UI registers its actions by replying to the host over
`postMessage` (same-frame `window.parent`, or its own `window` when driven
headlessly). All messages carry `protocol: "rapp-force-mode/1.0"`.

### 1. Announce capabilities (UI → host)

On load, if `window.__rappForceModeCapable`, the UI posts:

```js
parent.postMessage({
  protocol: "rapp-force-mode/1.0",
  type: "capabilities",
  app: "bookfactory",                 // the rapplication id
  actions: [
    { name: "run_pipeline",
      description: "Turn source material into a chapter",
      params: {                       // JSON-Schema-ish
        source: { type: "string", required: true },
        title:  { type: "string" },
        byline: { type: "string" } } },
    { name: "clear", description: "Reset the form", params: {} }
  ]
}, "*");
```

### 2. Invoke an action (host → UI)

```js
frame.postMessage({
  protocol: "rapp-force-mode/1.0",
  type: "invoke",
  id: "call-1",                       // correlation id
  name: "run_pipeline",
  params: { source: "…", title: "Ch. 1", byline: "@you" }
}, "*");
```

The UI performs the action **through its own normal code path** (the same one a
click would trigger — so it still hits the twin's `/chat`), then replies:

```js
parent.postMessage({
  protocol: "rapp-force-mode/1.0",
  type: "result",
  id: "call-1",
  ok: true,
  result: { chapter_url: "…" }        // or { ok:false, error:"…" }
}, "*");
```

### 3. Progress (optional, UI → host)

For long-running actions the UI MAY stream:

```js
parent.postMessage({ protocol: "rapp-force-mode/1.0", type: "progress",
                     id: "call-1", message: "Editor pass 2/5" }, "*");
```

## Rules

- **Opt-in and additive.** A UI without `rapp-force-mode` is still fully drivable
  via `/chat` and the headless DOM driver. Declaring it only adds semantic
  actions.
- **No new capability, no new wire.** Actions run the UI's *existing* code, which
  talks to the twin's `/chat`. `rapp-force-mode` is a control envelope, not a
  data channel — it never bypasses `/chat` (Art. XXV) and adds no route.
- **Same-origin, loopback-only.** The UI runs on its twin's loopback origin; the
  host confines it (CSP `connect-src 127.0.0.1`). Messages are validated by
  `protocol` and ignored otherwise.
- **Never exfiltrate, never collect secrets.** Actions may not read credentials;
  identity auth stays in the user's own browser (see the twin auth boundary).
- **Portable.** The same rapplication + UI works on any Grail brainstem outside
  Frontier — `rapp-force-mode` is just an extra hook a host may use.

## Host support (Frontier)

The Frontier host already injects `window.__rappForceModeCapable = true` +
`data-rapp-force-mode="ready"` into every rapplication UI it renders, and can
drive any UI via the headless DOM driver (`drive_twin`) or the twin's `/chat`.
Full `invoke`/`result` routing to a Surgeon tool is the next increment; the
marker + the two universal driving paths ship today.

## Store field (proposed)

A RAPP Store `rapplications[]` entry MAY declare:

```json
"force_mode": { "capable": true, "actions": ["run_pipeline", "clear"] }
```

so a host can show which rapplications expose semantic actions before hatching.
