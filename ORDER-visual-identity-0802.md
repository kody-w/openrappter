# ORDER — openrappter's own visual identity (retheme the anatomy page)

## 0. What's wrong

Kody: *"you shouldn't make the UI claude themed though... make it our own however you
think that should look for openrappter."*

He is right. I pointed you at `~/videos/catchup-0802/frame.md` as the taste bar — cream
ground, high-contrast display serif, clay/terracotta accent. That is Anthropic's palette.
The build is good; the **skin is borrowed**. My error, not yours. Keep the structure,
the organ model, the states, the copy. **Replace the look.**

## 1. The direction: a specimen case at night

Not a document. Not a dashboard. **A lit vitrine in a natural-history hall after hours,
with one exhibit still glowing** — because that exhibit is alive, on this machine, right
now.

Why this and not something else:

- It keeps the museum idea Kody actually asked for ("exploring at school or a museum").
- Dark ground is the maximum distance from the cream page we are replacing — nobody will
  mistake it for anything else.
- It makes the specimen the hero rather than the typography.
- It matches the real moment of use: you click a small green dinosaur in your menu bar,
  late, and a case opens.
- **It gives colour a job.** On cream, colour was decoration. On black, colour is state.

## 2. Palette — semantic, not decorative

Every colour means something. Nothing is used "because it looks nice."

```
ground        #0B0F0D   near-black, faint cool-green cast — not pure black
case          #141A17   the panel the specimen sits in
rule          #232C27   hairlines, callout leaders
bone          #E8E4D9   the specimen line work, and primary text
muted         #7C8981   secondary text, latin names

alive         #4FD08A   the rappter's own green. ONLY for living organs.
degraded      #E0A340   amber. working, but not the way it should.
absent        #55625C   dim slate. the organ is not there.
sealed        #B08D57   brass. present, deliberately not opened. (the Vault)
```

Rule: `alive` green appears **nowhere** except things that are actually alive. If the
whole page is green it stops meaning anything. On a healthy organism you should see a
little green; on a degraded one you should see amber and feel it.

## 3. The specimen carries the state, not just the placards

This is the part that makes it worth rebuilding rather than recolouring.

Invert the drawing: **bone-coloured line work on dark**, not a dark silhouette on light.
An anatomical plate, not a logo.

Then let the figure itself report health, so you can read the organism at a glance
without hovering anything:

- **alive** organs are drawn solid, with a faint emissive bloom in `alive` green
- **degraded** organs pulse slowly in `amber` — visibly working, visibly not right
- **absent** organs are drawn as a **faint dashed outline** — you can see the bone that
  is not there. Right now "no name" is only words; it should be visible in the body.
- **sealed** (the Vault) is drawn closed, in `brass`, with no interior detail rendered.
  The refusal becomes part of the illustration.

The pulse organ may beat on the real cron interval. Subtle — a museum, not a rave.

## 4. Type

- **Organ names:** keep a display serif — a museum placard is a serif, and that instinct
  was right. Pick one with more character than the current setting; it must not read as
  the same page in dark mode. Consider a transitional or slab with visible personality.
- **Latin anatomical names** (`VERTEBRAE`, `CARDIUM`, `MANUS`): keep them. Small caps,
  wide tracking, `muted`. They are the single most museum-feeling thing on the page and
  they cost nothing.
- **Values, paths, shas, timestamps:** monospace, always. The machine's own voice.
- **Numbered callout pins** with hairline leaders to the figure: keep. That is the plate
  convention and it is working.

## 5. Keep all of this — it already passed

Do not regress what is good:

- the ten organs and the `data-organ` delegation
- the four states, and the plain-language consequence lines. *"This organism has no name.
  It will sound like every other assistant until you give it one."* is exactly right —
  **do not rewrite the copy**, only its setting.
- the sealed-Vault refusal and the never-read-`.env` rule
- read-from-disk-at-open, no mocks, absent shown as absent
- the drop-to-teach affordance and the hot-load path
- degradation to "asleep" with no daemon

## 6. Also fix: the blocking modal on the success path

The `confirm()` gating agent execution is correct — keep the trust boundary. But the
**success** confirmation is a blocking dialog, which means the drop path cannot be driven
by a headless test. Untestable is how the bones window and the video attachment both went
unverified for days on this project.

Replace the success dialog with an **inline, in-voice confirmation on the page** — the
new claw appearing under Hands, with the organism saying what it can now do. Same
message, same voice, no modal. Then a headless test can drive a drop end to end.

## 7. Acceptance

1. Screenshot `:18790/bones` headless and **look at it**. It must be unmistakably its own
   thing — if it reads as the same page with inverted colours, it failed.
2. Screenshot a **degraded** organism (stop the daemon) and confirm the difference is
   legible from the drawing alone, before reading a word.
3. Contrast: `bone` on `ground` and every state colour on `ground` must clear **WCAG AA**
   for their text sizes. Measure it, do not eyeball it.
4. No `alive` green on anything that is not alive.
5. Still renders with the network off and with the daemon stopped.
6. The drop path is drivable headlessly, no blocking dialog on success.

## 8. Report

The screenshot, the measured contrast numbers, and one honest sentence on whether it
looks like its own product or like a reskin. If it is a reskin, say so.
