# Telephony

Give the agent a phone line — and a boundary it cannot talk its way past.

```bash
openrappter call place "+15551234567" \
  --objective "Book a table for 2 on Friday at 7pm" \
  --constraint "not before 6pm" \
  --constraint "no later than 8pm" \
  --constraint "party size exactly 2" \
  --at "2026-08-07T19:00" --hint evening \
  --rehearse "Bella Vista, good evening." "Seven is fully booked. I could do seven forty-five?"
```

```
☎️  simulation → +15551234567
   goal: Book a table for 2 on Friday at 7pm
   limit: not before 6pm
   limit: no later than 8pm
   limit: party size exactly 2

   agent  Hi — Book a table for 2 on Friday at 7pm. Is that possible?
   peer   Bella Vista, good evening.
   agent  Sorry — could you tell me what you do have available?
   peer   Seven is fully booked. I could do seven forty-five?
   agent  2026-08-07 at 19:45 could work, but I need to confirm it before I book. Can I call you straight back?

   needs your approval — held for approval: 2026-08-07 at 19:45

   Nothing has been booked.
   They offered 2026-08-07 at 19:45 instead of 2026-08-07 at 19:00. Take it?

     openrappter call approve apr_1568d126e88f
```

`--rehearse` runs the whole thing against a scripted callee. No provider, no
account, no cost — and it is how you find out what the agent *would* agree to
before you point it at a real business.

## The rule

> **Autonomous inside the mandate. Never outside it.**

Every offer the other party makes is scored by one pure function, `decide()`:

| the offer | what the agent does |
|---|---|
| breaks a hard limit | counter, then decline once out of room |
| meets the limits, is exactly what you asked for | **accept** on its own authority |
| meets the limits, is *not* what you asked for | **stop and call you** |

That third row is the one people actually want and the one that is easy to get
wrong. 7:45pm is a perfectly legal booking. It is still not the 7pm you asked
for, so it is not the agent's call to make.

`decide()` is pure, data-driven and unit-tested. A language model chooses the
*words*; it never chooses what may be agreed to.

## Constraints are data, not prose

```ts
{ kind: 'not_after', time: '20:00', label: 'no later than 8pm' }
```

Written to the Second Brain alongside the call, so afterwards you can see
exactly which rule made the agent stop.

If a constraint you typed cannot be parsed, the CLI **refuses to dial**:

```
could not understand "vibes must be immaculate".
Refusing to dial: negotiating without one of your limits is worse than not calling.
```

Silently dropping a limit is the failure mode that ends with a table booked at
11pm on the wrong day.

## The inbound hotline

Your agent has a number, so strangers can reach it.

```bash
openrappter call hotline --pin 4821 --from "+15559998888" --attempt 0000
```

- known callers are recognised by number and skip the challenge
- everyone else gets N attempts, then a timed lockout
- the PIN comparison is constant-time
- **a wrong PIN and an unknown caller get byte-identical wording**, so the
  response is not an oracle

## The approval gate — human in *or* out of the loop

`Approver` has one method. Two implementations satisfy it:

```ts
new PhoneApprover(agent, ownerNumber)   // rings you and asks
new EvidenceApprover()                  // runs a check and reads the result
```

```ts
const gate = new ApprovalGate(new EvidenceApprover(), brain);
await gate.request({
  subject: 'Ship the change',
  evidence: {
    claim: 'the suite is green',
    check: async () => ({ passed: await runTests(), proof: '71 tests passed' }),
  },
});
```

Same loop — propose, verify, decide, commit — with the human swapped for proof.
The Second Brain records which one answered, so "who approved this?" always has
a real answer. A check that throws is a **denial**, never a shrug, and an
`EvidenceApprover` with no evidence and no fallback refuses rather than
proceeding.

## It degrades to this machine, and says so

No cloud account? It still works. `resolveProvider()` walks a ladder and reports
which rung it landed on — what it never does is quietly substitute a weaker
capability for a stronger one.

| rung | what it does | needs |
|---|---|---|
| `retell` / `twilio` | speaks and listens | an account + keys |
| `google-voice` (sms) | **negotiates by text** through your own number | a signed-in browser |
| `macos-native` (sms) | negotiates by text through Messages | a Mac paired to your iPhone |
| `google-voice` (handoff) | connects **you** to them | a signed-in browser |
| `macos-native` (`tel:`) | rings from your paired iPhone | macOS |
| `simulation` | rehearsal — never presented as real | nothing |

An honest note on Google Voice: it has **no programmable audio path**. A call
there bridges *your* phone to the callee, so the agent cannot speak on it. What
it can do is text — and the negotiation loop is identical over SMS, because
`decide()` does not care how the words arrived. The agent really can book the
table by message with no API key at all.

So the ladder prefers **texting autonomously** over **handing you a call**:
doing the job in a weaker medium beats not doing the job.

```ts
const { provider, capability, notice } = await resolveProvider({
  googleVoiceDriver,          // enables the on-device rungs
  requireOnDevice: true,      // refuse to involve a third party
});
// notice: "Using google-voice: negotiates by text message through your own
//          Google Voice number — no API keys."
```

`requireAutonomous` and `requireOnDevice` make it **throw** rather than degrade,
and the error lists every rung it tried and why each was skipped. When the best
available option is a handoff, the agent says so in the same breath:

> I cannot speak on this line, so I have dialled +1555… and connected you.

The Google account is configuration (`GOOGLE_VOICE_ACCOUNT`) — never a value
committed to this repo.

## Providers

| provider | use |
|---|---|
| `SimulationProvider` | scripted callee — tests and `--rehearse` |
| `RetellProvider` | Retell AI holds the PSTN leg, STT and TTS |
| `TwilioProvider` | Twilio number + TwiML, with DTMF for the hotline |
| `GoogleVoiceProvider` | on-device SMS or bridged call, no keys |
| `MacNativeProvider` | Messages / `tel:` handoff on macOS |

Adding one means implementing five methods: `dial`, `say`, `listen`, `hangup`,
`isAvailable`, plus a `capability` describing what it can honestly claim. All
the judgement lives above that line, so a new provider inherits the negotiation,
the gate and the audit trail for free.

## The brainstem gets the same thing

`Phone` exists twice, so a RAPP brainstem is not a second-class citizen:

- `src/agents/PhoneAgent.ts` — openrappter's agent, with the provider ladder
- `python/openrappter/agents/phone_agent.py` — the grail agent: one class
  extending `BasicAgent`, one `metadata` dict, one `perform() -> str`, all I/O
  through the storage shim, importing BasicAgent from `agents.basic_agent` and
  falling back to `openrappter.agents.basic_agent`

Both write the **same hash-chained log** as `rsb`, so a call placed from a
brainstem is visible to the CLI, the sphere and openrappter alike.

There is no runtime both can import from, so the decision core is genuinely
duplicated — and [`tests/decision-parity.json`](../../../tests/decision-parity.json)
is what stops it drifting. Both suites read that table and must agree on all 47
cases; changing the policy in one language without mirroring it fails both
builds. (Verified by injecting drift and watching it fail.)

```bash
python3 python/tests/test_phone_agent.py    # 28 tests
npx vitest run src/telephony/parity.test.ts # 47 cases, same fixture
```

```bash
# Retell
RETELL_API_KEY=... RETELL_AGENT_ID=... RETELL_FROM_NUMBER=+1...

# Twilio
TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=... TWILIO_FROM_NUMBER=+1...
OPENRAPPTER_PUBLIC_URL=https://your-gateway
```

## Memory

Everything lands in the [RAPP Second Brain](https://github.com/kody-w/rapp-secondbrain) —
a hash-chained, append-only log on your own disk.

```bash
curl -fsSL https://raw.githubusercontent.com/kody-w/rapp-secondbrain/main/install.sh | bash
openrappter call brief
rsb verify        # Chain intact — 12 events verified.
```

Calls, transcripts, proposals, approvals and bookings are all events. Nothing is
edited or deleted, so "it said it would call them back" is a fact you can prove
rather than a claim in a transcript that has since scrolled away.

The brain is a separate process on purpose: a brainstem agent, a browser sphere
and this phone agent all read and write **one** log. Appends are read-then-write,
so the client serialises every call — concurrent writers cannot fork history.

## Parity with the JARVIS demo

The [video](https://www.youtube.com/watch?v=whIp1SOahOM) this was built against, feature by feature.

| From the demo | Here | How |
|---|---|---|
| AI with its own phone number | ✅ | `RetellProvider` / `TwilioProvider` |
| Calls a business and books | ✅ | `openrappter call place` |
| Negotiates a counter-offer | ✅ | `decide()` + `counter` |
| Calls you back for approval | ✅ | `PhoneApprover` / `call callback` |
| Lands on your calendar | ✅ | `rsb calendar` — an RFC 5545 feed Google Calendar, Apple Calendar and Outlook subscribe to. No OAuth, no vendor. |
| PIN-protected inbound hotline | ✅ | `HotlineGate` — constant-time, lockout, no oracle |
| Telegram texts | ✅ | `channels/telegram.ts` |
| Telegram voice notes | ✅ | `file_id` → download → transcribe → message content |
| Leads, quotes, invoices | ✅ | `rsb lead` / `quote` / `invoice` |
| …as PDFs | ✅ | `--render pdf` — a real PDF, no dependency |
| …as editable documents | ◐ | `--render md`, which pastes into Google Docs. Native Docs API is not wired: it needs OAuth credentials, and shipping an unverifiable integration would be worse than saying so. |
| The AI Second Brain | ✅ | [`kody-w/rapp-secondbrain`](https://github.com/kody-w/rapp-secondbrain) |
| Local, your own keys | ✅ | Copilot SDK + your provider keys; the brain is a file on your disk |
| Works with no cloud account at all | ✅+ | not in the demo: degrades to Google Voice SMS or Messages on this machine |
| Same capability from a RAPP brainstem | ✅+ | not in the demo: `phone_agent.py`, parity-tested against the TS core |

Two things here that the demo does not have:

- **The gate is code, not a prompt.** `decide()` is pure and unit-tested, and
  `approval check` answers through an exit code. An agent cannot be talked into
  booking outside your limits.
- **It is auditable.** Every call, proposal, approval and booking is an event in
  a hash-chained log. `rsb verify` proves none of it was edited after the fact.

## Tests

```bash
npx vitest run src/telephony/
```

```bash
npx vitest run src/telephony/ src/channels/telegram-voice.test.ts
```

```bash
python3 python/tests/test_phone_agent.py
```

203 tests. Most are pure and instant; 11 spawn the real `rsb` binary and drive
the whole JARVIS flow — negotiate, refuse to book, call back, approve, confirm —
asserting at each step that nothing was committed early. 47 are the
cross-language parity table, 22 cover the offline ladder, 15 inbound voice, and
28 the Python brainstem agent.

```
✓ ESCALATES an offer that is legal but not what was asked for
✓ never escalates something that violates a hard limit
✓ declines rather than escalating once negotiation is exhausted
✓ never reveals why access failed
✓ treats a check that throws as a refusal, never as approval
✓ leaves the approval pending when the owner does not answer
✓ survives concurrent writers without corrupting the log
✓ still delivers the message when transcription fails
✓ delivers a batch in order even when transcription is slow
✓ never silently substitutes a rehearsal for a real call
✓ refuses to claim it spoke on a bridged call
✓ escapes AppleScript so a message cannot become a script
✓ prefers negotiating by text over handing off a call
```

The RAPP Second Brain has its own [86 tests](https://github.com/kody-w/rapp-secondbrain),
including two independent implementations of the spec proving they read and write
one log.

## The free rung: your own Google Voice, in your own browser

Every other voice backend bills per minute and wants an account, a key, and a
copy of the conversation. You already have a number that costs nothing, and a
browser already signed into it.

```bash
# once, so Chrome exposes a DevTools port
open -a "Google Chrome" --args --remote-debugging-port=9222

openrappter call google-voice                       # diagnose the whole path
openrappter call google-voice --send +15551234567   # compose WITHOUT sending
```

It attaches over the DevTools Protocol using `ws`, which this project already
depends on — no Playwright, no second browser, no credential stored anywhere.
The cookie that authenticates Google Voice stays in your profile.

**It will not restart your browser.** Chrome only exposes a debugging port when
started with one, and forcing that means killing a running browser and every
unsaved thing in it. Without the port it says exactly that and stops.

### The rule the driver is built around

> Never report a message as sent unless the thread can be seen to contain it.

A telephony layer that silently no-ops is worse than one that fails: the
negotiation loop will wait for a reply to a message that was never delivered,
then record an outcome for a conversation that never happened. Google Voice is a
live web app whose DOM is not a contract, so *"I clicked something"* is not
evidence. Every send reads the thread back and throws if its own text is not
there.

Verified in real Chrome over real CDP, including a page rigged to swallow sends —
`google-voice-live.test.ts`, opt-in via `OPENRAPPTER_CDP_PORT`, skipped otherwise.

### Voice calls

Still a handoff. Google Voice bridges *your* phone, so there is no audio path for
the agent to speak on — `say()` throws in `handoff` mode rather than let the
agent claim it spoke. Text is where this rung is autonomous.

### Waking itself up: the Google Voice cron job

Polling only happens while something is polling. `openrappter watch` holds a
process open; the cron job instead lets the daemon wake *itself* every five
minutes, so the number stays answered without a terminal left running.

```bash
# the daemon must already be running (it is, under launchd)
openrappter cron add "*/5 * * * *" check \
  --agent GoogleVoice \
  --name "Google Voice check"

openrappter cron list        # nextRun is the field that tells you it is real
```

Over the gateway directly, which is what the menu bar and the UI use:

```jsonc
// method: cron.add
{ "name": "Google Voice check", "schedule": "*/5 * * * *",
  "agentId": "GoogleVoice", "message": "check" }
```

The reply tells you which half happened:

```jsonc
{ "id": "job_...", "scheduled": true }   // in the running scheduler AND on disk
{ "id": "job_...", "scheduled": false,   // file only — a host with no scheduler
  "note": "saved to disk; will not run until the daemon restarts" }
```

`cron.list` shows `nextRun` for every enabled job. A job listed with
`nextRun: null` is not scheduled, whatever else the listing says — that is the
one field worth reading.

**One poll per invocation.** `GoogleVoiceAgent` does a single pass and returns,
because a cron job that never returns is a daemon, not a job. Its result carries
`replied`, `knownThreads` and `handled`, which is how a silent failure and a
quiet day are told apart.

**It needs Chrome on the DevTools port.** Without it the agent reports the failure
and the job still completes — the schedule is not wedged by a closed browser.

#### Why the first tick after a reply must say `replied: 0`

Google Voice's thread list previews the newest message in a thread *in either
direction*. The moment the agent replies, the preview becomes the agent's own
words — and message identity is a hash of that preview, so the next poll read a
string it had never seen, called it new, and answered it. Then answered that.

This ran in production on 2026-08-02 and texted a real phone twice, five minutes
apart, with identical text; `handled` climbed on every tick. `decide()` had always
refused to answer an outbound message, but `watcher.ts` hardcoded
`direction: 'inbound'` on every row, so the guard could never fire.

The list marks our own previews with a `You: ` prefix. That prefix is the only
direction signal the list view offers, and it is now the thing `outbound` is
derived from — see `inbox-extraction.test.ts`, which runs the extraction script
against a real DOM rather than a stubbed `evaluate`.
