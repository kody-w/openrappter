# Voice in the Frontier — two contracts, not one

Voice shows up in two places that look similar and are not. Treating them as one problem is how
voice features get slow, or bad, or both.

| | **Narration** | **Chat voice** |
|---|---|---|
| What it is | the Frontier saying what it is doing while someone watches | the Brainstem's reply, spoken |
| Who is waiting | nobody — the work proceeds regardless | a person, mid-conversation |
| The trade | **quality over latency** | latency is the whole problem |
| Default | on during a Showtime run and in Show Mode, off otherwise | **off** |

Both take their quality voice from **VibeVoice**; chat voice may additionally open with a fast local
voice (see *The relay*). Every engine here ships in the opt-in Voice Sense under `CONSTITUTION.md`
Article II: installed on first enable, removable without trace, and on-device — no utterance, in
either contract, is synthesized off the machine.

## Narration: latency is free, so spend it on quality

Narration describes work that is already happening. It may lag the action by a moment without
costing anyone anything, so it takes the good voice. It also keeps the screen free — the reason to
narrate aloud rather than draw more on the display is that a person can then look somewhere else
and still follow along.

## Chat voice: it is a voice *message*, not a live voice

VibeVoice is too slow to answer conversationally. Where there is no fast voice to open with, the fix
is not a worse voice — it is to stop pretending the reply is live. (Where there is one, see *The
relay*.)

People already know what a voice message is. It arrives from the person you are talking with, you
can see it coming, you do not expect it instantly, and it plays when it lands. That idiom fits the
latency exactly, and it is honest: the voice really is still being made.

So when chat voice is enabled:

- **The text reply is never held back.** It lands at full speed. The voice is an additional channel
  that catches up — nobody waits on audio to read an answer.
- **The arriving voice is visible in the transcript**, in the same idiom a messaging app uses for a
  voice message still coming through. The wait is shown, not hidden behind a spinner that implies
  something is wrong.
- **It plays itself when it is complete.** No second click to collect a thing you already asked for.
- **It is off by default**, and the control that turns it on says plainly what it changes: replies
  will also arrive as voice messages, shortly after the text.

The point of the affordance is expectation, not decoration. A delay a person understands is not a
delay they mind; the same seconds spent behind a silent spinner read as the product being broken.

## The relay: start fast, finish well

The two contracts above assume you must choose. You do not.

**Start speaking immediately in the fast voice, and let VibeVoice take the baton mid-utterance.**
Both engines are given the same text at the same moment. The fast one begins at once, so speech
starts with no wait at all. Behind it the good voice is **cooking in** — being generated while the
first one talks — and the instant its audio is ready, playback hands off at the next word boundary,
into the same sentence, already in progress. The listener hears a reply that starts instantly and
gets better while it is still being spoken.

**The bar for the seam is a radio one.** A late-night DJ crossfading between tracks is exactly the
effect: you notice that what you are hearing got *better*, never that something *switched*. A seam
audible as a seam is a bug; a seam audible as an upgrade is the whole feature. That framing also
sets the target for the good voice itself — the warmth and evenness of a late-night radio voice is
what "better" means here, not simply a higher sample rate.

This is the best of the trade rather than a compromise between its halves: latency is paid by the
fast voice, quality is delivered by the good one, and the seam is a single word.

### How the handoff works

1. **One text, two synthesizers.** Both receive the identical string. If the text changes — a
   streamed reply that revised itself — the relay is off; see the rules below.
2. **The fast voice starts immediately** and reports where it is: which word is being spoken now.
3. **VibeVoice returns audio with word-level timings.** When it lands, find the word the fast voice
   is about to speak, seek to that word's offset in the VibeVoice audio, and swap.
4. **Swap at a word boundary, never inside a word**, with a short crossfade (tens of milliseconds)
   so the change of voice is a change of voice and not a click.
5. **Every word is spoken exactly once.** The handoff may not repeat the word it lands on, and may
   not skip it. That is the whole correctness condition — a listener who hears "the the" or loses a
   word learns to distrust the voice.

If VibeVoice cannot give word-level timings, hand off at the next **sentence** boundary instead.
That is a longer wait for a better seam, and it is a perfectly good implementation — a relay that
only changes voice between sentences is still a relay.

### The occasional station ident

**Decision: accepted.** This is a deliberate product choice, made by the repository owner with the
tradeoff understood. It is not an oversight, and it is not to be quietly removed by a later tidying
pass — if it is ever dropped, that is a decision someone makes on purpose and records here.

Once in a while — not often — the handoff is played rather than hidden: the good voice comes in over
the top of the fast one the way a station breaks into a broadcast, says something brief, and carries
on with the answer. Radio has a name for this; it is a **station ident**, and treating it as a known
format element rather than a joke in the code is what keeps it legible to anyone reading the design.

**Why it earns its place.** A product people enjoy using is not a lesser goal than a product that
works, and the two are not in tension here: the ident costs nothing, blocks nothing, and carries
nothing. What it buys is character — the thing that makes a voice feel like a voice rather than a
speech synthesiser, gives a demo a moment people remember, and makes individual replies distinctive
enough that someone would want to keep one. Software that is merely correct is forgettable, and
forgettable infrastructure does not get adopted.

The charm is entirely in the scarcity. A bit that fires every turn is an irritation to be switched
off within a day; one that fires rarely is personality. So it is fenced:

- **Roughly one handoff in twenty-five**, and driven by a **counter, not randomness**. A counter is
  testable, reproducible in a demo, and cannot cluster — random chance will eventually fire twice in
  a row, which is exactly the thing that makes it annoying.
- **Show Mode and demonstration only.** That is the context where being listened to is the point.
  Off everywhere else.
- **One occurrence is all it gets.** If someone hears it once and dislikes it, they can end it
  there and then — permanently, in a single action, without hunting for anything. The control is
  attached to the occurrence itself, the way "turn these off" sits on the notification rather than
  three menus away.

  This is a requirement rather than a courtesy, and rarity is exactly why. A feature that fires once
  in twenty-five turns is uniquely hard to switch off: the annoyance and the search are separated in
  time, so by the time someone goes looking they no longer remember what the thing was called or
  where it would live. Rarity makes a buried setting effectively unreachable. So the moment carries
  its own exit: one action, no confirmation, no "not now" — off, immediately, and **never again**,
  across this session and every session after it. Not a snooze, and not something a later update
  turns back on.

  This is a **one-time seal**, the Frontier's general shape for local-first preferences — see
  [`ONE-TIME-SEALS.md`](ONE-TIME-SEALS.md). Everything ships sealed, one action pops the seal, and a
  popped seal never re-seals.

  "Never" is scoped honestly: it is as strong as a local preference can be — this device, this
  install, for as long as it stands, surviving restarts and updates. It does not follow the person
  to another machine, because nothing here syncs; a Sense is on-device by Article II, and claiming
  otherwise would be a promise the product cannot keep. A fresh install starts fresh, and that is
  the only case where it returns.

  If the choice cannot be written down — no preference store, a read-only profile — it is still
  honoured for the rest of the session and the failure is surfaced. What must never happen is
  silently discarding an off choice and playing the thing again as though the person had not asked.
- **It can also be turned off ahead of time.** A named, user-visible setting — not a developer flag, not an
  environment variable, not something you have to know about to find. Off takes effect immediately
  and for the rest of the session, not at the next restart; it persists; and off means *never*,
  with no residual counter waiting to fire once the setting is toggled back. It is its own switch,
  separate from voice itself: keeping the relay and dropping the ident is a normal thing to want,
  and must not require giving up the good voice to get it.
- **Never when audio is the only channel.** In the audio-bound case the voice is not entertainment,
  it is the interface; interrupting it is not a flourish, it is an obstruction.
- **It never costs correctness.** It cannot delay the answer, obscure a word, or break the
  word-exactly-once rule. It rides on a handoff that was going to happen anyway.
- **It never carries content.** Nothing the listener needs is ever inside the ident, so a listener
  who has it switched off has lost nothing at all.

### Keeping one you liked

A good cutover is a small piece of character — the moment the crappy voice gives way to the good one
is genuinely distinctive, and no two land quite the same. So a person can **keep one**.

The design consequence is the interesting part: **you only know you liked it after it has gone by.**
A save control that only works while audio is playing is useless for something a few seconds long.
So:

- **A short rolling buffer.** The last few cutovers are held so "save that one" works retroactively,
  the way a dashcam keeps the minute before you pressed the button. Everything else is discarded.
- **Save the seam, not the whole reply.** What is worth keeping is a few seconds spanning both
  voices, so the upgrade is audible in the saved clip. A recording of the answer is just the answer.
- **Nothing is persisted until asked.** The buffer is temporary and on-device; only an explicit save
  writes a file. A voice feature that quietly accumulated recordings of a person's conversations
  would be a serious problem, not a nice extra — synthesized speech still carries what was said.
- **It attaches to the conversation, so it travels.** A kept cutover belongs to the transcript it
  came from, which means it rides along with the tile like anything else the conversation owns.
- **It is deletable, and deleting it means gone.** Same rule as every other Sense under Article II:
  removable without trace.

### Rules that keep it honest

- **The relay never stalls speech.** If VibeVoice is late, the fast voice simply finishes the
  utterance and the next one starts the race again. Nothing waits, nothing is dropped.
- **If VibeVoice arrives before playback starts**, skip the relay and play it from the beginning.
- **If the text changed after the fast voice began**, do not hand off. A seamless voice saying
  different words is worse than a consistent poor one — the relay may improve how a sentence sounds,
  never what it says.
- **The change is allowed to be audible.** It signals the good voice arrived, and pretending
  otherwise would require making the fast voice worse or the good one blander.
- **The text reply is still never held back.** The relay is about speech; reading never waits on it.

### What it changes above

The voice-message idiom stays right for the case where there is no fast voice to open with — a long
reply, or a person who wants only the good voice. Where speech should begin at once, the relay is
the better default, because it removes the wait without giving up the voice.

## If it were audio-bound

Everything above assumes text is carrying the conversation and voice is an extra channel. Take the
text away — an audio-only conversation, on the radio — and the same design becomes strict rather
than optional. That case is worth designing for directly, for two reasons: it is the honest test of
whether the voice path is any good, and it is the situation of anyone who cannot see the screen.

What changes when audio is the only channel:

- **Dead air is the failure mode, not latency.** A station never goes silent while the next thing is
  cued; something is always on air. That is precisely what the fast voice is for, and why the good
  one cooks in behind it rather than in front of it. "Wait three seconds for a better voice" is a
  reasonable trade when you can read in the meantime and an unacceptable one when you cannot.
- **The seam has no safety net.** With text on screen, a dropped or duplicated word is recoverable —
  the reader just looks. In audio it is simply lost. The word-exactly-once rule stops being
  fastidiousness and becomes the correctness condition.
- **Interruption must work mid-utterance.** A listener cannot skim ahead or stop reading; the only
  way out of a long answer is to talk over it. Speech must stop the instant the person speaks, which
  is the two-player law in another medium: the person wins the moment they act.
- **Pacing carries meaning.** Pauses, emphasis and speed are the audio equivalent of paragraphs and
  headings. A handoff that preserves the words but resets the prosody mid-sentence will still sound
  wrong, so continuity is a property of delivery, not only of text.

**Design the voice path as though it were audio-bound, and the text-bound case gets it for free.**
The reverse does not hold: a voice built assuming someone can always read the screen fails the
person who cannot.

## What this rules out

- Holding the text reply until the audio is ready.
- Presenting a slow voice as though it were a live one.
- Turning chat voice on by default because narration sounded good — they are different contracts,
  and only one of them has someone waiting.
- A relay that repeats or drops the word it hands off on, or that hands off into different text.
- Making the fast voice deliberately worse so the upgrade sounds bigger.
- Any voice path that only works because the listener can also read the screen.
- A station ident that fires often, fires at random, carries content, or fires when audio is the
  only channel the listener has.
- Retaining synthesized audio of a person's conversations beyond the rolling buffer without an
  explicit save.

## Status

**Specified, not implemented — none of this exists in the tree.** There is no speech synthesis of
any kind: no VibeVoice integration, no fast local voice, no relay, no station ident, no rolling
buffer, no saved cutover, and no setting for any of it. Read every present-tense sentence above as
"a conforming implementation does this", not as a description of shipped behaviour.

What does exist that this would build on: the opt-in Sense model in `../CONSTITUTION.md` Article II,
and `probeMediaOrgan` in `../electron/video-tools.mjs`, which is the right shape for gating a large
first-run download behind consent.

### Desktop provider ownership

The packaged TypeScript desktop now owns the optional ElevenLabs provider and
its OS-encrypted credential boundary. This beta/Frontier shell intentionally
does not duplicate that client, receive a raw key, or grow a parallel TTS path.
Future XPedition/Grail work consumes the typed `VoiceSurfaceAdapter` and
`VoiceAudioDescriptor` seam from `typescript/src/voice/integration.ts`; it must
not reach into the provider or credential store. The local relay, station
ident, and rolling-buffer design above remains a separate beta specification.
The default Grail adapter and bounded back-and-forth conversation controller now
live beside that seam in `typescript/src/voice/grail-adapter.ts` and
`conversation.ts`. Pending shells remain untouched.
