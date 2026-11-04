# Mac app self-check

Run the built executable with `--doctor` for a short health report:

```sh
cd app
swift build -c release --product OpenRappter
.build/release/OpenRappter --doctor
.build/release/OpenRappter --doctor --json
```

The self-check does not open a window, ask for permissions, start or stop the
mind, or change sign-in settings. It checks the mind at `OPENRAPPTER_MIND`
(default `http://127.0.0.1:18790`), microphone and speech permissions, and
the app's saved login item, including whether its executable still exists.
The mind read is limited to eight seconds; no other mind addresses are tried.

Both formats include four checks and one suggested next step. The structured
format is `{"checks":[{"name":"mind","status":"ok","words":"..."}],"next":"..."}`
with additional `microphone`, `speech`, and `login-item` checks. The mind status
is `ok`, `hungry`, `no-copilot`, or `unreachable`. These are observations, not command
failures: the self-check exits successfully even when attention is needed.

## Creature transitions

`OpenRappterCore/CreatureStateMachine.swift` is a value-only state machine.
Events return effects; finding a mind, signing in, listening, asking, speaking,
resting, and selecting a card all update one presentation. `CreatureDriver`
runs those effects through an injected handler. `MacCreatureEffects` supplies
the real Mac adapters, and `main.swift` only wires the notch, keys, menu, and
folder updates to the driver.

Run `swift test` from this folder. The transition tests use fake minds, ears,
speech output, clipboard contents, and a virtual clock: no window, recording,
or live sign-in is needed. The original self-check and client tests remain.
`FIXES.md` maps all 47 confirmed defects to passing regression tests.

The creature never replaces an already starting mind. Missing Apple tools get
an Install action instead of repeated prompts. Only a copy in `/Applications`
or `~/Applications` arranges automatic startup; other copies offer to move.
Upgrades refresh the launcher's files without stopping a healthy or starting
mind. Failed dependency setup backs off and keeps its download cache.
Choose **Stop starting at login** to turn off future starts while leaving the
current creature and mind running. This choice survives reopening and upgrades;
a mind needed later starts without restoring automatic startup. **Keep my mind
ready when I sign in** explicitly restores both the creature and mind at login.
Homebrew removal stops both helpers, and upgrades reopen the new app.

Temporary sign-in copying restores all saved clipboard items, unless something
new was copied meanwhile. Approval cards work even before sign-in. Twin notes
use plain action words and direct objections to the **Object** button in the
Mac app; there is no phone reply shortcut.

Background retries wait for live turns, sign-ins, and unanswered cards. Later
on a permission or help card never cancels a separate sign-in. The owner's
words, caller requests, stream updates, and mind answers (including speech)
are preserved verbatim; plain-word replacements are only for the creature's
own copy.
