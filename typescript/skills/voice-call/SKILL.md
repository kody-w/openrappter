---
name: voice-call
description: Place goal-directed phone calls with explicit constraints and human approval.
metadata: {"openclaw":{"emoji":"📞"}}
---

# Voice Call

Place calls on the owner's behalf without letting the agent negotiate past the
limits it was given.

## Requirements

No plugin switch is required. Rehearsals use the built-in simulation provider
and need no account, API key, or phone call.

For live calls, OpenRappter resolves an available provider from Retell, Twilio,
Google Voice, or the on-device handoff. Provider credentials are documented in
`src/telephony/README.md`.

## Rehearse First

```bash
openrappter call place "+1234567890" \
  --objective "Book a table for two at 7pm" \
  --constraint "not before 6pm" \
  --constraint "no later than 8pm" \
  --rehearse "Seven is unavailable. I can offer 7:45."
```

`--rehearse` exercises the complete negotiation and approval path without
dialing anyone. Use it before a live call.

## Place a Live Call

```bash
openrappter call place "+1234567890" \
  --objective "Book a table for two at 7pm" \
  --constraint "not before 6pm" \
  --constraint "no later than 8pm"
```

If the other party proposes something inside the hard limits but different
from the requested outcome, the agent stops and creates an approval instead of
accepting on its own.

## Resolve an Approval

```bash
openrappter call pending
openrappter call approve "<approval-id>"
# or:
openrappter call deny "<approval-id>"
```

To ask by phone instead:

```bash
openrappter call callback "<approval-id>" --to "+1234567890"
```

## Diagnostics

```bash
openrappter call brief
openrappter call google-voice
openrappter call hotline --pin 4821 --from "+15559998888"
```

There is no conference-call command. A placed call ends through its provider
when the synchronous call flow completes.
