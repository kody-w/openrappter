# doors/1 — ask OpenRappter, never macOS

macOS ties privacy approvals (Reminders, Notes, Messages, chat.db) to the exact program that asks, so every
script, launchd job and new Python restarts the permission hunt. OpenRappter, the signed notch app, holds those
approvals once. Everything else asks OpenRappter through this one standard. A door is an action behind the
app's existing **needs** approval; it is not a new product.

## Where
A Unix socket at `~/.openrappter/doors.sock`, mode `0600` (only this user). No TCP port. Override for tests with
`OPENRAPPTER_DOORS_SOCK`. If the socket is absent, the app is not running: callers fall back to their old path.

## Shape
One JSON object per line, one reply line per request. Several requests may share a connection.

    → {"door": "reminders.open", "args": {"list": "Beam"}, "caller": "beam_local"}
    ← {"ok": true, "result": [{"id": "x-apple-reminder://…", "title": "…"}]}
    ← {"ok": false, "error": "plain words"}

`caller` and `why` are optional. `why` is one line (≤200 chars) the notch card shows Kody when it asks;
device agents always send it. Without `caller` the caller is the program file behind the socket (from the kernel).

## Approval
The first call to a door by a new caller shows a needs card in the notch: "<caller> wants to <door>" with
**Allow once / Always / No**. The request waits (up to 120 s) for the click. "Always" is stored in
`~/.openrappter/doors-allow.json` as `{"allow": {"<caller>": ["<door>", …]}}`; delete a line to take it back.
No answer counts as No. `doors.hello` never asks.

## Doors in doors/1
| door | args | result |
|---|---|---|
| `doors.hello` | — | `{"contract":"doors/1","doors":[…]}` |
| `reminders.open` | `list` (default `Beam`) | `[{"id","title"}]` open reminders |
| `reminders.add` | `title`, `note`, `list` (default `Beam`) | `{"id","title"}` the new reminder |
| `reminders.done` | `id`, `note`, `list` (optional; faster) | `{"id","done":true}` ticks it off, note in its body |
| `notes.publish` | `topic`, `headline`, `body`, `folder` (default `Beam`) | `{"note_id","link"}` newest-first entry in note "Beam · <topic>" |
| `notes.read` | `title`, `folder` | `{"title","body"}` (HTML body) |
| `messages.send` | `to`, `text` | `{"sent":true}` via this Mac's iMessage |
| `messages.recent` | `since_rowid`, `limit` (≤1000), `newest` (true = the latest `limit` rows) | `[{"rowid","ts","text","from_me","handle"}]` from chat.db |

## MCP door
`rappter-doors-mcp` (stdio MCP server, app/doors) serves the same doors with the same approvals to any MCP client
(Claude Code, Copilot CLI, Codex). Caller = the client's `clientInfo.name` from `initialize`, so the notch card names
who asks. Each door is one tool (`.` becomes `_`, e.g. `reminders_open`), its input schema read from the table above;
a new door is a new tool, and an existing tool never changes meaning.

## Errors
`ok:false` with an `error` sentence a person can read: unknown door, missing argument, Kody said no, macOS
refused (the sentence names the System Settings switch when known). The CLI exits 1; the SDK raises
`DoorRefused`, or `DoorUnavailable` when nothing is listening.

## Versioning
`doors/1` is this page. An existing door never changes meaning or drops a result field. New doors and new optional
args may be added within `doors/1`. A door that should go becomes an alias of its replacement and keeps working;
only a change of meaning makes `doors/2`, served beside `doors/1`.

## Clients
- CLI: `rappter-door <door> [json-args]` (app/doors, installed to `~/bin` by `app/doors/install.sh`).
- SDK: `app/doors/rappter_doors.py` — `doors.call(name, **args)` plus one helper per door.
- MCP: `rappter-doors-mcp` (see app/doors/README-mcp.md).
- Any language: open the socket, write a line, read a line.
