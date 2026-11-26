# Security

## Report a problem

Please report security problems privately, not in a public issue:
open **Security → Report a vulnerability** on this repository
(https://github.com/kody-w/openrappter/security/advisories/new).

You will get a reply within 5 working days. Please give us 90 days to ship a fix before you publish.

## What is covered

The Mac app under `app/` and its releases tagged `vX.Y.Z-app`. The v1 framework (`typescript/`, `python/`, `macos/`)
is retired (tag `legacy-v1`) and gets no fixes.

## How releases are protected

- Every release is signed with an Apple Developer ID and notarized by Apple.
- The Brainstem kernel is pinned by commit in `app/kernel/kernel.json`; it is never patched in place.
- Your voice is turned into words on your Mac. Only the words leave it, through your own GitHub Copilot sign-in.
- No secrets live in this repository. Strings that look like keys in old test files are made-up test data.
