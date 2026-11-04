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
is `ok`, `hungry`, or `unreachable`. All three are observations, not command
failures: the self-check exits successfully even when attention is needed.
