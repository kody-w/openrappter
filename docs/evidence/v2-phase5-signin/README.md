# Sign-in door (2026-10-24)

Kody's screenshot: the creature sent the browser to the kernel's `/login` page and got "Method Not Allowed".
The grail's `/login` is a `POST` that starts a GitHub device sign-in and hands back a short code; there is no page.

Now the app posts, copies the code, opens GitHub's device page, shows the code big on the card, and watches
`/health` flip from hungry to fed (the kernel polls GitHub by itself).

- `signin-card.png` — the card in the notch, cropped: the code, the plain words, one button.
- `signin-live.log` — the run on Kody's Mac attached to the app's own kernel on :18790 (`OPENRAPPTER_SIGNIN=1`
  presses the button from the environment). `sign-in code … copied; opening https://github.com/login/device`;
  the clipboard held the same code. Kody approved on GitHub and 20 seconds later: `fed: signed in`; the kernel's `/health` went from `unauthenticated` to `ok`.

Tests: `cd app && swift test` → 17 of 17 (the fake kernel now answers `GET /login` with 405 exactly like the grail,
and `POST /login` with a code).
