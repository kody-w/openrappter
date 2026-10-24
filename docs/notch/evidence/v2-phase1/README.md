# Phase 1 evidence: the mind client (2026-10-23, M4 Max, macOS 27.0.1)

Done-when: the app and curl both get `response` from a live kernel. Observed:

| Proof | File | What was observed |
|---|---|---|
| Attach to a running personal kernel | `attach-7181.log`, `speaking.png` | `GET /health` answered (v0.6.16, 22 agents), `POST /chat` answered in 2 s, the notch showed the reply in the speaking posture, app exited 0 |
| Launch the pinned grail kernel in its own home | `launch-18790.log` | `kernel/run.sh` cloned kody-w/rapp-installer at the pinned SHA, built a venv, started on :18790 in 55 s; `/health` 200 with `status: unauthenticated`; `/chat` HTTP 500 "Not authenticated"; the kernel on :7071 stayed 200 throughout |
| Hungry, not crashed | `hungry.png`, `hungry.log` | against the unsigned kernel the creature shows "needs you" with a one-line ask instead of an error |
| Unit tests | `swift test` | 10 of 10 pass: senses parser (7), fake-kernel client contract, hungry mapping, runner attach order |

Not yet done: sign-in for the launched kernel (phase 2 adds the "Take over" button that opens `/login`; keeper `signin register` is the no-second-device-flow route), launchd so the kernel outlives the app (phase 4), voice.
