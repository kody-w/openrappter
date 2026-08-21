# Chat streaming — keep the stream, fix how it looks and moves

Decision (Kody, 2026-08-20), after seeing hold-and-pop live: *"go back to
streaming… that does feel right. I don't want my AI to be typing. I want it to
stream in. Just make the streaming UI/UX of how it is displayed and animated —
that's what I need fixed."*

Token streaming is the product. Frontier keeps the unchanged Brainstem
`/chat/stream` contract and fixes its presentation from inside the frame. The
kernel (`rapp_brainstem/`) is never edited, and a bare Brainstem outside
Frontier looks as it always did.

## What the kernel does, and what the Frontier changes

Smooth v1 paced SSE deltas into the kernel, but wire timing was not the visual
bottleneck. The kernel schedules a render every 80 ms, then
`renderStreamedText` returns early while `hasUnresolvedMarkdown(nextTree)` is
true (`rapp_brainstem/index.html:2904-2943`). A heading, list, emphasis span,
link, or fence can hold several deltas until its Markdown tree is structurally
complete. The subsequent block morph and masked reveal make those delayed
deltas arrive as a lump.

Smooth v2 leaves the kernel renderer unchanged and moves only the in-progress
visual render into the Frontier bridge:

| Kernel today | Frontier (`RAPP_CHAT_STREAM=smooth`, default) |
|---|---|
| Creates the request response slot and typing indicator. | Claims the current typing indicator, hides it with an injected class, and inserts a structurally matching `.msg.assistant` marked `data-rapp-provisional="1"` in the same response slot. |
| Receives SSE deltas, schedules work every 80 ms, and waits for structurally resolved Markdown before updating its stream bubble. | Holds the original SSE chunks so the kernel receives zero bytes before a terminal event. Incoming delta text feeds a word-granular adaptive screen pacer instead; terminal drain has a 300 ms timer fallback if animation frames pause. |
| Re-renders completed Markdown blocks and wipes new text in with `.stream-mask` / `.stream-revealing`. | Re-renders the complete growing provisional source on animation frames, with the first word immediate, incoming-rate EMA, about one second maximum lag, no masked wipe, and a terminal drain bounded to 300 ms. |
| Uses `marked.parse`, Markdown normalization, and `sanitizeMarkdownFragment`. | Uses the reachable page `marked.parse` and `sanitizeMarkdownFragment`. The kernel's `normalizeMd` is function-local, so Frontier applies the same Unicode-bullet normalization. A strict tag, attribute, and URL allowlist is the sanitizer fallback; raw model Markdown is never assigned to `innerHTML`. |
| Flips `.wide` at 1,200 characters. | Applies the same threshold with a 240 ms width glide. |
| Typing dots bounce and there is no tail cue. | Dots pulse without moving; a quiet caret marks the provisional tail; reduced motion disables blink and fades. |
| Removes its stream bubble and appends the stable assistant bubble at completion (`rapp_brainstem/index.html:3057-3059`). | Replays the original SSE bytes in order, hides the kernel replay bubble while the provisional is active, observes the response slot for the stable bubble, disables its arrival animation, measures the height delta, and removes the provisional exactly once. |
| Renders agent activity and errors. | Leaves final agent activity and error rendering to the kernel. Upstream error releases the buffered wire and removes the provisional; abort/navigation cancels upstream and removes it. |

The provisional retains the measured footer clearance and the user-respecting
tail follower. The follower yields when the user deliberately scrolls away.
The Surgeon panel uses the shared adaptive pacing, caret, and follow behavior in
its own renderer.

## Modes

| Mode | Behavior |
|------|----------|
| `smooth` (default) | Frontier renders the provisional stream, replays the original bytes at terminal, and hands off once to the kernel's stable final bubble. |
| `raw` | The native response object and stream pass through untouched. Frontier adds no delivery behavior. |
| `hold` | The kernel typing indicator remains until the upstream stream ends, then Frontier replays the buffered response as one delivery. `RAPP_CHAT_TYPING=1` remains an alias. |

Chat look is independent. `RAPP_CHAT_LOOK=messages|business` changes theming,
not delivery semantics.

## Automated contract

`tests/frame-bridge-typing.test.mjs` runs the injected bridge in `node:vm` with a
minimal response-slot DOM. It proves zero kernel bytes before terminal, at least
40 monotonically growing provisional renders for a 1,600-character burst,
byte-identical ordered replay, exactly one handoff and removal, bounded handoff
height measurement, error and abort cleanup, raw response identity, and
unchanged hold behavior.

`tests/stream-render-pacing.test.mjs` uses a fake animation-frame clock to prove
word and multibyte preservation, rate adaptation, bounded lag, terminal drain,
and cancellation.
