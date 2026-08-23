# OpenRappter — autonomous UI driver: data-flow report

Facts only. Repo: `` (branch
`feat/frontier-store-self-evolving-rapplications`, HEAD `582c4edd`). All `file:line`
references are to that checkout. Live numbers were measured on 2026-08-20 against the
Frontier instance running on this machine (driver pid 50540, loopback port 49607, started
17:30:56Z) using read-only bus actions (`inspect`, `read`, `route_telemetry`, status
calls) plus one `screenshot`; raw payloads are saved next to this file as `live-*.json`.
Static numbers come from `measure.mjs` (regex over start tags, method stated in §6).

Token estimates use 4 bytes/token throughout.

---

## 1. The loop — who calls whom, per turn

There are **two independent loops** that share one HTTP bus and one visible window.
Neither is the `AgenticDrive` postMessage bus described in `beta/CONSTITUTION.md:175-181`
and `beta/docs/UI-AUTOSTEER-PROTOCOL.md`; that document is committed truncated at 66 lines
and ends mid-sentence inside stage 4 ("`contentWindow` (the frame *") — the bus spec it
names does not exist in the tree (commit `f191ee21`).

### Processes

| Process | What runs there | Key code |
|---|---|---|
| Electron **main** | UI-driver HTTP server (in-process), `RappterSurgeon` instances (one per chat tab, max 12), `uiCommand` queue, route manager, twin manager | `beta/electron/ui-driver-server.mjs:1618` (`createServer`), `beta/electron/main.mjs:490-491`, `:865-893`, `:1563-1589` |
| Electron **renderer (shell)** | `beta/ui/index.html` + `renderer.js`; hosts the Brainstem `<iframe id="brainstem">` (`beta/ui/index.html:670-674`) and twin tile iframes | `beta/ui/renderer.js:1271-1311` (Surgeon event rendering) |
| **Brainstem iframe** (Grail UI) | Unchanged `rapp_brainstem/index.html` served by the routed worker at `http://127.0.0.1:<port>/?beta=1` (live: `:49608`) — this is the default target of every driver command | `ui-driver-server.mjs:61-64` (`brainstemFrame`) |
| **Brainstem worker** (Python/Flask) | `rapp_brainstem/brainstem.py` in an isolated `AGENTS_PATH`; runs `BrainstemUiDriver.perform()` when the model calls it | `rapp_brainstem/brainstem.py:2180-2228`, `beta/scripts/brainstem_ui_driver_agent.py:181-269` |
| **Copilot CLI** (child of main, stdio) | The Rappter Surgeon model loop via `@github/copilot-sdk` | `beta/electron/rappter-surgeon.mjs:838-852` |
| **Copilot API** (remote) | The model behind Brainstem `/chat`; receives tool schemas + tool results | `brainstem.py:2501`, `:2529` |

### Authentication and transport (same for both loops)

- Server listens on `127.0.0.1:<ephemeral>` (`ui-driver-server.mjs:1893`), generates a 32-byte
  hex `token` and a separate `artifactToken` (`:1563-1564`), writes
  `~/.brainstem/beta-launcher/ui-driver.json` (mode 0600) with `{version, host, port, token,
  pid, brainstemRuntimeFingerprint, runtimeFingerprint, startedAt}` (`:1901-1910`;
  `writeMetadata` `:1524-1531`).
- Commands: `POST /v1/command` with `Authorization: Bearer <token>` (`:1736-1743`); body is
  JSON ≤ 256 KB (`:19`, `:38-53`); `validateCommand` whitelists 19 actions (`:1341-1379`).
- Artifacts (PNG/WebM) are served at `GET /v1/{captures|recordings}/<id>?token=<artifactToken>`
  (`:1587-1588`, `:1708-1734`), map capped at 100 entries (`:1580-1582`).
- Long commands: headers are flushed immediately and a single space heartbeat is written
  every 15 s (`:1748-1755`); the JSON body therefore may start with whitespace.
- Callers read the metadata file and POST: Python agent (`brainstem_ui_driver_agent.py:11-19`,
  `:182-203`, `urlopen` timeout 130 s), Electron main `rawUiCommand` (`main.mjs:872-893`),
  external harnesses (`beta/scripts/drive-via-chat.mjs:81-98`,
  `beta/scripts/walkthrough-via-chat.mjs:388-403`).
- Execution: the server picks a frame and runs
  `(${browserDriverCommand.toString()})(${JSON.stringify(command)})` via
  `frame.executeJavaScript(source, true)` (`:1880-1881`). Frame choice: `twin:<id>` →
  `twinFrame()` by URL prefix (`:69-76`, `:1869-1871`; prefixes from
  `main.mjs:1564-1567`); `target:"shell"` → `mainFrame` (`:1872-1873`); otherwise the first
  frame in the tree whose URL passes `loopbackUrl` (`:61-64`, `:1874`).
- Serialization on the main-process side: all Surgeon sessions share one module-level
  promise chain `uiStageChain` (`main.mjs:865-870`); the HTTP server itself has no mutex,
  so Python-agent commands and Surgeon commands can interleave.

### Loop A — Brainstem-side (`BrainstemUiDriver` agent; this is what puts text into the Brainstem model's context)

The agent is **not** part of the default composition: `route-manager.mjs:1223-1240`
composes `~/.brainstem/src/rapp_brainstem/agents/*_agent.py` plus the two memory rings;
`grep brainstem_ui_driver` across `beta/` finds it only in `package.json:51`, tests, and the
two harness scripts. It enters a worker either as `delegate_to_brainstem`'s
`ephemeral_agent` (the `drive:e2e` path, `drive-via-chat.mjs:22-42`) or if a user installs
it. When present, it is reloaded and its schema sent on **every** `/chat` request.

1. A user types in the Brainstem composer `#input`/`#send` (`rapp_brainstem/index.html`), or
   the Surgeon's `chat` action types it for them (`ui-driver-server.mjs:503-586`).
2. Grail UI → `POST /chat/stream` with `conversation_history` capped to 40 messages /
   60,000 chars, role+content only (`rapp_brainstem/index.html:1313-1325`, `:1334-1337`,
   `:2795-2799`).
3. `brainstem.py` builds `messages = [system] + history + user` and calls Copilot with all
   agent schemas as tools, streaming (`:2486-2501`).
4. Model emits `tool_calls: [{function:{name:"BrainstemUiDriver", arguments:{action,...}}}]`.
5. `run_tool_calls` (`:2180-2228`): `agent.perform(**args)` (`:2213`) →
   `_camelize` (`brainstem_ui_driver_agent.py:22-43`) → HTTP POST (`:193-203`) →
   server → frame → DOM → result.
6. `perform` returns `json.dumps(result, indent=2)` (`:269`) for every action except
   `screenshot` / `stop_recording`, which return a **dict** `{content, log, captures,
   recordings}` (`:214-268`).
7. `run_tool_calls` appends `f"[{fn_name}] {result}"` to `logs` (`:2214`) and
   `{"role":"tool","content": str(result)}` to the results (`:2222-2227`). For the dict
   case `str(result)` is the **Python repr** (single quotes, `None`) — that is what the model
   reads and what lands in `agent_logs`. No truncation anywhere on this path.
8. `messages.extend(tool_results)` (`:2547`), SSE `{"type":"agent","logs":...}` (`:2548`),
   loop up to **3 rounds** (`:2486`), then a final tool-less completion if still asking for
   tools (`:2555-2560`). SSE `done` carries `agent_logs: "\n".join(all_logs)` (`:2596`).
   (Non-stream `/chat` mirrors this: `:2307-2323`, `:2332`, `:2347`.)
9. Frontier's default `smooth` frame bridge forwards the SSE as adaptive word-sized delta
   events (first piece immediate, then a 32 ms cadence with a ≤1 s lag bound). The `agent`
   event waits for earlier text, then Grail stores its logs in a variable
   (`rapp_brainstem/index.html:2980-2981`, no per-tool indicator); `done` flushes queued text,
   and Grail commits `{role:'assistant', content}` to history (`:1334-1337`) and renders
   **one** stable assistant bubble with a collapsed
   "▶ agent called BrainstemUiDriver" disclosure containing the full `agent_logs`
   (`:3026`, `:3059` → `appendMsg` `:2453-2545`).

### Loop B — Surgeon-side (GitHub Copilot tools in `rappter-surgeon.mjs`)

1. User (or the `surgeon_chat` driver action, `ui-driver-server.mjs:436-502`) types into
   `#surgeon-input` and clicks `#surgeon-send` (`beta/ui/index.html:728`, `:731`).
2. Renderer → IPC `beta:surgeon-send` (`beta/electron/preload.cjs:20`) → main
   `RappterSurgeon.send()` → `session.sendAndWait({prompt}, 1 h)` (`rappter-surgeon.mjs:889-911`).
3. The Copilot CLI model calls driver-backed tools; **11** of them hit the bus:
   `delegate_to_brainstem` (`:203-241` → `:1289-1335`: `set_chat_lease` + `wait #input` +
   `chat`), `inspect_visible_brainstem` (`:243-257`), `capture_visible_brainstem`
   (`:728-734` → `:1401-1428`), `clear_brainstem_chat` (`:749-765`, `targetText:"Clear"`),
   `refresh_brainstem_view` (`:767-782`), `start_demo_recording` (`:784-801`),
   `stop_demo_recording` (`:803-834` → `:1430-1464`), `drive_visible_brainstem`
   (`:487-540` → `run`), `drive_twin` (`:542-582` → `run` + `twin`), `set_ai_force_mode`
   (`:584-601`), `show_mode_click_through` (`:603-617` → `:1337-1399`).
4. Each handler calls `this.uiCommand` = `main.mjs:865-893` (queued, then the same POST).
5. The handler's return value goes back to the SDK. Only objects shaped
   `{textResultForLlm, resultType}` get special handling (`@github/copilot-sdk/dist/session.js:1027-1045`);
   plain objects/strings are passed through for the CLI to serialize (the serializer is not
   in this repo; the "surgeonfmt" column in §2 assumes compact `JSON.stringify`). No
   Frontier-side truncation; `grep -i 'compact|truncat'` over `session.js` finds nothing.
6. SDK session events → `tool-start` / `tool-complete` (`rappter-surgeon.mjs:854-874`) →
   `emitSurgeonEvent` → IPC `beta:surgeon-event` (`main.mjs:531-533`, `:936`) →
   `handleSurgeonEvent`. In default `smooth` mode, `delta` text runs through the shared
   adaptive pacer into one caret-marked bubble; tool boundaries flush earlier text and tool
   rows remain live. Tool **results are never sent to the renderer**; only name +
   running/done/failed.
7. Session is one persistent CLI session with `infiniteSessions` and `memory` enabled
   (`rappter-surgeon.mjs:841-852`); every tool result stays in it for the life of the tab.

### Loop B → A hand-off (`delegate_to_brainstem`)

`chat` action (`ui-driver-server.mjs:503-586`): records the max `#chat .response-slot
[data-request-id]` (`:509-513`), types the prompt into `#input` one character per
`setControlValue` at **5 ms/char** (`:515-520`, `:328-334`), clicks `#send`, waits ≤2 s for a
new request-id slot via `MutationObserver` (`:521-552`), then polls every 150 ms for
`.msg.assistant:not(.typing-indicator):not(.stream-arriving)` (`:559-585`, default 180 s,
max 1 h) and returns `{requestId, response, agentLogs}` where `agentLogs` =
`normalizedText(reply.querySelector(".agent-logs"))` (`:576-580`). The `.agent-logs` box is
`display:none` while collapsed; `innerText` of a non-rendered element returns its
`textContent`, so the **entire** agent-log string (every tool result of that Brainstem turn)
comes back into the Surgeon context. `delegateToBrainstem` returns
`JSON.stringify(result, null, 2)` (`rappter-surgeon.mjs:1314`, `:1329`); `withRoute` records
2,000-char / 1,000-char previews to telemetry only (`route-manager.mjs:2156-2163`).

---

## 2. What TEXT enters model context per action

Measured at rest (fresh Brainstem welcome screen, shell with intro dismissed). "agentfmt" =
what Loop A puts in the tool message (`json.dumps(result, indent=2)`); "surgeonfmt" =
compact JSON for Loop B. Both paths additionally copy the same text into `agent_logs` (Loop
A) — i.e. Loop A counts every result **twice** in the response stream (tool message +
`agent_logs`), and a `delegate_to_brainstem` turn counts it a **third** time when
`agentLogs` is scraped back into the Surgeon.

| Action (server) | Result shape (code) | Bound in code | Measured at rest |
|---|---|---|---|
| `inspect` | `{title, url, interactive:[{selector, tag, text, disabled}], text}` (`:611-631`) | `limit` 1..200, default 80 (`:618`); `text` per element ≤180 (`:622`); body `text` ≤4,000 (`:629`) | Brainstem frame: 21 elements → **4,387 B (~1.1k tok)**; shell: 16 → 3,775 B. Worst case ≈ 200 × (≈100 selector + 180 text + ≈45 JSON) + 4,000 ≈ **68 KB (~17k tok)** |
| `read` | `{selector, text}` (`:632-642`) | default 12,000 chars; **no upper bound** (`Number(step.limit) \|\| 12000`, `:640`; the walkthrough passes 20,000, `walkthrough-via-chat.mjs:810-819`) | body: 948 B; `#chat` fresh: 527 B; `#chat` grows with the transcript |
| `click` | `{clicked: selectorFor(el), text: normalizedText(el)}` (`:281-284`) | `text` unbounded (a `<select>` returns all option labels) | ≈ 40–300 B |
| `type` | `{typed: n, selector}` (`:339`) | — | ≈ 40–120 B |
| `press` | `{pressed, selector}` (`:674`) | — | ≈ 40–120 B |
| `wait` | `{selector\|null, text}` (`:366-369`) | with a selector, `text` = **full `innerText` of the matched element, no slice** (`:368`) — e.g. `wait selector:#chat` returns the whole transcript | 30 B – unbounded |
| `announce` | `{announced}` (`:649`) | — | ≈ 40 B |
| `run` | `{results:[…]}` (`:689-697`) | 1..40 steps (`:1368`); sum of the above | — |
| `screenshot` | `{captureUrl, dataUrl, path, size, visibleText}` (`:1591-1616`) | `visibleText` ≤12,000 (`:1605`, Brainstem frame only); `dataUrl` = JPEG q72, ≤1,280 px wide (`:1599-1601`, `:1611`) | wire **59,215 B** (dataUrl 57,979 B; window 2560×1656). Loop A: `dataUrl` popped (`brainstem_ui_driver_agent.py:250`), returns dict → `str()` repr ≈ 400 B + visibleText (≤12 KB, 892 B at rest). Loop B `capture_visible_brainstem`: `Visible Brainstem text:\n` + visibleText as text **plus the JPEG as a binary image part** (`rappter-surgeon.mjs:1414-1427`) |
| `stop_recording` | `{recording, screenshot}` (`:1845-1859`) | as screenshot | Loop A: dict repr with visibleText (`brainstem_ui_driver_agent.py:220-248`); Loop B: JSON with `visibleText` (`rappter-surgeon.mjs:1454-1463`) |
| `start_recording` | `{encoder, frameRate, maxDurationMs, startedAt}` (`:1279-1284`) | — | ≈ 100 B |
| `route_telemetry` | `{sequence, active_route, worker_count, stack_count, stack_tree, …, events, chat_lease_count, navigation_count}` (`:1786-1807`) | `events` grows over the session | **3,345 B (~836 tok)** |
| `tour` | `{available, running, step, index, total, steps[]}` (`:1497-1504`) | — | 302 B |
| `force_mode`, `set_chat_lease`, `recording_status`, `refresh` | tiny objects | — | 16–40 B |
| `chat` | `{requestId, response, agentLogs}` (`:576-580`) | **unbounded** (full reply + full agent logs) | depends on the turn |
| `surgeon_chat` | `{response}` (`:495-497`) | unbounded (full Surgeon reply) | — |

Per-request fixed overhead in Loop A when the agent is loaded: tool schema **3,776 B
(~944 tok)** + `system_context` **919 B (~229 tok)** on every `/chat` call
(`brainstem_ui_driver_agent.py:49-162`, `:163-179`). The `drive:e2e` harness additionally
pastes the whole agent source — **11,000 B (~2.75k tok)** — into the visible Surgeon chat as
the user message (`drive-via-chat.mjs:14-15`, `:27-31`; same pattern in
`walkthrough-via-chat.mjs`).

### Worst offenders (by code path)

1. **`screenshot` via Loop A** — `system_context` instructs the model to call it "after an
   important click or completed workflow" (`brainstem_ui_driver_agent.py:167-169`); each call
   injects up to 12,000 chars of page text as a Python-repr'd dict, twice (tool message +
   `agent_logs`).
2. **`read` with no selector / large `limit`** — whole body `innerText`, default 12 KB, no
   ceiling (`:640`).
3. **`wait` with a selector** — returns the element's full `innerText` (`:368`).
4. **`chat` → `agentLogs`** — re-imports every Loop-A tool result into Loop B (`:579`).
5. **`inspect`** — 4.4 KB at rest, up to ~68 KB; `inspect_visible_brainstem` defaults to 80
   elements (`rappter-surgeon.mjs:253`); the Python schema lets `inspect` be a `run` step too
   (`brainstem_ui_driver_agent.py:52-60`).
6. **Echo into `agent_logs`** — `brainstem.py:2214` copies every result verbatim into the
   string that the Grail UI renders (§4) and that the `chat` action scrapes.
7. **In-turn accumulation** — up to 3 rounds × N tool calls kept in `messages`
   (`brainstem.py:2542-2547`), no pruning; cross-turn the Grail UI re-sends only
   user/assistant `content` (`rapp_brainstem/index.html:1334-1337`), so tool text leaves
   the Brainstem context only if the assistant did not echo it into its reply. Loop B keeps
   everything in the CLI session (`rappter-surgeon.mjs:844`).
8. **`route_telemetry.events`** grows for the life of the route manager.

---

## 3. How targets are addressed, and the accuracy failure modes that follow

### Addressing modes (`browserDriverCommand`, `ui-driver-server.mjs:205-225`)

- **CSS `selector`** → `document.querySelector(step.selector)` — first match only (`:206-211`).
  If that first match is not `visible()`, the action errors `Visible UI target not found`
  (`:677-683`) without trying later matches (only `wait` iterates matches, `:351-358`).
- **`targetText` / `text`** → candidates are
  `button,a,input,textarea,select,[role='button'],[role='menuitem'],[tabindex]` filtered by
  `visible()` (`:218-222`); match = first element whose `normalizedText` (innerText ||
  aria-label || title || value, whitespace-collapsed, lower-cased) **equals** the wanted text,
  else first whose text **includes** it (`:223-224`). Document order decides ties.
- **No** index, coordinates, role+name queries, generated element handles, or
  data-attribute lookup. `press` with no selector targets `document.activeElement || body`
  (`:652`).
- Frame is chosen per command (`target` / `twin`), not per selector; `findElement` never
  crosses frames and `querySelectorAll` does not pierce shadow roots.

### Generated selectors (`selectorFor`, `:188-203`)

`#id` if the element has an id; otherwise a path of ≤5 `localName[:nth-of-type(n)]` segments
walking up from the element and stopping at 5 parts **or** `body`, whichever first. Paths
are therefore **unanchored** when deeper than 5; `querySelector` resolves them from the
document root as "first element anywhere matching this tail". Live samples the model
receives:

```
"div:nth-of-type(4) > div:nth-of-type(2) > div > p:nth-of-type(3) > button:nth-of-type(1)"   (Brainstem: "New here? Take the 5-minute guided tour")
"footer > div:nth-of-type(2) > div:nth-of-type(2) > button:nth-of-type(3)"                     (Brainstem: "Clear")
"div:nth-of-type(2) > div > div > div:nth-of-type(2) > button:nth-of-type(5)"                  (shell: "Show Mode: click-through preview")
"header > div:nth-of-type(1)"                                                                  (Brainstem: the logo div the bridge made focusable)
```

Live: **10 of 21** Brainstem-frame entries and **8 of 16** shell entries were nth-of-type
paths (no id). Any sibling insertion (a new chat message, a new Surgeon tab, a new twin
tile) shifts `nth-of-type` and silently retargets the path.

### Failure modes that follow from the code

| Mode | Where | Effect |
|---|---|---|
| Ambiguous text | `:223-224` | substring fallback picks the first visible candidate containing the text; e.g. the shell has two "×" buttons (`#explorer-close`, `#surgeon-close`) — live `duplicateTexts=1`; `#model-select`'s `text` is the concatenation of every option label (180 chars), so any model name substring-matches the select |
| Dynamic lists | `:188-203` | `#chat`, `#surgeon-log`, `#surgeon-tabs`, `#agent-tree`, herd tiles and Show Mode starters are all renderer-generated without ids → nth-of-type paths only |
| Stale scans | `:611-631` | `inspect` is a one-shot snapshot with no handles/versioning; nothing detects that the DOM changed between `inspect` and `click` |
| Re-render / reload | `main.mjs:1380-1388`, `renderer.js:64`, `:110` | the `#beta-*` menu and the logo's role/aria-label exist only after the frame bridge is injected over IPC; after `refresh` they exist again only once the renderer re-installs the bridge |
| Frames | `:1869-1881` | one frame per command; the Surgeon's `drive_visible_brainstem` schema has **no `target` property** (`rappter-surgeon.mjs:513-524`), so it can only ever address the Brainstem frame — shell controls (Explorer, Surgeon tabs, `#enter`) are unreachable from that tool; the Python schema has `target` (`brainstem_ui_driver_agent.py:97-101`) |
| Twin frames | `:69-76`, `main.mjs:748-776` | tiles are found by URL prefix (works through the `document.write` injection, `main.mjs:698-709`); a popped-out twin is a separate `BrowserWindow`, not in `mainWindow`'s frame tree → not drivable |
| Shadow DOM | `:206-224` | not traversed |
| Visibility ≠ clickability | `:167-176` | `visible()` checks rect/display/visibility/opacity only — not `disabled`, `pointer-events`, or occlusion by `#splash`, the login overlay, `#intro`, or the driver's own overlays; `element.click()` on a disabled button is a silent no-op that still returns `{clicked}` |
| Synthetic events | `:276-277`, `:669-670`, `:386-397` | `click()` and `KeyboardEvent`s are `isTrusted=false`; `press` dispatches only `keydown`+`keyup` (no `keypress`, no default action, so Enter does not submit unless the app listens on keydown); the chat-lease witnesses observe only trusted events and never prevent one, and a trusted interaction hands the composer to the person so the driver's next checkpoint yields |
| Wait semantics | `:342-376` | text-only `wait` is `document.body.innerText.includes(text)` polled every 100 ms — it is satisfied by any earlier occurrence, including the **user prompt that asked for the marker** (e.g. the walkthrough's `STACK_CHURN_READY` instruction is itself in the transcript), the driver's narration label, or the collapsed/visible logs; default timeout 10 s, max 120 s |
| No post-action verification | `:264-285`, `:310-340`, `:651-675` | `click`/`type`/`press` sleep `settleMs` (defaults 520/300/280 ms) and return success unconditionally; only `chat` (`:509-585`) and `surgeon_chat` (`:458-499`) have completion detection (request-id slot / reply-count baseline) |
| Python `force_mode` never reaches the server | `brainstem_ui_driver_agent.py:22-43`, `:102-108`, `:176`; `ui-driver-server.mjs:1756` | `_camelize` has no `force_mode → forceMode` mapping; the server checks `command.forceMode === true`; the schema and `system_context` tell the model to "pass force_mode=true on your run" — it is silently ignored (the `action:"force_mode"` form works) |
| Timeouts | `brainstem_ui_driver_agent.py:203`, `:1753` | Python caller gives up at 130 s; `wait` max 120 s fits, but a `run` of several waits does not |
| Driver residue in page text | `:231-240`, `:252-258`, `:338` | the narration label's `textContent` is never cleared (only `.show` removed; opacity 0 is still "rendered"), so the last label ("Clicking Send", "Typing in the Brainstem") stays in `body.innerText` and appears in `read`, `wait` matching and `visibleText`; `inspect` excludes driver nodes via `dataset.brainstemAiDriver` (`:617`) but `read`/`screenshot` do not |
| Concurrency | `main.mjs:865-870` vs `ui-driver-server.mjs:1618` | Surgeon commands are queued; Python-agent commands are not — two cursors can fight over one page |

---

## 4. What the CHAT shows the user during a drive

### Brainstem chat (Grail UI in the iframe) — Loop A

- **During the turn:** Grail appends its typing indicator before sending
  (`rapp_brainstem/index.html:2547-2564`). Under default `smooth`, Frontier forwards the first
  complete word-sized piece immediately and paces the rest at 32 ms, adaptively combining
  pieces whenever the backlog would exceed one second. Grail's `ensureBubble()` removes the
  indicator on that first delta and adds `stream-arriving` / `stream-mask`
  (`:2945-2953`). Frontier's smooth-only CSS disables the mask and 560 ms coalesce animation,
  replaces the slide with a 160 ms opacity-only arrival, calms the dots, glides the 1,200-char
  max-width change, and attaches a quiet caret to `stream-arriving`. Tail following pins
  content above the measured footer unless the user scrolls away. The `agent` event still
  only feeds a variable (`:2980-2981`), so **no per-tool indicator** exists in this chat.
- **At terminal/error:** queued text flushes immediately before the terminal event. The
  concatenated delta text is byte-equal to upstream and event order is preserved. On normal
  completion Grail removes the provisional `stream-arriving` node (`:3057`) and appends the
  stable markdown bubble (`:3059`), which removes the class-scoped caret exactly at the swap.
  A reader failure emits completed text followed by a `type:"error"` event; abort cancels
  upstream. `RAPP_CHAT_STREAM=raw` uses the untouched native response; `hold` buffers until
  completion, and `RAPP_CHAT_TYPING=1` remains a hold alias.
- **On completion:** exactly **one** assistant bubble per `/chat` turn, regardless of how
  many driver calls ran (≤3 rounds): `appendMsg('assistant', finalText, finalLogs)`
  (`:3059`; non-stream `:2766`). If `finalLogs` is non-empty the bubble carries an
  `.agent-logs-wrapper` with a `button.logs-label` reading "▶ agent called
  BrainstemUiDriver" (`:2496-2512`) and a `div.agent-logs.collapsed` whose `textContent` is
  the **entire `agent_logs` string**, with `[Agent] {…}` payloads pretty-printed
  (`:2513-2523`). Collapsed by default; one click expands the whole thing.
- **Bubble width:** assistant text > 1,200 chars gets class `wide` (`:2474`); the model's
  prose is the only thing the user sees without expanding, and its content is whatever the
  model wrote from the raw JSON/repr results — there is no rendering of `clicked`/`typed`
  results as steps.
- **Media:** the `captures` / `recordings` keys the Python agent returns for `screenshot` /
  `stop_recording` (`brainstem_ui_driver_agent.py:232-248`, `:259-268`) have **no renderer**
  in the Grail UI (`grep captures|recordings|<video` over `rapp_brainstem/index.html`:
  none) — they appear only as text inside the collapsed logs. `beta/README.md:220-221`
  ("shown with playback controls in the agent activity attached to the chat response")
  describes behavior the code does not implement for this path.
- **Delegated prompts:** the Surgeon's `chat` action visibly types the prompt into `#input`
  at 5 ms/char (`ui-driver-server.mjs:515-520`) — a 1,000-char prompt takes ≈5 s to appear,
  then shows as a normal user bubble.
- **Per action, message count:** one provisional assistant bubble streams during the turn,
  then Grail swaps it for one stable assistant bubble + optional disclosure; via
  `delegate_to_brainstem`: +1 user bubble.

### Surgeon panel (shell) — Loop B

- Per tool call: one `.surgeon-tool` row `⚙ <toolName> running` → `done`/`failed`
  (`renderer.js`, `addSurgeonTool` / `finishSurgeonTool`), kept live while prior paced text
  flushes. Arguments and
  results are **never rendered** (they are never sent over IPC — `rappter-surgeon.mjs:858-873`).
- In default `smooth`, the first paced piece creates one
  `.surgeon-message.assistant.stream-arriving` bubble and quiet caret; subsequent word-sized
  pieces append at the shared cadence. The panel follows the tail above its measured composer
  clearance unless the user scrolls more than 80 px away, then resumes at the bottom or on the
  next reply. `done` flushes the scheduler, applies the authoritative final text, removes
  `stream-arriving`, pins once, and persists the same history content as before.
  `raw` appends each SDK delta directly; `hold` keeps the accessible three-dot typing bubble
  and atomic delivery. Reduced motion disables the caret/fade and leaves the pre-response dots
  static.
- `artifact` events render `<img>`/`<video controls>` tiles with a link (`:552-577`) — only
  from `capture_visible_brainstem`, `stop_demo_recording`, and `show_mode_click_through
  capture` (`rappter-surgeon.mjs:1375-1383`, `:1405-1413`, `:1436-1453`).
- `lease` events add an assistant bubble "Temporary capability leased." (`:1292-1293`).
- The user's own message is shown verbatim — for `npm run drive:e2e` that is the 11 KB Python
  source (`drive-via-chat.mjs:22-42`), typed in at 5 ms/char by `surgeon_chat`
  (`ui-driver-server.mjs:464-469`) ≈ 55 s of typing animation.
- Sessions persist user/assistant text in `localStorage` (`:491-494`, `:1302-1304`).

---

## 5. Existing affordances to build on

### Stable ids / attributes already in the UI

**Shell (`beta/ui/index.html:661-822`)** — 27 ids, all static: `#splash`, `#error`,
`#brainstem` (iframe, `title="RAPP Brainstem chat"`), `#explorer`
(`aria-label="Live Brainstem agents Explorer"`), `#explorer-refresh`, `#explorer-close`,
`#agent-tree` (`role="tree"`), `#agent-viewer`, `#agent-viewer-tab`, `#agent-viewer-empty`,
`#agent-source`, `#explorer-status`, `#surgeon-tab`, `#surgeon`
(`aria-label="GitHub Copilot Rappter Surgeon"`), `#surgeon-model`, `#surgeon-herd-btn`,
`#surgeon-new` (`aria-label`), `#surgeon-close`, `#surgeon-tabs`, `#surgeon-log`
(`role="log" aria-live="polite"`), `#surgeon-input`, `#surgeon-mode`, `#surgeon-send`,
`#intro`, `#intro-title`, `#show-mode-interview-prompt`, `#enter`; plus
`[data-show-mode-tour]`. Renderer-generated: `#surgeon-herd` (`renderer.js:763`),
`.surgeon-tool[data-tool-name][data-tool-call-id][data-active]` (`:519-521`),
`[data-store-id]` (`:862`), `[data-twin-id]` (`:1010`), `.surgeon-message.{user,assistant,error}`,
`.surgeon-artifact`, `.surgeon-session`.

**Brainstem frame (`rapp_brainstem/index.html`)** — 58 distinct ids statically; the ones
the driver already relies on: `#input`, `#send`, `#chat` (`role="log" aria-live="polite"`,
`:1204`), `.response-slot[data-request-id]` (`:2620`, `:2551`), `.msg.{user,assistant,system}`,
`.bubble`, `.typing-indicator`, `.stream-arriving`, `.agent-logs-wrapper`, `.agent-logs`
(`#agent-logs-<n>`, `aria-controls`/`aria-expanded` on the label, `:2515-2517`),
`#model-select`, `#theme-btn`, `#registry-btn`, `#agents-btn`, `#voice-btn`,
`#voice-settings-btn`, `#vscode-link`, `#version-tag`, `#session-id`. The footer quick
prompts / Export / Import / Clear / Get Help buttons have **no ids** (nth-of-type only).
No `data-*` attributes in the static markup.

**Shell-injected into the Brainstem frame** (`BETA_FRAME_BRIDGE_SOURCE`, `main.mjs:200-262`,
installed via IPC `beta:install-frame-bridge` `main.mjs:1380-1388` from `renderer.js:64`,
`:110`): `#beta-app-btn` (`aria-label`, `aria-haspopup`, `aria-expanded`), `#beta-app-panel`,
`#beta-check-updates`, `#beta-update-status[data-phase=idle|checking|applying|current|
success|available|blocked|error]` (`role="status" aria-live`), `#beta-install-update`;
`header .logo` gains `role="button"`, `tabindex=0`, `aria-label="Toggle
live agents"`, `aria-expanded`, `data-beta-explorer-toggle`. Agent Arena adds
`@brainstem.grab`, `@herd.tile[<id>]` plus `.wake`, `.fold`, and `.race`, and
the `@arena.layout`, `@arena.arrange`, and `@arena.raceTarget` controls; none
are present in herd mode.

**Twin frames**: marker only — `window.__rappForceModeCapable=true` and
`html[data-rapp-force-mode="ready"]` (`main.mjs:685-694`); popped-out windows add
`#__rappViewToggle` (`:724-746`).

### In-page state hooks

`window.__brainstemAiDriver` (`ui-driver-server.mjs:253`) with `chatLeaseTokens`,
`chatLeaseLocked`, `composerHandoffs`, `composerHandoffAt`, `composerHandoffReason`,
`driverComposerValue`, `chatLeaseBannerTimer`, `lastRun`, `cursorIdleTimer`; all of
these fields die with the document on a route swap, so `composerHandoffs` is not a
session-monotonic counter. `window.__brainstemBetaNavigationCount`
(`:1787-1791`); `window.rappShowModeTour` (`:1468-1504`; 14 steps, `beta/ui/show-mode-tour.js:182`)
exposing `steps`, `start/next/prev/stop`, `running`, `step`; `window.__brainstemBetaRecording`
/ `__brainstemBetaLastRecording` (`:713`, `:846`).

### Completion / verification logic that already exists

- `chat`: request-id baseline + `MutationObserver` + stable-reply selector + error-slot
  detection (`:509-585`).
- `surgeon_chat`: assistant/error reply-count baselines + `send.disabled` gate (`:458-499`).
- `wait`: polling primitive with selector+text filter (`:342-376`).
- `delegate_to_brainstem`: lease acquire/release with tokens (`rappter-surgeon.mjs:954-996`),
  `waitForVisibleBrainstem` retry loop (`:1267-1287`).
- Telemetry previews: `route-callback-end` stores 2,000-char `agent_logs_preview` and
  1,000-char `response_preview` (`route-manager.mjs:2156-2163`) — the only place a
  truncation of these payloads already exists.

### Limits already in code (complete list found)

| Limit | Value | Where |
|---|---|---|
| Command body | 256 KB | `ui-driver-server.mjs:19`, `:43` |
| `run` steps | 1..40 | `:1368`; Surgeon schemas `maxItems: 40` `rappter-surgeon.mjs:498`, `:553` |
| `inspect.limit` | 1..200, default 80 | `:618`; Surgeon `maximum: 200` `:250` |
| `inspect` per-element text | 180 | `:622` |
| `inspect.text` | 4,000 | `:629` |
| `read.limit` | default 12,000, min 1, **no max** | `:640` |
| `screenshot.visibleText` | 12,000 | `:1605` |
| Screenshot preview | ≤1,280 px wide, JPEG q72 | `:1599-1601`, `:1611` |
| `wait.timeoutMs` | 100..120,000, default 10,000 | `:343` |
| `chat.timeoutMs` | 1,000..3,600,000, default 180,000 | `:554-557` |
| `surgeon_chat.timeoutMs` | default/max 3,600,000 | `:476-479` |
| `typingDelayMs` | 0..100, default 18 (chat/surgeon_chat use 5) | `:328`, `:519`, `:468` |
| Force-mode idle | 30 s (1 s..10 min) | `:1392`, `:1448-1456` |
| Cursor idle hide | 4 s | `:158` |
| Artifacts map | 100 | `:1580-1582` |
| Recording | ≤10 min, ≤500 MB, 2–12 fps | `:1119-1126`, `:1672` |
| Python HTTP timeout | 130 s | `brainstem_ui_driver_agent.py:203` |
| Brainstem tool rounds | 3 | `brainstem.py:2307`, `:2486` |
| Tool result / `agent_logs` | **none** | `brainstem.py:2214`, `:2226` |
| Grail history re-sent | 40 msgs / 60,000 chars | `rapp_brainstem/index.html:1313-1314` |
| Grail transcript export | 16 turns × 2,000 chars | `:1437-1439` |
| Surgeon tabs | 12 | `main.mjs:491` |
| SDK-side truncation | none found | `session.js` |

### Schemas

- Python tool schema: `brainstem_ui_driver_agent.py:114-162` (top-level `action` enum of 13;
  `steps[]` with 7 step actions; 21 step properties incl. snake_case keys mapped by
  `_camelize` `:22-43`; `target` enum `brainstem|shell`).
- Surgeon: `drive_visible_brainstem` (`rappter-surgeon.mjs:487-540`; 6 step actions, camelCase,
  no `target`), `drive_twin` (`:542-582`, adds `twin_id`), `inspect_visible_brainstem`
  (`:243-257`), `delegate_to_brainstem` (`:203-241`).

### Test doubles / harnesses

- `uiDriverInternals` export (`ui-driver-server.mjs:1930-1942`) exposes
  `browserDriverCommand`, `validateCommand`, recording functions, `runTourCommand`.
- `beta/tests/ui-driver-server.test.mjs` (8 tests): all assert against **function source
  text** (`.toString()` + regex, `:57-91`, `:111-138`) or `validateCommand`; no DOM, no
  `findElement`/`targetText` coverage. `rappter-surgeon.test.mjs` has no driving tests
  (grep for drive/visible/inspect/screenshot/record in test names: none);
  `show-mode-tour.test.mjs:18` and `installer-contract.test.mjs:33` only read the agent file;
  `twin-manager.test.mjs` references `uiCommand`.
- Live harnesses: `beta/scripts/drive-via-chat.mjs` (`npm run drive:e2e`),
  `beta/scripts/walkthrough-via-chat.mjs` (`brainstem-walkthrough`); both talk to the bus
  directly with `inspect`/`click`/`read`/`screenshot`/`surgeon_chat`.

---

## 6. Measured facts

**Method for static counts.** `measure.mjs` (beside this file) regex-scans start tags and
counts exactly the driver's candidate set
`button,a,input,textarea,select,[role=button],[role=menuitem],[tabindex]`
(`ui-driver-server.mjs:220`, `:614`) before the `visible()` filter, plus `id=`,
`aria-label=`, `title=`, `data-*`, `<iframe>`; "approx body text" strips
`<script>/<style>/<template>/<svg>` and tags from `<body>` on and collapses whitespace (it
over-counts hidden content). **Method for live counts.** The real bus was queried; the
driver's own `visible()` filter applied.

| Surface | Static interactive candidates | …with `id` | …with `aria-label` | …with `title` | All `id`s | All `aria-label`s | `data-*` names | iframes | Approx static body text |
|---|---|---|---|---|---|---|---|---|---|
| `beta/ui/index.html` (Electron shell) | 10 (9 button, 1 textarea) | 9 | 1 | 6 | 27 | 3 | `data-show-mode-tour` | 1 | 4,473 chars (~1.1k tok, incl. hidden intro) |
| `rapp_brainstem/index.html` (Brainstem frame) | 55 (29 button, 13 a, 6 select, 5 input, 1 textarea, 1 span[tabindex]) | 24 | 3 | 17 | 58 distinct (59 total) | 3 | none | 0 | 1,815 chars |
| `beta/index.html` (**GitHub Pages installer page, not the shell**) | 8 (6 a, 2 button) | 8 | 0 | 0 | 18 | 4 | `data-theme` | 0 | 1,668 chars |

Renderer-generated interactive elements: `renderer.js` creates 8 `button`, 1 `a`, 1 `input`
(`createElement` count); Grail `index.html` creates 6 `button`, 4 `a`, 2 `input`, 1
`textarea`; the frame bridge adds 3 buttons + 1 status div to the Brainstem frame.

**Live `inspect` (visible only):**

| Target | Elements | `#id` selectors | nth-of-type paths | empty text | duplicate texts | body `text` | Result size (agentfmt / surgeonfmt) |
|---|---|---|---|---|---|---|---|
| Brainstem frame | 21 | 11 | 10 | 0 | 0 | 892 B | 4,387 B / 3,485 B |
| Shell | 16 | 8 | 8 | 1 (`#surgeon-input`) | 1 ("×") | 927 B | 3,775 B / 3,083 B |

`limit: 200` returned identical results (no more visible candidates at rest).

**Live `read`:** Brainstem body 948 B; `#chat` 527 B (fresh welcome); shell body 1,032 B;
`#agent-tree` 0 B (explorer not populated at the time).

**Live `screenshot`:** 59,215 B on the wire; `dataUrl` 57,979 B; `visibleText` 892 B;
window 2,560 × 1,656. **Live `route_telemetry`:** 3,345 B. **`tour status`:** 302 B, 14 steps.

**Distinct `/drive` actions:** server whitelist **19** (`ui-driver-server.mjs:1343-1363`):
`announce, chat, click, force_mode, inspect, press, read, recording_status, route_telemetry,
refresh, run, screenshot, start_recording, set_chat_lease, stop_recording, surgeon_chat,
tour, type, wait`. Exposed to the Brainstem model: 13 top-level + 7 step actions
(`brainstem_ui_driver_agent.py:52-60`, `:128-141`). Exposed to the Surgeon model: 6 step
actions inside `drive_visible_brainstem`/`drive_twin` plus 9 other bus-backed tools (11
tools total touch the bus).

**Fixed text costs:** tool schema 3,776 B (~944 tok) per `/chat` request; `system_context`
919 B (~229 tok); agent source 11,000 B (~2.75k tok) when pasted into the Surgeon chat by the
e2e harness. **Typing animation:** 5 ms/char for delegated prompts (1,000 chars ≈ 5 s;
11,000 chars ≈ 55 s); 18 ms/char default for `type`.

**Max result size limits in code:** none on tool results or `agent_logs`
(`brainstem.py:2214`, `:2226`); `read` has no ceiling (`:640`); the largest bounded single
result is `inspect` at ≈68 KB (200 × ≈325 B + 4,000); `screenshot` is bounded by the JPEG
(measured 58 KB) + 12,000 chars.
