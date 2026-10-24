# Phase 2 and 3 evidence: voice, hands, eyes, needs (2026-10-23, M4 Max, macOS 27.0.1, signed OpenRappter.app)

| Proof | File | Observed |
|---|---|---|
| Ask → spoken reply | `say-and-card.log` | attached to the personal kernel on :7181, asked "What is two plus two?", reply "Two plus two equals four." shown in the notch and spoken by the system voice |
| Needs card | `card.png`, `say-and-card.log` | a card dropped into `~/.openrappter/needs/` appeared in 2 s with Allow once / No / Always / Later; a real click on Always wrote `demo-ph-1.answer.json` with `allow-always` |
| Claude Code hook | `swift test` + shell run | PermissionRequest → card → answer file → hook printed the allow decision; deny path printed deny with message; Stop and Notification dropped cards; unanswered cards withdraw after 55 s |
| Type for me | `typed.log`, `typed-target-received.txt` | 75 characters inserted at the cursor of a test window through Accessibility (`via ax`); the window's file shows the exact sentence. The clipboard+⌘V fallback for terminals and Electron apps is unverified: a synthetic ⌘V did not land on this Mac in 3 of 3 tries, from the app and from a script |
| Login service | `login-service.log`, `hungry-own-kernel.png` | with no kernel on :18790 the app wrote `~/Library/LaunchAgents/com.openrappter.kernel.plist`, launchd started the pinned kernel (healthy in 46 s), the app showed the hungry card, and after the app quit `/health` still answered 200. `:7071` stayed 200 throughout |
| Read my screen | `screen-read.log` | ScreenCaptureKit + Vision read 4,104 characters off the front window; the kernel answered about it in 3 s. Reply text redacted here because it came from a private terminal |
| Unit tests | `swift test` | 12 of 12 |

Unverified: a live hold-⌥-Space microphone round trip (needs a person at the key; the env-driven path exercises everything after the transcript).
