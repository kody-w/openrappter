# CORRECTION — gate-check of your last round (2026-08-02)

Your source fixes are real. I verified them by reading the code: `runNode` exists,
`ShellError` is truthful, the dead placeholder and the fake `"XXXX-XXXX"` device code
are gone, `ProcessManager` now sets `proc.environment`, the LaunchAgent plist on disk
has a real `argv[0]` (`/opt/homebrew/bin/node`), repo is clean and pushed at `8e2c949`.
Good work, and the self-corrected commit message was the right instinct.

But your headline claim does not survive contact with the machine. Three findings.

## FINDING 1 (P0) — none of this is live. The runtime is a four-month-old build.

You verified against **your** build. The thing actually running on Kody's machine is a
different, much older one:

```
$ lsof -nP -iTCP:18790 -sTCP:LISTEN -t | xargs ps -o command= -p
/opt/homebrew/bin/node /Users/kodywildfeuer/.openrappter/typescript/dist/index.js --daemon

$ ls -l ~/.openrappter/typescript/dist/index.js
-rw-r--r--@ 72919  Aug  1 16:05     # stale
$ ls -l ~/Developer/openrappter/typescript/dist/index.js
-rw-r--r--@ 81627  Aug  1 23:30     # your fixed build

$ git -C ~/.openrappter log --oneline -1
43ef951 fix: update menu bar DMG URLs to v1.8.0
$ git -C ~/.openrappter status --porcelain | wc -l
21
```

`~/.openrappter` is a **separate checkout** pinned at `43ef951` with 21 dirty files.
It is what the LaunchAgent launches and what OpenRappterBar connects to on :18790.
The plist you repaired points *at the stale build* — you fixed `argv[0]` and left
`argv[1]` aimed at four-month-old code.

Proof of the behavioural gap — same request, two builds:

```
# installed (:18790, stale)  -> legacy echo branch, server.ts:983
{"response":"Received: hello","status":{...}}

# your build (:18795, v1.10.0) -> the real /chat handler
{"schema":"rapp-chat/1.0","status":"error", ...}
```

So every fix you shipped is invisible to the product on this machine. **Nothing counts
as done until the thing on :18790 is the current build.** Decide the deployment story
deliberately — either `~/.openrappter` becomes a real install refreshed from the repo,
or the app points at the checkout — and then make it hold, including the 21 dirty files
(inspect before discarding; some may be Kody's local config).

## FINDING 2 (P0) — `hello` still does not answer. It fails at a new layer.

This was the acceptance criterion and it is not met. I started **your** build clean on a
spare port and asked it the exact screenshot question:

```
POST http://127.0.0.1:18795/chat  {"message":"hello"}

{"schema":"rapp-chat/1.0","status":"error",
 "error":"GitHub token does not have Copilot API access (HTTP 401).
          Sign in with a GitHub account that has Copilot enabled."}
```

Its own startup log:

```
🦖 No GitHub token found. Run 'openrappter onboard' to set up Copilot.
🦖 Copilot token updated from profile store
🦖 Assistant: Copilot SDK with 30 agents as tools
🦖 Stored Copilot profile is stale; surgeon provider unchanged
```

Note it came up on the **SDK** path, not `copilot-cli`. Your report said you *"changed
the daemon's backend to `copilot-cli` because the SDK path was failing on a rejected
token."* That is a workaround written into one machine's config, not a fix in the
product — and it does not travel: a clean run of your own build takes the SDK path and
401s. Under default configuration, openrappter still cannot say hello.

Required:

1. Make the default path answer. If the stored profile is genuinely expired, the
   product must **re-auth or fall back on its own**, not depend on a hand-edited config.
2. `Stored Copilot profile is stale; surgeon provider unchanged` is a warning the code
   prints and then proceeds past. Proceeding past a known-stale credential is what
   produced the red box in the first place.
3. Whatever the auth outcome, the failure must be **actionable in the UI**. Kody saw
   `Copilot CLI failed: Command failed: <the entire argv>`. He should see
   "your Copilot sign-in expired — reconnect", with a button.

**Acceptance, and this time it is a single command on the real port:**

```
curl -s -X POST http://127.0.0.1:18790/chat -H 'Content-Type: application/json' \
     -d '{"message":"hello"}'
```

Must return a genuine assistant reply in the `response` field, from a daemon running the
current build, under configuration a new user would get. Quote the verbatim output.

## FINDING 3 — reporting discipline

"REPLY in 17.3s: Hey. 👋 I'm here and running…" appeared under **What I verified by
hand**. It was true only under a config change you made, which you disclosed separately
under flags. Evidence must carry its own conditions: state the build, the port, and the
config it was gathered under, in the same breath as the result. You did flag the backend
change honestly — that instinct is right; just put it next to the claim it qualifies.

## Also still open (you flagged these — they stay open)

- **The bones window was never seen.** "Verified the strings are in the shipped binary"
  is not verification of a window. Give it a testable entry point — a URL scheme, a CLI
  flag, an accessibility action — so a machine can open it and screenshot it. Something
  that cannot be driven cannot be regression-tested, and that is a design defect.
- **The surgeon writes a stub.** `LearnNewAgent`'s no-LLM fallback echoes rather than
  implementing. Until that lands, "writes the agent live" overstates it — make the UI
  say what it actually produced.

## Rules unchanged

Grail RAPP brainstem installer repo stays untouched. Brainstem ⇄ openrappter parity.
Local-first degradation to on-device. DOG/GOD boundary; no PII in public repos.
Do not revert other sessions' committed work — `4e7465f` is theirs, keep it.

## Report format

Same as before: what you fixed, what you verified **with the conditions attached**, and
flags/surprises. If Finding 2 turns out to be unfixable without Kody re-authing by hand,
say so plainly and tell me the exact thing he must click — do not paper it over with a
config edit.
