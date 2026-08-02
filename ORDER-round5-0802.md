# ORDER — round 5 (2026-08-02): finish the video

## 0. You were cut off again by the same network fault

`ETIMEDOUT` to the model endpoint, mid-TTS. Not your fault, and not a reason to start
over. Jobs 1–3 landed and I verified them:

```
openrappter:// claimants   -> exactly 1: /Applications/OpenRappter Bar.app   (acceptance met)
/Applications app          -> restored, current build
repo                       -> clean, 0 unpushed
```

The second-checkout report was good work. You correctly found that its own `origin/main`
was stale and re-tested the branch tips against the authoritative remote rather than
trusting the local ref — that is the right instinct, and it changed the answer.

## 1. Where the video actually stands

`~/videos/catchup-0802/` — scaffolded from `catchup-0801-part3`, and these exist:

```
BRIEF.md  SCRIPT.md  audio_request.json  index.html  frame.md
assets/voice/01..07.wav  +  transcript.json
compositions/frames/    <- EMPTY. this is the gap.
renders/                <- does not exist yet.
```

The script is good — the register is right, the self-reply beat is placed correctly, and
"report, don't sell" is holding. Do not rewrite it. **Build the seven frames, render,
watch, deliver.**

## 2. Finish it

1. Build `compositions/frames/01..07` against `frame.md` and the existing
   `catchup-0801-part3` frames as the structural reference — `<template>` wrapper, inline
   `<style>`, `#root` with `data-composition-id` / `data-start` / `data-duration` /
   `data-width` / `data-height`, `.clip` elements with their own `data-*`, and the
   trailing script registering `window.__timelines["<id>"]`.
2. Time each frame to its narration WAV — the durations are already fixed by the audio
   you generated. Do not leave dead air at the end of a frame.
3. Render.
4. **Watch it.** Sample frames across the whole timeline, not just the first second.
   Kody's standing rule: an unwatched render is not done. If a frame is broken, blank,
   or text overflows, fix it and re-render.
5. Text him the link. Use **iMessage**, not SMS — you already learned that the hard way
   at rowid 214540 (`error=4`). Verify `is_sent=1` by rowid before claiming delivery.

## 3. Two findings from round 4 that must reach Kody — put them in your report

- **The dino may be invisible on his machine.** You established the status items sit at
  x=801/883/923 and the notch spans x=771–956 — the icons are *behind the notch*. That
  is a real bug and it means "click the dino" may not be reachable for him at all. Say
  so plainly; do not bury it.
- **`fix/imessage-tahoe-attributedbody` @ `5953ed8` is genuinely unmerged** — "OpenRappter
  Bar 1.11.0 DMG (signed, permission-walkthrough onboarding)". A signed DMG with
  onboarding is not a trivial orphan. Report what it contains and whether it still
  applies. **Do not merge it** — that is Kody's call.

## 4. Rules unchanged

Grail installer untouched. No PII in public repos. Reversible changes only.
Do not revert other sessions' work.

## 5. Report

Short this time. What the video says, that you watched it and what you saw, the delivery
receipt, and the two findings above. If the render fails, hand me the blocker — do not
ship an unwatched file and do not text him a link you have not opened.
