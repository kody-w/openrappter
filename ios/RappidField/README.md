# RAPPID Field

A sound-first, location-optional companion prototype for Quantum RAPPIDs, built
as a native iOS SwiftUI app.

A companion here is one canonical RAPP/1 identity projected through several
independently verifiable dimensions. The creature language is product UX; the
integrity model is RAPP/1. This app is the phone-shaped window onto an organism
that lives on your own machine.

---

## The IP boundary

This is an original work. It borrows the broad, unprotectable idea of a
creature-companion app and nothing else.

**What this app deliberately does not do**

| Not here | Instead |
|---|---|
| Any franchise creature, name, or evolution chain | Original starter paths (Canopy / Current / Forge) and original molt lines |
| Elemental type triangles | Paths are a *posture*, not a counter — no path beats another, and no path is an element |
| Capture devices, throwing mechanics, catching loops | No capture mechanic at all; growth is an append-only proposal you approve |
| A stylised world map, trails, stops, or arenas | No map, and no location code at all |
| Any franchise art, sprite, model, sound, melody, font, or trade dress | Everything on screen is drawn in code from the organism's own MIDI DNA; every sound is synthesised on device |
| Franchise wording, taglines, or UI copy | All copy is original |

The boundary is enforced by a test, not only by this document:
`StarterPathTests.testVocabularyStaysOriginal` fails the build if a denylisted
term reaches any user-facing string.

The winged third Forge stage — **Aetherwing** — earns wings from verified frame
depth. It is never called a dragon and does not resemble any franchise
character; it has no character art at all, because nothing in this app does.

---

## What you actually see

There are no 3D models, no sprites, and no shipped images. A companion's visual
identity **is** its sonic identity, drawn:

- a **16-note MIDI DNA motif**, a pure function of the RAPPID and its birth
  trait snapshot — an 8-note call and a trait-bent response;
- an **identity ring** (pitch as radius, onset as angle, velocity as weight);
- a **piano roll** of the same notes over a rendered waveform trace;
- an original **wake call**: an emergence glide into the call phrase, additively
  synthesised from sine partials at play time.

The same companion produces the same picture and the same sound on any device,
offline, forever. Identity is never derived from the motif — the motif is
derived from the identity.

**Playback rules.** Nothing autoplays, ever. Every play control has an explicit
Stop, an accessibility label, and a hint. `PlaybackPolicy.autoplayEverAllowed`
is a compile-time constant set to `false` and asserted in tests. Haptics are
used where the hardware supports them, and the UI says so plainly when it does
not, as on the simulator. Audio failures are surfaced in the UI, never
swallowed.

### Byte-exact parity with the host

`Sources/Core/MidiDNA.swift` is a port of the OpenRappter host derivation, and
it is verified byte-for-byte rather than by eye. `SonicIdentityTests` pins
golden vectors — musical parameters, all 16 notes, the rendered `dna-prompt.mid`
byte count and its sha256 — produced by the **host TypeScript runtime** via
`Tools/generate-parity-vectors.mjs`. All three starter fixtures render MIDI
whose content address matches the host exactly.

```bash
node Tools/generate-parity-vectors.mjs        # host-side golden vectors
swiftc -O -o Tools/parity-dump Sources/Core/Canonical.swift \
    Sources/Core/MidiDNA.swift Tools/main.swift && ./Tools/parity-dump
```

---

## The three starter paths

No path is gated, and the app never asks for, stores, or infers an age.

| Path | Challenge | Leans toward | Molt line |
|---|---|---|---|
| **Canopy** | Guided (easy) | Safety, steady memory | Seedling → Strider → Raptor |
| **Current** | Adaptive (medium) | Balanced traits | Ripple → Voyager → Resonant |
| **Forge** | Frontier (hard) | Autonomy, high-risk/high-payoff reach | Spark → Talon → Aetherwing |

Onboarding states, for each path, what it **asks of you**, what it **does with
your data**, what you **get for it**, and what the **trade** is. Canopy carries
a recommendation for new operators — advice only; nothing reads it and nothing
is locked.

**Molting never changes identity.** A molt renames the projection and unlocks
habitat behaviour. `Companion.molted(to:)` returns the same `RappidIdentity`,
the same birth traits, the same assets, and the same motif —
`MoltIdentityTests` asserts all of it. Stage is derived from accepted frame
depth, never from bytes.

---

## Weight, height, and honest numbers

The Field Guide shows exact integers or an explicit refusal:

- **Weight** — unique verified bytes. A `(space, hash)` pair counts once, so a
  duplicate asset cannot make an organism heavier. The Canopy fixture carries
  the same MIDI address under two dimensions on purpose, and the card shows
  three unique addresses across four assets.
- **Incomplete weight** — if any carried dimension has an unknown size, there is
  no total. The app states what it *can* verify and names the unmeasured
  dimension. Nothing is estimated, rounded, or filled in with zero. The Forge
  fixture exercises this.
- **Frame height** — contiguous accepted append-only body-frame depth. The fact.
- **Display height** — a *versioned* presentation curve (`display-height/1.2`)
  over frame height, labelled with its version everywhere it appears. Not
  identity, and not a physical fact.

Fixture sonic byte counts and hashes are not decorative: they are the real
bytes of the MIDI and wake-call renders performed on device.

---

## Growth: proposals are never authority

The Growth screen puts a **self-steer leash** in front of everything —
**Observe**, **Propose**, or **Run Approved** — and no setting grants
autonomous mutation. `GrowthLeashPolicy.autonomousAppendEverAllowed` is
`false` at compile time.

A proposal is a reading. `GrowthProposal.isAuthoritative` is a constant on the
type, not a field a producer can set, and a host that marks a proposal
authoritative is refused at decode time. Proposals state their provider
(`deterministic-rules-and-scoring`, `learnedTransformer: false`) and show the
evidence they read.

Appending is the only thing that makes a proposal real, and it must pass every
gate: appendable origin, then a paired host, then the `Run Approved` leash, then
an explicit `GrowthApproval` minted by the confirmation sheet for that exact
proposal. Each refusal is a distinct thrown error with its own message.
Synthetic fixtures can never be appended to; the button is disabled and the
reason is printed on the card.

---

## Auth and host pairing

**No GitHub or Copilot OAuth token ever touches this device.** Copilot stays
authenticated on your host. `AuthPolicy.oauthTokensOnDevice` is `false`.

```text
host                                iPhone
----                                ------
shows RAPPID link  ------------->   rappid-link://pair?host=...&code=ABCD-EFGH-JKMN&fp=...
  or scans the device offer  <----   rappid-field://offer?device=...&install=...&scopes=...&nonce=...
verifies proof     <-------------   PairingRequest { schema, deviceName, deviceInstallID,
                                                     requestedScopes, nonce, proof }
mints scoped grant ------------->   DeviceCredential -> Keychain (actor)
                                    Authorization: Bearer ... on every call
revokes at any time ------------>   credential dies; the app falls back to fixtures
```

- The **one-time code never travels**. What travels is
  `sha256("rappid-field/1:pair\n<canonical json>")`, bound to the code, the
  device install id, and a nonce, so a captured request cannot be replayed.
  `PairingTests.testPairingRequestCarriesNoCredentialAndNotTheCodeItself`
  asserts the encoded payload mentions no token, secret, bearer, OAuth, GitHub
  or Copilot material, and does not contain the code in any form.
- The QR the host scans is an **offer**, not a secret — a photograph of it
  authenticates nobody.
- The credential lives in the **Keychain** behind an `actor`
  (`KeychainCredentialStore`), is scoped to the four habitat methods, is
  revocable from the host, prints itself redacted, and travels only as an
  `Authorization` header — never in a URL or a body.
- Loopback hosts may use plain HTTP because that traffic never leaves the
  device; anything else must be HTTPS. The exception is scheme-exact:
  `http://localhost`, `http://127.0.0.1`, and `http://[::1]` are accepted,
  while FTP, file, WebSocket, and every other scheme are refused even when
  their host is loopback.
- The real host transport is `HTTPHostTransport`: JSON-RPC over HTTPS or
  literal-loopback HTTP. `SyntheticGateway` is a separate, visibly demo-only
  fixture and never creates or stores a credential.
- Before `rappid.grow`, the device requests `rappid.approval.issue` for the
  exact RAPPID and proposal id, then sends the returned single-use
  `approvalId`. The host rejects replay, expiry, another device, a missing
  `rappid.grow` scope, or any mismatched binding.

---

## The privacy model

- **No location.** There is no CoreLocation import in the target and no
  location usage string in the Info.plist, so iOS could not show a prompt even
  if code asked. `PrivacyTests` walks the shipped bundle's Info.plist and fails
  if any `NSLocation*`, `NSCamera*`, `NSMotion*`, `NSContacts*`,
  `NSUserTracking*` or `NSBluetooth*` key appears, or if any background mode is
  declared.
- **No discovery mode in this build.** The Privacy screen carries a switch that
  records an opinion and changes nothing. The documented future intent is
  coarse, when-in-use location only, requested once at the moment it is turned
  on — never precise, never in the background, and never for anyone else. **No
  child location tracking, in any form, ever.**
- **No age, no account, no email, no analytics, no third-party SDKs.**
- **Everything persisted is listed in the app**, on the Privacy screen, from
  `PersistedState`: the path you chose, your leash, the privacy switches, a
  random per-install id (not a hardware or advertising identifier), and whether
  onboarding is done. Plus the device credential in the Keychain once you pair.
- **Nothing leaves the device** until you pair with a host you control.

---

## CMR/1 — committed messages

The companion screen never streams tokens at you. Response deltas are consumed
for liveness and held in a **private buffer** the view layer cannot read; the
operator sees a stable presence bubble; one atomic commit reveals the finished
message. Cancel or error **discards the uncommitted draft entirely** — no
half-sentence survives a failure, and nothing arrives late after a cancel.
Reduced Motion replaces the animated presence dots with a static line, and the
bubble conveys *presence*, not progress, because a progress hint leaks the same
thing the text would.

---

## Debug autopilot

A DEBUG-only command mailbox that drives the app the way a finger does — an AI
player interface first, and a test harness second. An agent reads a bounded
semantic state, picks from the actions the game says it will accept, and plays.

### One game, two players

```
   buttons ─┐                        ┌─ GameState (encounter, training, progress)
            ├─▶ GameCommand ─▶ GameReducer.reduce ─┤
 autopilot ─┘        (pure)          └─ GameEffect ─▶ GameEngine performs it
```

`GameReducer` is a pure function of `(GameState, GameCommand, GameContext)`.
Every button in the app and every autopilot command produces the same
`GameCommand` and lands in the same `reduce`, so an agent and a person are
playing one game rather than two implementations of it. The reducer decides
what is allowed; `GameEngine` only carries out the effects it returns.

`availableActions` in every receipt is computed *by asking the reducer* what it
would refuse, so the advertised list can never drift from the behaviour — and a
test asserts that agreement in seven different game states.

### The loop

| Step | What happens |
|---|---|
| **Choose** | `selectStarter` then `confirmStarter`. Selecting is not choosing. |
| **Listen** | `playWakeCall` / `stopWakeCall` — the companion's own 16-note motif |
| **Discover** | `beginEncounter`, then `encounterMove` with `listen`, `approach`, `steady` or `withdraw` |
| **Train** | `beginTraining`, then `trainingAnswer` with `echo`, `invert` or `extend` |
| **Inspect** | `inspectCompanion` — traits in exact thousandths, frame height, weight, dimensions |
| **Read** | `setLeash`, then `requestProposal` — always non-authoritative |
| **Decide** | `openConfirmation` → `acknowledgeConfirmation --target <proposal id>` → `approveAppend` or `cancelAppend` |

**Discovery encounters** are local to the *companion*, not to a place: the
signal is derived from its own motif and an encounter counter, and no location
is read, requested, or inferred. A signal has a kind (`echo`, `drift`,
`chorus`), a strength, and four steps. Listening is safe and reveals another
note; approaching before two notes are heard costs attunement, and after them
it is the winning move; holding a signal costs its strength every step.
Reaching 80 attunement attunes it and raises the field meter.

**Training drills** are call and response over four consecutive notes of the
motif. A rising fragment is `extend`, a falling one is `invert`, a level one is
`echo` — and the fragment's `intervals` are published in the state, so an agent
can play a drill properly from the receipt alone rather than guessing. The
`play-demo` journey wins every round that way.

Play feeds the reading and nothing else: attunement, resolved encounters and
completed drills go into the proposal's seed and evidence, so a companion you
have played with reads differently from one you have not. It changes no
identity, no frame height, and no weight — a test asserts exactly that.

### Two locks before it exists

| Lock | Effect |
|---|---|
| Build configuration | `AutopilotGate.isCompiledIn` is `false` in Release, the driver is never constructed, and every carrier is inert |
| Explicit opt-in | Even a DEBUG build does nothing without `RAPPID_AUTOPILOT=1` (environment) or `-RAPPID_AUTOPILOT 1` (launch argument) |

When it is live, an unobtrusive **AUTOPILOT** badge sits in the top corner, so a
build that can be driven never looks like one that cannot.

The Release check names executable surfaces rather than grepping the broad word
`Autopilot` (the inert gate/session shells deliberately remain):

```bash
nm -a .build/Build/Products/Release-iphonesimulator/RappidField.app/RappidField \
  | grep -E "AutopilotDriver|AutopilotParser|AutopilotCommand|AutopilotReceipt|AutopilotAction|Mailbox|AutopilotBadge"
strings -a .build/Build/Products/Release-iphonesimulator/RappidField.app/RappidField \
  | grep RAPPID_AUTOPILOT
```

Both commands must print nothing.

### The protocol

Commands are versioned JSON:

```json
{"type":"command","version":1,"seq":7,"id":"<unique>","action":"navigate","target":"growth"}
```

Every command is answered with a receipt published to the pasteboard:

```json
{"type":"receipt","version":1,"id":"<same>","seq":7,"cursor":7,"status":"ok","state":{ … }}
```

Parsing is strict and refuses rather than guesses: wrong version, unknown
action, missing id, **missing or non-positive `seq`**, unexpected keys,
non-string `target`/`value`, an oversized value, or an oversized payload are all
refused with a machine-readable code.
Anything that is *not* one of our commands — the operator's own clipboard, a
receipt, arbitrary text — is ignored silently and produces no receipt. A
command id is honoured once; a replay is refused with `duplicate-command-id`
and is never re-executed.

### A strict stepwise handshake

There is no fire-and-forget path. One command is in flight at a time:

```
CLI                                    app
 │ seq := cursor + 1
 │ write one command (unique id, seq) ─────▶ mailbox
 │                                          detects it once (change cursor)
 │                                          refuse if: duplicate id · seq ≤ cursor · busy
 │                                          cursor := seq   (acceptance spends the place)
 │                                          dispatch the same GameCommand a button sends
 │                                          ── settle ──────────────────────────────
 │                                            • the habitat is no longer loading
 │                                            • a sent message has committed/failed/cancelled
 │                                            • an animated move has finished animating
 │                                            • or `command-timeout` after settleTimeout
 │ ◀──────────────────────────────────────── write receipt {id, seq, cursor, status, state}
 │ match id AND seq, check cursor ≥ last
 │ assert postcondition, then and only then send seq+1
```

| Rule | Enforced by |
|---|---|
| One command at a time | `busy: another command is still running` |
| Strictly increasing order | `stale-sequence: 3 is not past cursor 7`, carrying the cursor to resync from |
| Accepted once | `duplicate-command-id`, bounded 256-entry replay cache |
| A refused *move* still spends its place | cursor advances on acceptance, whatever the outcome |
| A command refused *at the door* does not | parse-level refusals answer with `seq: 0` and leave the cursor alone |
| The receipt describes a settled app | `settle(after:)` waits for services, the committed message, and the animation |
| A stall is reported, not hung | `status: "error"`, `command-timeout: sendChat: the reply never committed` |
| The caller never runs ahead | `Session.send` refuses to write while a receipt is outstanding, and a `HandshakeTimeout` ends the run on the step that went unanswered |

The cursor is discoverable: it rides on every receipt, so a caller joining a
session already in progress calls `resync()` and reads it out of the mailbox
rather than guessing.

Because the receipt is written only once the work has settled, journeys assert
directly instead of polling — the `sendChat` step's own receipt already reports
`chatMessages: 2, chatPhase: "idle"`.

### The allowlist

`navigate`, `selectStarter`, `confirmStarter`, `openCard`, `fillPairingHost`,
`fillPairingCode`, `submitSyntheticPair`, `playWakeCall`, `stopWakeCall`,
`setLeash`, `requestProposal`, `openConfirmation`, `acknowledgeConfirmation`,
`approveAppend`, `cancelAppend`, `fillChatInput`, `sendChat`, `cancelChat`,
`resetSyntheticState`, `snapshot`, `inspectCompanion`, `beginEncounter`,
`encounterMove`, `leaveEncounter`, `beginTraining`, `trainingAnswer`,
`endTraining`.

That is the whole surface. There is no action that evaluates code, addresses a
view by selector or coordinate, fetches a URL, touches the filesystem, runs a
shell, injects a credential, bypasses a confirmation, or deletes anything the
operator would miss — and a test fails the build if a verb that looks like one
ever appears.

The ordinary gates stay in force. `approveAppend` is refused unless the
confirmation sheet is open *and* acknowledged, and even then it runs the same
`GrowthLeashPolicy` a finger does — which refuses a synthetic fixture.
`submitSyntheticPair` mints the grant locally and ignores any value handed to
it, so no credential can be injected. `fillPairingHost` accepts only HTTPS or a
loopback address, and nothing fetches it.

### Receipts carry semantic state

The `state` object is a fixed, bounded key set. `screen`, `starter`, `stage`,
`availableActions`, `encounter`, `weightComplete`, `frameHeight` and the pending
`proposal` are always reported when they exist, alongside onboarding stage,
companion name, short RAPPID prefix, traits in exact thousandths, weight bytes
(absent when incomplete — never guessed), display height and its curve version,
dimension count, origin, pairing mode, leash, confirmation flags, wake-call
state, chat phase and message *count*, attunement, encounters resolved, drills
completed, and the current `training` fragment.

No geometry, no view identifiers, no message text, and no credential, token,
one-time code or host address. Tests assert the key set is a subset of the
declared allowlist and that no receipt carries credential material.

```
$ ./scripts/autopilot.py state
  screen             growth
  starter            canopy
  stage              Strider
  frameHeight        9
  weightComplete     True
  attunement         35
  encountersResolved 1
  drillsCompleted    1
  encounter          none
  training           none
  proposal           proposal-2c6ab71c… · skill · authoritative=False · appendable=False
  availableActions   beginEncounter, beginTraining, fillChatInput, …, requestProposal, setLeash, snapshot
```

### Transports, and a platform limit worth knowing

Receipts always go to the pasteboard, and `simctl pbpaste` reads them — writing
a pasteboard is never prompted.

Reading one is. On iOS 16 and later an app cannot read general-pasteboard
content another process wrote without a system confirmation, which was proven
three ways on iOS 26 while building this:

1. `UIPasteboard.general.string` raises *"RAPPID Field would like to paste from
   CoreSimulator-Bridge"* and blocks behind the alert;
2. `xcrun simctl privacy <device> grant all <bundle>` does not cover it — there
   is no pasteboard service to grant;
3. `UIPasteboard.general.detectedValues(for:)`, the pattern-detection API,
   throws *"Operation not authorized"*.

`simctl openurl` on a custom scheme is no better: it raises *"Open in RAPPID
Field?"*, and a URL cannot carry the activation flag into a cold launch.

So there are two inbound carriers, and both reach the identical parser,
allowlist, replay guard and receipt path:

| `--transport` | How commands arrive | Unattended? |
|---|---|---|
| `clipboard` | `simctl pbcopy`, read from the pasteboard mailbox | No — someone must tap "Allow Paste" per command. Requires the second opt-in `RAPPID_AUTOPILOT_CLIPBOARD=1` |
| `file` (default) | A one-slot mailbox inside the app's own container | Yes |

Reading the pasteboard for *commands* is a separate opt-in precisely because
that read blocks behind a modal alert, which would starve an unattended run.
The container mailbox is polled first for the same reason, and it is emptied
when read, so a relaunch never re-runs the last command.

Polling is foreground-only: the driver is suspended whenever the scene leaves
`.active`.

### The CLI

```bash
# boot, install, launch with autopilot enabled
./scripts/autopilot.py up --autopilot

# one command, printed with its receipt
./scripts/autopilot.py send navigate --target growth
./scripts/autopilot.py send setLeash --value runApproved
./scripts/autopilot.py state

# the whole deterministic journey, from a fresh install
./scripts/autopilot.py smoke

# a full play session: choose, listen, encounter, drill, read, decide
./scripts/autopilot.py play-demo

# the specified clipboard carrier (needs someone to allow each paste)
./scripts/autopilot.py up --autopilot --clipboard
./scripts/autopilot.py --transport clipboard send snapshot
```

The smoke journey walks onboarding, both weight cases, wake-call play/stop, the
leash, every append refusal, pairing, a committed chat message, replay and
malformed-command refusals, and the reset — asserting the receipt state at each
step. The `play-demo` journey plays the game instead: it wins a discovery
encounter by listening before approaching, wins every drill round by reading
the published intervals, watches the proposal change because of that play, and
is refused at the append. Both exit non-zero on any mismatch.

Both end with the handshake proof, and fail if fewer than ten sequential
handshakes were made or the cursor ever failed to move forward:

```
46 sequential handshakes · cursor 0 -> 46 · monotonic=True · unanswered=0
PASSED all 50 checks
```

---

## Architecture

```text
Sources/
  Core/       Canonical JSON, sha256, the shared deterministic stream, MIDI DNA
  Models/     RappidIdentity, StarterPath, MoltStage, CreatureStats + WeightLedger,
              Companion, Growth (proposal, approval, leash policy)
  Game/       GameCommand, GameState + rules, the pure GameReducer, GameEngine
  Sonic/      SonicSignature, WakeCallSynthesizer, WakeCallPlayer, FieldHaptics
  Services/   Pairing types, CredentialStore (actor), RappidGateway + transports,
              GatewayDecoding, ProposalEngine, SyntheticField fixtures, CMR buffer
  Autopilot/  DEBUG-only: gate, protocol + strict parser, mailboxes, driver, session
  Design/     FieldTheme, FieldComponents, drawn starfield background
  Features/   Onboarding, FieldGuide, Play (encounter + drill), Growth, Chat,
              Pairing, Settings
  App/        RappidFieldApp, RootView, AppModel, FieldNavigator, PrivacyPolicy
Tests/RappidFieldTests/
  SonicIdentityTests     host byte parity, determinism, no autoplay
  StarterPathTests       starter mappings, trait posture, no age gate, IP denylist
  MoltIdentityTests      same identity across molt, derived stage
  WeightTests            exact / incomplete / dedupe, versioned display height
  GrowthAuthorityTests   proposal non-authority, every append refusal
  PairingTests           no credential in payload, proof binding, redaction, Keychain
  PrivacyTests           bundle declares no location or camera purpose
  GatewayTests           wire shape, credential only in the header, decode honesty
  CommittedMessageTests  buffer commit / cancel / failure, view-model reveal
  GameReducerTests       encounter and drill rules, gates, availableActions agreement
  AutopilotTests         allowlist, refusals, replay, inert modes, semantic state,
                         binding confirmation, no credential in a receipt, and an
                         agent playing an encounter and a drill from receipts alone
scripts/
  autopilot.py           simctl driver: up / send / state / smoke / play-demo
```

Models and services are pure and synchronously testable; the views hold no
logic worth testing. Screen state lives in `FieldNavigator` rather than in each
view's `@State`, so a finger and the debug autopilot drive exactly one path to
every outcome, and the game's own rules live in one pure reducer both of them
call. Errors propagate — there are no broad catches and no success-shaped
fallbacks.

---

## Build and run

Requires Xcode 26+ and [XcodeGen](https://github.com/yonaskolb/XcodeGen).
Targets iOS 17.0+. Verified on the iPhone 17 Pro simulator.

```bash
cd ios/RappidField

# 1. Generate the Xcode project from project.yml
xcodegen generate

# 2. Build for the simulator
xcodebuild -project RappidField.xcodeproj -scheme RappidField \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath .build build

# 3. Run the tests
xcodebuild -project RappidField.xcodeproj -scheme RappidField \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath .build test

# 4. Install and launch
xcrun simctl boot "iPhone 17 Pro"
xcrun simctl install "iPhone 17 Pro" \
  .build/Build/Products/Debug-iphonesimulator/RappidField.app
xcrun simctl launch "iPhone 17 Pro" com.openrappter.rappidfield

# 5. Drive it from a terminal (DEBUG only)
./scripts/autopilot.py smoke

# Optional: skip onboarding for a screenshot pass (argument domain, not persisted)
xcrun simctl launch "iPhone 17 Pro" com.openrappter.rappidfield \
  -field.onboardingComplete YES -field.starterPath forge
```

Or open `RappidField.xcodeproj` in Xcode and press Run. The project file is
generated and git-ignored; `project.yml` is the source of truth.

---

## Prototype vs real

| Real, working, verifiable | Prototype stand-in |
|---|---|
| MIDI DNA derivation, byte-exact against the host runtime | The host itself — this app ships no gateway |
| Wake-call synthesis and playback, rendered on device | — |
| Weight ledger, dedupe, incomplete-weight refusal | Fixture memory/skill/device byte counts; the sonic ones are real |
| Display-height curve and versioning | — |
| Leash, local confirmation, host-issued single-use approval, and exact `rappid.grow` receipt | Synthetic fixtures always refuse |
| One-time host proof handshake, Keychain storage, scoped bearer credential, and host revocation | Demo-only synthetic mode stores no credential |
| JSON-RPC over URLSession with the real bearer in `Authorization` and strict #438 decoding | — |
| CMR/1 buffering, commit, cancel, failure | The companion's voice — replies come from a small local responder, not a model |
| The play loop: encounters, drills, attunement, and their effect on a reading | A long game — there is one encounter table and one drill, sized to prove the loop rather than to fill an evening |
| The debug autopilot, its allowlist, refusals and receipts | Anything in a Release build — it is compiled out, and the CLI is a development tool, not a product surface |
| Every privacy claim above | — |

Companions shown without a paired host are **deterministic local fixtures**,
labelled `SYNTHETIC` on every screen that shows one, and the app refuses to
append to them rather than faking a body frame.

There is no App Store metadata, no icon artwork, and no analytics.
