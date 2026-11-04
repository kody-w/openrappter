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
speech output, clipboard contents, and a virtual clock: no recording or live
sign-in is needed. Rendered-view tests use temporary offscreen windows, on-device
text recognition, and real button and text-field events. They do not capture the
desktop or activate the app. The original self-check and client tests remain.
`FIXES.md` maps all 69 canonical defect numbers and exact titles to regression
tests for their scenarios, including virtual-clock and real adapter coverage.
The canonical titles were supplied by proof5; the external detailed review
files were not readable in this session.

The creature never replaces an already starting mind. Missing Apple tools get
an Install action instead of repeated prompts. Only a copy in `/Applications`
or `~/Applications` arranges automatic startup; other copies offer to move.
Upgrades refresh the launcher's files without stopping a healthy or starting
mind. An upgrade-copy failure is logged without losing a healthy attachment.
First setup may take more than four minutes; the creature keeps waiting and
explains that it is still getting ready. Failed dependency setup backs off and
keeps its download cache.
Choose **Stop starting at login** to turn off future starts while leaving the
current creature and mind running. This choice survives reopening and upgrades;
a mind needed later starts without restoring automatic startup. **Keep my mind
ready when I sign in** explicitly restores both the creature and mind at login.
Homebrew removal stops both helpers, and upgrades reopen the new app.

Temporary sign-in copying restores all saved clipboard items, unless something
new was copied meanwhile. **Later** hides the code without cancelling sign-in
or restoring the clipboard; **Sign me in** shows it again. Only **Cancel
sign-in**, completion, failure, or quitting releases the temporary clipboard.
Successful sign-in has a readable confirmation. Approval cards work even before
sign-in. Twin notes use plain action words and direct objections to the
**Object** button in the Mac app; there is no phone reply shortcut.

Background retries wait for live turns, sign-ins, and unanswered cards. Stopping
automatic startup does not stop recovery of a missing mind. Later
on a permission or help card never cancels a separate sign-in. The owner's
words, caller requests, stream updates, and mind answers (including speech)
are preserved verbatim; plain-word replacements are only for the creature's
own copy.

## Talking, typing, and sleeping

Choose **Type to me** to open the notch's text field without microphone access.
Say **go to sleep** while holding Option and Space, type it in that field, or
choose **Go to sleep (Quit OpenRappter)** from the menu to quit. This unloads only
the current creature so it cannot immediately reopen itself; the saved choice
for future Mac sign-ins and the running mind are left alone. Dictating the words
"go to sleep" with Control added still types those words rather than quitting.

Fresh owners see sign-in before optional permission cards, including access to
texts. Access to texts is requested only from the owner's menu action, not at
startup. Older queued permissions wait through sign-in and can be deferred
across launches; deferral never grants access. Optional automatic startup
advice also waits behind sign-in. An Applications copy can take over from a
still-running DMG or translocated copy, rather than waiting forever.

After a turn settles, replies, successful dictation, shortcut instructions, and
other creature notices clear after eight seconds and the notch compacts without
a click. **Got it** can dismiss them sooner. An old timer cannot hide a new turn
or another caller's unanswered decision. Conversation history remains intact.
Full replies, card titles, caller explanations, and every card option are
scrollable rather than truncated. An unsent typed draft pauses automatic
compacting and survives view replacement. A question typed while another one
is being answered stays in its field; only the local sleep command can
interrupt the current question.

Questions asked before the mind is ready are explicitly acknowledged, including
spoken feedback, with instructions to ask again once ready. Dictation requests
Accessibility before offering its setting; busy feedback distinguishes typing,
reading, and thinking. Speech-recognition failures are distinct from silence or
a missing microphone. Screen-access guidance explains the required restart.
Failure to arrange future startup never disables an already answering mind.
