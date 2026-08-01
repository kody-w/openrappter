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

## Providers

| provider | use |
|---|---|
| `SimulationProvider` | scripted callee — tests and `--rehearse` |
| `RetellProvider` | Retell AI holds the PSTN leg, STT and TTS |
| `TwilioProvider` | Twilio number + TwiML, with DTMF for the hotline |

Adding one means implementing five methods: `dial`, `say`, `listen`, `hangup`,
`isAvailable`. All the judgement lives above that line, so a new provider
inherits the negotiation, the gate and the audit trail for free.

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

86 tests. 60 are pure and instant; 11 spawn the real `rsb` binary and drive the
whole JARVIS flow — negotiate, refuse to book, call back, approve, confirm —
asserting at each step that nothing was committed early; 15 cover inbound voice.

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
```

The RAPP Second Brain has its own [86 tests](https://github.com/kody-w/rapp-secondbrain),
including two independent implementations of the spec proving they read and write
one log.
