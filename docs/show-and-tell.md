# Show-and-Tell

Show-and-Tell learns a reusable workflow from a demonstration without treating
screen recording as permission to collect everything.

## Lifecycle

```bash
openrappter show-and-tell start --intent "Publish a verified release"
openrappter show-and-tell note "I wait for every required check before tagging"
openrappter show-and-tell observe "Confirmed the package smoke install" --app Terminal
openrappter show-and-tell capture --label "All required checks are green"
openrappter show-and-tell stop
openrappter show-and-tell analyze
openrappter show-and-tell review --feedback "Make the verification step explicit"
openrappter show-and-tell approve
openrappter show-and-tell bundle
openrappter show-and-tell propose
openrappter show-and-tell revise-plan --intent "Publish only after every required check"
openrappter show-and-tell revise-plan --approve
openrappter show-and-tell export --plugin-name verified-release
openrappter show-and-tell build --target all
openrappter show-and-tell replay
openrappter show-and-tell test
```

`start`, analysis `approve`, plan `revise-plan --approve`, and `delete` require
confirmation from an interactive local terminal. Plan edits and plan approval
must be separate turns, so approval always binds the text the reviewer read.
`analyze --enhance` has its own confirmation because it sends the
privacy-safe textual summary to GitHub Copilot. A model, remote client, or
background daemon cannot mint these one-use tokens.

In OpenRappter Desktop, the equivalent boundaries are native Electron dialogs
owned by the main process. Screenshot capture has its own confirmation and is
limited to the active window that was validated immediately before and after
capture.

## What is recorded

- active application and window changes
- browser destinations with credentials, query strings, fragments, and
  opaque identifier-like path segments removed
- local path examples reduced to `~/...` or `<absolute>/<basename>` before export
- narration notes and explicit semantic observations
- OpenRappter ComputerUse actions, excluding typed text
- the validated active window only when `show-and-tell capture` is confirmed

The detached collector records context, not continuous video. It posts a local
recording notification and heartbeat, stops after eight hours at most, and
marks abandoned sessions failed instead of silently starting a second worker.

## Privacy boundary

- Everything is local under `~/.openrappter/show-and-tell/`.
- Directories use mode `0700`; databases and files use `0600`.
- Secret-shaped values use the Flight Recorder sanitizer.
- Credential- or sign-in-looking windows cannot be captured.
- Typed text is stored as a character count only.
- Raw screenshots and screenshot paths are never sent to a model.
- Copilot enhancement is optional and receives only the sanitized textual
  timeline after a separate local confirmation.
- Optional “Tell” narration downloads Whisper Small q8 once (~252 MB), records
  microphone audio locally, transcribes at 16 kHz mono, and appends the spoken
  text to the session. Audio is retained only inside the private session.

## Review and artifacts

Analysis always starts with a deterministic local reconstruction. The optional
Copilot pass can refine that baseline but invalid output is rejected.

Approval freezes the reviewed intent and ordered steps as the source for:

- `~/.openrappter/skills/<name>/SKILL.md`
- `~/.openrappter/skills/<name>/manifest.json`
- `~/.openrappter/automations/<name>/automation.json`
- `~/.openrappter/marketplace/<name>/...` for a private marketplace export

`propose` first lifts demonstration-specific values into editable `{{value}}`
tokens and marks risky steps for confirmation. Nothing builds in that turn.
`revise-plan` edits that proposal; a separate `revise-plan --approve` freezes it.
Skills tell the agent to prefer native APIs, CLI tools, filesystem operations,
and browser tools over replaying pixels. Automations are created disabled.
`show-and-tell replay` is always a dry run, and `show-and-tell test` checks files, hashes, privacy,
schema, and the disabled automation default.

## Shared runtime contract

TypeScript and Python use the same SQLite schema and
[`openrappter-show-and-tell/1.0`](../contracts/show-and-tell-v1.json) contract.
A session started by one runtime can be inspected, extended, stopped, analyzed,
and packaged by the other without conversion.
