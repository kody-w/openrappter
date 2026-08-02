# ORDER — round 4 (2026-08-02)

## 0. What passed my gate-check

The cleanup and the cron both hold. Verified by hand, not from your report:

```
/Applications/OpenRappter*.app        -> gone
~/.openrappter-app-backup-0802/       -> 5 bundles + BEFORE-kody-data.sha
                                         + MOVED.txt + ORIGINAL-PATHS.txt  (reversible)
~/.openrappter/{config,memory,agents,cron}.json  -> all intact
POST :18790/chat {"message":"hello"}  -> status success, live reply, post-cleanup
agent outbound texts since the fix    -> 0   (self-reply loop is dead)
texts to +14048628786                 -> 214538/539/541/542 is_sent=1 delivered=1
```

Catching the self-reply loop was the real win — it was texting a live phone every five
minutes and would have kept going. Reporting the failed SMS honestly (`error=4`, forced
SMS on an iMessage contact) instead of quietly resending is exactly right.

## 1. The cleanup acceptance is NOT met — four bundles still claim the scheme

I asked for **exactly one**. There are four:

```
~/Developer/openrappter/macos/dist/OpenRappter Bar.app          <- current, keep
~/Documents/GitHub/OpenRappter/macos/dist/OpenRappter Bar.app   <- stale, unregister
~/Documents/GitHub/OpenRappter/macos/dist/dmg-staging/...app    <- stale, unregister
/Volumes/OpenRappter Bar/OpenRappter Bar.app                    <- ghost record
```

The `/Volumes` one is a dead LaunchServices entry, not a live mount — nothing is
mounted, so just purge the record. You cleaned the two you found in `/Applications` and
stopped; you never swept for others.

**And there is a second checkout neither of us knew about:** `~/Documents/GitHub/
OpenRappter` at `464a3dc "feat(vui): serve the rapp-vui reference UI at /vui"`. Work
none of tonight's rounds touched. Do not delete it and do not merge it — **report what
it is**, whether `464a3dc` is reachable from `origin/main`, and whether it holds
anything unique. If it is a stale duplicate, say so; if it has unmerged work, name it.
That is a judgment call for Kody, not for you.

## 2. Kody has no app in /Applications any more — that is on me

He had two, I authorized moving both, and nothing replaced them. Right now the only
launchable bundle is inside a dev tree. Install the **current** build to `/Applications`
so he has a real app again, then confirm:

- `openrappter://` resolves to exactly that one bundle
- launching it produces a working menu-bar dino
- `POST :18790/chat {"message":"hello"}` still answers afterwards
- clicking the dino opens the bones window against `~/.openrappter` (his real data)

## 3. The catch-up video has now slipped four rounds

`~/videos/` has nothing newer than `catchup-0801-part3` — yesterday. Kody has asked for
this in almost every steering message: *"goal /loop until perfect: take a video and text
me when you are done that catches me up."* You texted him a bug finding, which was the
right call for that finding, but it is not the catch-up.

Make it. It covers what actually changed across these rounds, in his voice, at his
quality bar — the deploy split that ended the four-month drift, the auth ladder that
made the product stop choosing a broken path, the self-reply loop that was texting a
real phone, click-the-dino-see-the-bones. Then text him the link.

Verify it the way his standing rule requires: **watch it** — sample frames across the
whole timeline — before you deliver. Do not hand over a render you have not looked at.

## 4. Still open, lower priority

The patient/surgeon UI. `4e7465f` landed the surgeon; the two-pane patient framing that
replaces the sidebar-of-views shell is not done. `LearnNewAgent` now takes a model and
reports `implementation: 'scaffold' | 'generated'` — good, that stopped the overclaim.

## 5. Rules unchanged

Grail RAPP brainstem installer repo untouched. Brainstem ⇄ openrappter parity.
Local-first degradation. DOG/GOD boundary — no PII in any public repo. Do not revert
other sessions' work. Do not delete anything without a reversible backup.

## 6. Report format

Same discipline — build, port, config attached to every claim; flags and surprises at
the end. If the video cannot be rendered or you cannot watch it, say so and hand me the
blocker rather than shipping unwatched.
