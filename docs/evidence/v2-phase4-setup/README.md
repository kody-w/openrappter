# First run: the four powers (2026-10-24)

- `setup-card.png` — the card in the notch with two powers faked as missing (`OPENRAPPTER_SETUP_FAKE=typing:notAsked,screen:denied`). Cropped to the panel.
- `setup-fake.log` — that run's log: `setup shown microphone=granted speech=notAsked typing=notAsked screen=denied`.
- `setup-live.log` — a real first run on Kody's Mac: speech recognition had never been allowed; Kody clicked the orange button and the Mac's prompt. Ends in `power speech -> granted` and `setup done`.

Tests: `cd app && swift test` → 15 of 15 (SetupTests covers the override parser, asking order, and plain words).
