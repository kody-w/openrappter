# RAPP UI Autosteer — `rapp-ui-autosteer/1.0`

**RAPP UI Autosteer** is the standard Frontier pattern for making any
application **AI-steerable through its own user interface**: scan the app's
HTML/UI surface, inject the minimal controller layer it is missing, embed it in
a rapplication iframe, and drive it over an explicit message bus — so the AI
operates the app exactly as a person would (same screens, same controls, same
feedback), while everything it does stays observable and evidence-backed.

This is a protocol, not a library. A rapplication conforms by implementing the
five stages and the laws below. Amend this document only in the same commit as
the behavior it standardizes (the `beta/CONSTITUTION.md` rule).

## Definitions

- **Twin** — an isolated Brainstem worker hatched by the Frontier
  (`beta/electron/twin-manager.mjs`), bound to its own `127.0.0.1:<port>`. That
  loopback origin is "the app's own origin" throughout this document.
- **Engine** — the twin's `*_agent.py`, the deterministic code behind its `/chat`.
- **Live-state sidecar** — a file the engine writes next to itself (into its own
  `AGENTS_PATH` dir) named `<name>_live_state.py` — NOT `*_agent.py`, so the
  kernel never imports it: first line a `#` comment, then exactly one JSON
  object; written atomically (`tmp` + `os.replace`, mode 0600) on every engine
  action. The kernel serves it at `GET /agents/export/<name>_live_state.py` —
  free for **same-origin** loopback callers, and gated by the per-install
  `X-Brainstem-Secret` for any LAN caller *and* any cross-origin browser caller — including another
  loopback port, which `_is_foreign_browser_request()` treats as foreign
  (`rapp_brainstem/brainstem.py:345-357`). The route is **not** "loopback-only"; it is
  same-origin-free and secret-gated, which is why stage 3 requires injected code to run at the app's
  own origin.
- **Autosteer bus (AgenticDrive)** — the postMessage wire specified in stage 4.

Reference implementations (read the committed ones before writing a new one — tier B is a described pattern, not a committed file):

| Tier | Where the controllers enter | How the app is served | Reference |
|------|-----------------------------|-----------------------|-----------|
| **A — generation-time** | The rapplication generates the app; the bus is baked into the generated code | A local server the rapplication starts (static files + a same-origin `/chat` proxy, e.g. the studio's generated `serve.py`) | `beta/frontier/rapplications/agentic-app-studio/agents/agentic_app_studio_agent.py` (`LOCAL_APP_HTML`); parent side in its `index.html` |
| **B — wrap-time** | An existing app is carried (e.g. inside an `.egg`); a **copy** is surgically patched with the shims it needs | Injected over the twin's own frame (`document.write` at the twin origin) or its pop-out window | the AIdeate workshop egg pattern: AI calls re-pointed to the twin's `/chat`, live-state poller added, original app untouched |
| **C — host-injection** | The Frontier host injects a capability marker into every rapplication frame it renders | n/a (instrumentation only) | `instrumentRappUi()` / `injectFrameUi()` in `beta/electron/main.mjs` |

## The five stages

### 1. SCAN — map the operable surface
Read the app's HTML/DOM and enumerate what a person can do with it: forms,
buttons, inputs, navigation, and the feedback each action produces. Produce a
**drive map**: `intent → { control (stable selector), action, completion signal }`.
Prefer stable `id`s and `data-*` attributes; if the app lacks them, the inject
stage adds them to the copy rather than relying on brittle positional selectors.

### 2. PLAN — decide the minimal additions
For each intent, ask: can it be exercised and *observed* through the DOM alone?
Anything that cannot — async completions with no signal, internal state with no
readout, remote calls that must be re-pointed to local services — becomes a
**controller addition**. Minimal means minimal: the bus mirrors the human
surface; it never adds capabilities the UI doesn't have.

### 3. INJECT — deliver the controllers
Pick the tier. In every tier:
- the **injected bytes themselves** carry a banner comment naming what was
  added and why (source-file comments in the injector do not count — the
  declaration travels with the code);
- injection lands in a **copy, generated output, or frame** — never the user's
  original files;
- injected code runs at the app's own origin so `/chat` and asset fetches stay
  same-origin.

### 4. DRIVE — the Autosteer bus (AgenticDrive)

**Addressing.** A parent drives a specific app by posting to that iframe's `contentWindow`: the
frame *is* the address, so several apps can be driven at once without a router, a session id, or any
shared namespace between them. Inside a frame, an intent addresses a **handle** from the drive map —
a stable name — never a CSS path, so re-layout cannot silently re-target a command.

**Two messages, one direction each.** `agentic-drive` carries a command from the parent into the app.
`agentic-event` carries everything the app says back: the result of a command, correlated by the id
the parent sent, and unsolicited events the app raises on its own. One name per direction keeps the
contract small enough to implement from this page.

```js
// parent → app
frame.contentWindow.postMessage({ type: "agentic-drive", id, intent: "submit", args }, origin)
// app → parent
parent.postMessage({ type: "agentic-event", id, ok: true, observed: "result-rendered" }, origin)
```

**Every command completes exactly once.** Success or failure, always with the id it was given, never
silence. If an intent has no completion signal to report, the drive map is wrong and the fix is in
stage 1 — a timeout tuned until it usually passes is how a driver starts lying about what it did.

**Bounded and observed.** Commands carry a budget and the parent supersedes a command that outlives
it, so a wedged app fails visibly instead of hanging the driver. Completion is *observed* — the
signal named in the drive map appeared — never assumed from elapsed time.

**Same origin, no privilege.** The bus is postMessage between the parent and an app running at the
app's own origin, checked against an expected origin on both ends. It grants nothing the interface
does not already grant: if a person cannot do it in the UI, no intent can either.

**Never exclusive.** A drive never captures focus or the pointer, never installs a modal or a
click-swallowing overlay, and yields any contested control to the person, reporting
`yielded_to_user`. The person's input path stays live for the whole drive.

### 5. PROVE — the drive must be shown, not asserted

An autosteer implementation is proven when, from a cold start and with no human input, a scripted
drive exercises **every intent in the drive map** and each one is confirmed by its named completion
signal. That run is the artifact — a recording, a trace, or both.

Three obligations that are easy to skip and are the whole value of the stage:

1. **The original is untouched.** Checksum the app's own files before and after a driven run: byte
   identical. Injection landed in the copy, the generated output, or the frame — as stage 3 requires.
2. **The injection declares itself.** The delivered bytes carry the banner naming what was added and
   why, and the proof reads it out of the *shipped* artifact, not out of the injector's source.
3. **Failure is reported as failure.** Inject a fault — remove a control, break a completion signal —
   and confirm the drive reports that intent as failed rather than passing on a timeout. A harness
   that cannot fail has not proven anything about the runs where it passed.

What is not exercised is reported as unverified. An intent in the drive map with no proving run is a
claim, and the point of this protocol is that driving an interface produces evidence rather than
confidence.
