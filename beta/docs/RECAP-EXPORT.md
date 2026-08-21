# Recap export — a background run leaves something you can publish

An autosteer run that happened while nobody was watching is only useful if you can see what
it did afterwards. So a driven run ends by writing a **recap**: a folder a person can review
and, if they choose, upload to a [RAPP Vision](SUMMON-PROTOCOL.md) channel by hand.

Nothing is uploaded automatically. The run produces the artifact; publishing is a separate,
deliberate act, for the same reason nothing else here syncs.

## What a run writes

    <betaHome>/recaps/<runId>/
      recap.webm      the edited film of the run
      poster.png      a still, for the channel card
      entry.json      a channel.json-shaped entry, ready to paste
      trace.jsonl     the driver trace the run produced
      README.md       what this is and exactly what to do with it

`entry.json` matches what a channel manifest expects, with **relative** `src` values, because
rapp-vision resolves every `src` against the manifest's own URL. Dropping the folder into a
channel repository and adding the entry is then the whole publishing step — no rewriting of
paths, no editing.

```json
{
  "id": "frontier-run-2026-08-21-1204",
  "title": "Frontier: hatch a rapplication and prove it answers",
  "poster": "recaps/frontier-run-2026-08-21-1204/poster.png",
  "sources": [{ "src": "recaps/frontier-run-2026-08-21-1204/recap.webm", "type": "video/webm" }]
}
```

## The better half: the recap can also be *live*

rapp-vision entries are not only video. A `live` entry carries `scenes` and timestamped
`actions` that replay recorded gestures against the real application in an iframe, with play,
pause and seek — which is the same mechanism as
[`UI-AUTOSTEER-PROTOCOL.md`](UI-AUTOSTEER-PROTOCOL.md).

**The driver trace is already that data.** Every command is recorded with its handle, its
arguments and its timestamp, which is exactly the `actions` array a live entry wants. So the
same run can emit both:

- **the video**, which anyone can watch anywhere, and
- **a live entry**, which replays against the actual app rather than showing a picture of it.

A live recap stays true when the product changes underneath it — it will replay against the
new UI and visibly fail where the UI moved, which is more useful than a video that quietly
becomes wrong. Emit the video as the default and the live entry alongside it.

## Rules

1. **Nothing is published by the run.** It writes a folder. A person reviews it and uploads it.
2. **Review before publish is the point of the README.** A recap is a recording of a real
   screen: it can contain a customer name, a path, a token in a log line. The README says so
   plainly and lists what is in the folder, because "I did not know it captured that" is not
   recoverable after publishing.
3. **Work material never becomes a public recap.** The same boundary as everywhere else, and
   the ease of publishing is not a reason to soften it.
4. **The recap says what it is.** Title, date, and which run produced it, so a viewer can tell
   a demonstration from a real session.
5. **A failed run still writes a recap.** The runs worth watching are often the ones that went
   wrong, and a recap that only appears on success is a highlight reel.

## Status

**Partly built.** The recording half exists — the driver records the window and can produce a
film, and the trace is already written per run. What does not exist: the recap folder, the
poster still, `entry.json`, the README, and the live-entry emitter that turns the trace into
`scenes` and `actions`. Recording now also refuses up front when the media organ is absent
rather than failing mid-run, which is what makes an unattended run's failure legible.
